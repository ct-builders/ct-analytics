/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * The example storefront.
 *
 * Plain JavaScript, no framework, no build step — the same constraints the
 * tracker itself works under, so this file doubles as proof that instrumenting
 * a site needs nothing more than a script tag and some attributes.
 *
 * Where each of the three integration levels shows up:
 *
 *   Level 1 (script alone) — nothing in this file. The client reports page
 *     views by itself, including on the `pushState` navigations below, and
 *     picks the search term out of `?q=`.
 *
 *   Level 2 (data attributes) — the product cards and filter chips carry
 *     `data-clickstream` attributes. Search for `data-clickstream` here: every one is
 *     in markup, and none has a matching event call in JavaScript.
 *
 *   Level 3 (the API) — only where a click genuinely cannot carry the value:
 *     the result count after a search, the order total, and the sign-in.
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------- catalog */

  var CATALOG = [
    { sku: 'SW-42', key: 'merino-crew',     name: 'Merino Crew Sweater',   category: 'mens/knitwear',  price: 12900, color: 'blue',  size: 'm',  swatch: '#5b7fa6' },
    { sku: 'SW-43', key: 'merino-vneck',    name: 'Merino V-Neck',         category: 'mens/knitwear',  price: 11900, color: 'grey',  size: 'l',  swatch: '#8b9099' },
    { sku: 'SW-44', key: 'lambswool-crew',  name: 'Lambswool Crew',        category: 'mens/knitwear',  price:  9900, color: 'green', size: 's',  swatch: '#6d8a6a' },
    { sku: 'SH-11', key: 'oxford-shirt',    name: 'Oxford Shirt',          category: 'mens/shirts',    price:  8900, color: 'white', size: 'm',  swatch: '#e8eaee' },
    { sku: 'SH-12', key: 'flannel-shirt',   name: 'Brushed Flannel Shirt', category: 'mens/shirts',    price:  9500, color: 'red',   size: 's',  swatch: '#a8524c' },
    { sku: 'JK-31', key: 'quilted-jacket',  name: 'Quilted Jacket',        category: 'mens/outerwear', price: 24900, color: 'green', size: 'l',  swatch: '#4f6152' },
    { sku: 'JK-32', key: 'rain-shell',      name: 'Lightweight Rain Shell',category: 'mens/outerwear', price: 19900, color: 'black', size: 'm',  swatch: '#3a3d42' },
    { sku: 'AC-51', key: 'wool-scarf',      name: 'Lambswool Scarf',       category: 'accessories',    price:  4900, color: 'grey',  size: 'os', swatch: '#9aa0a8' }
  ];

  var CURRENCY = 'USD';

  /* --------------------------------------------------------------- state */

  var cart = [];
  var customer = null;
  /** Facets applied on the current listing, as [{name, value}]. */
  var facets = [];
  var sort = '';

  var view = document.getElementById('view');

  function money(minor) {
    return '$' + (minor / 100).toFixed(2);
  }

  /** A ProductRef in the shape the tracker expects. */
  function ref(p) {
    return {
      sku: p.sku,
      productKey: p.key,
      name: p.name,
      categoryPath: p.category,
      price: { centAmount: p.price, currencyCode: CURRENCY }
    };
  }

  function cartTotal() {
    return cart.reduce(function (n, line) { return n + line.product.price * line.quantity; }, 0);
  }

  function cartCount() {
    return cart.reduce(function (n, line) { return n + line.quantity; }, 0);
  }

  function refreshChrome() {
    document.getElementById('cartcount').textContent = String(cartCount());
    var account = document.getElementById('account');
    if (customer) {
      // Level 2: the sign-out is a pure attribute, with no JavaScript behind
      // it beyond clearing local state.
      account.innerHTML =
        '<span class="meta">' + customer.email + '</span> ' +
        '<a href="#" id="logout" data-clickstream="logout">Sign out</a>';
    } else {
      account.innerHTML = '<a href="/login" data-route="/login">Sign in</a>';
    }
  }

  /* -------------------------------------------------------------- routing */

  /**
   * Navigate with pushState.
   *
   * Nothing here reports a page view: the tracker wraps `pushState` itself and
   * classifies the new URL. That is level 1 doing its job on a single-page
   * site, which is the case most analytics installs get wrong.
   */
  function go(path) {
    history.pushState({}, '', path);
    render();
  }

  document.addEventListener('click', function (ev) {
    var link = ev.target.closest && ev.target.closest('[data-route]');
    if (link) {
      ev.preventDefault();
      go(link.getAttribute('data-route'));
      return;
    }
    var out = ev.target.closest && ev.target.closest('#logout');
    if (out) {
      ev.preventDefault();
      // The `logout` event itself is reported by the data attribute; this only
      // clears the storefront's own state.
      customer = null;
      refreshChrome();
      go('/');
    }
  });

  window.addEventListener('popstate', render);

  document.getElementById('searchbar').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var q = document.getElementById('q').value.trim();
    if (!q) return;
    facets = [];
    sort = '';
    go('/search?q=' + encodeURIComponent(q));
  });

  /* --------------------------------------------------------------- views */

  function matches(p, q) {
    var n = q.toLowerCase();
    return p.name.toLowerCase().indexOf(n) !== -1 ||
      p.key.indexOf(n) !== -1 ||
      p.category.indexOf(n) !== -1 ||
      p.color.indexOf(n) !== -1;
  }

  function applyFacets(list) {
    return list.filter(function (p) {
      return facets.every(function (f) { return String(p[f.name]) === f.value; });
    });
  }

  function applySort(list) {
    var out = list.slice();
    if (sort === 'price-asc') out.sort(function (a, b) { return a.price - b.price; });
    if (sort === 'price-desc') out.sort(function (a, b) { return b.price - a.price; });
    return out;
  }

  /** Compact form of the current selection, for the data attribute. */
  function facetAttr() {
    return facets.map(function (f) { return f.name + ':' + f.value; }).join(',');
  }

  /**
   * A product card.
   *
   * Level 2 in full: the link carries `data-clickstream="result_click"` with the
   * product's identity and its rank, so the click that joins a query to a
   * product is recorded without this file calling the tracker at all.
   */
  function card(p, index) {
    return '' +
      '<a class="card" href="/product/' + p.key + '" data-route="/product/' + p.key + '"' +
      ' data-clickstream="result_click"' +
      ' data-sku="' + p.sku + '"' +
      ' data-product-key="' + p.key + '"' +
      ' data-name="' + p.name + '"' +
      ' data-category-path="' + p.category + '"' +
      ' data-price="' + p.price + '"' +
      ' data-currency="' + CURRENCY + '"' +
      ' data-position="' + (index + 1) + '">' +
      '<div class="swatch" style="background:' + p.swatch + '"></div>' +
      '<div class="name">' + p.name + '</div>' +
      '<div class="price">' + money(p.price) + '</div>' +
      '<div class="meta">' + p.color + ' · size ' + p.size + '</div>' +
      '<div class="rank">rank ' + (index + 1) + '</div>' +
      '</a>';
  }

  /** Filter chips, each one a level-2 facet event. */
  function facetChips(candidates) {
    var groups = { color: [], size: [] };
    candidates.forEach(function (p) {
      if (groups.color.indexOf(p.color) === -1) groups.color.push(p.color);
      if (groups.size.indexOf(p.size) === -1) groups.size.push(p.size);
    });

    var html = '<div class="facets"><span class="label">Filter</span>';
    ['color', 'size'].forEach(function (name) {
      groups[name].forEach(function (value) {
        var on = facets.some(function (f) { return f.name === name && f.value === value; });
        // The *resulting* selection is put on the attribute, so the tracker
        // records the state after the click rather than just the delta.
        var next = on
          ? facets.filter(function (f) { return !(f.name === name && f.value === value); })
          : facets.concat([{ name: name, value: value }]);
        html += '<button class="chip" aria-pressed="' + on + '"' +
          ' data-facet="' + name + ':' + value + '"' +
          ' data-clickstream="' + (on ? 'facet_remove' : 'facet_apply') + '"' +
          ' data-facet-name="' + name + '"' +
          ' data-facet-value="' + value + '"' +
          ' data-facets="' + next.map(function (f) { return f.name + ':' + f.value; }).join(',') + '"' +
          ' data-result-count="' + candidates.filter(function (p) {
            return next.every(function (f) { return String(p[f.name]) === f.value; });
          }).length + '">' + value + '</button>';
      });
    });

    html += '<span class="label">Sort</span>';
    [['', 'Relevance'], ['price-asc', 'Price ↑'], ['price-desc', 'Price ↓']].forEach(function (pair) {
      html += '<button class="chip" aria-pressed="' + (sort === pair[0]) + '"' +
        ' data-sort="' + pair[0] + '"' +
        (pair[0] ? ' data-clickstream="sort_change" data-sort-value="' + pair[0] + '"' : '') +
        '>' + pair[1] + '</button>';
    });
    return html + '</div>';
  }

  // Filter and sort chips change local state; the events themselves come from
  // the attributes above.
  document.addEventListener('click', function (ev) {
    var chip = ev.target.closest && ev.target.closest('.chip');
    if (!chip) return;

    if (chip.hasAttribute('data-facet')) {
      var parts = chip.getAttribute('data-facet').split(':');
      var name = parts[0];
      var value = parts[1];
      var on = facets.some(function (f) { return f.name === name && f.value === value; });
      facets = on
        ? facets.filter(function (f) { return !(f.name === name && f.value === value); })
        : facets.concat([{ name: name, value: value }]);
      render({ skipDiscovery: true });
      return;
    }
    if (chip.hasAttribute('data-sort')) {
      sort = chip.getAttribute('data-sort');
      render({ skipDiscovery: true });
    }
  }, false);

  function listing(title, subtitle, candidates) {
    var shown = applySort(applyFacets(candidates));
    view.innerHTML =
      '<h1>' + title + '</h1>' +
      '<p class="sub">' + subtitle + '</p>' +
      facetChips(candidates) +
      (shown.length
        ? '<div class="grid">' + shown.map(card).join('') + '</div>'
        : '<div class="empty"><b>Nothing matches.</b>Try removing a filter.</div>');
    return shown;
  }

  function renderHome() {
    view.innerHTML =
      '<h1>Northaven</h1>' +
      '<p class="sub">Everything on this page is instrumented. Search for something, filter it, ' +
      'open a product and buy it — then read the reports.</p>' +
      '<div class="banner">Try <code>merino</code> for a normal journey, or <code>cashmere</code> ' +
      'to produce a zero-result search.</div>' +
      '<h2>Featured</h2>' +
      '<div class="grid">' + CATALOG.slice(0, 4).map(card).join('') + '</div>';
  }

  function renderSearch(params, opts) {
    var q = params.get('q') || '';
    var candidates = CATALOG.filter(function (p) { return matches(p, q); });
    var shown = listing(
      'Results for “' + q + '”',
      candidates.length + ' item' + (candidates.length === 1 ? '' : 's') + ' found',
      candidates
    );

    // Level 3: only the result count needs the API. The tracker already
    // reported the term from the URL, but it cannot know the total — and
    // without the total, the zero-result report stays empty.
    if (!opts.skipDiscovery) {
      clickstream.search(q, candidates.length, { facets: facets, sort: sort || undefined });
    }
    return shown;
  }

  function renderCategory(path, opts) {
    var candidates = CATALOG.filter(function (p) { return p.category === path; });
    listing(
      path.split('/').pop().replace(/^./, function (c) { return c.toUpperCase(); }),
      path + ' · ' + candidates.length + ' items',
      candidates
    );
    // Level 3 again, and for the same reason: the count.
    if (!opts.skipDiscovery) {
      clickstream.categoryView(path, { resultCount: candidates.length, facets: facets, sort: sort || undefined });
    }
  }

  function renderProduct(key) {
    var p = CATALOG.filter(function (x) { return x.key === key; })[0];
    if (!p) {
      view.innerHTML = '<div class="empty"><b>No such product.</b></div>';
      return;
    }

    view.innerHTML =
      '<div class="pdp">' +
      '<div class="swatch" style="background:' + p.swatch + '"></div>' +
      '<div>' +
      '<h1>' + p.name + '</h1>' +
      '<p class="sub">' + p.category + ' · ' + p.color + ' · size ' + p.size + ' · <code>' + p.sku + '</code></p>' +
      '<p style="font-size:22px;font-weight:650">' + money(p.price) + '</p>' +
      '<div class="buy">' +
      '<input type="number" id="qty" min="1" max="9" value="1" aria-label="Quantity">' +
      // Level 2: the add to cart is entirely declarative. The only JavaScript
      // below is the storefront's own basket state.
      '<button data-clickstream="add_to_cart"' +
      ' data-sku="' + p.sku + '"' +
      ' data-product-key="' + p.key + '"' +
      ' data-name="' + p.name + '"' +
      ' data-category-path="' + p.category + '"' +
      ' data-price="' + p.price + '"' +
      ' data-currency="' + CURRENCY + '"' +
      ' data-quantity="1"' +
      ' id="addtocart">Add to cart</button>' +
      '</div>' +
      '<p class="hint" style="margin-top:14px;color:var(--muted)">This button carries no click handler for ' +
      'analytics — the event comes from its <code>data-clickstream</code> attributes.</p>' +
      '</div></div>';

    // Keep the declared quantity in step with the input, so the attribute the
    // tracker reads is always the one the shopper chose.
    var qty = document.getElementById('qty');
    var button = document.getElementById('addtocart');
    qty.addEventListener('input', function () {
      button.setAttribute('data-quantity', String(Math.max(1, parseInt(qty.value, 10) || 1)));
    });
    button.addEventListener('click', function () {
      var quantity = Math.max(1, parseInt(qty.value, 10) || 1);
      var existing = cart.filter(function (l) { return l.product.sku === p.sku; })[0];
      if (existing) existing.quantity += quantity;
      else cart.push({ product: p, quantity: quantity });
      refreshChrome();
      button.textContent = 'Added ✓';
      setTimeout(function () { button.textContent = 'Add to cart'; }, 1200);
    });

    // Level 3: a product view is not a click, so nothing declarative can fire
    // it. The tracker attaches the search or category that led here.
    clickstream.productView(ref(p));
  }

  function renderCart() {
    if (!cart.length) {
      view.innerHTML = '<h1>Your cart</h1><div class="empty"><b>Nothing in the cart.</b>' +
        'Find something first.</div>';
      clickstream.cartView({ itemCount: 0 });
      return;
    }

    view.innerHTML =
      '<h1>Your cart</h1>' +
      '<table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th></th></tr></thead><tbody>' +
      cart.map(function (line) {
        return '<tr><td>' + line.product.name + ' <code>' + line.product.sku + '</code></td>' +
          '<td class="num">' + line.quantity + '</td>' +
          '<td class="num">' + money(line.product.price * line.quantity) + '</td>' +
          // Level 2 once more, for the removal.
          '<td class="num"><button class="ghost remove"' +
          ' data-clickstream="remove_from_cart"' +
          ' data-sku="' + line.product.sku + '"' +
          ' data-name="' + line.product.name + '"' +
          ' data-price="' + line.product.price + '"' +
          ' data-currency="' + CURRENCY + '"' +
          ' data-quantity="' + line.quantity + '"' +
          ' data-remove-sku="' + line.product.sku + '">Remove</button></td></tr>';
      }).join('') +
      '</tbody></table>' +
      '<p style="text-align:right;font-size:18px;font-weight:650;margin-top:14px">Total ' + money(cartTotal()) + '</p>' +
      '<p style="text-align:right"><button id="checkout">Checkout</button></p>';

    view.querySelectorAll('.remove').forEach(function (b) {
      b.addEventListener('click', function () {
        var sku = b.getAttribute('data-remove-sku');
        cart = cart.filter(function (l) { return l.product.sku !== sku; });
        refreshChrome();
        render();
      });
    });

    document.getElementById('checkout').addEventListener('click', function () {
      go('/checkout');
    });

    clickstream.cartView({
      cartTotal: { centAmount: cartTotal(), currencyCode: CURRENCY },
      itemCount: cartCount()
    });
  }

  function renderCheckout() {
    if (!cart.length) {
      go('/cart');
      return;
    }
    view.innerHTML =
      '<h1>Checkout</h1>' +
      '<p class="sub">' + cartCount() + ' item(s) · ' + money(cartTotal()) + '</p>' +
      '<p><button id="pay">Place order</button></p>' +
      '<p class="hint" style="color:var(--muted)">No payment is taken. This exists to fire ' +
      '<code>checkout_start</code>, <code>checkout_step</code> and <code>order_submit</code>.</p>';

    clickstream.checkoutStart({
      cartTotal: { centAmount: cartTotal(), currencyCode: CURRENCY },
      itemCount: cartCount()
    });
    clickstream.checkoutStep('shipping');

    document.getElementById('pay').addEventListener('click', function () {
      clickstream.checkoutStep('payment');
      var total = cartTotal();
      var number = 'A-' + (1000 + Math.floor(Math.random() * 9000));

      // Level 3, and the clearest example of why the API exists: the order
      // number and total are only known once the server has responded, so no
      // attribute could have carried them.
      clickstream.orderSubmit({
        orderNumber: number,
        total: { centAmount: total, currencyCode: CURRENCY },
        itemCount: cartCount(),
        items: cart.map(function (line) { return { product: ref(line.product), quantity: line.quantity }; })
      });

      cart = [];
      refreshChrome();
      go('/order-confirmation?order=' + encodeURIComponent(number));
    });
  }

  function renderConfirmation(params) {
    view.innerHTML =
      '<h1>Order placed</h1>' +
      '<div class="confirm"><b>Thank you.</b> Order <code>' +
      (params.get('order') || '—') + '</code> is confirmed.' +
      '<p style="margin:10px 0 0">The revenue from this order is now attributable back to the search ' +
      'or category that first put each line in the basket. See <b>Revenue by discovery</b>.</p></div>';
  }

  function renderLogin() {
    view.innerHTML =
      '<h1>Sign in</h1>' +
      '<p class="sub">Any email works. Nothing is stored beyond this tab.</p>' +
      '<form class="login" id="loginform">' +
      '<input type="email" id="email" placeholder="you@example.com" value="jen@example.com" required>' +
      '<input type="password" id="password" placeholder="Password" value="123" required>' +
      '<button type="submit">Sign in</button>' +
      '</form>';

    document.getElementById('loginform').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var email = document.getElementById('email').value.trim();
      customer = { id: 'c-' + email.split('@')[0], email: email };

      // Level 3: a sign-in carries an identity the tracker then applies to
      // every later event in the session.
      clickstream.login({ customerId: customer.id, customerRef: customer.email, method: 'password' });
      refreshChrome();
      go('/');
    });
  }

  /* -------------------------------------------------------------- render */

  function render(opts) {
    opts = opts || {};
    var path = location.pathname;
    var params = new URLSearchParams(location.search);

    if (path === '/' || path === '') renderHome();
    else if (path === '/search') renderSearch(params, opts);
    else if (path.indexOf('/category/') === 0) renderCategory(path.slice('/category/'.length), opts);
    else if (path.indexOf('/product/') === 0) renderProduct(path.slice('/product/'.length));
    else if (path === '/cart') renderCart();
    else if (path === '/checkout') renderCheckout();
    else if (path === '/order-confirmation') renderConfirmation(params);
    else if (path === '/login') renderLogin();
    else view.innerHTML = '<div class="empty"><b>Not found.</b>' + path + '</div>';

    refreshChrome();
  }

  // Session-wide dimensions, so the reports can segment by them.
  clickstream.identify({ store: 'northaven-us', channel: 'web', locale: 'en-US', currency: CURRENCY });

  render();
})();
