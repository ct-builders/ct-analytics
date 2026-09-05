/*
 * SPDX-License-Identifier: MIT
 * Copyright (c) 2026 commercetools GmbH and the ct-builders contributors
 * Freely available, AS IS and UNSUPPORTED. See LICENSE.
 */

/**
 * Column sorting, for every table the admin renders.
 *
 * Three things decide the shape of this file.
 *
 * It upgrades the headers into buttons rather than being served headers that
 * are already buttons, so a page whose script did not run offers no control
 * that cannot do anything.
 *
 * It reads `data-sort` in preference to the cell's text, because the admin
 * formats before it renders and `$1,234.56`, `41%` and `2m 4s` all compare
 * wrongly as strings.
 *
 * It travels with its own hash. The admin's policy is `default-src 'none'`,
 * which blocks inline script — deliberately, since every cell on the page
 * began life in a browser payload. Naming this exact script in `script-src`
 * keeps that: the one script the admin ships can run and nothing a report
 * value smuggles in can. The hash is computed from the source rather than
 * written down, so editing the script cannot leave a stale digest behind.
 */

import { createHash } from 'node:crypto';

export const SORT_SCRIPT = `
(function () {
  var collate = new Intl.Collator('en', { numeric: true, sensitivity: 'base' }).compare;

  // An em dash is this admin's "no value"; it sorts as absent, not as text.
  function key(cell) {
    if (!cell) return '';
    var raw = cell.getAttribute('data-sort');
    raw = (raw === null ? cell.textContent : raw).trim();
    return raw === '—' ? '' : raw;
  }

  function sort(table, th, index) {
    var body = table.tBodies[0];
    var list = Array.prototype.slice.call(body.rows);
    var numeric = list.every(function (row) {
      var k = key(row.cells[index]);
      return k === '' || isFinite(Number(k));
    });
    var was = th.getAttribute('aria-sort');
    // A number reads best largest first, a name A to Z.
    var dir = was === 'ascending' ? 'descending'
      : was === 'descending' ? 'ascending'
        : numeric ? 'descending' : 'ascending';
    var sign = dir === 'ascending' ? 1 : -1;

    list.sort(function (a, b) {
      var x = key(a.cells[index]);
      var y = key(b.cells[index]);
      // Rows with nothing in this column stay at the bottom either way, so
      // reversing a sort never buries the rows that do have a value.
      if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
      return sign * (numeric ? Number(x) - Number(y) : collate(x, y));
    });

    var head = table.tHead.rows[0];
    for (var i = 0; i < head.cells.length; i++) head.cells[i].setAttribute('aria-sort', 'none');
    th.setAttribute('aria-sort', dir);

    var frag = document.createDocumentFragment();
    for (var j = 0; j < list.length; j++) frag.appendChild(list[j]);
    body.appendChild(frag);
  }

  var tables = document.querySelectorAll('main table');
  for (var t = 0; t < tables.length; t++) {
    (function (table) {
      if (!table.tHead || !table.tBodies[0] || table.tBodies[0].rows.length < 2) return;
      var head = table.tHead.rows[0];
      for (var c = 0; c < head.cells.length; c++) {
        (function (th, index) {
          var label = th.textContent;
          var button = document.createElement('button');
          button.type = 'button';
          button.textContent = label;
          button.title = 'Sort by ' + label;
          button.addEventListener('click', function () { sort(table, th, index); });
          th.textContent = '';
          th.appendChild(button);
          th.className = th.className ? th.className + ' sortable' : 'sortable';
          th.setAttribute('aria-sort', 'none');
        })(head.cells[c], c);
      }
    })(tables[t]);
  }
})();
`;

/**
 * The `script-src` source expression that lets exactly this script run.
 *
 * A CSP hash is taken over the element's contents as UTF-8 bytes, which is
 * the string above verbatim — so it has to be interpolated into the page
 * without a character's difference either side.
 */
export const SORT_SCRIPT_CSP_HASH = `'sha256-${createHash('sha256')
  .update(SORT_SCRIPT, 'utf8')
  .digest('base64')}'`;
