# The event taxonomy

Sixteen event types, a closed set. The collector refuses anything else at the
door and returns the reason.

That closedness is what keeps the reports trustworthy. With free-form event
names and an untyped property bag, nothing guarantees that a `search` carries a
query or that an `add_to_cart` carries a price — so a report built on them is
full of blanks with no way to find out why. Site-specific dimensions go in
`props`, which every event accepts and no shipped report reads.

## Events

| Event | Required | Also carries | Funnel step |
|---|---|---|---|
| `page_view` | `pageType` | `title`, `referrer` | — |
| `search` | `query` | `resultCount`, `facets`, `sort` | Discover |
| `category_view` | `categoryPath` | `categoryId`, `categoryName`, `resultCount`, `facets`, `sort` | Discover |
| `facet_apply` | `facet.name` | `facet.value`, `facets`, `resultCount` | — |
| `facet_remove` | `facet.name` | `facet.value`, `facets`, `resultCount` | — |
| `sort_change` | `sort` | `previousSort` | — |
| `result_click` | `product`, `position` | — | — |
| `product_view` | `product` | — | View product |
| `add_to_cart` | `product` | `quantity`, `cartTotal` | Add to cart |
| `remove_from_cart` | `product` | `quantity`, `cartTotal` | — |
| `cart_view` | — | `cartTotal`, `itemCount` | — |
| `checkout_start` | — | `cartTotal`, `itemCount` | Checkout |
| `checkout_step` | — | `step`, `cartTotal`, `itemCount` | — |
| `order_submit` | `total` | `orderId`, `orderNumber`, `itemCount`, `items` | Order |
| `login` | — | `customerId`, `customerRef`, `method` | — |
| `logout` | — | `customerId`, `customerRef` | — |

Every event also carries `path`, `ts`, `props`, its session `context`, and its
`attribution`.

## Page types

`home` · `search` · `category` · `product` · `cart` · `checkout` ·
`order_confirmation` · `account` · `login` · `other`

An unrecognised URL is `other` rather than a guess. A mislabelled page type is
worse than an unlabelled one, because it silently pollutes a funnel
denominator.

## Shared shapes

### Money

```js
{ centAmount: 12900, currencyCode: 'USD', fractionDigits: 2 }
```

Minor units, always, alongside the currency. Never a float: 19.99 in binary
floating point, summed across ten thousand line items, does not equal what the
order says it does — and a revenue report that disagrees with the orders is
worse than no revenue report.

### ProductRef

```js
{
  productId: 'a1b2…',        // one of these three is required
  productKey: 'merino-crew',
  sku: 'SW-42',
  name: 'Merino Crew Sweater',
  categoryPath: 'mens/knitwear',
  price: { centAmount: 12900, currencyCode: 'USD' }
}
```

Which identifier you use does not matter — sites differ in what they know at
each point. It must be the **same** one across `result_click`, `product_view`
and `add_to_cart`, or attribution cannot pin the product between them. The
client prefers `sku`, then `productKey`, then `productId`.

### FacetSelection

```js
{ name: 'color', value: 'blue' }
```

`facets` on an event is the complete selection at that moment, not the delta.
Recording the state is what lets a report show the whole filter sequence that
led to one product.

### Attribution

Attached by the client; a site never sets it.

```js
{
  discoveryId: '…',            // correlates back to the search or category view
  discoveryType: 'search',     // search | category | direct | recommendation
  query: 'merino',
  categoryPath: 'mens/knitwear',
  facets: [{ name: 'color', value: 'blue' }],
  position: 3                  // 1-based rank in the result list
}
```

### Context

Session-wide dimensions, set with `clickstream.identify()`. These are the columns
the segment filters slice by.

```js
{ store: 'us-store', channel: 'web', locale: 'en-US', currency: 'USD',
  customerId: 'c-1', customerRef: 'shopper@example.com' }
```

`store` and `channel` stay two independent fields. Concatenating them makes
both unusable as filters.

Anything else you add is kept — a B2B site passing `businessUnit` gets it
stored — but no shipped report reads it.

## How attribution works

The link from a search to the product it sold is computed in the browser,
because it cannot be recovered afterwards. Given rows for `search("merino")`,
`facet_apply(color=blue)` and `add_to_cart(SW-42)`, a later query can only
guess they are related because they sit near each other in one session. That
guess breaks the moment a shopper opens three products in tabs, searches again
mid-browse, or arrives at a product from a recommendation strip.

So:

1. A `search` or `category_view` mints a `discoveryId` and becomes the current
   listing context.
2. `facet_apply`, `facet_remove` and `sort_change` narrow that listing without
   starting a new one — the id stays stable, which is what lets a report show
   the full filter sequence behind one purchase.
3. A `result_click` pins the current context, plus the rank, **to that
   product**.
4. `product_view`, `add_to_cart` and `remove_from_cart` read the pin. With no
   pin, they fall back to the current listing; with no listing at all, they are
   `direct`.
5. `order_submit` records how the shopper was browsing when they ordered.
   Per-product revenue attribution is a SQL join from the order's lines back to
   the session's own `add_to_cart` rows, so the order payload does not have to
   carry it.

State lives in `sessionStorage`, so it survives the full page navigation a
server-rendered store does on every click and dies with the tab — the correct
lifetime for "the search I am shopping from right now". A snapshot is copied
rather than referenced, so a later filter click cannot retroactively rewrite an
earlier product's recorded filters. At most 50 products keep a pin; a shopper
past that in one session is well beyond the point where the earliest view's
originating search still explains anything.

`logout` clears it, so one shopper's browsing context does not leak into the
next session on a shared machine.

## Validation

Lenient about unknown fields, strict about the ones reports read.

An event with an extra property is accepted and stored — a site will always
know something the taxonomy did not anticipate. An event missing its
discriminating dimension is refused with a reason.

Rejections are **per event**, not per batch: one broken call site in a site's
markup does not cost the other 49 events in the request. Every refusal is
recorded and shown in the **Install health** report, so a badly instrumented
site looks different from a site nobody visited.

Two further protections worth knowing:

- **A wildly wrong client clock is clamped, not dropped.** Phones with bad
  clocks are common, and a 1979 timestamp vanishes from every date-ranged
  report. Beyond 24 hours of skew the arrival time is substituted and the row
  is marked.
- **Batch order is preserved.** Several events firing in the same millisecond
  is routine on a listing page, so each row records its position in its batch.
  The funnel depends on that ordering.
