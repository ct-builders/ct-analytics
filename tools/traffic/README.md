# Traffic generator

Generates shopper traffic against a storefront. It does two jobs from one
behaviour model.

**Seeding.** Give a storefront's analytics a believable past, so a walkthrough opens
on inhabited reports instead of empty ones. Weeks of history in under a minute.

```bash
CLICKSTREAM_INGEST_KEY=… node tools/traffic/run.js \
  --profile thegoodstore --sessions 400 --days 45 \
  --endpoint https://your-collector.example/collect
```

**Verifying.** Drive a real browser through the real storefront, then check
that what the tracking captured matches what the shopper was told to do.

```bash
node tools/traffic/run.js --profile thegoodstore --mode browser --sessions 12 \
  --target https://your-store.example

CLICKSTREAM_GATE_PASSWORD=… node tools/traffic/reconcile.js \
  --log tools/traffic/log/<run>.jsonl --admin https://your-admin.example
```

Start with `--dry-run`. It prints the persona mix, the funnel that mix implies,
and one sample session translated into events — and writes nothing.

## How it fits together

```
personas ──► behaviour model ──► intent script ──┬──► synth driver ──► collector
                                                 │      (fast, backfilled)
                                                 └──► browser driver ──► real storefront
                                                        (slow, genuinely end to end)
                                    │
                                    └──► action log ──► reconcile.js
                                          (ground truth)
```

The behaviour model produces an **intent script** — "search for sofa", "click
result 3", "add to cart" — and nothing else. It knows about shoppers; it knows
nothing about HTTP, Playwright, CSS selectors or the event taxonomy.

That separation is the whole design:

- **Seeded and live data are the same shape.** A run can backfill six weeks of
  history and then generate live traffic on top of it without the join showing,
  because both came from the same scripts.
- **The accuracy check is exact, not statistical.** The script says the shopper
  clicked result 3, so `source_position` either says 3 or the tracking is
  wrong. Nothing is inferred from timing or ordering.

## Why personas rather than one funnel dice-roll

The funnel is an *outcome* of the persona mix.

A uniform "40% of sessions add to cart" rule produces a tidy funnel and a
Sessions report full of identical-looking visits — open any one and it is
obviously synthetic. Real traffic is a mixture: most visitors never intended to
buy, a few arrived knowing the SKU. Mixtures are what make session journeys
read like people.

| Persona | Share | What it exercises |
|---|---|---|
| Lands and leaves | 30% | The single-page-view path. The largest group on any real store, and the one synthetic data usually omits — which is why synthetic conversion rates look wrong |
| Window shopping | 26% | Category browsing, some filtering, rarely buys |
| Comparing carefully | 18% | Deep browsing, heavy filtering and sorting, hits the catalog's edges so produces most zero-result searches |
| Came to buy | 14% | Short funnel, high conversion |
| Signed-in regular | 12% | Identity across sessions, multi-unit baskets |

`--dry-run` prints the funnel this mix implies. Tune the weights in
`lib/personas.js` to hit a different conversion rate.

## Omnichannel

Where a profile lists `stores`, a session that commits to a basket may choose a
store-fulfilled method instead of delivery — and the method is drawn from what
that store actually offers, so the reports never show a location taking
curbside orders it cannot fulfil. Someone will read a row in front of an audience and ask.

`storeFulfillmentRate` in the profile controls how much of the business the
store network carries. The **Fulfilment mix** report is the aggregate; **Store
performance** is the same business split by where it landed.

## Determinism

Same `--seed`, same data. A dataset that looked right yesterday looks
identical today.

Sessions get their own derived seed rather than sharing one generator, because
the drivers run concurrently and sharing would make the output depend on
scheduling order.

## Adding a store

One JSON file in `profiles/`. Nothing in the model or the drivers is
store-specific.

A profile holds the catalog, the search terms that match it, the terms that
deliberately do not, categories, facets, URL shapes, CSS selectors, and
optionally the store network. What it does **not** hold is a hostname — the
target always comes from `--target` or `CLICKSTREAM_TARGET_URL`, so one profile
drives a local dev server, a preview deploy and production.

Categories and search terms reference products by SKU rather than repeating
them. A dangling SKU is an error, not a filtered-out row: it would silently
shrink a result list and skew every rank in the reports.

## The action log

One JSON line per session, in `log/`, holding what the shopper was instructed
to do and what the driver reports it did. This is the ground truth
`reconcile.js` reads — comparing captured events against other captured events
would prove nothing.

JSONL so a long run can be tailed while it is still going, and so a crash
leaves every completed line readable.

## What reconcile.js reports

Three classes, in descending severity:

| Class | Means |
|---|---|
| `missing-session` | A whole visit never arrived. Ingest, auth, or the client failing to load |
| `missing-events` | The session arrived but is short of a step. An un-instrumented call site, or an event lost on navigation |
| `wrong-field` | The event arrived carrying the wrong value. The most dangerous class, because the reports look populated and are subtly untrue |
| `extra-events` | More than the script asked for. Usually double-counting |

It reads the data through the admin's gated `/api/session-events`, as a client
of the same gate a person uses. There is no back door for it, and the database
needs no public access.

Exit code is 0 when everything reconciles, 1 when there are findings, 2 on a
failure to run — so it can gate a scheduled job.

## Flags

```
--profile <id>        store profile (default thegoodstore)
--mode synth|browser  synth posts events directly; browser drives a real page
--sessions <n>        sessions to generate (default 200)
--days <n>            spread history over this many days (default 30, synth only)
--seed <n>            PRNG seed (default 20260905)
--concurrency <n>     parallel sessions (default 8)
--customers <n>       signed-in customer pool size (default 12)
--target <url>        storefront base URL (browser mode)
--endpoint <url>      collector /collect URL (synth mode)
--log <path>          action log path
--loop                keep generating at --rate-per-minute until stopped
--headed              show the browser (browser mode)
--dry-run             print the plan, write nothing
--quiet               summary only
```

`CLICKSTREAM_INGEST_KEY` is required in synth mode — ingest is authenticated.
