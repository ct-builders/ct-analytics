/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The install stub, for pasting inline into <head>.
 *
 * Its only job is to make `window.clickstream` callable during page parse, before
 * clickstream.js has downloaded. Calls made in that window are recorded and
 * replayed once the real client arrives. Without it, a site that reports a
 * login or an order from inline markup near the top of the page loses the
 * event roughly whenever the network is slow — intermittently, and only in
 * production.
 *
 * Minified, this is under 500 bytes. See docs/install.md for the paste-ready
 * form; this file is the readable original.
 */
/**
 * @param {any} w the `window` the stub installs itself on
 * @param {Document} d
 * @param {string} tag
 * @param {string} src
 */
(function (w, d, tag, src) {
  w.clickstream = w.clickstream || { q: [] };
  var methods = [
    'track', 'pageView', 'search', 'categoryView', 'facetApply', 'facetRemove',
    'sortChange', 'resultClick', 'productView', 'addToCart', 'removeFromCart',
    'cartView', 'checkoutStart', 'checkoutStep', 'orderSubmit', 'login',
    'logout', 'identify', 'flush'
  ];
  for (var i = 0; i < methods.length; i++) {
    (function (m) {
      // Only stub what is missing, so loading the snippet twice — which
      // happens when it lands in both a layout and a page template — cannot
      // replace the real client with a queue that nothing drains.
      if (!w.clickstream[m]) {
        w.clickstream[m] = function () { w.clickstream.q.push([m, arguments]); };
      }
    })(methods[i]);
  }
  var el = /** @type {HTMLScriptElement} */ (d.createElement(tag));
  el.src = src;
  el.defer = true;
  d.head.appendChild(el);
})(/** @type {any} */ (window), document, 'script', 'https://YOUR-COLLECTOR.example/c.js?site=YOUR-SITE');
