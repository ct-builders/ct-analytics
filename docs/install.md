# Installing Commerce Clickstream on a site

Three levels of integration. A site can use any mix of them, and they compose
without double-counting.

## Level 1 — the script tag

```html
<script src="https://your-collector.example/c.js?site=acme" defer></script>
```

This alone gives you:

- A page view for every page, classified from its URL as `home`, `search`,
  `category`, `product`, `cart`, `checkout`, `order_confirmation`, `account`,
  `login` or `other`.
- Single-page navigations. `pushState` and `replaceState` fire no event of
  their own, so the client wraps them; `popstate` and `hashchange` are covered
  too.
- The search term from the query string, on pages classified as `search`.
  Checked in order: `q`, `query`, `search`, `s`, `keyword`.

A locale prefix is stripped before classifying, so `/en-us` is the home page
rather than a category.

### Configuration

Three sources, least specific first: the script URL's query string, the tag's
`data-` attributes, and a `window.CLICKSTREAM_CONFIG` object set before the script
loads.

The query string matters most in practice — it is often the only one available
when the tag is pasted into a CMS field that strips unknown attributes.

| Option | Default | What it does |
|---|---|---|
| `site` | — | Site slug. Required; nothing is sent without it |
| `endpoint` | `<script origin>/collect` | Where to POST |
| `auto` | `true` | Report page views automatically |
| `autoSearch` | `true` | Watch the query string for a search term |
| `autoClicks` | `true` | Bind the `data-clickstream` click listener |
| `flushInterval` | `2000` | Queue linger before an automatic send, ms |
| `autoSearchDelay` | `800` | Grace period for the site to report a search itself |
| `hashCustomerRef` | `false` | SHA-256 the shopper reference in the browser |
| `debug` | `false` | Log every queued and sent batch |

```html
<script>
  window.CLICKSTREAM_CONFIG = {
    site: 'acme',
    endpoint: '/api/clickstream',
    classify: function (path) {
      // Return a page type to override the built-in URL patterns, or nothing
      // to fall through to them.
      if (path.indexOf('/lookbook/') === 0) return 'category';
    }
  };
</script>
<script src="https://your-collector.example/c.js" defer></script>
```

### Prefer a first-party endpoint

Proxy a path on the site's own origin through to the collector and point
`endpoint` at it. The request is then same-origin: unaffected by
tracker-blocking extensions, and needing no CORS configuration.

`examples/storefront/server.js` is a working proxy in about twenty lines.

## Level 2 — data attributes

Clicks reported with no JavaScript at all. A delegated listener on the document
reads `data-clickstream` and the dimensions beside it.

This is the level most sites should reach for. The instrumentation lives on the
markup rather than in a bundle, so it survives a frontend rewrite.

```html
<!-- The click that joins a query to a product. Fire this on result links and
     the search-to-product report fills itself in. -->
<a href="/product/sw-42" data-clickstream="result_click"
   data-sku="SW-42" data-name="Merino Crew" data-position="3"
   data-price="12900" data-currency="USD">Merino Crew</a>

<button data-clickstream="add_to_cart" data-sku="SW-42" data-quantity="1"
        data-price="12900" data-currency="USD">Add to cart</button>

<button data-clickstream="remove_from_cart" data-sku="SW-42" data-quantity="1">Remove</button>

<!-- `data-facets` is the selection AFTER this click, so the state is recorded
     rather than just the delta. -->
<button data-clickstream="facet_apply" data-facet-name="color" data-facet-value="blue"
        data-facets="color:blue,size:m" data-result-count="4">Blue</button>

<button data-clickstream="facet_remove" data-facet-name="color" data-facet-value="blue"
        data-facets="size:m">Blue ✕</button>

<button data-clickstream="sort_change" data-sort="price-asc">Price ↑</button>

<a href="#" data-clickstream="logout">Sign out</a>
```

### Attributes by event

| `data-clickstream` | Reads |
|---|---|
| `result_click` | `sku` / `product-key` / `product-id`, `name`, `category-path`, `price`, `currency`, `position` |
| `product_view` | the product attributes above |
| `add_to_cart` | the product attributes, plus `quantity`, `cart-total` |
| `remove_from_cart` | the product attributes, plus `quantity`, `cart-total` |
| `facet_apply` / `facet_remove` | `facet-name`, `facet-value`, `facets`, `result-count` |
| `sort_change` | `sort`, `previous-sort` |
| `search` | `query`, `result-count` |
| `category_view` | `category-path`, `category-id`, `category-name` |
| `checkout_start` | `cart-total`, `currency`, `item-count` |
| `login` | `customer-id`, `customer-ref`, `method` |
| `logout` | — |

