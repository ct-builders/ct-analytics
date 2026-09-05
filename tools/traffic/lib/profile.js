/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Store profiles.
 *
 * A profile is everything about one storefront that the behaviour model and
 * the drivers need: its catalog, the search terms that actually match it, the
 * terms that deliberately do not, its categories and facets, its URL shapes
 * and — for the browser driver — its CSS selectors.
 *
 * What a profile deliberately does NOT contain is a hostname. The target
 * always comes from `--target` or `CLICKSTREAM_TARGET_URL`, so the same
 * profile drives a local dev server, a preview deploy and production, and so
 * a profile is safe to commit.
 *
 * Adding a store is one JSON file. Nothing in the model or the drivers is
 * store-specific.
 */

import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
export const PROFILE_DIR = join(here, '..', 'profiles');

/** @typedef {{sku: string, slug?: string, name?: string, priceCents?: number,
 *             categoryPath?: string, attrs?: Record<string,string>}} ProfileProduct */

/** @typedef {{id: string, label: string, site: string, context: Record<string,string>,
 *             paths: Record<string,string>, selectors: Record<string,string>,
 *             facets: {name: string, values: string[]}[], sorts: string[],
 *             searchMisses: string[],
 *             categories: {slug: string, name: string, products: ProfileProduct[]}[],
 *             searchTerms: {term: string, products: ProfileProduct[]}[],
 *             products: ProfileProduct[]}} Profile */

export async function listProfiles() {
  const files = await readdir(PROFILE_DIR);
  return files.filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
}

/**
 * Load a profile and resolve its SKU references into product objects.
 *
 * Categories and search terms reference products by SKU rather than
 * repeating them, so a price or a name is stated once. Resolving happens here
 * so neither the model nor the drivers has to care.
 *
 * @param {string} id
 * @returns {Promise<Profile>}
 */
export async function loadProfile(id) {
  let raw;
  try {
    raw = JSON.parse(await readFile(join(PROFILE_DIR, `${id}.json`), 'utf8'));
  } catch (err) {
    const available = (await listProfiles()).join(', ');
    throw new Error(`no profile "${id}" (available: ${available})`);
  }

  const bySku = new Map(raw.products.map((p) => [p.sku, p]));
  const resolve = (skus, where) =>
    (skus || []).map((sku) => {
      const product = bySku.get(sku);
      // A dangling SKU would silently shrink a result list and quietly skew
      // every rank in the reports, so it is an error rather than a filter.
      if (!product) throw new Error(`profile ${id}: ${where} references unknown sku "${sku}"`);
      return product;
    });

  const profile = {
    ...raw,
    categories: (raw.categories || []).map((c) => ({
      ...c,
      products: resolve(c.productSkus, `category "${c.slug}"`)
    })),
    searchTerms: (raw.searchTerms || []).map((t) => ({
      ...t,
      products: resolve(t.productSkus, `search term "${t.term}"`)
    }))
  };

  validate(profile);
  return profile;
}

function validate(p) {
  const problems = [];
  if (!p.site) problems.push('`site` is required — the registered site slug events are recorded under');
  if (!p.products?.length) problems.push('`products` is empty');
  if (!p.searchTerms?.length) problems.push('`searchTerms` is empty — no search would ever be generated');
  if (!p.searchMisses?.length) {
    // Without misses there are no zero-result searches, and the report that
    // is most worth demonstrating stays empty.
    problems.push('`searchMisses` is empty — no zero-result searches would be generated');
  }
  if (!p.categories?.length) problems.push('`categories` is empty');
  for (const required of ['home', 'search', 'category', 'product']) {
    if (!p.paths?.[required]) problems.push(`paths.${required} is required`);
  }
  if (problems.length) {
    throw new Error(`profile ${p.id} is not usable:\n  - ${problems.join('\n  - ')}`);
  }
}

/** Fill `{token}` placeholders in a path template. */
export function pathFor(profile, key, vars = {}) {
  const template = profile.paths[key];
  if (!template) throw new Error(`profile ${profile.id} has no path for "${key}"`);
  return template.replace(/\{(\w+)\}/g, (_, name) =>
    encodeURIComponent(String(vars[name] ?? ''))
  );
}
