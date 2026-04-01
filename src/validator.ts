import type {
  NormalizedEndpoint,
  EndpointResult,
  EndpointStatus,
  AuthConfig,
  ValidationReport,
  ValidatorConfig,
} from "./types.ts";
import { sampleValue, ParamResolver } from "./sampler.ts";

// ─── Status Classification ────────────────────────────────────────────────────

function classifyStatus(httpStatus: number): EndpointStatus {
  if (httpStatus >= 200 && httpStatus < 300) return "valid";
  if (httpStatus === 400 || httpStatus === 422) return "bad_request";
  if (httpStatus === 401) return "unauthenticated";
  if (httpStatus === 403) return "forbidden";
  if (httpStatus === 404) return "not_found";
  if (httpStatus === 405) return "method_not_allowed";
  if (httpStatus >= 500) return "server_error";
  return "error";
}

/**
 * An endpoint is "executable" when it actually exists and responded — even if
 * the auth failed or our test params were wrong. Not-found, wrong-method, and
 * network failures are the only non-executable outcomes.
 */
function isExecutable(status: EndpointStatus): boolean {
  return !["not_found", "method_not_allowed", "unreachable", "error"].includes(status);
}

// ─── Auth Header Builder ──────────────────────────────────────────────────────

function buildAuthHeaders(auth: AuthConfig): Record<string, string> {
  switch (auth.type) {
    case "bearer":
      return { Authorization: `Bearer ${auth.token}` };
    case "basic": {
      const encoded = btoa(`${auth.username}:${auth.password}`);
      return { Authorization: `Basic ${encoded}` };
    }
    case "apikey":
      return { [auth.header]: auth.value };
    case "none":
    default:
      return {};
  }
}

// ─── Single Endpoint Executor ─────────────────────────────────────────────────

async function executeEndpoint(
  endpoint: NormalizedEndpoint,
  baseUrl: string,
  auth: AuthConfig,
  resolver: ParamResolver,
  timeoutMs: number,
  extraHeaders: Record<string, string> = {}
): Promise<EndpointResult> {
  const start = Date.now();

  // Build URL + path params
  const { url: basePathUrl, usedParams } = resolver.buildUrl(baseUrl, endpoint.path, endpoint);

  // Build query params
  const queryParams: Record<string, string> = {};
  for (const param of endpoint.parameters) {
    if (param.in !== "query") continue;
    if (param.required) {
      queryParams[param.name] = String(sampleValue(param.schema, param.name));
    }
  }

  const urlWithQuery = Object.keys(queryParams).length > 0
    ? `${basePathUrl}?${new URLSearchParams(queryParams).toString()}`
    : basePathUrl;

  // Build headers
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "openapi-validator/0.1",
    ...buildAuthHeaders(auth),
    ...extraHeaders,
  };

  // Build request body
  let bodyPayload: unknown = undefined;
  if (endpoint.requestBody && ["POST", "PUT", "PATCH"].includes(endpoint.method)) {
    const { contentType, schema } = endpoint.requestBody;
    headers["Content-Type"] = contentType;
    bodyPayload = sampleValue(schema, "body");
  }

  const requestDetails = {
    url: urlWithQuery,
    headers: sanitizeHeaders(headers),
    body: bodyPayload,
    queryParams,
  };

  // Execute request
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let httpStatus: number;
    let responseBody: unknown;

    try {
      const response = await fetch(urlWithQuery, {
        method: endpoint.method,
        headers,
        body: bodyPayload !== undefined ? JSON.stringify(bodyPayload) : undefined,
        signal: controller.signal,
      });

      httpStatus = response.status;
      const text = await response.text();
      responseBody = tryParseJson(text) ?? text;
    } finally {
      clearTimeout(timer);
    }

    const status = classifyStatus(httpStatus);
    const executable = isExecutable(status);

    // Record response so later endpoints can reuse IDs
    if (httpStatus >= 200 && httpStatus < 300) {
      resolver.recordResponse(endpoint.path, responseBody, endpoint.method);
    }

    const truncated = truncateBody(responseBody);

    return {
      operationId: endpoint.operationId,
      method: endpoint.method,
      path: endpoint.path,
      summary: endpoint.summary,
      tags: endpoint.tags,
      status,
      executable,
      httpStatusCode: httpStatus,
      responseSummary: buildSummary(status, httpStatus, endpoint),
      responseBody: truncated,
      requestDetails,
      durationMs: Date.now() - start,
      deprecated: endpoint.deprecated,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "AbortError";
    const message = err instanceof Error ? err.message : String(err);

    return {
      operationId: endpoint.operationId,
      method: endpoint.method,
      path: endpoint.path,
      summary: endpoint.summary,
      tags: endpoint.tags,
      status: "unreachable",
      executable: false,
      httpStatusCode: null,
      responseSummary: isTimeout ? `Request timed out after ${timeoutMs}ms` : `Network error: ${message}`,
      responseBody: null,
      requestDetails,
      durationMs: Date.now() - start,
      deprecated: endpoint.deprecated,
    };
  }
}