A product needs **one** of `data-sku`, `data-product-key` or `data-product-id`.
Which one does not matter, but it must be the *same* one across
`result_click`, `product_view` and `add_to_cart`, or attribution cannot pin the
product between them.

Prices are minor units: `data-price="12900"` with `data-currency="USD"` is
$129.00.

`order_submit` is not in the table because a click cannot carry an order total
that only exists once the server has responded.

## Level 3 — the API

`window.clickstream` is callable, and safe to call before the client has finished
loading if you install the stub.

### The install stub

Paste this inline in `<head>`, above the script tag. It makes `journey`
callable during page parse and replays anything queued once the real client
arrives. Without it, a site that reports a sign-in or an order from markup near
the top of the page loses the event whenever the network is slow —
intermittently, and only in production.

```html
<script>
(function(w,d,t,s){w.clickstream=w.clickstream||{q:[]};
var m=['track','pageView','search','categoryView','facetApply','facetRemove','sortChange',
'resultClick','productView','addToCart','removeFromCart','cartView','checkoutStart',
'checkoutStep','orderSubmit','login','logout','identify','flush'];
for(var i=0;i<m.length;i++)(function(n){if(!w.clickstream[n])w.clickstream[n]=function(){
w.clickstream.q.push([n,arguments])}})(m[i]);
var e=d.createElement(t);e.src=s;e.defer=true;d.head.appendChild(e)})
(window,document,'script','https://your-collector.example/c.js?site=acme');
</script>
```

### Methods

```js
clickstream.pageView('product', { title: 'Merino Crew' });
clickstream.search('merino', 12, { facets: [{ name: 'color', value: 'blue' }], sort: 'price-asc' });
clickstream.categoryView('mens/knitwear', { resultCount: 24 });
clickstream.facetApply({ name: 'color', value: 'blue' }, [{ name: 'color', value: 'blue' }], 4);
clickstream.facetRemove({ name: 'color', value: 'blue' }, [], 24);
clickstream.sortChange('price-asc', 'relevance');
clickstream.resultClick({ sku: 'SW-42', name: 'Merino Crew' }, 3);
clickstream.productView({ sku: 'SW-42', name: 'Merino Crew', price: { centAmount: 12900, currencyCode: 'USD' } });
clickstream.addToCart({ sku: 'SW-42' }, 1, { centAmount: 12900, currencyCode: 'USD' });
clickstream.removeFromCart({ sku: 'SW-42' }, 1);
clickstream.cartView({ cartTotal: { centAmount: 12900, currencyCode: 'USD' }, itemCount: 1 });
clickstream.checkoutStart({ cartTotal: { centAmount: 12900, currencyCode: 'USD' }, itemCount: 1 });
clickstream.checkoutStep('payment');
clickstream.orderSubmit({
  orderNumber: 'A-1049',
  total: { centAmount: 12900, currencyCode: 'USD' },
  itemCount: 1,
  items: [{ product: { sku: 'SW-42', price: { centAmount: 12900, currencyCode: 'USD' } }, quantity: 1 }]
});
clickstream.login({ customerId: 'c-1', customerRef: 'shopper@example.com', method: 'password' });
clickstream.logout();

// Session-wide dimensions the reports segment by.
clickstream.identify({ store: 'us-store', channel: 'web', locale: 'en-US', currency: 'USD' });

clickstream.flush();                 // send the queue now
clickstream.money(12900, 'USD');     // build a Money value
clickstream.config();                // effective configuration, for debugging
clickstream.identity();              // { anonymousId, sessionId }
```

`orderSubmit` and `login` flush immediately, because both are normally followed
by a navigation.

### The one call worth making even on a minimal install

```js
clickstream.search(term, resultCount);
```

The automatic path picks the term out of the URL but cannot know the total, so
it omits the count rather than inventing a zero. Without a real count, the
**Zero-result searches** report — the most directly actionable list in the
system — stays empty.

Passing the count yourself is safe alongside the automatic path: the client
waits `autoSearchDelay` for the site to report a search itself and yields to it
rather than reporting the same search twice.

## Verifying an install

1. Load a page with `debug=true` on the script URL and watch the console. Every
   queued and sent batch is logged.
2. Check the network tab for a `202` from the collect endpoint. Its response
   body lists any rejected events with the reason.
3. Open **Install health** in the admin. Anything the collector refused is
   there, with the reason and the payload.

The most common mistakes, in order: a missing `?site=`, a slug that is not
registered (`404`), an origin the site's `origins` list does not include
(`403`), and product identifiers that differ between the listing and the
product page — which is silent, and shows up as attribution falling back to
the listing rather than pinning the product.
