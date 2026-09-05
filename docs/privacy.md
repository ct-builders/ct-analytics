# What Commerce Clickstream stores about people

A plain account of the data, and of the decisions the module leaves to you.

## The two identities

**`anonymousId`** — a random opaque id, generated with the browser's own
cryptographic RNG and kept in `localStorage`. It is durable per browser and
answers "has this shopper been here before".

It is not derived from anything about the device, the browser or the person.
There is no fingerprinting: no canvas hashing, no font enumeration, no IP
hashing, no user-agent hashing. A shared machine is one shopper.

**`sessionId`** — a second random id in `sessionStorage`, reset after 30
minutes of inactivity. It is the unit every funnel report counts.

Neither is a cookie, so neither is sent to any other origin, and nothing here
is shared with any third party. There is no third-party pixel, no ad network,
and no data leaves the collector you run.

## What is recorded per event

Page paths and page types, search terms, category paths, facet selections,
sort orders, result positions, product identifiers and names, quantities,
money amounts in minor units, order numbers, and the funnel step each event
represents.

Plus, per session: the user agent string, a device class derived from it
(`mobile` / `tablet` / `desktop`), the referrer, the landing path, and whatever
`store`, `channel`, `locale` and `currency` the site reports.

**The IP address is not stored.** There is no column for it, and the collector
does not read one.

## Customer identity

`customerRef` is whatever the site passes — normally an email address. This is
the only field in the system that identifies a real person, and it is there
only because a site chose to put it there.

Two ways to avoid holding addresses:

**Hash it in the browser.** With `hashCustomerRef=true`, the client SHA-256s
the value before it leaves the page and the collector never receives the
address. Case and surrounding whitespace are normalised first, so one person
hashes to one value however the site happens to hold their address. Reports
still group by shopper; nobody reading them sees an email.

```html
<script src="https://…/c.js?site=acme&hashCustomerRef=true" defer></script>
```

**Pass an internal id instead.** `clickstream.login({ customerId: 'c-1' })` with no
`customerRef` records the sign-in and the shopper without ever naming them.

`clickstream.logout()` records who left, then drops the identity from the session
and clears the browsing context — so nothing after that point is attributed to
the customer who just walked away from a shared machine.

## Retention

**Off by default.** `CLICKSTREAM_RETENTION_DAYS=180` with `npm run retention` on a
schedule deletes events older than the window, then the sessions and shoppers
left with nothing behind them.

It is off by default because how long you keep behavioural data is a decision
about your own commitments, not one a module should make for you. It exists
because a system that records shopper behaviour and never forgets any of it is
a liability rather than an asset.

Deletion runs in batches of 5,000. One `DELETE` over a year of events holds a
lock long enough to stall ingest, and a collector returning errors during the
nightly cleanup loses events permanently, since the browser does not retry.

## Consent

Commerce Clickstream does not ship a consent banner and does not check for one. Whether you
need consent depends on your jurisdiction and on what your site chooses to
report — and the honest position is that the storage itself is first-party and
functional, while `customerRef` is personal data by any reading.

If you gate on consent, the clean way is not to load the script until consent
is given. The API is a no-op with no `site` configured, so a conditional script
tag is enough:

```html
<script>
  if (userHasConsented()) {
    var s = document.createElement('script');
    s.src = 'https://…/c.js?site=acme';
    s.defer = true;
    document.head.appendChild(s);
  }
</script>
```

## Deleting one shopper's data

There is no built-in endpoint for this, because exposing deletion over HTTP on
a service whose collector is internet-facing is a worse default than making it
a deliberate query.

```sql
-- By customer reference, if the site reports one.
DELETE FROM shoppers
 WHERE id IN (SELECT shopper_id FROM sessions WHERE customer_ref = $1);

-- Or by browser id, which `clickstream.identity()` returns in the page.
DELETE FROM shoppers WHERE anonymous_id = $1;
```

`ON DELETE CASCADE` removes that shopper's sessions, events and order lines.

## Access to the reports

The admin renders every shopper's browsing history, so treat it as sensitive.

`CLICKSTREAM_ADMIN_TOKEN` is a shared secret, compared in constant time — enough to
keep the reports off the open internet, and not an identity system. Anything
carrying real traffic should also sit behind your platform's own access layer;
[docs/gcp-setup.md](gcp-setup.md) shows Cloud Run IAM and Identity-Aware Proxy
in front of it.

With no token configured the admin refuses every request rather than serving
openly, so a deploy that forgets the variable fails loudly. `CLICKSTREAM_ADMIN_OPEN=true`
overrides that for a trusted machine.

Every value rendered is HTML-escaped and the pages carry a restrictive
`Content-Security-Policy`, because report cells originate in browser payloads
and are therefore untrusted input.

## What the collector accepts

Until a site lists `origins`, the collector accepts events for it from any
origin. That is convenient while wiring a site up and it is an open door to
anyone who wants to write junk into your reports, so the collector warns about
it on startup and `npm run site:add -- --origins …` closes it.

Bodies are capped at 256 KB, batches at 50 events, and strings at 512
characters — enforced while reading, so an oversized body is refused rather
than buffered first.
