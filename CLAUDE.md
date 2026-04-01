# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A Bun/TypeScript CLI tool that validates whether OpenAPI 3.x endpoints are **executable** — meaning they exist and respond on a real server. It does not validate functional correctness or response schema conformance; it only checks reachability and classifies each endpoint by its HTTP response.

## Commands

```bash
bun install                              # Install dependencies
bun src/cli.ts --help                    # Show usage
bun src/cli.ts --spec <path|url>         # Run validator (minimum required args)
bun src/cli.ts --spec ./api.yaml --base-url http://localhost:3000
bun src/cli.ts --spec ./api.yaml --auth bearer:<token> --output report.json
```

## Architecture

```
src/types.ts      — All TypeScript types: OpenAPI spec shape, NormalizedEndpoint, EndpointResult, ValidationReport
src/parser.ts     — Load spec (JSON/YAML, file or URL), resolve inline $refs, normalize into NormalizedEndpoint[]
src/sampler.ts    — Generate synthetic test values for parameters + ParamResolver (captures real IDs from responses)
src/validator.ts  — HTTP execution, status classification, concurrency control, report assembly
src/cli.ts        — CLI arg parsing, progress output, final report printing, writes report.json
```

**Data flow:**
```
OpenAPI spec file/URL
  → loadSpec() + normalizeSpec()     [parser.ts]
  → NormalizedEndpoint[]
  → validateEndpoints()              [validator.ts]
      → sortByDependency()           list-first so ParamResolver captures IDs early
      → executeEndpoint() × N        fetch() with sampled params + resolved path params
      → classifyStatus()             maps HTTP status → EndpointStatus
  → ValidationReport → report.json
```

## Status Classification

| Status | HTTP codes | `executable` |
|---|---|---|
| `valid` | 2xx | true |
| `bad_request` | 400, 422 | true — endpoint exists, synthetic params were rejected |
| `unauthenticated` | 401 | true |
| `forbidden` | 403 | true |
| `not_found` | 404 | false |
| `method_not_allowed` | 405 | false |
| `server_error` | 5xx | false |
| `unreachable` | network/timeout | false |
| `error` | other | false |

The `executable` boolean is the primary signal: **true** means the path/method exists on the server.

## Key Design Constraints

- **No functional validation** — the goal is endpoint existence/reachability, not schema conformance
- **Generalize, don't hardcode** — must work with any OpenAPI 3.x spec, not tied to any specific API
- **Path param resolution** — `ParamResolver` in `sampler.ts` records IDs from list endpoint responses and substitutes them into later parameterized calls (e.g. GET /users runs before GET /users/{userId})
- **Synthetic params** — `sampleValue()` in `sampler.ts` generates minimal test values; 400 responses from bad params are expected and classified as `bad_request` (still executable)
- **Auth is injected globally** — one auth config applies to all requests; per-endpoint auth is not supported
- **$ref resolution** — only local (`#/components/...`) refs are resolved; external file refs are not supported

## Auth Formats (--auth flag)

```
bearer:<token>
apikey:<HeaderName>:<value>
basic:<username>:<password>
```

## Output

`report.json` contains a `ValidationReport` with:
- `spec` — title, version, baseUrl
- `totalEndpoints` — count of endpoints tested
- `results[]` — one `EndpointResult` per endpoint with status, httpStatusCode, executable, requestDetails, responseBody (truncated), durationMs
- `summary` — counts per status + executable/not_executable totals
