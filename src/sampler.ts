import type { SchemaObject, NormalizedEndpoint } from "./types.ts";

// ─── Sample Value Generator ───────────────────────────────────────────────────
// Generates minimal, safe test values for parameters based on their JSON Schema.
// The goal is to produce values that allow the endpoint to respond (not to pass
// full validation), so we favor whatever keeps the request syntactically valid.

export function sampleValue(schema: SchemaObject | null, name = ""): unknown {
  if (!schema) return sampleByName(name);

  // Use example/default from spec when available
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;

  // Use first enum value
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];

  // Merge allOf/anyOf/oneOf to a single schema for sampling
  const merged = mergeCompositeSchema(schema);
  if (merged !== schema) return sampleValue(merged, name);

  switch (schema.type) {
    case "string":
      return sampleString(schema, name);
    case "integer":
    case "number":
      return schema.minimum ?? 1;
    case "boolean":
      return true;
    case "array":
      return [sampleValue(schema.items ?? null, name)];
    case "object":
      return sampleObject(schema);
    case "null":
      return null;
    default:
      // type not specified — try to infer from name or fall back to string
      return sampleByName(name);
  }
}

function sampleString(schema: SchemaObject, name: string): string {
  const format = schema.format;
  if (format === "date") return "2024-01-01";
  if (format === "date-time") return "2024-01-01T00:00:00Z";
  if (format === "time") return "00:00:00";
  if (format === "email") return "test@example.com";
  if (format === "uri" || format === "url") return "https://example.com";
  if (format === "uuid") return "00000000-0000-0000-0000-000000000001";
  if (format === "password") return "Password123!";
  if (format === "byte") return btoa("test");
  if (format === "binary") return "test";

  return sampleByName(name) as string;
}

function sampleByName(name: string): unknown {
  const lower = name.toLowerCase();
  if (lower.includes("email")) return "test@example.com";
  if (lower.includes("phone")) return "+15550001234";
  if (lower.includes("url") || lower.includes("uri") || lower.includes("link")) return "https://example.com";
  if (lower.includes("date") && lower.includes("time")) return "2024-01-01T00:00:00Z";
  if (lower.includes("date")) return "2024-01-01";
  if (lower.includes("time")) return "00:00:00";
  if (lower.includes("uuid") || lower.includes("guid")) return "00000000-0000-0000-0000-000000000001";
  if (lower.includes("id")) return "1";
  if (lower.includes("count") || lower.includes("limit") || lower.includes("max") || lower.includes("size")) return 10;
  if (lower.includes("offset") || lower.includes("skip") || lower.includes("page")) return 0;
  if (lower.includes("name")) return "test";
  if (lower.includes("title")) return "Test Title";
  if (lower.includes("description") || lower.includes("summary") || lower.includes("body")) return "Test description";
  if (lower.includes("token")) return "test-token";
  if (lower.includes("key")) return "test-key";
  if (lower.includes("password") || lower.includes("secret")) return "Password123!";
  if (lower.includes("status")) return "active";
  if (lower.includes("type")) return "test";
  if (lower.includes("tag")) return "test";
  if (lower.includes("version")) return "1";
  if (lower.includes("lang") || lower.includes("locale")) return "en";
  if (lower.includes("currency")) return "USD";
  if (lower.includes("country")) return "US";
  return "test";
}

function sampleObject(schema: SchemaObject): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);

  for (const [key, propSchema] of Object.entries(props)) {
    // Only fill required fields to minimize noise; add non-required if no required fields exist
    if (required.size === 0 || required.has(key)) {
      result[key] = sampleValue(propSchema, key);
    }
  }
  return result;
}

function mergeCompositeSchema(schema: SchemaObject): SchemaObject {
  const list = schema.allOf ?? schema.anyOf ?? schema.oneOf;
  if (!list || list.length === 0) return schema;
  // Use first sub-schema as representative sample
  return { ...schema, ...list[0], allOf: undefined, anyOf: undefined, oneOf: undefined };
}

