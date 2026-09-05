/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Commerce Clickstream — shopper journey capture for ecommerce sites.
 *
 * One file, plain JavaScript, no build step and no dependencies. It runs as a
 * classic script tag, so it drops into a Next.js storefront, a hand-written
 * HTML page, Webflow, or a template you only reach through a CMS field.
 *
 *   <script src="https://your-collector.example/c.js?site=acme" defer></script>
 *
 * There are three levels of integration, and a site can use any mix of them.
 *
 * 1. THE SCRIPT ALONE reports page views, classifying each page from its URL,
 *    and reports a search whenever it finds a search term in the query string.
 *    Single-page navigations are picked up too. No other change to the site.
 *
 * 2. DATA ATTRIBUTES report clicks with no JavaScript at all. Add
 *    `data-clickstream="add_to_cart"` to a button, along with the dimensions the
 *    reports need, and a delegated listener does the rest:
 *
 *      <button data-clickstream="add_to_cart" data-sku="SW-42"
 *              data-quantity="1" data-price="1999" data-currency="USD">
 *
 *    This is the level most sites should reach for, because it survives a
 *    frontend rewrite — the attributes live on the markup, not in a bundle.
 *
 * 3. THE API covers what a click cannot express — an order total known only
 *    after the server responds, or a login. `window.clickstream` is available
 *    immediately, even before this file has finished loading, because the
 *    snippet in docs/install.md installs a queueing stub.
 *
 *      clickstream.orderSubmit({ orderNumber: 'A-1',
 *                            total: { centAmount: 4999, currencyCode: 'USD' } });
 *
 * Three properties matter more than any feature here. It never throws, because
 * this code runs on the add-to-cart path and analytics that can break a
 * checkout is worse than no analytics. It never loses the last event, because
 * the interesting ones are followed immediately by a navigation. And it never
 * blocks rendering.
 */

/**
 * `window` extensions this file reads or installs. Declared once so the rest
 * of the file needs no casts.
 *
 * @typedef {Window & typeof globalThis & {
 *   CLICKSTREAM_CONFIG?: Record<string, any>,
 *   clickstream?: Record<string, any>,
 *   msCrypto?: Crypto
 * }} ClickstreamWindow
 */

