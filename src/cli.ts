#!/usr/bin/env bun
import { loadSpec, getBaseUrl, normalizeSpec } from "./parser.ts";
import { validateEndpoints } from "./validator.ts";
import type { AuthConfig, ValidatorConfig, EndpointResult } from "./types.ts";

// ─── CLI Arg Parser ───────────────────────────────────────────────────────────

function parseArgs(argv: string[]): ValidatorConfig & { help?: boolean } {
  const args = argv.slice(2); // strip "bun" and script path
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const getAll = (flag: string): string[] => {
    const result: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && args[i + 1]) result.push(args[i + 1]);
    }
    return result;
  };
  const has = (flag: string) => args.includes(flag);

  if (has("--help") || has("-h") || args.length === 0) {
    return { help: true } as never;
  }

  const specPath = get("--spec") ?? get("-s") ?? args.find((a) => !a.startsWith("-"));
  if (!specPath) throw new Error("No spec file provided. Use: --spec <path-or-url>");

  // Auth parsing
  let auth: AuthConfig = { type: "none" };
  const authArg = get("--auth");
  if (authArg) {
    if (authArg.startsWith("bearer:")) {
      auth = { type: "bearer", token: authArg.slice(7) };
    } else if (authArg.startsWith("apikey:")) {
      // format: apikey:HeaderName:value
      const parts = authArg.slice(7).split(":");
      auth = { type: "apikey", header: parts[0], value: parts.slice(1).join(":") };
    } else if (authArg.startsWith("basic:")) {
      // format: basic:username:password
      const parts = authArg.slice(6).split(":");
      auth = { type: "basic", username: parts[0], password: parts.slice(1).join(":") };
    } else {
      // Assume bare bearer token
      auth = { type: "bearer", token: authArg };
    }
  }

  // Extra headers: --header "X-Foo:bar"
  const extraHeaders: Record<string, string> = {};
  for (const h of getAll("--header")) {
    const colon = h.indexOf(":");
    if (colon !== -1) extraHeaders[h.slice(0, colon).trim()] = h.slice(colon + 1).trim();
  }

  return {
    specPath,
    baseUrl: get("--base-url") ?? get("-b"),
    auth,
    outputPath: get("--output") ?? get("-o") ?? "report.json",
    concurrency: parseInt(get("--concurrency") ?? get("-c") ?? "3", 10),
    timeoutMs: parseInt(get("--timeout") ?? "10000", 10),
    retries: parseInt(get("--retry") ?? "2", 10),
    retryDelayMs: 1000,
    skipTags: getAll("--skip-tag"),
    onlyTags: getAll("--only-tag"),
    skipDeprecated: has("--skip-deprecated"),
    extraHeaders,
  };
}

// ─── Progress Printer ─────────────────────────────────────────────────────────

const STATUS_ICONS: Record<string, string> = {
  valid: "✓",
  bad_request: "~",
  unauthenticated: "🔒",
  forbidden: "⛔",
  not_found: "✗",
  method_not_allowed: "✗",
  server_error: "!",
  unreachable: "✗",
  error: "?",
};

const STATUS_COLORS: Record<string, string> = {
  valid: "\x1b[32m",       // green
  bad_request: "\x1b[33m", // yellow
  unauthenticated: "\x1b[33m",
  forbidden: "\x1b[33m",
  not_found: "\x1b[31m",   // red
  method_not_allowed: "\x1b[31m",
  server_error: "\x1b[31m",
  unreachable: "\x1b[31m",
  error: "\x1b[31m",
};

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function printProgress(result: EndpointResult, index: number, total: number): void {
  const icon = STATUS_ICONS[result.status] ?? "?";
  const color = STATUS_COLORS[result.status] ?? "";
  const pad = String(index).padStart(String(total).length, " ");
  const http = result.httpStatusCode != null ? `[${result.httpStatusCode}]` : "[---]";
  const ms = `${result.durationMs}ms`;
  const deprecated = result.deprecated ? ` ${DIM}(deprecated)${RESET}` : "";

  console.log(
    `  ${DIM}${pad}/${total}${RESET} ${color}${icon} ${result.method.padEnd(7)}${RESET} ` +
    `${DIM}${http.padEnd(6)}${RESET} ${result.path}${deprecated}` +
    `  ${DIM}${ms}${RESET}`
  );
}

// ─── Report Printer ───────────────────────────────────────────────────────────

