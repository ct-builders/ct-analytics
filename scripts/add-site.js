/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Register a site, or update one.
 *
 * A site must exist before the collector will accept its events — an unknown
 * slug is refused with a 404, because it is almost always a typo in a script
 * tag and silently accepting it produces an empty report with no explanation.
 *
 *   npm run site:add -- --slug acme --name "Acme Storefront" \
 *     --origins https://acme.example,https://www.acme.example
 */

import { closePool, query } from '../apps/server/src/db.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const slug = arg('slug');
if (!slug) {
  console.error('usage: npm run site:add -- --slug <slug> [--name <name>] [--origins a,b] [--inactive]');
  process.exit(1);
}

const name = arg('name', slug);
const origins = arg('origins', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const active = !process.argv.includes('--inactive');

try {
  const r = await query(
    `INSERT INTO sites (slug, name, origins, active)
          VALUES ($1, $2, $3, $4)
     ON CONFLICT (slug) DO UPDATE
        SET name = EXCLUDED.name,
            origins = EXCLUDED.origins,
            active = EXCLUDED.active
      RETURNING id, slug, name, origins, active`,
    [slug, name, origins, active]
  );
  const site = r.rows[0];
  console.log(`[clickstream] site ${site.slug} (${site.name}) ${active ? 'active' : 'INACTIVE'}`);
  console.log(
    site.origins.length
      ? `[clickstream]   origins: ${site.origins.join(', ')}`
      : '[clickstream]   origins: any (fine while wiring a site up; set --origins before production)'
  );
  console.log(`[clickstream]   <script src="https://YOUR-COLLECTOR/c.js?site=${site.slug}" defer></script>`);
} catch (err) {
  console.error(`[clickstream] could not register site: ${err.message}`);
  process.exitCode = 1;
} finally {
  await closePool();
}
