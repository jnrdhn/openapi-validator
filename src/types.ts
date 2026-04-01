// ─── OpenAPI Spec Types ───────────────────────────────────────────────────────

export interface OpenAPISpec {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, SecurityScheme>;
    parameters?: Record<string, ParameterObject>;
    requestBodies?: Record<string, RequestBodyObject>;
  };
  security?: SecurityRequirement[];
}

export interface PathItem {
  summary?: string;
  description?: string;
  parameters?: ParameterObject[];
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  security?: SecurityRequirement[];
  responses?: Record<string, ResponseObject>;
  deprecated?: boolean;
}

export interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
  example?: unknown;
  $ref?: string;
}

export interface RequestBodyObject {
  required?: boolean;
  content: Record<string, { schema?: SchemaObject }>;
  $ref?: string;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface SchemaObject {
  type?: string;
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  example?: unknown;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  $ref?: string;
  allOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  oneOf?: SchemaObject[];
}

export type SecurityScheme =
  | { type: "http"; scheme: "bearer" | "basic" | string; bearerFormat?: string }
  | { type: "apiKey"; in: "header" | "query" | "cookie"; name: string }
  | { type: "oauth2"; flows: unknown }
  | { type: "openIdConnect"; openIdConnectUrl: string };

export type SecurityRequirement = Record<string, string[]>;

// ─── Normalized Endpoint ─────────────────────────────────────────────────────

export interface NormalizedEndpoint {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  parameters: ResolvedParameter[];
  requestBody: ResolvedRequestBody | null;
  security: SecurityRequirement[];
  deprecated: boolean;
}

export interface ResolvedParameter {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  required: boolean;
  description: string;
  schema: SchemaObject | null;
}

export interface ResolvedRequestBody {
  contentType: string;
  schema: SchemaObject | null;
  required: boolean;
}

// ─── Auth Configuration ───────────────────────────────────────────────────────

export type AuthConfig =
  | { type: "bearer"; token: string }
  | { type: "apikey"; header: string; value: string }
  | { type: "basic"; username: string; password: string }
  | { type: "none" };

// ─── Validation Report Types ──────────────────────────────────────────────────

/**
 * Classification of an endpoint's executability:
 *
 * - `valid`              — 2xx response; endpoint exists and responded successfully.
 * - `bad_request`        — 400/422; endpoint exists but our test params were insufficient.
 *                          Still counts as executable (the path is reachable).
 * - `unauthenticated`    — 401; endpoint exists but requires auth credentials.
 * - `forbidden`          — 403; endpoint exists but the provided credentials lack permission.
 * - `not_found`          — 404; endpoint path does not exist on the server.
 * - `method_not_allowed` — 405; the HTTP method is not supported for this path.
 * - `server_error`       — 5xx; endpoint exists but the server encountered an error.
 * - `unreachable`        — Network error, DNS failure, or timeout; server did not respond.
 * - `error`              — Unexpected classification (other HTTP status codes).
 */
export type EndpointStatus =
  | "valid"
  | "bad_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "method_not_allowed"
  | "server_error"
  | "unreachable"
  | "error";

export interface EndpointResult {
  operationId: string;
  method: string;
  path: string;
  summary: string;
  tags: string[];
  status: EndpointStatus;
  /**
   * True when the endpoint path/method exists and the server responded
   * (even if auth failed or params were wrong). False when the endpoint
   * is not found, the method is wrong, or the server was unreachable.
   */
  executable: boolean;
  httpStatusCode: number | null;
  responseSummary: string;
  responseBody: unknown;
  requestDetails: {
    url: string;
    headers: Record<string, string>;
    body: unknown;
    queryParams: Record<string, string>;
  };
  durationMs: number;
  deprecated: boolean;
  /** Number of retries made before this result was recorded (omitted when 0). */
  retryCount?: number;
}

export interface ValidationReport {
  timestamp: string;
  spec: {
    title: string;
    version: string;
    baseUrl: string;
  };
  totalEndpoints: number;
  results: EndpointResult[];
  summary: {
    valid: number;
    bad_request: number;
    unauthenticated: number;
    forbidden: number;
    not_found: number;
    method_not_allowed: number;
    server_error: number;
    unreachable: number;
    error: number;
    executable: number;
    not_executable: number;
  };
}

// ─── Validator Config ─────────────────────────────────────────────────────────

export interface ValidatorConfig {
  specPath: string;
  baseUrl?: string;
  auth: AuthConfig;
  outputPath: string;
  concurrency: number;
  timeoutMs: number;
  /** Max retry attempts for transient failures (429, 502–504, timeout). Default: 2. */
  retries: number;
  /** Base delay in ms between retries (exponential backoff). Default: 1000. */
  retryDelayMs: number;
  /** Skip endpoints tagged with these tags */
  skipTags?: string[];
  /** Only run endpoints tagged with these tags */
  onlyTags?: string[];
  /** Skip deprecated endpoints */
  skipDeprecated?: boolean;
  /** Extra headers to add to every request (e.g. tenant ID, API version) */
  extraHeaders?: Record<string, string>;
}
