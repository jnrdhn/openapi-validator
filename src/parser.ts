import yaml from "js-yaml";
import type {
  OpenAPISpec,
  NormalizedEndpoint,
  ResolvedParameter,
  ResolvedRequestBody,
  ParameterObject,
  SchemaObject,
  SecurityRequirement,
} from "./types.ts";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loadSpec(pathOrUrl: string): Promise<OpenAPISpec> {
  let raw: string;

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    const res = await fetch(pathOrUrl);
    if (!res.ok) throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
    raw = await res.text();
  } else {
    const file = Bun.file(pathOrUrl);
    if (!(await file.exists())) throw new Error(`Spec file not found: ${pathOrUrl}`);
    raw = await file.text();
  }

  const spec = pathOrUrl.match(/\.(yaml|yml)$/i) || raw.trimStart().startsWith("openapi:")
    ? (yaml.load(raw) as OpenAPISpec)
    : (JSON.parse(raw) as OpenAPISpec);

  if (!spec.openapi) throw new Error("Not a valid OpenAPI spec (missing 'openapi' field)");
  if (!spec.paths) throw new Error("OpenAPI spec has no 'paths' defined");

  return spec;
}

export function getBaseUrl(spec: OpenAPISpec, override?: string): string {
  if (override) return override.replace(/\/$/, "");
  if (spec.servers && spec.servers.length > 0) {
    const url = spec.servers[0].url;
    // Handle relative server URLs (e.g. "/api/v1")
    if (url.startsWith("/")) {
      console.warn(`⚠️  Server URL is relative ("${url}"). Pass --base-url to set the host.`);
    }
    return url.replace(/\/$/, "");
  }
  throw new Error("No server URL found in spec. Pass --base-url <url>");
}

// ─── $ref Resolver ────────────────────────────────────────────────────────────

function resolveRef<T>(ref: string, spec: OpenAPISpec): T | null {
  if (!ref.startsWith("#/")) return null; // external refs not supported
  const parts = ref.replace("#/", "").split("/");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let current: any = spec;
  for (const part of parts) {
    if (current == null) return null;
    current = current[part];
  }
  return current as T;
}

function resolveParameter(param: ParameterObject, spec: OpenAPISpec): ParameterObject {
  if (param.$ref) {
    const resolved = resolveRef<ParameterObject>(param.$ref, spec);
    return resolved ?? param;
  }
  return param;
}

function resolveSchema(schema: SchemaObject | undefined, spec: OpenAPISpec): SchemaObject | null {
  if (!schema) return null;
  if (schema.$ref) {
    const resolved = resolveRef<SchemaObject>(schema.$ref, spec);
    return resolved ? resolveSchema(resolved, spec) : null;
  }
  return schema;
}

// ─── Normalizer ───────────────────────────────────────────────────────────────

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"] as const;

export function normalizeSpec(spec: OpenAPISpec): NormalizedEndpoint[] {
  const endpoints: NormalizedEndpoint[] = [];

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    if (!pathItem) continue;

    // Parameters defined at the path level apply to all operations
    const pathLevelParams = (pathItem.parameters ?? []).map((p) => resolveParameter(p, spec));

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;

      // Merge path-level params with operation-level params (operation wins on name collision)
      const operationParams = (operation.parameters ?? []).map((p) => resolveParameter(p, spec));
      const mergedParamMap = new Map<string, ParameterObject>();
      for (const p of [...pathLevelParams, ...operationParams]) {
        mergedParamMap.set(`${p.in}:${p.name}`, p);
      }

      const parameters: ResolvedParameter[] = Array.from(mergedParamMap.values()).map((p) => ({
        name: p.name,
        in: p.in as ResolvedParameter["in"],
        required: p.required ?? p.in === "path",
        description: p.description ?? "",
        schema: resolveSchema(p.schema, spec),
      }));

      // Request body
      let requestBody: ResolvedRequestBody | null = null;
      if (operation.requestBody) {
        let rb = operation.requestBody;
        if (rb.$ref) {
          rb = resolveRef(rb.$ref, spec) ?? rb;
        }
        const contentType = Object.keys(rb.content ?? {})[0] ?? "application/json";
        const mediaType = rb.content?.[contentType];
        requestBody = {
          contentType,
          schema: resolveSchema(mediaType?.schema, spec),
          required: rb.required ?? false,
        };
      }

      // Security: operation-level overrides spec-level (empty array means no auth for this op)
      const security: SecurityRequirement[] =
        operation.security !== undefined ? operation.security : (spec.security ?? []);

      const operationId =
        operation.operationId ??
        `${method.toUpperCase()}_${path.replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "")}`;

      endpoints.push({
        operationId,
        method: method.toUpperCase(),
        path,
        summary: operation.summary ?? operation.description ?? path,
        tags: operation.tags ?? [],
        parameters,
        requestBody,
        security,
        deprecated: operation.deprecated ?? false,
      });
    }
  }

  return endpoints;
}
