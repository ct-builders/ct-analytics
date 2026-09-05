# Securing a deployment

Two endpoints, opposite exposure, different answers.

## Ingest is authenticated

`POST /collect` is a write endpoint on the public internet, so it requires a
bearer token:

```
Authorization: Bearer <CLICKSTREAM_INGEST_KEY>
```

The collector **refuses to start** without a credential. That is deliberate:
an open ingest endpoint fails invisibly — the reports fill up and look
completely normal while anyone who found the URL writes into them.

```bash
CLICKSTREAM_INGEST_KEY="$(openssl rand -hex 32)"
```

Keys shorter than 24 characters are refused at startup too.

### The token belongs on your server, not in the page

A shopper's browser cannot hold a secret. Anything the page can read, so can
anyone who views source, opens devtools, or reads the network tab. So the
architecture that makes ingest genuinely authenticated is:

```
shopper's browser  ──POST /api/clickstream──►  your server  ──POST /collect──►  collector
     (no secret)         (same origin)          (holds token)   (Bearer token)
```

Your site already wants this proxy for unrelated reasons: the request is
same-origin, so tracker-blocking extensions leave it alone and there is no CORS
configuration to get wrong. Point the client at your own path:

```html
<script>window.CLICKSTREAM_CONFIG = { site: 'acme', endpoint: '/api/clickstream' };</script>
<script src="https://your-collector.example/c.js" defer></script>
```

`examples/storefront/server.js` is a working proxy in about twenty lines,
including the header that attaches the token.

### Browser-direct ingest, and what it is actually worth

A site with no backend of its own has nowhere to keep a token. For that case
there is an explicit opt-in:

```bash
CLICKSTREAM_INGEST_ALLOW_BROWSER=true
```

Posts are then accepted on the strength of the `Origin` header matching that
site's allowlist. Stated plainly: **`Origin` is set by the browser, and
anything that is not a browser can forge it.** What this buys you is that a
scanner which stumbles onto the endpoint cannot write to your reports. What it
does not buy you is any guarantee that a write came from your site.

Two guardrails come with it. A site whose `origins` list is empty is refused
outright, because "authenticated by origin" against a list that permits every
origin is not authentication. And the collector logs a warning on every start
while the mode is on, so it does not quietly become the permanent arrangement.

```bash
npm run site:add -- --slug acme --name "Acme" \
  --origins https://acme.example,https://www.acme.example
```

Include the exact scheme and host. `https://acme.example` and
`https://www.acme.example` are two different origins.

### Rotating the key

Deploy the collector with the new key, update the proxy, then remove the old
one. There is no key list, so the two have to overlap in time only as long as
it takes to roll both — which is why the token lives in one place.

## The reports are gated

The admin renders every shopper's browsing history. Two ways to close it, and
they are not equivalent.

**A shared password**, via the gate. The reports redirect to `/gate`, which
asks for a work email and one password, then sets a first-party `HttpOnly`,
`Secure`, `SameSite=Lax` cookie.

```bash
GATE_SITE=<registered-site-id>
GATE_AUTH_URL=https://your-auth-service.example
```

The password is never held by the process. It is validated by whatever
`GATE_AUTH_URL` points at, which is also where the access log lives. Setting
one half without the other refuses to start, because that combination leaves
the reports open while looking closed.

A satisfied gate is sufficient authorization on its own — there is deliberately
not a second token to also present, because two secrets to distribute means the
weaker one defines the security of the whole thing.

**A bearer token**, via `CLICKSTREAM_ADMIN_TOKEN`, compared in constant time.
Simpler, and worse to share: it gets pasted into chat, it breaks when someone
trims a query string, and rotating it means telling everyone.

With neither configured the admin refuses every request rather than serving
openly, so a deploy that forgets the variable fails loudly.
`CLICKSTREAM_ADMIN_OPEN=true` overrides that, and belongs only on a machine
nothing else can reach.

Either way, put your platform's own access layer in front for anything
carrying real traffic — see [gcp-setup.md](gcp-setup.md) for Cloud Run IAM and
Identity-Aware Proxy.

## What is deliberately never gated

Three paths stay open, and gating any of them breaks the system silently
rather than loudly:

| Path | Why |
|---|---|
| `POST /collect` preflight | A browser cannot send credentials until the preflight succeeds |
| `GET /c.js` | Loaded by shoppers' browsers, which have no credential |
| `GET /health` | A platform probe meeting a redirect is a failing deployment |

## The rest of the surface

- Bodies are capped at 256 KB, batches at 50 events, strings at 512 characters
  — enforced while reading, so an oversized body is refused rather than
  buffered first.
- The admin is read-only. No route it serves writes anything.
- Every value the admin renders is HTML-escaped, and its pages carry a
  restrictive `Content-Security-Policy`. Report cells originate in browser
  payloads and are therefore untrusted input.
- Deletion and retention are a SQL query and a CLI command, not HTTP
  endpoints. Nothing that destroys data is reachable over the network.
- The database needs no public IP. On Cloud Run it is reached over a mounted
  Unix socket; see [gcp-setup.md](gcp-setup.md).

What Clickstream stores about people, and the choices that are yours rather
than the module's, are in [privacy.md](privacy.md).