function printReport(report: ReturnType<typeof buildFinalReport>): void {
  const s = report.summary;
  const { totalEndpoints } = report;

  console.log("\n─────────────────────────────────────────");
  console.log(`  Results for: ${report.spec.title} ${report.spec.version}`);
  console.log(`  Base URL:    ${report.spec.baseUrl}`);
  console.log("─────────────────────────────────────────");
  console.log(`  Total endpoints:   ${totalEndpoints}`);
  console.log(`  \x1b[32m✓ valid\x1b[0m             ${s.valid}`);
  console.log(`  \x1b[33m~ bad_request\x1b[0m       ${s.bad_request}`);
  console.log(`  \x1b[33m🔒 unauthenticated\x1b[0m  ${s.unauthenticated}`);
  console.log(`  \x1b[33m⛔ forbidden\x1b[0m        ${s.forbidden}`);
  console.log(`  \x1b[31m✗ not_found\x1b[0m         ${s.not_found}`);
  console.log(`  \x1b[31m✗ method_not_allowed\x1b[0m ${s.method_not_allowed}`);
  console.log(`  \x1b[31m! server_error\x1b[0m      ${s.server_error}`);
  console.log(`  \x1b[31m✗ unreachable\x1b[0m       ${s.unreachable}`);
  console.log(`  ? error             ${s.error}`);
  console.log("─────────────────────────────────────────");
  console.log(`  Executable:     ${s.executable} / ${totalEndpoints}`);
  console.log(`  Not executable: ${s.not_executable} / ${totalEndpoints}`);
  console.log("─────────────────────────────────────────\n");
}

// ─── Final Report Builder ─────────────────────────────────────────────────────

function buildFinalReport(
  raw: Awaited<ReturnType<typeof validateEndpoints>>,
  specTitle: string,
  specVersion: string
) {
  return {
    ...raw,
    spec: { ...raw.spec, title: specTitle, version: specVersion },
  };
}

// ─── Help Text ────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
openapi-validator — Test whether OpenAPI endpoints are executable

USAGE
  bun src/cli.ts --spec <path-or-url> [options]

OPTIONS
  --spec, -s    <path|url>   Path to OpenAPI spec file (JSON or YAML), or URL   [required]
  --base-url, -b <url>       Override the base URL from the spec's servers[]
  --auth        <value>      Authentication:
                               bearer:<token>
                               apikey:<HeaderName>:<value>
                               basic:<username>:<password>
  --header      <Key:Value>  Extra request header (repeatable)
  --output, -o  <path>       Output report path (default: report.json)
  --concurrency,-c <n>       Parallel requests (default: 3)
  --timeout     <ms>         Request timeout in ms (default: 10000)
  --retry       <n>          Retry attempts for 429/502-504/timeout (default: 2, 0 to disable)
  --only-tag    <tag>        Only test endpoints with this tag (repeatable)
  --skip-tag    <tag>        Skip endpoints with this tag (repeatable)
  --skip-deprecated          Skip deprecated endpoints
  --help, -h                 Show this help

EXAMPLES
  bun src/cli.ts --spec ./petstore.yaml --base-url http://localhost:3000
  bun src/cli.ts --spec https://api.example.com/openapi.json --auth bearer:mytoken
  bun src/cli.ts --spec ./api.yaml --auth apikey:X-Api-Key:secret --output results.json
  bun src/cli.ts --spec ./api.yaml --auth basic:admin:password --only-tag users

STATUS CODES
  ✓  valid              — 2xx, endpoint responded successfully
  ~  bad_request        — 400/422, endpoint exists but test params were rejected
  🔒 unauthenticated    — 401, endpoint requires credentials
  ⛔ forbidden          — 403, credentials lack permission
  ✗  not_found          — 404, endpoint path doesn't exist
  ✗  method_not_allowed — 405, HTTP method not supported
  !  server_error       — 5xx, server-side error
  ✗  unreachable        — Network error or timeout
  ?  error              — Other HTTP status
`);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let config: ValidatorConfig & { help?: boolean };

  try {
    config = parseArgs(process.argv);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (config.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`\nLoading spec: ${config.specPath}`);

  let spec;
  try {
    spec = await loadSpec(config.specPath);
  } catch (err) {
    console.error(`Failed to load spec: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const baseUrl = (() => {
    try {
      return getBaseUrl(spec, config.baseUrl);
    } catch (err) {
      console.error(`${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  })();

  const endpoints = normalizeSpec(spec);

  console.log(`Spec: ${spec.info.title} v${spec.info.version}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log(`Endpoints: ${endpoints.length} found\n`);

  if (endpoints.length === 0) {
    console.error("No endpoints found in spec.");
    process.exit(1);
  }

  const rawReport = await validateEndpoints(
    endpoints,
    baseUrl,
    config,
    printProgress
  );

  const report = buildFinalReport(rawReport, spec.info.title, spec.info.version);

  printReport(report);

  const outputFile = Bun.file(config.outputPath);
  await Bun.write(outputFile, JSON.stringify(report, null, 2));
  console.log(`Report written to: ${config.outputPath}\n`);
}

main();