(function () {
  'use strict';

  /** @type {ClickstreamWindow} */
  var w = /** @type {any} */ (window);

  /* ---------------------------------------------------------------- config */

  /**
   * Configuration comes from three places, most specific first: a global set
   * before this file loads, the script tag's data attributes, and the script
   * URL's query string. The query string matters most in practice — it is the
   * only one available when the tag is pasted into a CMS field that strips
   * unknown attributes.
   */
  var DEFAULTS = {
    site: '',
    endpoint: '',
    /** Report page views automatically, including on SPA navigations. */
    auto: true,
    /** Watch the query string for a search term. */
    autoSearch: true,
    /** Bind the delegated `data-clickstream` click listener. */
    autoClicks: true,
    /** Queue linger before an automatic send, in milliseconds. */
    flushInterval: 2000,
    /** SHA-256 the customer reference in the browser, never sending the raw value. */
    hashCustomerRef: false,
    /** Query-string keys treated as a search term, in priority order. */
    searchParams: ['q', 'query', 'search', 's', 'keyword'],
    /**
     * How long the automatic search waits for the site to report the same
     * term itself, in milliseconds. See `scheduleAutoSearch`.
     */
    autoSearchDelay: 800,
    /** Log queue activity. */
    debug: false
  };

  var STORAGE_PREFIX = 'clickstream.';
  var SESSION_TIMEOUT_MS = 30 * 60 * 1000;
  var MAX_BATCH = 50;
  var MAX_TRACKED_PRODUCTS = 50;
  var MAX_STRING = 512;

  /** Every event name this file will send. A typo becomes a no-op, not a row. */
  var EVENT_TYPES = {
    page_view: 1, search: 1, category_view: 1, facet_apply: 1, facet_remove: 1,
    sort_change: 1, result_click: 1, product_view: 1, add_to_cart: 1,
    remove_from_cart: 1, cart_view: 1, checkout_start: 1, checkout_step: 1,
    order_submit: 1, login: 1, logout: 1
  };

  var PAGE_TYPES = {
    home: 1, search: 1, category: 1, product: 1, cart: 1, checkout: 1,
    order_confirmation: 1, account: 1, login: 1, other: 1
  };

  var cfg = readConfig();

  function readConfig() {
    var out = {};
    for (var k in DEFAULTS) if (has(DEFAULTS, k)) out[k] = DEFAULTS[k];

    // Least specific: the script URL's query string.
    var el = currentScript();
    if (el && el.src) {
      var qs = queryOf(el.src);
      assign(out, {
        site: qs.site,
        endpoint: qs.endpoint,
        auto: bool(qs.auto),
        autoSearch: bool(qs.autoSearch),
        autoClicks: bool(qs.autoClicks),
        debug: bool(qs.debug),
        hashCustomerRef: bool(qs.hashCustomerRef)
      });
    }

    // Then the tag's own data attributes.
    if (el && el.dataset) {
      assign(out, {
        site: el.dataset.site,
        endpoint: el.dataset.endpoint,
        auto: bool(el.dataset.auto),
        autoSearch: bool(el.dataset.autoSearch),
        autoClicks: bool(el.dataset.autoClicks),
        debug: bool(el.dataset.debug),
        hashCustomerRef: bool(el.dataset.hashCustomerRef)
      });
    }

    // Most specific: an explicit global, for sites that would rather configure
    // in code than in markup.
    var g = w.CLICKSTREAM_CONFIG;
    if (g && typeof g === 'object') for (var j in g) if (has(g, j)) out[j] = g[j];

    // Default the endpoint to the origin that served this file, so the common
    // case needs only `?site=`. A same-origin path still wins when given,
    // because first-party requests survive tracker-blocking extensions.
    if (!out.endpoint) {
      var base = el && el.src ? originOf(el.src) : '';
      out.endpoint = base ? base + '/collect' : '/api/clickstream';
    }
    return out;
  }

  /**
   * `document.currentScript` is null inside a deferred module or when the tag
   * was injected, so fall back to locating our own filename.
   */
  /** @returns {HTMLScriptElement|null} */
  function currentScript() {
    if (document.currentScript) return /** @type {HTMLScriptElement} */ (document.currentScript);
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      var s = all[i].src || '';
      if (s.indexOf('clickstream') !== -1 || /\/j\.js(\?|$)/.test(s)) return all[i];
    }
    return null;
  }

  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  /** Copy only the keys that were actually supplied. */
  function assign(target, src) {
    for (var k in src) {
      if (has(src, k) && src[k] !== undefined && src[k] !== null && src[k] !== '') target[k] = src[k];
    }
  }

  function bool(v) {
    if (v === undefined || v === null || v === '') return undefined;
    return !(v === 'false' || v === '0' || v === false);
  }

  function queryOf(url) {
    var out = {};
    var i = url.indexOf('?');
    if (i === -1) return out;
    var parts = url.slice(i + 1).split('&');
    for (var n = 0; n < parts.length; n++) {
      var kv = parts[n].split('=');
      if (kv[0]) out[decodeURIComponent(kv[0])] = decodeURIComponent((kv[1] || '').replace(/\+/g, ' '));
    }
    return out;
  }

  function originOf(url) {
    var m = /^(https?:\/\/[^/]+)/.exec(url);
    return m ? m[1] : '';
  }

  function log() {
    if (!cfg.debug || !window.console) return;
    try { console.debug.apply(console, ['[clickstream]'].concat([].slice.call(arguments))); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- storage */

  /**
   * Storage access throws outright in some privacy modes — not on write, on
   * access — so each store is probed once and swapped for an in-memory shim
   * when unusable. Attribution then degrades to "direct" and nothing breaks.
   */
  function safeStore(get) {
    try {
      var s = get();
      var probe = STORAGE_PREFIX + 'probe';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) {
      return memoryStore();
    }
  }

  function memoryStore() {
    var map = {};
    return {
      getItem: function (k) { return has(map, k) ? map[k] : null; },
      setItem: function (k, v) { map[k] = String(v); },
      removeItem: function (k) { delete map[k]; }
    };
  }

  var durable = safeStore(function () { return window.localStorage; });
  var perTab = safeStore(function () { return window.sessionStorage; });

  function readJson(store, key) {
    try {
      var raw = store.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }

  function writeJson(store, key, value) {
    try { store.setItem(key, JSON.stringify(value)); } catch (e) { /* quota or private mode */ }
  }

  /* -------------------------------------------------------------- identity */

  /**
   * Cryptographically random id, formatted as a v4 UUID so the collector's
   * UUID columns accept it. Not a fingerprint: nothing here is derived from
   * the device, the browser or the person.
   */
  function randomId() {
    var c = window.crypto || w.msCrypto;
    if (c && c.randomUUID) return c.randomUUID();
    if (c && c.getRandomValues) {
      var b = c.getRandomValues(new Uint8Array(16));
      b[6] = (b[6] & 0x0f) | 0x40;
      b[8] = (b[8] & 0x3f) | 0x80;
      var hex = '';
      for (var i = 0; i < b.length; i++) hex += (b[i] + 0x100).toString(16).slice(1);
      return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' + hex.slice(20);
    }
    // Last resort on a browser with no crypto at all. Still opaque, and the
    // collector only needs uniqueness.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
      var r = (Math.random() * 16) | 0;
      return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  /**
   * Two identities with deliberately different lifetimes. `anonymousId` is
   * durable per browser and answers "has this shopper been here before".
   * `sessionId` resets after an inactivity window and is the unit every funnel
   * counts — without the window, one long-lived tab reads as a single
   * enormous session and every conversion rate is wrong.
   */
  function anonymousId() {
    var key = STORAGE_PREFIX + 'anonymousId';
    try {
      var existing = durable.getItem(key);
      if (existing) return existing;
      var id = randomId();
      durable.setItem(key, id);
      return id;
    } catch (e) {
      // Unstorable: every event looks like a new shopper, which is the honest
      // outcome rather than inventing a stable id we cannot keep.
      return randomId();
    }
  }

  function session() {
    var key = STORAGE_PREFIX + 'session';
    var now = Date.now();
    var stored = readJson(perTab, key);
    var expired = !stored || !stored.id || (now - stored.lastSeen) > SESSION_TIMEOUT_MS;
    var next = expired
      ? { id: randomId(), startedAt: now, lastSeen: now }
      : { id: stored.id, startedAt: stored.startedAt || now, lastSeen: now };
    writeJson(perTab, key, next);
    return { sessionId: next.id, isNewSession: expired };
  }

  /* ----------------------------------------------------------- attribution */

  /**
   * Discovery attribution: answering "which search sold this product".
   *
   * This is the one thing a flat event log cannot recover afterwards. Given
   * rows for search("merino"), facet_apply(color=blue) and add_to_cart(SW-42),
   * a later query can only guess they are related because they sit near each
   * other in one session. That guess breaks as soon as a shopper opens three
   * products in tabs, searches again mid-browse, or arrives from a
   * recommendation strip.
   *
   * So the link is recorded when it is actually known — here, as it happens. A
   * search or category view mints a discovery id, and every product the
   * shopper then touches carries the discovery that led to it, pinned per
   * product rather than per session.
   *
   * State lives in sessionStorage: it survives the full page navigation a
   * server-rendered store does on every click, and dies with the tab, which
   * is the right lifetime for "the search I am shopping from right now".
   */
  var ATTR_KEY = STORAGE_PREFIX + 'attribution';

  function attrState() {
    var s = readJson(perTab, ATTR_KEY) || {};
    return { discovery: s.discovery || null, products: s.products || {}, order: s.order || [] };
  }

  /**
   * Identity used to pin attribution to a product. Prefers the most specific
   * identifier available, and must agree across result_click, product_view and
   * add_to_cart or the pin misses — which is why the listing fallback exists.
   */
  function productIdentity(p) {
    if (!p) return null;
    if (p.sku) return 'sku:' + p.sku;
    if (p.productKey) return 'key:' + p.productKey;
    if (p.productId) return 'id:' + p.productId;
    return null;
  }

  /**
   * A plain copy of the discovery state. Copied rather than referenced
   * because attribution is immutable once attached: a later facet click must
   * not retroactively rewrite an earlier product's recorded filters.
   */
  function snapshot(d) {
    if (!d) return { discoveryType: 'direct' };
    var out = { discoveryId: d.discoveryId, discoveryType: d.discoveryType };
    if (d.query) out.query = d.query;
    if (d.categoryPath) out.categoryPath = d.categoryPath;
    if (d.facets && d.facets.length) {
      out.facets = [];
      for (var i = 0; i < d.facets.length; i++) {
        out.facets.push({ name: d.facets[i].name, value: d.facets[i].value });
      }
    }
    return out;
  }

  function pin(state, product, attribution) {
    var id = productIdentity(product);
    if (!id) return;
    // Re-insert so the most recently touched product is newest, then evict
    // from the front. A product clicked again moves back to the head.
    var idx = state.order.indexOf(id);
    if (idx !== -1) state.order.splice(idx, 1);
    state.order.push(id);
    state.products[id] = attribution;
    while (state.order.length > MAX_TRACKED_PRODUCTS) {
      delete state.products[state.order.shift()];
    }
  }

  /**
   * Update discovery state from an event and return the attribution to attach.
   *
   * Both jobs happen in one pass because they are order-sensitive: a search
   * must mint its id BEFORE the attribution is read, so the search row carries
   * the id later events join to, while a product view must read state without
   * modifying it.
   */
  function decorate(event) {
    var state = attrState();
    var attribution;
    var dirty = false;

    switch (event.type) {
      case 'search':
        state.discovery = {
          discoveryId: randomId(), discoveryType: 'search',
          query: event.query, facets: event.facets, sort: event.sort
        };
        attribution = snapshot(state.discovery);
        dirty = true;
        break;

      case 'category_view':
        state.discovery = {
          discoveryId: randomId(), discoveryType: 'category',
          categoryPath: event.categoryPath, facets: event.facets, sort: event.sort
        };
        attribution = snapshot(state.discovery);
        dirty = true;
        break;

      case 'facet_apply':
      case 'facet_remove':
        // Facets narrow the listing the shopper is already on; they do not
        // start a new discovery. Holding the id stable is what lets a report
        // show the whole filter sequence that led to one product.
        if (state.discovery) {
          state.discovery.facets = event.facets;
          dirty = true;
        }
        attribution = state.discovery ? snapshot(state.discovery) : undefined;
        break;

      case 'sort_change':
        if (state.discovery) {
          state.discovery.sort = event.sort;
          dirty = true;
        }
        attribution = state.discovery ? snapshot(state.discovery) : undefined;
        break;

      case 'result_click':
        // The definitive link: this product, from this listing, at this rank.
        attribution = snapshot(state.discovery);
        attribution.position = event.position;
        pin(state, event.product, attribution);
        dirty = true;
        break;

      case 'product_view':
      case 'add_to_cart':
      case 'remove_from_cart':
        var id = productIdentity(event.product);
        var pinned = id ? state.products[id] : null;
        if (pinned) {
          attribution = pinned;
        } else {
          // No pin: either the site does not mark up its result links, or the
          // shopper arrived some other way. The current listing is a weaker
          // but usually correct guess.
          attribution = snapshot(state.discovery);
          if (id && state.discovery) { pin(state, event.product, attribution); dirty = true; }
        }
        break;

      case 'order_submit':
        // Per-product revenue attribution is a join in SQL, from the order's
        // items back to this session's own add_to_cart rows. So the order
        // event records only how the shopper was browsing when they ordered.
        attribution = snapshot(state.discovery);
        break;

      default:
        attribution = undefined;
    }

    if (dirty) writeJson(perTab, ATTR_KEY, state);
    return attribution;
  }

  function resetAttribution() {
    try { perTab.removeItem(ATTR_KEY); } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------------- hashing */

  var HEX = [];
  for (var h = 0; h < 256; h++) HEX.push((h + 0x100).toString(16).slice(1));

  /**
   * SHA-256 to lowercase hex, via WebCrypto. Async, so the digest happens on
   * the send path rather than in `track` — keeping every public method
   * synchronous and non-blocking.
   *
   * Normalises case and surrounding space first, so one person hashes
   * identically however the site happens to hold their address.
   */
  function sha256Hex(input, done) {
    var subtle = window.crypto && window.crypto.subtle;
    if (!subtle || typeof TextEncoder === 'undefined') return done(null);
    try {
      var bytes = new TextEncoder().encode(String(input).trim().toLowerCase());
      var p = subtle.digest('SHA-256', bytes);
      // Older WebKit exposed a callback-style CryptoOperation rather than a
      // promise; treating that as a promise silently never resolves.
      if (!p || typeof p.then !== 'function') return done(null);
      p.then(function (buf) {
        var view = new Uint8Array(buf);
        var out = '';
        for (var i = 0; i < view.length; i++) out += HEX[view[i]];
        done(out);
      })['catch'](function () { done(null); });
    } catch (e) { done(null); }
  }

  /* ----------------------------------------------------------------- queue */

  var queue = [];
  var timer = null;
  var context = {};

  function str(v) {
    if (typeof v !== 'string') return undefined;
    var t = v.replace(/^\s+|\s+$/g, '');
    if (!t) return undefined;
    return t.length > MAX_STRING ? t.slice(0, MAX_STRING) : t;
  }

  function currentPath() {
    try { return location.pathname + location.search; } catch (e) { return undefined; }
  }

  /**
   * Queue one event. Public methods funnel through here, so validation,
   * attribution, stamping and the never-throw guarantee all live in one place.
   */
  function track(event) {
    try {
      if (!event || !EVENT_TYPES[event.type]) { log('ignored unknown event', event); return; }
      if (!cfg.site) { log('no site configured; event dropped'); return; }

      var wire = {};
      for (var k in event) if (has(event, k)) wire[k] = event[k];
      wire.ts = new Date().toISOString();
      if (!wire.path) wire.path = currentPath();
      var attribution = decorate(event);
      if (attribution) wire.attribution = attribution;
      wire.context = shallow(context);

      queue.push(wire);
      log('queued', wire.type, wire);

      // A full batch goes at once; anything else waits briefly for a
      // companion, so a listing page's several events travel in one request.
      if (queue.length >= MAX_BATCH) flush();
      else schedule();
    } catch (e) {
      log('track failed', e);
    }
  }

  function shallow(o) {
    var out = {};
    for (var k in o) if (has(o, k)) out[k] = o[k];
    return out;
  }

  function schedule() {
    if (timer) return;
    timer = setTimeout(function () { timer = null; flush(); }, cfg.flushInterval);
  }

  /**
   * Send everything queued. `beacon` forces navigator.sendBeacon, which is the
   * browser's guaranteed-on-unload channel.
   */
  function flush(beacon) {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!queue.length) return;
    var batch = queue.splice(0, queue.length);

    buildPayload(batch, function (body) {
      if (!body) return;
      if (beacon && navigator.sendBeacon) {
        try {
          navigator.sendBeacon(cfg.endpoint, new Blob([body], { type: 'application/json' }));
          log('beaconed', batch.length);
          return;
        } catch (e) { /* fall through to fetch */ }
      }
      post(body, batch.length);
    });
  }

  function post(body, count) {
    try {
      if (window.fetch) {
        // `keepalive` so the request survives a navigation started right
        // after the call — the add-to-cart and login cases.
        window.fetch(cfg.endpoint, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: body,
          keepalive: true
        })['catch'](function () { log('send failed; batch dropped'); });
      } else {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', cfg.endpoint, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.withCredentials = true;
        xhr.send(body);
      }
      log('sent', count);
    } catch (e) {
      // The collector being down must never surface in the storefront.
      // Events are dropped rather than retried: a retry queue that outlives
      // the page reorders a session's events, and the funnel depends on order.
      log('send threw; batch dropped', e);
    }
  }

  /** Serialize the envelope, hashing the customer reference if configured. */
  function buildPayload(batch, done) {
    var s = session();
    var envelope = {
      site: cfg.site,
      anonymousId: anonymousId(),
      sessionId: s.sessionId,
      events: batch
    };

    if (!cfg.hashCustomerRef) return done(serialize(envelope));

    // Collect the distinct references in this batch, hash each once, then
    // rewrite. One digest per address rather than one per event.
    var refs = {};
    for (var i = 0; i < batch.length; i++) {
      var r = (batch[i].context && batch[i].context.customerRef) || batch[i].customerRef;
      if (r) refs[r] = true;
    }
    var list = Object.keys(refs);
    if (!list.length) return done(serialize(envelope));

    var remaining = list.length;
    var map = {};
    for (var n = 0; n < list.length; n++) {
      (function (raw) {
        sha256Hex(raw, function (digest) {
          // No WebCrypto but hashing was asked for: drop the reference rather
          // than send an address the caller explicitly wanted withheld.
          map[raw] = digest || undefined;
          if (--remaining === 0) {
            for (var m = 0; m < batch.length; m++) {
              var e = batch[m];
              if (e.context && e.context.customerRef) e.context.customerRef = map[e.context.customerRef];
              if (e.customerRef) e.customerRef = map[e.customerRef];
            }
            done(serialize(envelope));
          }
        });
      })(list[n]);
    }
  }

  function serialize(o) {
    try { return JSON.stringify(o); } catch (e) { return null; }
  }

  /* ------------------------------------------------------------ public API */

  function money(centAmount, currencyCode, fractionDigits) {
    var amount = typeof centAmount === 'number' ? centAmount : parseInt(centAmount, 10);
    if (isNaN(amount) || !currencyCode) return undefined;
    var m = { centAmount: amount, currencyCode: String(currencyCode).toUpperCase() };
    if (fractionDigits !== undefined && fractionDigits !== null && fractionDigits !== '') {
      var fd = parseInt(fractionDigits, 10);
      if (!isNaN(fd)) m.fractionDigits = fd;
    }
    return m;
  }

  var api = {
    /** Report any event in the taxonomy. Typed helpers below call this. */
    track: track,

    pageView: function (pageType, extra) {
      var e = { type: 'page_view', pageType: PAGE_TYPES[pageType] ? pageType : 'other' };
      if (extra) for (var k in extra) if (has(extra, k)) e[k] = extra[k];
      if (!e.title && typeof document !== 'undefined') e.title = document.title || undefined;
      if (!e.referrer && typeof document !== 'undefined') e.referrer = document.referrer || undefined;
      track(e);
    },

    search: function (query, resultCount, extra) {
      var e = { type: 'search', query: str(query) };
      // Remember it, so the automatic query-string path yields rather than
      // reporting the same search again. The two integration levels are meant
      // to be mixable, and a site calling search() to supply the result count
      // is the normal case, not an edge one.
      if (e.query) {
        lastReportedSearch = { query: e.query, path: currentPath() };
        if (autoSearchPending && autoSearchPending.query === e.query) {
          lastAutoSearch = e.query;
          autoSearchPending = null;
        }
      }
      // Omitted, never defaulted to zero: `result_count = 0` is what the
      // zero-result report counts, and inventing it for a caller who simply
      // does not know the total would fabricate demand the catalog met fine.
      var count = intOrUndef(resultCount);
      if (count !== undefined) e.resultCount = count;
      if (extra) for (var k in extra) if (has(extra, k)) e[k] = extra[k];
      if (e.query) track(e);
    },

    categoryView: function (categoryPath, extra) {
      var e = { type: 'category_view', categoryPath: str(categoryPath) };
      if (extra) for (var k in extra) if (has(extra, k)) e[k] = extra[k];
      if (e.categoryPath) track(e);
    },

    facetApply: function (facet, facets, resultCount) {
      track({ type: 'facet_apply', facet: facet, facets: facets || [], resultCount: intOrUndef(resultCount) });
    },

    facetRemove: function (facet, facets, resultCount) {
      track({ type: 'facet_remove', facet: facet, facets: facets || [], resultCount: intOrUndef(resultCount) });
    },

    sortChange: function (sort, previousSort) {
      track({ type: 'sort_change', sort: str(sort), previousSort: str(previousSort) });
    },

    resultClick: function (product, position) {
      track({ type: 'result_click', product: product, position: intOr(position, 0) });
    },

    productView: function (product) { track({ type: 'product_view', product: product }); },

    addToCart: function (product, quantity, cartTotal) {
      track({ type: 'add_to_cart', product: product, quantity: intOr(quantity, 1), cartTotal: cartTotal });
    },

    removeFromCart: function (product, quantity, cartTotal) {
      track({ type: 'remove_from_cart', product: product, quantity: intOr(quantity, 1), cartTotal: cartTotal });
    },

    cartView: function (extra) {
      var e = { type: 'cart_view' };
      if (extra) for (var k in extra) if (has(extra, k)) e[k] = extra[k];
      track(e);
    },

    checkoutStart: function (extra) {
      var e = { type: 'checkout_start' };
      if (extra) for (var k in extra) if (has(extra, k)) e[k] = extra[k];
      track(e);
    },

    checkoutStep: function (step, extra) {
      var e = { type: 'checkout_step', step: str(step) };
      if (extra) for (var k in extra) if (has(extra, k)) e[k] = extra[k];
      track(e);
    },

    orderSubmit: function (order) {
      var e = { type: 'order_submit' };
      if (order) for (var k in order) if (has(order, k)) e[k] = order[k];
      track(e);
      // The confirmation page is usually followed by a redirect, and this is
      // the event the whole system exists to record. Do not wait for a timer.
      flush();
    },

    login: function (customer) {
      var c = customer || {};
      api.identify({ customerId: c.customerId, customerRef: c.customerRef });
      track({ type: 'login', customerId: c.customerId, customerRef: c.customerRef, method: str(c.method) });
      flush();
    },

    logout: function () {
      track({ type: 'logout', customerId: context.customerId, customerRef: context.customerRef });
      // Drop the identity before the queue drains, so nothing after this is
      // attributed to the customer who just left a shared machine.
      delete context.customerId;
      delete context.customerRef;
      flush();
      resetAttribution();
    },

    /** Merge session-wide dimensions: store, channel, locale, currency, customer. */
    identify: function (next) {
      if (!next) return;
      for (var k in next) {
        if (!has(next, k)) continue;
        if (next[k] === undefined || next[k] === null || next[k] === '') delete context[k];
        else context[k] = next[k];
      }
    },

    /** Send everything queued now. */
    flush: function () { flush(); },

    /** Build a Money value in minor units, e.g. money(1999, 'USD'). */
    money: money,

    /** Effective configuration, for debugging an install. */
    config: function () { return shallow(cfg); },

    /** The identities this browser is reporting under. */
    identity: function () {
      var s = session();
      return { anonymousId: anonymousId(), sessionId: s.sessionId };
    },

    /** Present so a site can feature-detect a real client versus the stub. */
    loaded: true
  };

  function intOr(v, fallback) {
    var n = typeof v === 'number' ? v : parseInt(v, 10);
    return isNaN(n) ? fallback : n;
  }

  function intOrUndef(v) {
    if (v === undefined || v === null || v === '') return undefined;
    var n = intOr(v, NaN);
    return isNaN(n) ? undefined : n;
  }

  /* ------------------------------------------------- auto: page classifying */

  /**
   * Classify a page from its URL. Deliberately conservative: an unrecognised
   * path is `other` rather than a guess, because a mislabelled page type is
   * worse than an unlabelled one — it silently pollutes a funnel denominator.
   *
   * Override per site with CLICKSTREAM_CONFIG.classify, or by calling
   * clickstream.pageView() explicitly and turning `auto` off.
   */
  /** @type {Array<[string, RegExp]>} */
  var PATTERNS = [
    ['order_confirmation', /\/(order-confirmation|thank-?you|receipt|confirmation)(\/|$|\?)/i],
    ['checkout', /\/(checkout|payment|shipping)(\/|$|\?)/i],
    ['cart', /\/(cart|basket|bag)(\/|$|\?)/i],
    ['login', /\/(login|signin|sign-in|register|signup|sign-up)(\/|$|\?)/i],
    ['account', /\/(account|profile|orders|wishlist|my-account)(\/|$|\?)/i],
    ['product', /\/(product|products|p|pdp|item|dp)\//i],
    ['search', /\/(search|results|find)(\/|$|\?)/i],
    ['category', /\/(category|categories|c|collection|collections|shop|catalog)\//i]
  ];

  function classify(path) {
    if (typeof cfg.classify === 'function') {
      try {
        var custom = cfg.classify(path);
        if (custom && PAGE_TYPES[custom]) return custom;
      } catch (e) { /* fall through to the defaults */ }
    }
    var bare = path.split('?')[0].replace(/\/+$/, '');
    // A locale prefix such as /en-us must not make the home page look like a
    // category, so strip one leading language segment before testing empty.
    var delocalized = bare.replace(/^\/[a-z]{2}(-[a-z0-9]{2,4})?(?=\/|$)/i, '');
    if (delocalized === '' || delocalized === '/') return 'home';
    for (var i = 0; i < PATTERNS.length; i++) {
      if (PATTERNS[i][1].test(path)) return PATTERNS[i][0];
    }
    return 'other';
  }

  /** The search term in the current query string, if any. */
  function searchTermFrom(search) {
    var qs = queryOf('?' + String(search || '').replace(/^\?/, ''));
    for (var i = 0; i < cfg.searchParams.length; i++) {
      var v = str(qs[cfg.searchParams[i]]);
      if (v) return v;
    }
    return null;
  }

  var lastAutoPath = null;
  var lastAutoSearch = null;
  /** The most recent search the SITE reported, as {query, path}. */
  var lastReportedSearch = null;
  /** Pending automatic search, cancellable by the site reporting it first. */
  var autoSearchTimer = null;
  var autoSearchPending = null;

  /**
   * Report a page view, and a search when the URL carries a term.
   *
   * Guarded on the path so a re-render or a hash change does not report twice;
   * double-counted page views inflate every denominator in the funnel.
   */
  function autoReport() {
    try {
      var path = currentPath();
      if (path === lastAutoPath) return;
      lastAutoPath = path;

      var pageType = classify(path || '/');
      api.pageView(pageType);

      if (!cfg.autoSearch) return;
      var term = searchTermFrom(location.search);
      // Only on a page that is actually a search results page — a `?q=` on a
      // category page is a filter, not a search.
      if (!term || pageType !== 'search' || term === lastAutoSearch) return;
      scheduleAutoSearch(term, path);
    } catch (e) { log('auto report failed', e); }
  }

  /**
   * Report the URL's search term, unless the site reports it first.
   *
   * The wait exists because the two integration levels have to compose, and
   * they interleave in BOTH directions depending on how the page was reached:
   *
   *   - On a fresh page load, this script runs before the site's own code, so
   *     the automatic report would come first.
   *   - On a `pushState` navigation, the site renders and reports during the
   *     click, and this runs a tick later.
   *
   * Either way, reporting both produces two `search` rows for one search,
   * which doubles every search figure and halves every search-to-cart rate.
   * So the automatic one waits briefly and yields to the site's, which is
   * always the better record because it carries the result count.
   *
   * The delay costs nothing in practice: events batch for two seconds anyway,
   * so both land in the same request.
   */
  function scheduleAutoSearch(term, path) {
    if (autoSearchTimer) clearTimeout(autoSearchTimer);
    autoSearchPending = { query: term, path: path };
    autoSearchTimer = setTimeout(function () {
      autoSearchTimer = null;
      var pending = autoSearchPending;
      autoSearchPending = null;
      if (!pending) return;
      if (lastReportedSearch &&
          lastReportedSearch.query === pending.query &&
          lastReportedSearch.path === pending.path) {
        log('search already reported by the site; not duplicating', pending.query);
        return;
      }
      lastAutoSearch = pending.query;
      // The result count is not knowable from a URL, so it is left absent
      // rather than guessed. A site that wants the zero-result report to work
      // calls clickstream.search(term, count) itself once it knows.
      api.search(pending.query);
    }, cfg.autoSearchDelay);
  }

  /**
   * Single-page navigations. `pushState` and `replaceState` fire no event, so
   * they are wrapped; `popstate` and `hashchange` cover the rest. Reporting is
   * deferred a tick so the framework has committed the new URL first.
   */
  function watchNavigation() {
    var history = window.history;
    if (!history || !history.pushState) return;

    function wrap(name) {
      var original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        var out = original.apply(history, arguments);
        setTimeout(autoReport, 0);
        return out;
      };
    }
    wrap('pushState');
    wrap('replaceState');
    window.addEventListener('popstate', function () { setTimeout(autoReport, 0); });
    window.addEventListener('hashchange', function () { setTimeout(autoReport, 0); });
  }

  /* ---------------------------------------------------- auto: data-clickstream */

  /**
   * Declarative click tracking. A delegated listener on the document reads
   * `data-clickstream` and the dimensions beside it, so a site can be instrumented
   * by editing markup and writing no JavaScript at all — and the
   * instrumentation survives a frontend rewrite, because it lives on the
   * markup rather than in a bundle.
   *
   *   <button data-clickstream="add_to_cart" data-sku="SW-42" data-quantity="1"
   *           data-price="1999" data-currency="USD">Add to cart</button>
   *
   *   <a href="/product/sw-42" data-clickstream="result_click"
   *      data-sku="SW-42" data-position="3">…</a>
   *
   *   <button data-clickstream="facet_apply" data-facet-name="color"
   *           data-facet-value="blue">Blue</button>
   */
  function productFrom(d) {
    var p = {};
    if (d.productId) p.productId = d.productId;
    if (d.productKey) p.productKey = d.productKey;
    if (d.sku) p.sku = d.sku;
    if (d.name) p.name = d.name;
    if (d.categoryPath) p.categoryPath = d.categoryPath;
    var price = money(d.price, d.currency, d.fractionDigits);
    if (price) p.price = price;
    return p;
  }

  /** The facet selection currently applied, if the site publishes it. */
  function facetsFrom(d) {
    if (!d.facets) return [];
    // `color:blue,size:m` — a compact form that fits in one attribute.
    var out = [];
    var parts = String(d.facets).split(',');
    for (var i = 0; i < parts.length; i++) {
      var kv = parts[i].split(':');
      var name = str(kv[0]);
      if (name) out.push({ name: name, value: str(kv.slice(1).join(':')) || '' });
    }
    return out;
  }

  function handleDeclarativeClick(el) {
    var d = el.dataset;
    var type = d.clickstream;
    if (!EVENT_TYPES[type]) { log('unknown data-clickstream value', type); return; }

    switch (type) {
      case 'result_click':
        api.resultClick(productFrom(d), intOr(d.position, 0));
        break;
      case 'product_view':
        api.productView(productFrom(d));
        break;
      case 'add_to_cart':
        api.addToCart(productFrom(d), intOr(d.quantity, 1), money(d.cartTotal, d.currency));
        break;
      case 'remove_from_cart':
        api.removeFromCart(productFrom(d), intOr(d.quantity, 1), money(d.cartTotal, d.currency));
        break;
      case 'facet_apply':
        api.facetApply({ name: str(d.facetName), value: str(d.facetValue) || '' }, facetsFrom(d), intOrUndef(d.resultCount));
        break;
      case 'facet_remove':
        api.facetRemove({ name: str(d.facetName), value: str(d.facetValue) || '' }, facetsFrom(d), intOrUndef(d.resultCount));
        break;
      case 'sort_change':
        api.sortChange(d.sort, d.previousSort);
        break;
      case 'search':
        api.search(d.query, intOr(d.resultCount, 0));
        break;
      case 'category_view':
        api.categoryView(d.categoryPath, { categoryId: d.categoryId, categoryName: d.categoryName });
        break;
      case 'checkout_start':
        api.checkoutStart({ cartTotal: money(d.cartTotal, d.currency), itemCount: intOrUndef(d.itemCount) });
        break;
      case 'logout':
        api.logout();
        break;
      case 'login':
        api.login({ customerId: d.customerId, customerRef: d.customerRef, method: d.method || 'click' });
        break;
      default:
        // Anything else in the taxonomy needs values a click cannot carry
        // (an order total, for one), so it stays an explicit API call.
        log('data-clickstream=' + type + ' needs the API, not an attribute');
    }
  }

  function watchClicks() {
    document.addEventListener('click', function (ev) {
      try {
        // `closest` from the event target, so a click on an icon inside the
        // button still finds the annotated ancestor.
        var target = /** @type {any} */ (ev.target);
        var el = target && target.closest ? target.closest('[data-clickstream]') : null;
        if (el) handleDeclarativeClick(el);
      } catch (e) { log('click handler failed', e); }
    }, true);
  }

  /* ------------------------------------------------------------------ boot */

  /**
   * `pagehide` is the only lifecycle event that reliably fires on iOS Safari,
   * where `beforeunload` and `unload` do not. `visibilitychange` covers the
   * tab-switch case, after which a tab may be frozen and never resumed.
   */
  function watchUnload() {
    window.addEventListener('pagehide', function () { flush(true); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(true);
    });
  }

  /**
   * Adopt anything the install snippet queued before this file arrived, so a
   * call made during page parse is not lost. The stub records calls as
   * [method, args] pairs on `window.clickstream.q`.
   *
   * The stub is passed in rather than read from `window.clickstream`, because by
   * the time this runs the real client has replaced it. Reading the global
   * here is how the replay silently did nothing.
   */
  function drainStub(stub) {
    if (!stub || !stub.q || !stub.q.length) return;
    var pending = stub.q.slice();
    for (var i = 0; i < pending.length; i++) {
      var call = pending[i];
      var method = call && call[0];
      if (typeof api[method] === 'function') {
        try { api[method].apply(api, [].slice.call(call[1] || [])); } catch (e) { log('stub replay failed', method, e); }
      }
    }
    log('replayed ' + pending.length + ' queued call(s)');
  }

  // Capture the stub BEFORE overwriting the global, then replay into the real
  // client.
  var queuedStub = w.clickstream;
  w.clickstream = api;
  drainStub(queuedStub);

  if (!cfg.site) {
    // Loud, because a missing site is the single most common install mistake
    // and everything else about the page looks fine.
    if (window.console && console.warn) {
      console.warn('[clickstream] no site configured — add ?site=<slug> to the script URL. No events will be sent.');
    }
  }

  watchUnload();
  if (cfg.autoClicks) watchClicks();
  if (cfg.auto) {
    watchNavigation();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', autoReport);
    } else {
      autoReport();
    }
  }

  log('ready', cfg);
})();
