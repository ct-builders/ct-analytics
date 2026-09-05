# Commerce Clickstream

Commerce Clickstream records what shoppers actually do on an ecommerce site — what they
searched for, which filters they clicked, which product they chose, what they
added to the cart, and what they bought — and answers the question a plain
event log cannot: **which search sold this product.**

It is one JavaScript file in the browser, a Postgres collector, and a reporting
admin. No build step, no dependencies in the browser, and one dependency on the
server.

> Commerce Clickstream is freely available reference code, provided **as is and
> unsupported**. It is meant to be read, lifted and adapted. See
> [SUPPORT.md](SUPPORT.md).

## Install

One script tag on any site that can host one — a Next.js storefront, a
hand-written HTML page, a template you only reach through a CMS field.

```html
<script>window.CLICKSTREAM_CONFIG = { site: 'acme', endpoint: '/api/clickstream' };</script>
<script src="https://your-collector.example/c.js" defer></script>
```

That alone reports page views, classifies every page from its URL, follows
single-page navigations, and picks the search term out of the query string.

`endpoint` is a path on **your own** origin, which your server proxies to the
collector. Ingest requires a bearer token and the collector refuses to start
without one, so the token lives on your server and is attached there — a
secret shipped to a browser is not a secret. The proxy is about twenty lines;
there is a working one in `examples/storefront/server.js`, and
[docs/security.md](docs/security.md) covers the alternative for sites with no
backend of their own.

Two further levels are available, and a site can mix all three freely.

**Data attributes** report clicks with no JavaScript at all. The
instrumentation lives on the markup, so it survives a frontend rewrite.

```html
<button data-clickstream="add_to_cart" data-sku="SW-42"
        data-quantity="1" data-price="1999" data-currency="USD">Add to cart</button>

<a href="/product/sw-42" data-clickstream="result_click"
   data-sku="SW-42" data-position="3">Merino Crew</a>

<button data-clickstream="facet_apply"
        data-facet-name="color" data-facet-value="blue">Blue</button>
```

**The API** covers what a click cannot express — a total known only after the
server responds, a sign-in, or a result count.

```js
clickstream.search('merino', 12);
clickstream.login({ customerId: 'c-1', customerRef: 'shopper@example.com' });
clickstream.orderSubmit({
  orderNumber: 'A-1049',
  total: { centAmount: 12980, currencyCode: 'USD' },
  items: [{ product: { sku: 'SW-42', price: { centAmount: 6490, currencyCode: 'USD' } }, quantity: 2 }]
});
```

Full details in [docs/install.md](docs/install.md).

## What makes it different from a page-view counter

Discovery attribution. When a shopper searches for `merino`, filters to
`color=blue`, clicks the third result and buys it, the order's revenue is
attributable back to that search and that filter.

That link is recorded in the browser at the moment it is known, because it
cannot be reconstructed afterwards. Given rows for `search`, `facet_apply` and
`add_to_cart`, a later query can only guess they are related because they sit
near each other in one session — and that guess breaks as soon as a shopper
opens three products in tabs, searches again mid-browse, or arrives from a
recommendation strip. So each product carries the discovery that led to it,
pinned per product and surviving full page navigations.

## Run it locally

Needs Node 20+ and a local Postgres.

```bash
npm install
npm run db:create
npm run seed
npm run dev
```

The reports are then at
[localhost:8080/report/overview](http://localhost:8080/report/overview) — set
`CLICKSTREAM_ADMIN_TOKEN` and append `?token=…`, or set `CLICKSTREAM_ADMIN_OPEN=true`
on a trusted machine.

To click through a real storefront that fires every event, in a second
terminal:

```bash
npm run dev:storefront
```

Then open [localhost:3000](http://localhost:3000) and shop. Events appear in
the reports within a couple of seconds. Every `data-clickstream` attribute in that
example has no matching JavaScript call, which is the point of it.

## Standing up your own database

[docs/gcp-setup.md](docs/gcp-setup.md) covers Cloud SQL and Cloud Run
end to end, including the least-privilege service account, the connection
string, and what to set before real traffic reaches it. Any Postgres 14+ works;
nothing here is Google-specific beyond that document.

## The reports

| Report | Answers |
|---|---|
| Overview | Sessions, shoppers, conversion, revenue, average order |
| Funnel | Where sessions stop between discovery and order |
| Searches | What shoppers typed, how many matches, whether it led anywhere |
| Zero-result searches | Demand the catalog did not answer |
| Search to product | Which query led to which product |
| Revenue by discovery | Order revenue attributed to the search or category that sold it |
| Filters and facets | Which filters get used, and which lead to a cart |
| Categories browsed | Where shoppers browse, and how well each converts |
| Products | Views, adds and orders per product, with view-to-cart rate |
| Orders | Every order, with the shopper and how they found it |
| Pages | Traffic by page type and path |
| Sign-ins | Sign-in activity by registered shoppers |
| Sessions | Every visit, openable into the shopper's whole journey |
| Install health | Events the collector refused, and why |

Every one shares the same segment filters: date range, site, device, store,
channel, and signed-in versus anonymous. Details in
[docs/reports.md](docs/reports.md).

## The event taxonomy

Sixteen event types, a closed set. The collector refuses anything else at the
door and says why, which is what keeps the reports trustworthy: nothing
guarantees that a free-form `search` event carries a query, so a free-form
taxonomy produces reports full of blanks with no way to find out why.
Site-specific dimensions go in `props`, which every event accepts.

See [docs/events.md](docs/events.md), or the live reference at
`/events` in the admin.

## Security

Ingest is authenticated with a bearer token, and the collector refuses to start
without a credential — an open write endpoint fails invisibly, because the
reports fill up and look completely normal. The admin sits behind a shared
password or a token, and refuses every request when neither is configured.

Full account, including what browser-direct ingest is and is not worth:
[docs/security.md](docs/security.md).

## What it stores about people

A random opaque id per browser, and whatever identity the site chooses to
report. No fingerprinting, no third-party cookies, nothing shared with anyone.
`hashCustomerRef` makes the client SHA-256 a shopper's email before it leaves
the browser, so reports still group by shopper and nobody reading them sees an
address. Retention is off by default and is one environment variable.

[docs/privacy.md](docs/privacy.md) is the full account, including the parts
that are your decision rather than the module's.

## Tests

```bash
npm test
npm run typecheck
```

81 tests, no network access and no fixtures beyond a scratch database. The
end-to-end suite boots the collector, loads the real `clickstream.js` into a
browser-shaped scope, drives a shopper journey over HTTP into Postgres, and
reads the numbers back out through the real reports.

`npm run predeploy` runs both and is the gate before any deploy.

## Layout

| Path | What it is |
|---|---|
| `packages/browser/clickstream.js` | The client. One file, plain JS, no build step |
| `packages/browser/snippet.js` | The install stub, readable form |
| `packages/shared/events.js` | The taxonomy, shared by client and collector |
| `packages/shared/wire.js` | Wire format and validation |
| `apps/server/src/collector.js` | Ingest — the only part exposed to the internet |
| `apps/server/src/admin.js` | The reports. Read-only, no route writes anything |
| `apps/server/src/reports.js` | The report catalog |
| `apps/server/migrations/` | Schema |
| `examples/storefront/` | A small storefront firing every event |

## Licence

MIT. See [LICENSE](LICENSE).
