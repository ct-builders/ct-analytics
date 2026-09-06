# Instrumenting your site

Everything ct-analytics reports comes from events your site sends. This is the
list of what to send, where to send it from, and what each event has to carry
to be accepted.

There are three levels, and one site can mix them freely. Most sites end up
using all three: the script for pages, attributes for clicks, and the API for
the handful of values a click cannot know.

- [Level 1 — the script tag](#level-1--the-script-tag)
- [Level 2 — markup attributes](#level-2--markup-attributes)
- [Level 3 — the JavaScript API](#level-3--the-javascript-api)
- [Session dimensions](#session-dimensions)
- [Attribution, and why order matters](#attribution-and-why-order-matters)
- [Event reference](#event-reference)
- [Checking your install](#checking-your-install)

## Level 1 — the script tag

```html
<script src="https://YOUR-COLLECTOR/c.js?site=YOUR-SITE" defer></script>
```

That alone reports a page view for every page, classifies each one from its
URL, follows single-page navigations (`pushState`, `replaceState`, `popstate`),
and picks the search term out of the query string.

Configure it with a global instead of query parameters when you need more than
the basics:

```html
<script>
  window.CLICKSTREAM_CONFIG = {
    site: 'acme',
    endpoint: '/api/clickstream'
  };
</script>
<script src="https://YOUR-COLLECTOR/c.js" defer></script>
```

**Point `endpoint` at your own origin.** Ingest requires a bearer token, and a
token shipped to the browser is not a token. Your server proxies that path to
the collector and adds the `Authorization` header. Posting straight to the
collector from the browser is possible but weaker — see
[docs/security.md](docs/security.md).

### Options

| Option | Default | What it does |
|---|---|---|
| `site` | — | Required. The slug registered with the collector. An unknown slug is refused. |
| `endpoint` | — | Where events are posted. A path on your own origin. |
| `auto` | `true` | Report page views and follow SPA navigations. |
| `autoSearch` | `true` | Report a search when a recognised query parameter appears. |
| `autoClicks` | `true` | Bind the delegated `data-clickstream` listener. |
| `searchParams` | `q, query, search, s, keyword` | Query keys treated as a search term. |
| `classify` | — | `(path) => pageType`, to override the built-in URL rules. |
| `hashCustomerRef` | `false` | SHA-256 the customer reference before it leaves the browser. |
| `flushInterval` | `2000` | Milliseconds between batch sends. |
| `debug` | `false` | Log what the client is doing to the console. |

### Page classification

An unrecognised path is reported as `other` rather than guessed at — a
mislabelled page silently corrupts a funnel denominator, which is worse than an
unlabelled one.

| Page type | Matched by |
|---|---|
| `home` | the root, with one optional locale segment (`/`, `/en-us`) |
| `search` | `/search`, `/results`, `/find` |
| `category` | `/category`, `/categories`, `/c/`, `/collection`, `/shop`, `/catalog` |
| `product` | `/product`, `/products`, `/p/`, `/pdp`, `/item`, `/dp/` |
| `cart` | `/cart`, `/basket`, `/bag` |
| `checkout` | `/checkout`, `/payment`, `/shipping` |
| `order_confirmation` | `/order-confirmation`, `/thank-you`, `/receipt`, `/confirmation` |
| `login` | `/login`, `/signin`, `/register`, `/signup` |
| `account` | `/account`, `/profile`, `/orders`, `/wishlist` |
| `other` | anything else |

If your URLs do not look like those, supply `classify` rather than accepting
`other` everywhere:

```js
window.CLICKSTREAM_CONFIG = {
  site: 'acme',
  endpoint: '/api/clickstream',
  classify: function (path) {
    if (/^\/artikel\//.test(path)) return 'product';
    if (/^\/suche/.test(path)) return 'search';
  }
};
```

Return nothing and the built-in rules still apply.

## Level 2 — markup attributes

Add `data-clickstream` to the element, plus the dimensions beside it. The
listener is delegated from `document`, so it works on markup rendered after
load, and a click on an icon *inside* an annotated button still counts.

```html
<button data-clickstream="add_to_cart"
        data-sku="SW-42" data-name="Merino Crew"
        data-quantity="1" data-price="12900" data-currency="USD">
  Add to cart
</button>

<a href="/product/sw-42" data-clickstream="result_click"
   data-sku="SW-42" data-position="3">Merino Crew</a>

<button data-clickstream="facet_apply"
        data-facet-name="color" data-facet-value="blue"
        data-facets="color:blue,size:m" data-result-count="18">Blue</button>
```

This is the level worth reaching for first, because the instrumentation lives
on the markup: it survives a frontend rewrite, and it needs no JavaScript on
your side at all.

### Attributes the client reads

Product dimensions, on any product-shaped event:

| Attribute | Notes |
|---|---|
| `data-sku` | |
| `data-product-key` | |
| `data-product-id` | |
| `data-name` | |
| `data-category-path` | |
| `data-price` | **Minor units.** `12900` is £129.00. |
| `data-currency` | ISO code. Required for `data-price` to be read. |
| `data-fraction-digits` | Only for currencies that are not 2-digit. |

At least one of `data-sku`, `data-product-key` or `data-product-id` is
required, or the collector refuses the event.

Per event type:

| `data-clickstream` | Also reads |
|---|---|
| `result_click` | `data-position` (the rank, 1-based) |
| `product_view` | — |
| `add_to_cart` | `data-quantity`, `data-cart-total`, omnichannel |
| `remove_from_cart` | `data-quantity`, `data-cart-total`, omnichannel |
| `facet_apply` / `facet_remove` | `data-facet-name`, `data-facet-value`, `data-facets`, `data-result-count` |
| `sort_change` | `data-sort`, `data-previous-sort` |
| `search` | `data-query`, `data-result-count` |
| `category_view` | `data-category-path`, `data-category-id`, `data-category-name` |
| `checkout_start` | `data-cart-total`, `data-item-count`, omnichannel |
| `login` | `data-customer-id`, `data-customer-ref`, `data-method` |
| `logout` | — |

`data-facets` is the whole current selection in one attribute, as
`name:value,name:value`. It matters more than it looks: it is what lets a
report say a product sold *with the blue filter active*, not merely that
someone clicked blue at some point.

Omnichannel dimensions, readable on add-to-cart, remove-from-cart and
checkout-start:

```html
<button data-clickstream="add_to_cart" data-sku="SW-42"
        data-fulfillment="pickup"
        data-location-key="bk-01" data-location-name="Brooklyn">
```

`order_submit` is deliberately **not** in the table. A click cannot carry an
order total that the server only decides afterwards, so it stays an API call.
Annotating an element with it logs a console warning and sends nothing.

## Level 3 — the JavaScript API

For the values a click does not know.

```js
clickstream.search('merino', 12);

clickstream.login({
  customerId: 'c-1',
  customerRef: 'shopper@example.com',
  method: 'password'
});

clickstream.orderSubmit({
  orderNumber: 'A-1049',
  total: { centAmount: 12980, currencyCode: 'USD' },
  itemCount: 3,
  items: [
    { product: { sku: 'SW-42', name: 'Merino Crew',
                 price: { centAmount: 6490, currencyCode: 'USD' } }, quantity: 2 }
  ]
});
```

### Methods

| Method | Purpose |
|---|---|
| `pageView(pageType, extra?)` | Report a page view yourself. Needed only with `auto: false`. |
| `search(query, resultCount?, extra?)` | The result count is the reason to call this. |
| `categoryView(categoryPath, extra?)` | |
| `facetApply(facet, facets?, resultCount?)` | `facet` is `{ name, value }`; `facets` is the whole selection. |
| `facetRemove(facet, facets?, resultCount?)` | |
| `sortChange(sort, previousSort?)` | |
| `resultClick(product, position)` | `position` is the 1-based rank. |
| `productView(product)` | |
| `addToCart(product, quantity, cartTotal?, extra?)` | `extra` carries `fulfillment` and `location`. |
| `removeFromCart(product, quantity, cartTotal?, extra?)` | |
| `cartView(extra?)` | |
| `checkoutStart(extra?)` | `{ cartTotal, itemCount }` |
| `checkoutStep(step, extra?)` | `step` is your own label — `shipping`, `payment`. |
| `orderSubmit(order)` | Flushes immediately. |
| `login(customer)` | Sets the identity, reports the event, flushes. |
| `logout()` | Drops the identity before the queue drains. |
| `identify(dimensions)` | Merge session dimensions. See below. |
| `money(centAmount, currency, fractionDigits?)` | Build a Money value. |
| `flush()` | Send everything queued now. |
| `config()` | The effective configuration, for debugging. |
| `identity()` | `{ anonymousId, sessionId }`. |

A product is `{ sku?, productKey?, productId?, name?, categoryPath?, price? }`,
and `price` is `{ centAmount, currencyCode, fractionDigits? }`. At least one
identifier is required.

**Money is always minor units.** `12900` with `USD` is $129.00. Never send a
float — the reports sum these, and a float sum of money is wrong by design.

### Two calls worth making even on a minimal install

**`search(query, resultCount)`.** Without the count, the *Zero-result searches*
report — the most directly actionable list in the admin — stays empty forever.
The client never invents a count: an omitted one is omitted, because defaulting
to `0` would fabricate failed demand the catalog actually met.

**`orderSubmit`, with `items`.** The line items are what make per-product
revenue, revenue-by-discovery and *Bought together* work. An order without them
still counts as an order and contributes nothing else.

## Session dimensions

Call `identify` once you know them, usually right after the client loads:

```js
clickstream.identify({
  store: 'us-store',
  channel: 'web',
  locale: 'en-US',
  currency: 'USD'
});
```

These land on the session and every event in it, and they are what the admin's
segment filters slice by. `store` is the sales channel or market a visit
belongs to — not the physical store a shopper collects from, which travels as
`location` on the fulfilment dimensions.

Identity is separate. `login()` sets it, `logout()` clears it, and a session
that signs in halfway through is attributed correctly for its whole length —
the anonymous browsing before the sign-in is counted with the rest of the
visit, which is the honest reading of one person's session.

If your `customerRef` is an email address and you would rather it did not leave
the browser, set `hashCustomerRef: true` and the client sends a SHA-256 of it
instead. The reports still group by shopper; they just cannot show you who.

## Attribution, and why order matters

The link between a search and the product it sold is computed **in the
browser**, because that is the only place it is actually known. When a shopper
clicks a result, the client stamps that discovery — the query, the facets, the
rank — onto the product, and carries it forward onto the product view, the
add-to-cart, and the order line.

That gives you one rule to follow:

> Report the discovery **before** the product event it caused.

In practice that means calling `search()` or `categoryView()` when the listing
renders, and `resultClick()` when the shopper clicks through, rather than
reporting everything at the end. Get this right and *Search to product* and
*Revenue by discovery* work. Get it wrong and the product still appears in the
reports, with `direct` discovery — nothing breaks, but the question the whole
system exists to answer goes unanswered for that shopper.

A shopper who arrives straight on a product page with no prior listing is
genuinely `direct`, and that is recorded rather than guessed at.

## Event reference

The taxonomy is closed. An event outside this list is refused at the door and
recorded in *Install health* with the reason, so a mis-instrumented site looks
different from a site nobody visited.

| Event | Required fields |
|---|---|
| `page_view` | `pageType` from the closed list |
| `search` | `query` |
| `category_view` | `categoryPath` |
| `facet_apply` | `facet.name` |
| `facet_remove` | `facet.name` |
| `sort_change` | `sort` |
| `result_click` | a product identifier |
| `product_view` | a product identifier |
| `add_to_cart` | a product identifier |
| `remove_from_cart` | a product identifier |
| `cart_view` | — |
| `checkout_start` | — |
| `checkout_step` | — |
| `order_submit` | `total.centAmount`, `total.currencyCode` |
| `login` | — |
| `logout` | — |

Anything site-specific goes in `props`, which every event accepts:

```js
clickstream.track({ type: 'product_view', product: { sku: 'SW-42' },
                    props: { loyaltyTier: 'gold' } });
```

No shipped report reads `props`. It is there so a dimension you care about is
not lost while you decide what to do with it — free-form names in the typed
columns would mean nothing guarantees that a search carries a query, and every
report would become a pile of casts no index helps.

## Checking your install

Two places tell you whether it worked.

**Install health**, in the admin, lists every event the collector refused, with
the reason and the payload. An empty report and an empty *Install health* means
nothing is arriving at all — check the endpoint and the site slug. An empty
report with entries here means events are arriving and being rejected, and the
reason column says why.

**`debug: true`** logs what the client is doing to the browser console: what it
classified each page as, what it queued, and what it refused to send.

Then walk one journey yourself — search, filter, click a result, add to cart,
buy — and open **Session journey** in the admin. It replays that visit event by
event with the discovery attached to each one. If your own session reads
correctly there, the instrumentation is right.
