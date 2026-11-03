/*
 * invoice-core.js
 * Schema-tolerant helpers for editing Zoho POS "print profile" and
 * "print field details" JSON exports. Works in the browser (window.InvoiceCore)
 * and in Node (module.exports) so it can be unit-tested.
 *
 * Design rules:
 *  - Never drop or reorder keys we don't understand (round-trip safe).
 *  - Never corrupt big numeric IDs (>= 16 digits) that JSON.parse would round.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.InvoiceCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MARK = '__BIGINT__';
  const TOKEN_RE = /PrintModel\.[A-Za-z0-9_.]+/g;

  /* ---------------------------------------------------------------- JSON */

  // Wrap integers with 16+ digits in a marker string so JSON.parse can't round them.
  function protectBigInts(text) {
    let out = '';
    let i = 0;
    const n = text.length;
    let inStr = false;
    while (i < n) {
      const c = text[i];
      if (inStr) {
        out += c;
        if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
        if (c === '"') inStr = false;
        i++;
        continue;
      }
      if (c === '"') { inStr = true; out += c; i++; continue; }
      if (c === '-' || (c >= '0' && c <= '9')) {
        let j = i;
        if (text[j] === '-') j++;
        let k = j;
        while (k < n && text[k] >= '0' && text[k] <= '9') k++;
        if (k === j) { out += c; i++; continue; }
        const next = text[k];
        if (next === '.' || next === 'e' || next === 'E') {
          let m = k;
          while (m < n && /[0-9eE+\-.]/.test(text[m])) m++;
          out += text.slice(i, m);
          i = m;
          continue;
        }
        const digits = text.slice(j, k);
        out += digits.length >= 16 ? '"' + MARK + text.slice(i, k) + '"' : text.slice(i, k);
        i = k;
        continue;
      }
      out += c;
      i++;
    }
    return out;
  }

  function parseJson(text) {
    return JSON.parse(protectBigInts(String(text).replace(/^\uFEFF/, '')));
  }

  function stringifyJson(obj, indent) {
    return JSON.stringify(obj, null, indent == null ? 2 : indent)
      .replace(/"__BIGINT__(-?\d+)"/g, '$1');
  }

  /* -------------------------------------------------------------- values */

  const isPlainObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const isScalar = (v) => v === null || typeof v !== 'object';

  function displayVal(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' && v.startsWith(MARK)) return v.slice(MARK.length);
    return String(v);
  }

  // Convert text typed by a user back into a value of the same "kind" as the old value.
  function setValue(old, txt) {
    if (typeof old === 'boolean') return txt === true || txt === 'true';
    const isBig = typeof old === 'string' && old.startsWith(MARK);
    if (isBig || typeof old === 'number') {
      const t = String(txt).trim();
      if (t === '') return null;
      if (/^-?\d+$/.test(t)) return t.replace('-', '').length >= 16 ? MARK + t : Number(t);
      if (typeof old === 'number' && /^-?\d*\.?\d+(e[+-]?\d+)?$/i.test(t)) return Number(t);
      return txt;
    }
    if (old === null) return txt === '' ? null : txt;
    return txt;
  }

  const toNum = (v) => {
    const n = parseFloat(displayVal(v));
    return Number.isFinite(n) ? n : 0;
  };

  function writeNum(rec, key, num) {
    const v = Math.round(num * 100) / 100;
    rec[key] = typeof rec[key] === 'string' ? String(v) : v;
  }

  /* -------------------------------------------------------------- groups */

  function recsOf(g) {
    if (g.kind === 'array') return g.container;
    if (g.kind === 'map') return Object.values(g.container);
    return [g.container];
  }

  // Find every editable "table" in a JSON document: arrays of objects,
  // objects-of-objects (maps) and plain settings objects.
  function findGroups(rootNode, file) {
    const groups = [];
    const push = (path, kind, container) =>
      groups.push({ id: file + '|' + kind + '|' + (path || '(root)'), file, path: path || '(root)', kind, container });

    (function walk(node, path, depth, inArr) {
      if (depth > 8 || groups.length > 300) return;
      if (Array.isArray(node)) {
        if (node.length && node.every(isPlainObj)) push(path, 'array', node);
        node.slice(0, 60).forEach((el, i) => { if (isPlainObj(el) || Array.isArray(el)) walk(el, path + '[' + i + ']', depth + 1, true); });
        return;
      }
      if (!isPlainObj(node)) return;
      const vals = Object.values(node);
      if (!inArr) {
        if (vals.length >= 2 && vals.every(isPlainObj)) push(path, 'map', node);
        if (vals.filter(isScalar).length >= 3 && depth <= 3) push(path, 'single', node);
      }
      for (const k of Object.keys(node)) walk(node[k], path ? path + '.' + k : k, depth + 1, inArr);
    })(rootNode, '', 0, false);

    const rank = { array: 0, map: 1, single: 2 };
    groups.sort((a, b) =>
      rank[a.kind] - rank[b.kind] ||
      (a.kind === 'array' && b.kind === 'array' ? recsOf(b).length - recsOf(a).length : 0));
    return groups;
  }

  function columnsOf(recs) {
    const cols = [];
    const seen = new Set();
    for (const r of recs) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); cols.push(k); }
    return cols;
  }

  const scalarColumns = (recs) =>
    columnsOf(recs).filter((k) => recs.some((r) => r[k] !== undefined && isScalar(r[k])));

  /* ------------------------------------------------- column auto-detection */

  const BIND_RE = /^(col_?name|column_?name|column|binding|bind|field|field_?name|data_?field|data_?source|source|expression|print_?field|variable)$/i;
  const X_RE = /^(x|left|xpos|x_?pos(ition)?|pos_?x|offset_?x|start_?x|x_?coord(inate)?)$/i;
  const Y_RE = /^(y|top|ypos|y_?pos(ition)?|pos_?y|offset_?y|start_?y|y_?coord(inate)?)$/i;
  const W_RE = /^(w|width|element_?width|w_?size)$/i;
  const H_RE = /^(h|height|element_?height|h_?size)$/i;
  const LABEL_PREF = [/^label$/i, /^caption$/i, /^(display_?name|title|header)$/i, /^text$/i, /^name$/i, /^(value|content)$/i];
  const ID_KEY_RE = /^(id|print_?(field|profile|detail|element)?_?id|field_?id|element_?id|section_?id)$/i;

  function isBindingCol(recs, key) {
    if (!scalarColumns(recs).includes(key)) return false;
    if (BIND_RE.test(key)) return true;
    let n = 0, m = 0;
    for (const r of recs) {
      const v = r[key];
      if (typeof v === 'string' && v) { n++; if (/^PrintModel\./i.test(v)) m++; }
    }
    return n > 0 && m / n >= 0.3;
  }

  function autoConfig(g) {
    const recs = recsOf(g);
    const cols = scalarColumns(recs);
    const pick = (re) => cols.find((k) => re.test(k)) || '';
    let labelKey = '';
    for (const re of LABEL_PREF) { labelKey = pick(re); if (labelKey) break; }
    return {
      bindKey: cols.find((k) => isBindingCol(recs, k)) || '',
      labelKey,
      xKey: pick(X_RE), yKey: pick(Y_RE), wKey: pick(W_RE), hKey: pick(H_RE)
    };
  }

  /* ------------------------------------------------------------- row ops */

  // Next free numeric id for `key`, looking at every record in `pool` so the new
  // id is unique across the whole file, not just inside one section.
  function nextId(pool, key, sample) {
    let max = null;
    for (const r of pool) {
      const s = displayVal(r[key]);
      if (/^\d+$/.test(s)) { const b = BigInt(s); if (max === null || b > max) max = b; }
    }
    if (max === null) return undefined;
    const nxt = (max + 1n).toString();
    if (nxt.length >= 16) return MARK + nxt;
    return typeof sample === 'string' ? nxt : Number(nxt);
  }

  // Deep-copy `src`, giving id-like keys a fresh value. `pool` = all records
  // that may already use ids (defaults to `recs`).
  function cloneRecord(recs, src, pool) {
    const copy = JSON.parse(JSON.stringify(src));
    for (const k of Object.keys(copy)) {
      if (ID_KEY_RE.test(k) && isScalar(copy[k])) {
        const n = nextId(pool || recs, k, copy[k]);
        if (n !== undefined) copy[k] = n;
      }
    }
    return copy;
  }

  /* ---------------------------------------------------------- validation */

  function validate(opts) {
    const { files, groups, cfgOf, catalog, pageW, pageH } = opts;
    const out = [];
    const add = (level, msg) => out.push({ level, msg });
    const names = { profile: 'Print profile', fields: 'Print field details' };

    for (const k of ['profile', 'fields']) {
      if (!files[k].root) { add('error', names[k] + ' file is not loaded.'); continue; }
      try { parseJson(stringifyJson(files[k].root)); }
      catch (e) { add('error', names[k] + ' cannot be written back as valid JSON: ' + e.message); }
    }

    const bind = { profile: new Set(), fields: new Set() };
    const unknown = new Set();
    let rows = 0;

    for (const g of groups) {
      const recs = recsOf(g);
      const c = cfgOf(g);
      if (g.kind === 'array') rows += recs.length;

      if (c.bindKey) {
        let empty = 0;
        for (const r of recs) {
          const raw = r[c.bindKey];
          if (raw !== undefined && !isScalar(raw)) continue;
          const v = displayVal(raw).trim();
          if (!v) { if (raw !== undefined) empty++; continue; }
          for (const m of (v.match(TOKEN_RE) || [])) {
            bind[g.file].add(m);
            if (catalog && !catalog.has(m)) unknown.add(m);
          }
        }
        if (empty && recs.length > 1 && empty < recs.length) {
          add('info', empty + ' row(s) in "' + g.path + '" (' + g.file + ') have no field binding. That is fine for static text, lines or logos.');
        }
      }

      if (g.kind === 'array') {
        for (const k of columnsOf(recs)) {
          if (!ID_KEY_RE.test(k)) continue;
          const seen = new Set();
          const dups = new Set();
          for (const r of recs) {
            const v = displayVal(r[k]);
            if (v === '') continue;
            if (seen.has(v)) dups.add(v);
            seen.add(v);
          }
          if (dups.size) add('warn', 'Duplicate "' + k + '" values in "' + g.path + '" (' + [...dups].slice(0, 5).join(', ') + '). Zoho may reject or overwrite these on import.');
        }
      }

      if (c.xKey && c.yKey && pageW) {
        let over = 0;
        for (const r of recs) {
          const x = toNum(r[c.xKey]), y = toNum(r[c.yKey]);
          const w = c.wKey ? toNum(r[c.wKey]) : 0, h = c.hKey ? toNum(r[c.hKey]) : 0;
          if (x < 0 || y < 0 || x + w > pageW + 0.5 || (pageH && y + h > pageH + 0.5)) over++;
        }
        if (over) add('warn', over + ' element(s) in "' + g.path + '" extend past the page edge for the selected paper size.');
      }
    }

    if (unknown.size) {
      add('warn', 'Bindings not in the built-in POS field list (check spelling): ' + [...unknown].slice(0, 12).join(', ') + (unknown.size > 12 ? ' and ' + (unknown.size - 12) + ' more' : '') + '. Custom fields are fine if your POS defines them.');
    }

    if (bind.profile.size && bind.fields.size) {
      const missing = [...bind.profile].filter((b) => !bind.fields.has(b));
      if (missing.length) add('info', missing.length + ' field(s) used in the profile are not listed in the field details file: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? '...' : ''));
    }

    add('info', groups.length + ' editable section(s) found, ' + rows + ' row(s) in tables.');
    const order = { error: 0, warn: 1, info: 2 };
    return out.sort((a, b) => order[a.level] - order[b.level]);
  }

  /* ----------------------------------------------------------------- ZIP */

  function crc32(buf) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  // Minimal "stored" (uncompressed) ZIP writer. files: [{ name, data:Uint8Array }]
  function makeZipParts(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();

    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, 0, true); lh.setUint16(10, time, true); lh.setUint16(12, date, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, size, true); lh.setUint32(22, size, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true); ch.setUint16(12, time, true);
      ch.setUint16(14, date, true); ch.setUint32(16, crc, true); ch.setUint32(20, size, true);
      ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);

      offset += 30 + name.length + size;
    }

    const cdSize = central.reduce((a, b) => a + b.length, 0);
    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);
    eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
    eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
    return [...parts, ...central, new Uint8Array(eo.buffer)];
  }

  return {
    MARK, TOKEN_RE, ID_KEY_RE,
    protectBigInts, parseJson, stringifyJson,
    isPlainObj, isScalar, displayVal, setValue, toNum, writeNum,
    recsOf, findGroups, columnsOf, scalarColumns, isBindingCol, autoConfig,
    nextId, cloneRecord, validate, crc32, makeZipParts
  };
});