// ─── Path Parameter Resolver ──────────────────────────────────────────────────
// Tracks IDs/items returned from list/collection responses so that subsequent
// parameterized endpoints can substitute real values instead of synthetic ones.

export class ParamResolver {
  // Map of param name (lowercased) → resolved value
  private resolved = new Map<string, unknown>();

  /**
   * Record values extracted from a successful API response.
   * Looks for common ID fields at the top level and inside list arrays.
   * Write methods (POST/PUT/PATCH) overwrite existing values — a freshly-created
   * resource's ID is more relevant than one captured from a prior list response.
   */
  recordResponse(path: string, responseBody: unknown, method = "GET"): void {
    if (!responseBody || typeof responseBody !== "object") return;

    const overwrite = ["POST", "PUT", "PATCH"].includes(method.toUpperCase());
    const body = responseBody as Record<string, unknown>;

    // Direct ID fields on the root object
    this.extractIds(body, overwrite);

    // Items inside list-style arrays: { items: [...], data: [...], results: [...], etc. }
    for (const key of ["items", "data", "results", "records", "entries", "list", "value"]) {
      const arr = body[key];
      if (Array.isArray(arr) && arr.length > 0) {
        const first = arr[0];
        if (first && typeof first === "object") this.extractIds(first as Record<string, unknown>, overwrite);
      }
    }

    // If root is an array
    if (Array.isArray(responseBody) && responseBody.length > 0) {
      const first = responseBody[0];
      if (first && typeof first === "object") this.extractIds(first as Record<string, unknown>, overwrite);
    }

    // Derive param names from path segments for context
    // e.g. /users/{userId}/posts → "userid" → id stored as "userid" too
    const pathParamPattern = /\{(\w+)\}/g;
    let m: RegExpExecArray | null;
    while ((m = pathParamPattern.exec(path)) !== null) {
      const paramName = m[1].toLowerCase();
      if (!this.resolved.has(paramName)) {
        // Try to find a matching field in recorded IDs
        const match = this.findMatchingId(paramName);
        if (match !== undefined) this.resolved.set(paramName, match);
      }
    }
  }

  private extractIds(obj: Record<string, unknown>, overwrite = false): void {
    for (const [key, value] of Object.entries(obj)) {
      if (value === null || value === undefined) continue;
      const k = key.toLowerCase();
      if (overwrite || !this.resolved.has(k)) {
        this.resolved.set(k, value);
      }
      // Also store plain "id" if not set (or overwriting)
      if ((k === "id" || k.endsWith("id") || k.endsWith("_id")) && (overwrite || !this.resolved.has("id"))) {
        this.resolved.set("id", value);
      }
    }
  }

  private findMatchingId(paramName: string): unknown {
    // Direct match
    if (this.resolved.has(paramName)) return this.resolved.get(paramName);

    // Try suffix: "userid" → check "id"
    for (const [key, value] of this.resolved.entries()) {
      if (paramName.endsWith(key) || key.endsWith(paramName)) return value;
    }
    return undefined;
  }

  /** Resolve a path parameter value. Falls back to a synthetic value. */
  resolve(paramName: string, schema: SchemaObject | null): unknown {
    const lower = paramName.toLowerCase();
    const found = this.findMatchingId(lower);
    if (found !== undefined) return String(found);
    return sampleValue(schema, paramName);
  }

  /** Build a URL by substituting all path parameters. */
  buildUrl(baseUrl: string, path: string, endpoint: NormalizedEndpoint): { url: string; usedParams: Set<string> } {
    const usedParams = new Set<string>();
    const resolvedPath = path.replace(/\{(\w+)\}/g, (_, name) => {
      usedParams.add(name);
      const param = endpoint.parameters.find((p) => p.in === "path" && p.name === name);
      const value = this.resolve(name, param?.schema ?? null);
      return encodeURIComponent(String(value));
    });
    return { url: baseUrl + resolvedPath, usedParams };
  }
}
