# openapi-validator

[![GitHub](https://img.shields.io/badge/github-jnrdhn%2Fopenapi--validator-blue?logo=github)](https://github.com/jnrdhn/openapi-validator)

A CLI tool that validates whether OpenAPI 3.x endpoints are **executable** — meaning they exist and respond on a real server.

It does **not** validate functional correctness or response schema conformance. It only checks reachability and classifies each endpoint by its HTTP response. The primary output is an `executable` boolean per endpoint: **true** means the path/method exists on the server.

## Requirements

[Bun](https://bun.sh) >= 1.0.0

## Installation

```bash
bun add -g @jnrdhn/openapi-validator
```

Or run without installing:

```bash
bunx @jnrdhn/openapi-validator --spec ./api.yaml
```

## Usage

```
openapi-validator --spec <path-or-url> [options]
```

### Options

| Flag | Alias | Description | Default |
|---|---|---|---|
| `--spec` | `-s` | Path or URL to OpenAPI spec (JSON or YAML) | **required** |
| `--base-url` | `-b` | Override the base URL from the spec's `servers[]` | — |
| `--auth` | | Authentication (see formats below) | none |
| `--header` | | Extra request header, repeatable | — |
| `--output` | `-o` | Output report path | `report.json` |
| `--concurrency` | `-c` | Number of parallel requests | `3` |
| `--timeout` | | Request timeout in milliseconds | `10000` |
| `--only-tag` | | Only test endpoints with this tag, repeatable | — |
| `--skip-tag` | | Skip endpoints with this tag, repeatable | — |
| `--skip-deprecated` | | Skip deprecated endpoints | — |
| `--help` | `-h` | Show help | — |

### Auth formats

```
--auth bearer:<token>
--auth apikey:<HeaderName>:<value>
--auth basic:<username>:<password>
```

## Examples

```bash
# Local spec with base URL override
openapi-validator --spec ./petstore.yaml --base-url http://localhost:3000

# Remote spec with bearer token
openapi-validator --spec https://api.example.com/openapi.json --auth bearer:mytoken

# API key auth, custom output path
openapi-validator --spec ./api.yaml --auth apikey:X-Api-Key:secret --output results.json

# Basic auth, only test endpoints tagged "users"
openapi-validator --spec ./api.yaml --auth basic:admin:password --only-tag users

# Extra headers (e.g. tenant ID)
openapi-validator --spec ./api.yaml --header "X-Tenant-ID:acme" --header "X-Api-Version:2"

# Skip deprecated endpoints and a specific tag
openapi-validator --spec ./api.yaml --skip-deprecated --skip-tag internal
```

## Status classification

Each endpoint is classified into one of these statuses:

| Status | HTTP codes | `executable` | Meaning |
|---|---|---|---|
| `valid` | 2xx | true | Endpoint responded successfully |
| `bad_request` | 400, 422 | true | Endpoint exists, but synthetic test params were rejected |
| `unauthenticated` | 401 | true | Endpoint exists, requires credentials |
| `forbidden` | 403 | true | Endpoint exists, credentials lack permission |
| `not_found` | 404 | false | Endpoint path does not exist on the server |
| `method_not_allowed` | 405 | false | HTTP method not supported for this path |
| `server_error` | 5xx | false | Server-side error |
| `unreachable` | network/timeout | false | Server did not respond |
| `error` | other | false | Unexpected HTTP status |

`executable: true` is the primary signal — it means the path/method exists on the server, even if the request failed due to auth or bad params.

## Output

Results are written to `report.json` (or the path set by `--output`). The report contains:

```jsonc
{
  "timestamp": "2024-01-01T00:00:00.000Z",
  "spec": { "title": "My API", "version": "1.0.0", "baseUrl": "https://api.example.com" },
  "totalEndpoints": 42,
  "summary": {
    "valid": 10,
    "bad_request": 15,
    "unauthenticated": 8,
    "forbidden": 2,
    "not_found": 3,
    "method_not_allowed": 0,
    "server_error": 1,
    "unreachable": 0,
    "error": 3,
    "executable": 35,
    "not_executable": 7
  },
  "results": [
    {
      "method": "GET",
      "path": "/users",
      "status": "valid",
      "executable": true,
      "httpStatusCode": 200,
      "durationMs": 142,
      ...
    }
  ]
}
```

## How it works

1. Loads the OpenAPI spec (JSON or YAML, local file or URL)
2. Resolves inline `$ref` references
3. Generates synthetic test values for all parameters
4. Sends real HTTP requests to the server, sorted so list endpoints run before parameterized ones (e.g. `GET /users` before `GET /users/{id}`) — this lets the tool capture real IDs from responses and use them in subsequent requests
5. Classifies each response and writes the report

## Limitations

- Only local `$ref`s (`#/components/...`) are resolved; external file refs are not supported
- One auth config applies to all requests; per-endpoint auth is not supported
- Spec must be OpenAPI 3.x (not Swagger 2.x)
