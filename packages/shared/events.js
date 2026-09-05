/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The event taxonomy — the contract between the browser and the collector.
 *
 * The set is closed. Free-form event names plus an untyped property bag
 * produce data nobody can report on, because nothing guarantees that `search`
 * events carry a query or that `add_to_cart` events carry a price. A closed
 * set means the collector can reject a malformed event at the door and say
 * why, instead of storing it and leaving a hole in a report three weeks later.
 *
 * The escape hatch for genuinely site-specific dimensions is `props`, which
 * every event carries. Anything a report slices by earns a real field instead.
 */

/**
 * How an order reaches the shopper.
 *
 * An omnichannel storefront's most valuable analytics question is not "how
 * many orders" but "how much of the business is the store network carrying" —
 * and a delivery-only funnel cannot answer it. A closed set, because these
 * five are choices a shopper makes at checkout and a free-form string would
 * fragment the one report that compares them.
 *
 * @typedef {'delivery'|'pickup'|'curbside'|'reserve'|'ship_from_store'} Fulfillment
 */

/**
 * A physical location, when fulfilment involves one.
 *
 * `key` is what reports group by, so it must be stable; `name` is denormalised
 * for display so a report needs no store lookup.
 *
 * Deliberately not the same field as `context.store`, which is the sales
 * channel or market a session belongs to. A shopper on the US channel
 * collecting in Brooklyn has both, and collapsing them makes each unusable.
 *
 * @typedef {{ key: string, name?: string }} StoreLocation
 */

/** @typedef {'home'|'search'|'category'|'product'|'cart'|'checkout'|'order_confirmation'|'account'|'login'|'other'} PageType */

/**
 * Money in minor units, matching the commercetools centAmount convention.
 * Never a float: 19.99 in binary floating point, summed across ten thousand
 * line items, does not equal what the order says it does — and a revenue
 * report that disagrees with the orders is worse than no revenue report.
 *
 * @typedef {{ centAmount: number, currencyCode: string, fractionDigits?: number }} Money
 */

/**
 * A product, identified as loosely as the site can manage. One of the three
 * identifiers is required; which one does not matter, because sites differ.
 *
 * @typedef {{ productId?: string, productKey?: string, sku?: string,
 *             name?: string, categoryPath?: string, price?: Money }} ProductRef
 */

/** @typedef {{ name: string, value: string }} FacetSelection */

/**
 * How a shopper arrived at a product — what makes "which search sold this"
 * answerable. Filled in by the browser client, which is the only place the
 * link is actually known.
 *
 * @typedef {{ discoveryId?: string,
 *             discoveryType?: 'search'|'category'|'direct'|'recommendation',
 *             query?: string, categoryPath?: string,
 *             facets?: FacetSelection[], position?: number }} Attribution
 */

/** Every event type, in funnel order. Drives validation and the admin filters. */
export const EVENT_TYPES = [
  'page_view',
  'search',
  'category_view',
  'facet_apply',
  'facet_remove',
  'sort_change',
  'result_click',
  'product_view',
  'add_to_cart',
  'remove_from_cart',
  'cart_view',
  'checkout_start',
  'checkout_step',
  'order_submit',
  'login',
  'logout'
];

/** Coarse page classification, so reports group without parsing URLs. */
export const PAGE_TYPES = [
  'home',
  'search',
  'category',
  'product',
  'cart',
  'checkout',
  'order_confirmation',
  'account',
  'login',
  'other'
];

/**
 * The funnel, in order, as the event types that satisfy each step.
 *
 * Both the funnel report and its drop-off arithmetic read this, so the funnel
 * is defined exactly once. A step is satisfied by any of its types: a shopper
 * who browses a category rather than searching has still discovered something.
 */
export const FUNNEL_STEPS = [
  { key: 'discover', label: 'Discover', types: ['search', 'category_view'] },
  { key: 'product', label: 'View product', types: ['product_view'] },
  { key: 'cart', label: 'Add to cart', types: ['add_to_cart'] },
  { key: 'checkout', label: 'Checkout', types: ['checkout_start'] },
  { key: 'order', label: 'Order', types: ['order_submit'] }
];

/** Human labels for event types, used in the admin. */
export const EVENT_LABELS = {
  page_view: 'Page view',
  search: 'Search',
  category_view: 'Category browse',
  facet_apply: 'Filter applied',
  facet_remove: 'Filter removed',
  sort_change: 'Sort changed',
  result_click: 'Result clicked',
  product_view: 'Product viewed',
  add_to_cart: 'Added to cart',
  remove_from_cart: 'Removed from cart',
  cart_view: 'Cart viewed',
  checkout_start: 'Checkout started',
  checkout_step: 'Checkout step',
  order_submit: 'Order submitted',
  login: 'Signed in',
  logout: 'Signed out'
};

/** Event types that carry a product, and so participate in attribution. */
export const PRODUCT_EVENTS = ['result_click', 'product_view', 'add_to_cart', 'remove_from_cart'];

/** The closed set of fulfilment methods, in rough order of store involvement. */
export const FULFILLMENTS = ['delivery', 'pickup', 'curbside', 'reserve', 'ship_from_store'];

/** Human labels, used in the admin. */
export const FULFILLMENT_LABELS = {
  delivery: 'Ship to me',
  pickup: 'Pick up in store',
  curbside: 'Curbside',
  reserve: 'Reserve in store',
  ship_from_store: 'Shipped from store'
};

/**
 * Fulfilment methods the store network carries.
 *
 * Reports use this to separate "revenue a store touched" from plain delivery,
 * which is the number an omnichannel programme is judged on.
 */
export const STORE_FULFILLMENTS = ['pickup', 'curbside', 'reserve', 'ship_from_store'];

/** Event types that may carry a fulfilment choice and a location. */
export const FULFILLMENT_EVENTS = [
  'add_to_cart',
  'remove_from_cart',
  'cart_view',
  'checkout_start',
  'checkout_step',
  'order_submit'
];