// ─── Summary Builder ──────────────────────────────────────────────────────────

function buildSummary(status: EndpointStatus, httpStatus: number, endpoint: NormalizedEndpoint): string {
  switch (status) {
    case "valid":
      return `Endpoint responded with ${httpStatus} — successfully executable.`;
    case "bad_request":
      return `Endpoint exists (${httpStatus}) but rejected the test parameters — consider providing real param values via --extra-params.`;
    case "unauthenticated":
      return `Endpoint exists but requires authentication (${httpStatus}) — provide credentials via --auth.`;
    case "forbidden":
      return `Endpoint exists but the credentials lack permission (${httpStatus}).`;
    case "not_found":
      return `Endpoint path not found on server (${httpStatus}) — may be mismatched base URL or the route doesn't exist.`;
    case "method_not_allowed":
      return `HTTP method ${endpoint.method} is not allowed for this path (${httpStatus}).`;
    case "server_error":
      return `Server returned ${httpStatus} — endpoint exists but encountered a server-side error.`;
    default:
      return `Unexpected response: HTTP ${httpStatus}.`;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function truncateBody(body: unknown, maxChars = 2000): unknown {
  const serialized = JSON.stringify(body);
  if (!serialized || serialized.length <= maxChars) return body;
  return serialized.slice(0, maxChars) + "… [truncated]";
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const safe = { ...headers };
  // Redact auth values from the report
  if (safe["Authorization"]) safe["Authorization"] = safe["Authorization"].replace(/\s.+$/, " [redacted]");
  for (const key of Object.keys(safe)) {
    const lower = key.toLowerCase();
    if (lower.includes("key") || lower.includes("secret") || lower.includes("token")) {
      safe[key] = "[redacted]";
    }
  }
  return safe;
}

// ─── Concurrency Helper ───────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

// ─── Main Validator ───────────────────────────────────────────────────────────

export async function validateEndpoints(
  endpoints: NormalizedEndpoint[],
  baseUrl: string,
  config: ValidatorConfig,
  onProgress?: (result: EndpointResult, index: number, total: number) => void
): Promise<ValidationReport> {
  // Filter by tags if requested
  let filtered = endpoints;
  if (config.onlyTags && config.onlyTags.length > 0) {
    const only = new Set(config.onlyTags);
    filtered = filtered.filter((e) => e.tags.some((t) => only.has(t)));
  }
  if (config.skipTags && config.skipTags.length > 0) {
    const skip = new Set(config.skipTags);
    filtered = filtered.filter((e) => !e.tags.some((t) => skip.has(t)));
  }
  if (config.skipDeprecated) {
    filtered = filtered.filter((e) => !e.deprecated);
  }

  // Sort and group into phases so ID-producing endpoints run before ID-consuming ones
  const sorted = sortByDependency(filtered);
  const phases = buildExecutionPhases(sorted);

  const resolver = new ParamResolver();
  let completed = 0;
  const allResults: EndpointResult[] = [];

  for (const phase of phases) {
    const tasks = phase.map((endpoint) => async () => {
      const result = await executeEndpoint(
        endpoint,
        baseUrl,
        config.auth,
        resolver,
        config.timeoutMs,
        config.extraHeaders
      );
      completed++;
      onProgress?.(result, completed, filtered.length);
      return result;
    });

    const phaseResults = await runWithConcurrency(tasks, config.concurrency);
    allResults.push(...phaseResults);
  }

  // Re-order results to match original spec order
  const originalOrder = new Map(filtered.map((e, i) => [e.operationId, i]));
  const results = allResults;
  results.sort((a, b) => (originalOrder.get(a.operationId) ?? 0) - (originalOrder.get(b.operationId) ?? 0));

  const summary = buildSummaryStats(results);

  return {
    timestamp: new Date().toISOString(),
    spec: {
      title: "", // filled by caller
      version: "",
      baseUrl,
    },
    totalEndpoints: results.length,
    results,
    summary,
  };
}

/**
 * Sort endpoints by:
 * 1. Resource depth (shallower paths first — /users before /users/{id}/posts)
 * 2. Resource base path (groups same-resource endpoints together)
 * 3. Method lifecycle order within each resource:
 *    list GET → POST (create) → item GET → PUT → PATCH → DELETE
 */
function sortByDependency(endpoints: NormalizedEndpoint[]): NormalizedEndpoint[] {
  const METHOD_ORDER: Record<string, number> = {
    GET: 2, POST: 1, PUT: 3, PATCH: 4, DELETE: 5,
  };

  // Strip the trailing /{param} to get the collection/resource base path
  const resourceBase = (path: string) => path.replace(/\/\{[^}]+\}$/, "");

  // Count path parameters — used as nesting depth
  const depthOf = (path: string) => (path.match(/\{[^}]+\}/g) ?? []).length;

  const methodScore = (e: NormalizedEndpoint) => {
    const hasPathParams = e.parameters.some((p) => p.in === "path" && p.required);
    if (e.method === "GET" && !hasPathParams) return 0; // list endpoints always first
    return METHOD_ORDER[e.method] ?? 6;
  };

  return [...endpoints].sort((a, b) => {
    const baseA = resourceBase(a.path);
    const baseB = resourceBase(b.path);

    // 1. Shallower resources first
    const depthDiff = depthOf(baseA) - depthOf(baseB);
    if (depthDiff !== 0) return depthDiff;

    // 2. Group by resource base (alphabetical for stability)
    if (baseA !== baseB) return baseA.localeCompare(baseB);

    // 3. Within same resource, lifecycle order
    return methodScore(a) - methodScore(b);
  });
}

/**
 * Group sorted endpoints into execution phases by path-parameter depth.
 * Phase 0 (no path params) completes before Phase 1 (1 path param) starts, etc.
 * This prevents race conditions where a parameterized endpoint fires before
 * the list endpoint that would have provided its ID.
 */
function buildExecutionPhases(sorted: NormalizedEndpoint[]): NormalizedEndpoint[][] {
  const phaseMap = new Map<number, NormalizedEndpoint[]>();
  for (const ep of sorted) {
    const depth = (ep.path.match(/\{[^}]+\}/g) ?? []).length;
    if (!phaseMap.has(depth)) phaseMap.set(depth, []);
    phaseMap.get(depth)!.push(ep);
  }
  return [...phaseMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, eps]) => eps);
}

function buildSummaryStats(results: EndpointResult[]) {
  const counts = {
    valid: 0,
    bad_request: 0,
    unauthenticated: 0,
    forbidden: 0,
    not_found: 0,
    method_not_allowed: 0,
    server_error: 0,
    unreachable: 0,
    error: 0,
    executable: 0,
    not_executable: 0,
  };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.executable) counts.executable++;
    else counts.not_executable++;
  }
  return counts;
}
