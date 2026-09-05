-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
-- Freely available, AS IS and UNSUPPORTED. See LICENSE.

-- The storage model is one wide events table with typed columns for every
-- dimension a shipped report slices by, and JSONB for the long tail.
--
-- The alternative -- a narrow (type, props JSONB) table -- was rejected on
-- purpose. Every report then becomes a pile of `props->>'x'` casts that no
-- index helps, and nothing stops a site from sending `qty` where the last
-- release sent `quantity`. Typed columns make the schema the contract, and
-- make "top queries last week" an index scan rather than a full sweep.

CREATE TABLE IF NOT EXISTS sites (
  id          BIGSERIAL PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  -- Browser Origins allowed to post events. Empty means any origin, which is
  -- the right default while wiring a site up and the wrong one for production; the
  -- collector logs a warning while a site has no origins set.
  origins     TEXT[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The durable per-browser identity. A shopper, not a person: nothing here
-- identifies anyone, and a shared machine is one shopper.
CREATE TABLE IF NOT EXISTS shoppers (
  id            BIGSERIAL PRIMARY KEY,
  site_id       BIGINT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  anonymous_id  TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, anonymous_id)
);

-- A visit. The unit every funnel counts, so its boundaries are decided in the
-- browser (a 30-minute inactivity window) rather than inferred here.
CREATE TABLE IF NOT EXISTS sessions (
  id            BIGSERIAL PRIMARY KEY,
  site_id       BIGINT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  shopper_id    BIGINT NOT NULL REFERENCES shoppers (id) ON DELETE CASCADE,
  session_key   TEXT NOT NULL,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_event_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Session dimensions, denormalised so segment filters need no join. Each is
  -- filled from the first event that carries it and then updated when it
  -- changes, which is how a mid-session login lands on the session row.
  store         TEXT,
  channel       TEXT,
  locale        TEXT,
  currency      TEXT,
  customer_id   TEXT,
  customer_ref  TEXT,

  user_agent    TEXT,
  -- Derived from the user agent at ingest. Stored rather than computed per
  -- query because "by device" is on almost every report.
  device        TEXT,
  referrer      TEXT,
  landing_path  TEXT,

  UNIQUE (site_id, session_key)
);

CREATE INDEX IF NOT EXISTS sessions_site_started_idx ON sessions (site_id, started_at DESC);
CREATE INDEX IF NOT EXISTS sessions_shopper_idx      ON sessions (shopper_id);
CREATE INDEX IF NOT EXISTS sessions_customer_idx     ON sessions (site_id, customer_ref)
  WHERE customer_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id          BIGSERIAL PRIMARY KEY,
  site_id     BIGINT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  session_id  BIGINT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  shopper_id  BIGINT NOT NULL REFERENCES shoppers (id) ON DELETE CASCADE,
  type        TEXT NOT NULL,

  -- When it happened in the browser, and when it reached us. Both, because
  -- they disagree: a beacon sent on page hide can arrive minutes later, and a
  -- report ordered by arrival shows a session's events out of order.
  ts          TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Position within its batch. Several events fired in the same millisecond
  -- are common on a listing page, and the funnel depends on their order.
  seq         INTEGER NOT NULL DEFAULT 0,

  -- Page
  path        TEXT,
  page_type   TEXT,
  title       TEXT,
  referrer    TEXT,

  -- Search and listing
  query         TEXT,
  result_count  INTEGER,
  category_path TEXT,
  category_id   TEXT,
  sort          TEXT,
  facet_name    TEXT,
  facet_value   TEXT,
  -- The complete selection at the time of the event, not just the delta.
  facets        JSONB,
  position      INTEGER,

  -- Product
  product_id    TEXT,
  product_key   TEXT,
  sku           TEXT,
  product_name  TEXT,

  -- Money, always in minor units alongside its currency.
  unit_amount   BIGINT,
  currency      TEXT,
  quantity      INTEGER,
  cart_amount   BIGINT,
  item_count    INTEGER,

  -- Checkout and order
  step          TEXT,
  order_id      TEXT,
  order_number  TEXT,
  order_amount  BIGINT,

  -- Identity as of this event
  customer_id   TEXT,
  customer_ref  TEXT,
  login_method  TEXT,

  -- Attribution: how the shopper arrived at this product. Recorded in the
  -- browser, because it is the only place the link is actually known.
  -- discovery_id is TEXT rather than UUID so a hand-rolled integration
  -- sending something else degrades to a useless value instead of a 500.
  discovery_id         TEXT,
  discovery_type       TEXT,
  source_query         TEXT,
  source_category_path TEXT,
  source_position      INTEGER,
  source_facets        JSONB,

  -- Site-specific extras. No shipped report reads this.
  props       JSONB
);

CREATE INDEX IF NOT EXISTS events_site_ts_idx      ON events (site_id, ts DESC);
CREATE INDEX IF NOT EXISTS events_site_type_ts_idx ON events (site_id, type, ts DESC);
CREATE INDEX IF NOT EXISTS events_session_order_idx ON events (session_id, ts, seq);
CREATE INDEX IF NOT EXISTS events_query_idx        ON events (site_id, query)
  WHERE query IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_sku_idx          ON events (site_id, sku)
  WHERE sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_category_idx     ON events (site_id, category_path)
  WHERE category_path IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_facet_idx        ON events (site_id, facet_name, facet_value)
  WHERE facet_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_discovery_idx    ON events (discovery_id)
  WHERE discovery_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_customer_idx     ON events (site_id, customer_ref)
  WHERE customer_ref IS NOT NULL;

-- Order lines, so revenue can be attributed per product. Kept separate rather
-- than as JSONB on the order event: attributing revenue means joining these
-- lines back to the session's own add_to_cart rows to recover the search that
-- sold each one, and that join has to be indexable.
CREATE TABLE IF NOT EXISTS order_items (
  id           BIGSERIAL PRIMARY KEY,
  event_id     BIGINT NOT NULL REFERENCES events (id) ON DELETE CASCADE,
  site_id      BIGINT NOT NULL REFERENCES sites (id) ON DELETE CASCADE,
  session_id   BIGINT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  product_id   TEXT,
  product_key  TEXT,
  sku          TEXT,
  product_name TEXT,
  quantity     INTEGER NOT NULL DEFAULT 1,
  unit_amount  BIGINT,
  currency     TEXT
);

CREATE INDEX IF NOT EXISTS order_items_event_idx   ON order_items (event_id);
CREATE INDEX IF NOT EXISTS order_items_session_idx ON order_items (session_id);
CREATE INDEX IF NOT EXISTS order_items_sku_idx     ON order_items (site_id, sku)
  WHERE sku IS NOT NULL;

-- Rejected events, capped by the retention job. Without this, a site whose
-- markup sends a malformed dimension looks identical to a site nobody visited,
-- and the only symptom is a report that is emptier than it should be.
CREATE TABLE IF NOT EXISTS ingest_errors (
  id         BIGSERIAL PRIMARY KEY,
  site_slug  TEXT,
  event_type TEXT,
  reason     TEXT NOT NULL,
  payload    JSONB,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ingest_errors_ts_idx ON ingest_errors (ts DESC);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
