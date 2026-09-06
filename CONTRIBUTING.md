# Contributing

ct-analytics is unsupported reference code. Contributions are welcome but may not be
reviewed promptly, and forking is a perfectly good outcome.

## Ground rules

**No build step, and no browser dependencies.** `packages/browser/clickstream.js`
is one plain JavaScript file that runs as a classic script tag. That constraint
is the feature — it is what lets the client drop into a site whose frontend you
do not control. A change that requires bundling, transpiling, or npm-installing
anything into the browser is out of scope.

**One runtime dependency on the server.** `pg`, and nothing else. Validation is
hand-written rather than schema-library-driven for this reason.

**The taxonomy stays closed.** New event types go in
`packages/shared/events.js` with a validation rule beside them. Site-specific
dimensions belong in `props`, which every event already accepts.

**Typed columns for anything a report reads.** The wide `events` table is
deliberate. A dimension that a report slices by earns a real column and an
index; the JSONB columns are for the long tail only.

## Before opening a pull request

```bash
npm run predeploy
```

That is `npm run typecheck && npm test` — the local gate. There is no CI, so
this is the only thing standing between a change and a broken repository.
Say in the pull request that you ran it.

The type checking is `checkJs` over plain JavaScript with JSDoc. There is no
emit step; the files that ship are the files in the repository.

## Adding a report

One entry in `apps/server/src/reports.js`, exporting `{ key, title, blurb,
group, columns, run(filters) }`. The admin renders it generically, so nothing
else needs to change — no template, no route, no navigation entry.

Start from the shared `scoped` CTE so your report honours the same segment
filters as the others, and parameterise every value. No filter input is ever
interpolated into SQL.

Add it to the end-to-end suite's catalog walk if it needs anything beyond the
generic render — that test already asserts every catalog entry returns 200 over
real data.

## Reporting a security issue

Do not open a public issue. The two areas worth scrutiny are the collect
endpoint, which is exposed to the internet by necessity, and the admin's
rendering of values that originate in browser payloads.
