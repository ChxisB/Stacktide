# Hardening

What the API does at its edge before anything else, and what it leaves to the proxy in front of it (OPS-5). Most of
it is always on; four settings tune it.

## Headers

Every response, including 404, 401, 413 and 429, carries:

| Header | Value |
|---|---|
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `Referrer-Policy` | `no-referrer` |
| `Content-Security-Policy` | `default-src 'none'; frame-ancestors 'none'` |
| `Cross-Origin-Resource-Policy` | `same-origin` |
| `Cache-Control` | `no-store` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains`, **only** when the API is served over https |

"Served over https" means the GitLab sign-in redirect is https (`Secure` cookies). Behind a proxy that ends TLS, set the
redirect URL to its https address and the header follows.

The API answers JSON, so the CSP forbids loading anything from it. The web page served by `startWeb` (the `/` route of
`apps/web`) is **not** covered: it is a development server, and how the page is served in production is decided with OPS-2.

## CORS

Off by default: the page and the API share one origin (`apps/web` proxies `/` and everything else), so no browser call is
cross-origin. To let a page on another origin call the API with the session cookie, list it:

```
ORCH_CORS_ORIGINS=https://app.example.com,https://other.example.com
```

- The entries are origins, exactly as a browser sends them: no path, no trailing slash, no `*`, no `null`. Anything else
  stops the API from starting.
- The match is exact. `https://app.example.com.evil.test`, another port, another scheme or another case get nothing.
- A listed origin gets its own origin back in `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true`, and
  `Access-Control-Expose-Headers: x-request-id, retry-after`. Every answer varies by `Origin` once any origin is listed.
- A preflight from a listed origin is answered `204` (methods `GET, POST, PUT, PATCH, DELETE`; headers `content-type,
  authorization, x-request-id`; max age 600 s) before any route or sign-in. Any other preflight gets the plain 404 of an
  unknown route, with no CORS headers, and the browser refuses the call.
- The session cookie is `SameSite=Lax`, so a credentialed cross-origin call only carries it **between sites that share a
  registrable domain** (`app.example.com` calling `api.example.com`). Across unrelated sites the cookie is not sent whatever
  this list says; use an API token there.

There is no `Origin` check on requests beyond this. Cross-site form posts are stopped by the JSON-only body rule (415) and
`SameSite=Lax`.

## Body size

`ORCH_MAX_BODY_BYTES` (default 2 MiB, at least 1 MiB, at most 64 MiB). The same number is given to the server as its own
limit, which stops any larger body, declared or streamed, with a plain-text `413`. A request that declares a larger
`Content-Length` (a digit string, of any length) and reaches the application anyway (another host, a test) is answered
`413` `payload_too_large` before sign-in. The limit is not lowered below 1 MiB because a plan summary and a webhook may legitimately be that large.

## Rate limits

Each class of route is counted per window. A request over its limit gets `429` `rate_limited` with `Retry-After` in seconds,
and never reaches the handler or its validation. The counts are in `orch_rate_limited_total{limit}` ([metrics](metrics.md)).

| Class | Routes | Limit | Counted by |
|---|---|---|---|
| `login` | `GET /auth/login`, `GET /auth/callback`, `GET /auth/cli`, `POST /auth/cli/token` | 30 per 5 min | client address |
| `ci_exchange` | `POST /auth/ci/exchange` | 600 per min | client address |
| `webhook` | `POST /webhooks/gitlab/:connectionId` | 600 per min | client address |
| `token_create` | `POST /tokens` | 10 per 10 min | the person or token |
| `reveal` | the three `GET …/variables/:varId/value` and `GET …/resolved-variables/values` | 60 per min | the person or token |

- A route says which class it is in its options (`limit: "reveal"`), the way it says who may call it. A test lists the
  routes that have one and fails if a route that reads a secret's value does not.
- The reveal limit comes **before** the guard, so someone who may not read a secret is counted too: guessing at ids does
  not get more tries than reading does. A signed-out caller of a `caller` class is counted by address.
- The local-development principal is one trusted caller and is never limited.
- `ORCH_RATE_LIMIT_SCALE` (0.1 to 100, default 1) multiplies every limit; at least one request is always allowed.
  Runners or GitLab behind one address may need it above 1 for `ci_exchange` and `webhook`.

### Who the client is

With `ORCH_TRUSTED_PROXY_HOPS=0` (default) the client is the connection's peer, and `X-Forwarded-For` is **ignored**: anyone
can send it. Behind `n` reverse proxies that each **append** the address they saw to `X-Forwarded-For`, set it to `n`: the
client is the `n`-th entry from the right, so an entry the caller forged at the start does not matter. `apps/web` is
such a proxy and appends the address of its caller; count it.

Set the number to what is true. Too low behind a proxy, and all clients share the proxy's address and its limit. Too high,
and a caller who sends their own `X-Forwarded-For` picks their own count. A chain that is shorter than `n`, or an entry that
is not an IP address, falls back to the peer. An entry may carry a port (`203.0.113.9:51234`) or be a bracketed IPv6
address (`[2001:db8::1]:443`); the address is what is counted.

Two mistakes are logged once per process as a warning (no address in it): `X-Forwarded-For` arrives while the number is 0, and
the entry the number points at is not an address. Either one means every client is counted as the proxy.

### What it does not do

- The counters are in this process's memory. Each replica counts alone, a restart forgets, and `maxKeys` (10 000) caps the
  memory: a flood from many addresses can push older counters out. Put the limits in Postgres before running several replicas.
- An IPv6 client is counted per address, not per /64.
- There is no global per-address limit: a flood of requests with invalid credentials still costs a lookup each. Rate-limit
  the whole API at the proxy.
- `GET /metrics` is not limited; its bearer token and the network boundary are its protection.

## Dependencies

CI runs `bun audit` (the `audit` job) and fails on any known advisory in `bun.lock`. One is ignored by id,
`GHSA-67mh-4wv8-2f99`: esbuild 0.18 inside `drizzle-kit`, a development tool, and the advisory is about esbuild's
development server. Remove the `--ignore` when drizzle-kit takes a patched esbuild. `yaml` was raised from 2.8.1 to 2.8.3
for an advisory in this work. The job has not run in a real pipeline yet (FND-6); locally, `bun audit` exits 1 on a finding
and 0 when clean.
