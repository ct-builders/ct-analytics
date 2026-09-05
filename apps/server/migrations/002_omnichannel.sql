-- SPDX-License-Identifier: MIT
-- Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
-- Freely available, AS IS and UNSUPPORTED. See LICENSE.

-- Omnichannel: how an order reaches the shopper, and which store is involved.
--
-- These are typed columns rather than entries in `props` for the usual reason
-- — a report slices by them — but also because they answer the question an
-- omnichannel programme is actually judged on: how much of the business the
-- store network is carrying. That has to be indexable at both levels the
-- business reads it, per store and in aggregate.
--
-- `location_key` is deliberately NOT the same thing as `sessions.store`.
-- `sessions.store` is the sales channel or market a visit belongs to; this is
-- the physical place a shopper chose to collect from. A shopper on the US
-- channel picking up in Brooklyn has both, and one column cannot hold them.

ALTER TABLE events ADD COLUMN IF NOT EXISTS fulfillment   TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS location_key  TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS location_name TEXT;

-- Order lines carry it too: a mixed basket can ship one line and hold another
-- for collection, and per-line revenue attribution has to follow that split.
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS fulfillment  TEXT;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS location_key TEXT;

-- Aggregate: the fulfilment mix over a date range.
CREATE INDEX IF NOT EXISTS events_fulfillment_idx
  ON events (site_id, fulfillment, ts DESC)
  WHERE fulfillment IS NOT NULL;

-- Per store: one location's funnel, which is how a regional manager reads it.
CREATE INDEX IF NOT EXISTS events_location_idx
  ON events (site_id, location_key, ts DESC)
  WHERE location_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS order_items_location_idx
  ON order_items (site_id, location_key)
  WHERE location_key IS NOT NULL;
