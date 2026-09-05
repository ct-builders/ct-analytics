# The reports

Seventeen reports, all sharing one set of segment filters. Adding another is one
entry in `apps/server/src/reports.js` — the admin renders the catalog
generically.

Every table sorts by clicking a column header, largest first on a number and
A to Z on a name, and a second click reverses it. Rows with nothing in the
column stay at the bottom either way. The sort covers the rows on the page, so
raise **Rows** before sorting a report the row limit has truncated.

## Segment filters

Present on every report, and meaning the same thing on each.

| Filter | Values |
|---|---|
| Site | Any registered site, or all |
| Range | Today, last 7 / 30 / 90 days, all time |
| From / To | Explicit dates, which override the range so a shared link keeps its window |
| Device | mobile, tablet, desktop |
| Shoppers | All, signed in, anonymous |
| Store | Any value the sites report |
| Channel | Any value the sites report |
| Rows | 25 to 500 |

`/reports.json` publishes the catalog and each report's columns, so the reports
can be driven from a script without scraping HTML.

## Summary

**Overview** — sessions, shoppers, events, conversion, orders, revenue, average
order, searches, zero-result searches, category browses, filters applied,
product views, add-to-carts, view-to-cart rate, sign-ins, signed-in share.

Conversion is *sessions that ordered over all sessions*. Per session rather
than per shopper, because a shopper who returns and buys on their third visit
did not convert three times.

**Funnel** — Discover → View product → Add to cart → Checkout → Order, with
sessions at each step.

Two percentages, on purpose. Share of all sessions makes every row comparable
to one base; share of the previous step is where the drop-off actually is.
Reading only the first hides a step that loses half its traffic late in the
funnel. A session counts for a step if it produced any of that step's events,
so a shopper who browsed a category rather than searching still counts as
having discovered something.

## Discovery

**Searches** — every query, with how many matches it returned, how many
products were viewed from it, how many were added to a cart, and the resulting
search-to-cart rate.

The outcomes are joined by the query recorded *on the later event*, not by
adjacency in the log. That is what the browser's discovery attribution is for.

**Zero-result searches** — demand the catalog did not answer, with how many
shoppers asked and when it was last asked. The most directly actionable list
here. It needs the site to pass a result count; see
[docs/install.md](install.md).

**Search to product** — which query led to which product, with the best rank
the product was clicked at and the filters that were active.

This is the question a plain event log cannot answer.

**Revenue by discovery** — order revenue attributed to the search or category
that first put each line in the basket.

Each order line is matched back to the most recent `add_to_cart` for the same
product in the same session before the order, so the line inherits how the
shopper found it. "Most recent" is deliberate: it is correct when a shopper
adds, removes and re-adds the same product.

**Filters and facets** — which filters get used, how often each is removed
again, and how many add-to-carts happened with each one active.

A high remove count next to a low cart count is a filter that promises
something the results do not deliver.

**Categories browsed** — where shoppers browse, with the same
browse-to-cart treatment as searches.

## Products

**Products** — views, adds, removes, view-to-cart rate, units ordered and
revenue per product.

A high view count with a low view-to-cart rate is a product whose listing
promises more than its detail page delivers.

**Bought together** — product pairs that share an order, with the attach rate
read in both directions, a lift score and the revenue the two lines earned in
those orders.

The two attach rates are rarely the same number, and the difference is the
finding: a scarf that goes into 60% of jacket orders while jackets appear in
15% of scarf orders is an add-on to promote on the jacket page, not the other
way round.

Lift divides the pair's share of orders by the share the two products would
take together if neither influenced the other. Above 1 is an affinity; near 1
is two popular products meeting by volume. Read it next to the order count —
a pair seen twice can carry a large lift and mean nothing.

Built from order lines, so an abandoned cart is not a basket.

## Orders

**Orders** — every order with its total, line count, the shopper, the device,
and how they found what they bought. Each row links to that session's full
journey.

## Traffic

**Pages** — views, sessions and shoppers by page type and path.

## Shoppers

**Sign-ins** — sign-in and sign-out activity per registered shopper, with their
sessions, orders and revenue.

Grouped by the identity on the *session* rather than on the event, so a
shopper's anonymous browsing before they signed in is counted with the rest of
that visit.

**Sessions** — every visit, with counts per stage and a link into the journey.

**Session journey** — every event in one visit, in order, with a plain-language
summary of each and the discovery that led to it.

Deliberately not segment-filtered. Once you are looking at a single visit,
hiding part of it would be actively misleading.

## Diagnostics

**Install health** — events the collector refused, with the reason and the
payload.

Also not segment-filtered, for a different reason: a refused event never became
a row, so it has no session to filter by.

Check this first whenever a report is emptier than expected. It is the
difference between a broken install and a site nobody visited.

## Adding a report

```js
export const topBrands = {
  key: 'top-brands',
  title: 'Top brands',
  blurb: 'Which brands shoppers actually buy.',
  group: 'Products',
  columns: [
    { key: 'brand', label: 'Brand', type: 'text' },
    { key: 'orders', label: 'Orders', type: 'number' },
    { key: 'revenue', label: 'Revenue', type: 'money' }
  ],
  async run(f) {
    const s = scoped(f);
    return {
      rows: await rows(
        `WITH ${s.cte}
         SELECT props->>'brand' AS brand,
                COUNT(*)        AS orders,
                SUM(order_amount) AS revenue
           FROM scoped
          WHERE type = 'order_submit' AND props ? 'brand'
          GROUP BY brand
          ORDER BY revenue DESC
          LIMIT $${s.next}`,
        [...s.params, f.limit]
      )
    };
  }
};
```

Add it to the `REPORTS` array and it appears in the navigation, the catalog
JSON and the end-to-end suite's render walk.

Start from the shared `scoped` CTE so the report honours the same segment
filters as every other one, and parameterise every value — no filter input is
ever interpolated into SQL. Column `type` drives rendering: `text`, `number`,
`money`, `percent`, `date`, `code`.
