/* invoice-app.js — UI for the Invoice Template Designer (uses window.InvoiceCore) */
(function () {
  'use strict';
  const IC = window.InvoiceCore;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  const PAGES = {
    a4: { label: 'A4 (210 × 297 mm)', w: 210, h: 297 },
    a5: { label: 'A5 (148 × 210 mm)', w: 148, h: 210 },
    letter: { label: 'Letter (215.9 × 279.4 mm)', w: 215.9, h: 279.4 },
    t80: { label: '80 mm thermal roll', w: 80, h: 200, roll: true },
    t58: { label: '58 mm thermal roll', w: 58, h: 200, roll: true }
  };
  const UNIT_PX = { mm: 3.7795, cm: 37.795, px: 1, pt: 1.3333, in: 96 };
  const UNIT_MM = { mm: 1, cm: 10, px: 0.26458, pt: 0.35278, in: 25.4 };
  const DRAFT_KEY = 'invoiceDesigner.draft.v1';

  const S = {
    files: { profile: blank(), fields: blank() },
    groups: [], cfg: {}, sel: { gid: null, idx: 0 },
    catalog: [], catMap: new Map(),
    view: 'table', side: 'row', filter: '',
    page: 'a4', unit: 'mm', zoom: 1, snap: true, showSample: true, posFilter: '',
    undo: [], redo: []
  };
  function blank() { return { name: '', orig: '', origSnap: '', root: null }; }

  /* ------------------------------------------------------------ helpers */
  function toast(msg, type) {
    const t = h('div', { class: type || '' }, msg);
    $('#toast').append(t);
    setTimeout(() => t.remove(), type === 'err' ? 6000 : 3000);
  }
  const curGroup = () => S.groups.find((g) => g.id === S.sel.gid) || null;
  const cfgOf = (g) => (S.cfg[g.id] = S.cfg[g.id] || IC.autoConfig(g));
  // every record in the same file, so cloned rows get ids unique across the whole file
  const idPool = (g) => S.groups.filter((x) => x.file === g.file && x.kind === 'array').flatMap((x) => x.container);
  const curRec = () => { const g = curGroup(); if (!g) return null; return IC.recsOf(g)[S.sel.idx] || null; };
  const isMod = (k) => !!S.files[k].root && JSON.stringify(S.files[k].root) !== S.files[k].origSnap;

  /* ------------------------------------------------------------ undo/redo */
  function snapshot() {
    return { profile: S.files.profile.root ? JSON.stringify(S.files.profile.root) : null,
             fields: S.files.fields.root ? JSON.stringify(S.files.fields.root) : null };
  }
  function pushUndo() { S.undo.push(snapshot()); if (S.undo.length > 60) S.undo.shift(); S.redo = []; }
  function restore(s) {
    for (const k of ['profile', 'fields']) S.files[k].root = s[k] ? JSON.parse(s[k]) : null;
    rebuild(true);
  }
  function undo() { if (!S.undo.length) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
  function redo() { if (!S.redo.length) return; S.undo.push(snapshot()); restore(S.redo.pop()); }

  // Run a mutation with undo support, then refresh. opts.center=true re-renders the main pane.
  function edit(fn, opts) {
    pushUndo();
    fn();
    afterEdit(opts || {});
  }
  function afterEdit(opts) {
    renderGroups();
    renderChips();
    renderSide();
    if (opts.center) renderCenter();
    autosave();
  }

  /* ------------------------------------------------------------ loading */
  function setFile(kind, name, text, silent) {
    let root;
    try { root = IC.parseJson(text); }
    catch (e) { toast(name + ' is not valid JSON: ' + e.message, 'err'); return false; }
    S.files[kind] = { name, orig: text, root, origSnap: JSON.stringify(root) };
    $('#' + (kind === 'profile' ? 'nameProfile' : 'nameFields')).value = name;
    if (!silent) { S.undo = []; S.redo = []; rebuild(); }
    return true;
  }

  async function handleFiles(fileList, forced) {
    let any = false;
    for (const f of Array.from(fileList)) {
      let kind = forced;
      if (/field/i.test(f.name)) kind = 'fields';
      else if (/profile/i.test(f.name)) kind = 'profile';
      else if (!kind) kind = S.files.profile.root ? 'fields' : 'profile';
      const text = await f.text();
      if (setFile(kind, f.name, text, true)) any = true;
    }
    if (any) { S.undo = []; S.redo = []; rebuild(); }
  }

  async function loadPreset() {
    const id = $('#preset').value;
    if (!id) return;
    try {
      const r = await fetch('/api/invoice-template/' + encodeURIComponent(id));
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Could not load preset');
      const a = setFile('profile', j.profileFileName, j.profileText, true);
      const b = setFile('fields', j.fieldsFileName, j.fieldsText, true);
      if (a && b) { S.undo = []; S.redo = []; rebuild(); toast('Preset loaded.'); }
    } catch (e) { toast(e.message, 'err'); }
  }

  function guessUnit() {
    for (const g of S.groups) {
      if (g.kind !== 'array') continue;
      const c = cfgOf(g);
      if (!c.xKey || !c.yKey) continue;
      let max = 0;
      for (const r of IC.recsOf(g)) max = Math.max(max, IC.toNum(r[c.xKey]) + (c.wKey ? IC.toNum(r[c.wKey]) : 0));
      if (max > 0) return max <= 320 ? 'mm' : 'px';
    }
    return S.unit;
  }

  function rebuild(keepSel) {
    S.groups = [
      ...(S.files.profile.root ? IC.findGroups(S.files.profile.root, 'profile') : []),
      ...(S.files.fields.root ? IC.findGroups(S.files.fields.root, 'fields') : [])
    ];
    // drop stale configs (containers changed on undo) but keep user's column choices by id
    const keep = {};
    for (const g of S.groups) if (S.cfg[g.id]) keep[g.id] = S.cfg[g.id];
    S.cfg = keep;
    if (!S.groups.find((g) => g.id === S.sel.gid)) {
      const first = S.groups.find((g) => g.kind === 'array') || S.groups[0];
      S.sel = { gid: first ? first.id : null, idx: 0 };
    } else if (!keepSel) S.sel.idx = 0;
    if (!keepSel) S.unit = guessUnit();
    const any = !!(S.files.profile.root || S.files.fields.root);
    $('#workspace').hidden = !any;
    $('#exportBar').hidden = !any;
    $('#st1').innerHTML = any ? '1 Load' : '<b>1 Load</b>';
    $('#st2').innerHTML = any ? '<b>2 Edit</b>' : '2 Edit';
    renderChips(); renderGroups(); renderCenter(); renderSide(); autosave();
    if (any && !keepSel) $('#workspace').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ----------------------------------------------------------- rendering */
  function renderChips() {
    for (const k of ['profile', 'fields']) {
      const f = S.files[k], chip = $('#chip-' + k);
      chip.className = 'chip' + (f.root ? ' ok' : '');
      chip.textContent = f.root ? '✔ ' + f.name + (isMod(k) ? '  (edited)' : '') : 'not loaded';
    }
    const mods = ['profile', 'fields'].filter(isMod);
    $('#modState').innerHTML = mods.length ? '<span class="mod">● Unsaved edits in ' + mods.join(' + ') + '</span>' : 'No changes yet';
    $('#undo').disabled = !S.undo.length;
    $('#redo').disabled = !S.redo.length;
  }

  function renderGroups() {
    const box = $('#groups');
    box.replaceChildren();
    if (!S.groups.length) { box.append(h('p', { class: 'muted', style: { padding: '10px' } }, 'No editable tables found in the loaded file(s).')); return; }
    for (const g of S.groups) {
      const n = IC.recsOf(g).length;
      box.append(h('div', { class: 'g' + (g.id === S.sel.gid ? ' on' : ''), onclick: () => { S.sel = { gid: g.id, idx: 0 }; renderGroups(); renderCenter(); renderSide(); } },
        h('span', { class: 'b' }, g.file === 'profile' ? 'P' : 'F'),
        h('span', { class: 'p' }, (g.kind === 'single' ? '⚙ ' : '') + g.path),
        h('span', { class: 'c' }, g.kind === 'single' ? 'settings' : g.kind === 'map' ? n + ' items' : n + ' rows')));
    }
  }

  function renderCenter() {
    const root = $('#center');
    root.replaceChildren();
    const g = curGroup();
    if (!g) { root.append(h('p', { class: 'muted' }, 'Pick a section on the left.')); return; }
    const c = cfgOf(g), recs = IC.recsOf(g);
    root.append(toolbar(g, c, recs), S.view === 'layout' ? layoutView(g, c, recs) : tableView(g, c, recs));
  }

  function toolbar(g, c, recs) {
    const cols = IC.scalarColumns(recs);
    const sel = (key, label) => h('label', {}, label,
      h('select', { onchange: (e) => { c[key] = e.target.value; renderCenter(); } },
        h('option', { value: '' }, '(none)'),
        cols.map((k) => h('option', Object.assign({ value: k }, c[key] === k ? { selected: true } : {}), k))));
    const isArr = g.kind === 'array';
    return h('div', {},
      h('div', { class: 'bar' },
        h('div', { class: 'seg' },
          h('button', { class: S.view === 'table' ? 'on' : '', onclick: () => { S.view = 'table'; renderCenter(); } }, '☰ Table'),
          h('button', { class: S.view === 'layout' ? 'on' : '', onclick: () => { S.view = 'layout'; renderCenter(); } }, '▦ Layout preview')),
        S.view === 'table' ? h('input', { type: 'text', placeholder: 'Filter rows…', value: S.filter, oninput: (e) => { S.filter = e.target.value; renderCenter(); const i = $('#center input[placeholder^="Filter"]'); if (i) { i.focus(); i.setSelectionRange(S.filter.length, S.filter.length); } } }) : null,
        isArr ? h('button', { onclick: () => addRow() }, '＋ Add row') : null,
        h('span', { class: 'muted' }, g.file === 'profile' ? 'Print profile' : 'Field details', ' › ', g.path)),
      h('details', { class: 'map' }, h('summary', {}, 'Column mapping (auto-detected — change if the preview or field picker looks wrong)'),
        h('div', { class: 'mg' }, sel('bindKey', 'POS field binding'), sel('labelKey', 'Label / text'), sel('xKey', 'X position'), sel('yKey', 'Y position'), sel('wKey', 'Width'), sel('hKey', 'Height'))));
  }

  function cellInput(c, r, k) {
    const v = r[k];
    if (typeof v === 'boolean') return h('input', { type: 'checkbox', checked: v, onchange: (e) => edit(() => { r[k] = e.target.checked; }) });
    const inp = h('input', { type: 'text', class: 'cell' + (k === c.bindKey ? ' bind' : ''), value: IC.displayVal(v), onchange: (e) => edit(() => { r[k] = IC.setValue(r[k], e.target.value); }) });
    if (k === c.bindKey) inp.setAttribute('list', 'posfields');
    return inp;
  }

  function tableView(g, c, recs) {
    const cols = IC.scalarColumns(recs);
    const q = S.filter.trim().toLowerCase();
    const isArr = g.kind === 'array';
    const tb = h('tbody');
    let shown = 0, hidden = 0;
    recs.forEach((r, i) => {
      if (q && !JSON.stringify(r).toLowerCase().includes(q)) return;
      if (shown >= 300) { hidden++; return; }
      shown++;
      tb.append(h('tr', { 'data-i': i, class: i === S.sel.idx ? 'sel' : '', onclick: () => selectRow(i) },
        h('td', { class: 'muted' }, i + 1),
        cols.map((k) => h('td', {}, cellInput(c, r, k))),
        h('td', { class: 'act' }, isArr ? [
          h('button', { title: 'Move up', onclick: (e) => { e.stopPropagation(); moveRow(i, -1); } }, '▲'),
          h('button', { title: 'Move down', onclick: (e) => { e.stopPropagation(); moveRow(i, 1); } }, '▼'),
          h('button', { title: 'Duplicate', onclick: (e) => { e.stopPropagation(); dupRow(i); } }, '⧉'),
          h('button', { title: 'Delete', onclick: (e) => { e.stopPropagation(); delRow(i); } }, '🗑')] : null)));
    });
    return h('div', {},
      h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, '#'), cols.map((k) => h('th', {}, k)), h('th', {}, ''))), tb),
      hidden ? h('p', { class: 'muted' }, hidden + ' more rows hidden — use the filter to narrow down.') : null,
      !recs.length ? h('p', { class: 'muted' }, 'This section is empty.') : null);
  }

  function selectRow(i) {
    S.sel.idx = i;
    $$('#center tr[data-i]').forEach((tr) => tr.classList.toggle('sel', +tr.dataset.i === i));
    $$('#center .box').forEach((b) => b.classList.toggle('sel', +b.dataset.i === i));
    renderSide();
  }

  /* ----------------------------------------------------------- row ops */
  function addRow() {
    const g = curGroup(); if (!g || g.kind !== 'array') return;
    if (!g.container.length) { toast('Nothing to copy from — this section is empty.', 'err'); return; }
    dupRow(Math.min(S.sel.idx, g.container.length - 1));
  }
  function dupRow(i) {
    const g = curGroup(); if (!g || g.kind !== 'array') return;
    edit(() => { const copy = IC.cloneRecord(g.container, g.container[i], idPool(g)); g.container.splice(i + 1, 0, copy); S.sel.idx = i + 1; }, { center: true });
  }
  function delRow(i) {
    const g = curGroup(); if (!g || g.kind !== 'array') return;
    if (g.container.length <= 1 && !confirm('This is the last row in this section. Delete it anyway?')) return;
    edit(() => { g.container.splice(i, 1); S.sel.idx = Math.max(0, Math.min(S.sel.idx, g.container.length - 1)); }, { center: true });
  }
  function moveRow(i, d) {
    const g = curGroup(); if (!g || g.kind !== 'array') return;
    const j = i + d; if (j < 0 || j >= g.container.length) return;
    edit(() => { const a = g.container; [a[i], a[j]] = [a[j], a[i]]; S.sel.idx = j; }, { center: true });
  }

  /* ------------------------------------------------------ layout preview */
  function sampleFor(r, c) {
    const raw = c.bindKey ? IC.displayVal(r[c.bindKey]) : '';
    const tok = (raw.match(IC.TOKEN_RE) || [])[0];
    const f = tok && S.catMap.get(tok);
    const label = c.labelKey ? IC.displayVal(r[c.labelKey]) : '';
    if (S.showSample) return f ? f.sample : (label || raw);
    return raw || label;
  }

  function layoutView(g, c, recs) {
    const wrap = h('div');
    const pg = PAGES[S.page];
    wrap.append(h('div', { class: 'bar' },
      h('label', {}, 'Paper ', h('select', { onchange: (e) => { S.page = e.target.value; renderCenter(); } },
        Object.entries(PAGES).map(([k, p]) => h('option', Object.assign({ value: k }, S.page === k ? { selected: true } : {}), p.label)))),
      h('label', {}, 'Units in file ', h('select', { onchange: (e) => { S.unit = e.target.value; renderCenter(); } },
        Object.keys(UNIT_PX).map((u) => h('option', Object.assign({ value: u }, S.unit === u ? { selected: true } : {}), u)))),
      h('label', {}, 'Zoom ', h('input', { type: 'range', min: 0.4, max: 2, step: 0.1, value: S.zoom, oninput: (e) => { S.zoom = +e.target.value; renderCenter(); } })),
      h('label', {}, h('input', Object.assign({ type: 'checkbox', onchange: (e) => { S.snap = e.target.checked; } }, S.snap ? { checked: true } : {})), ' Snap to whole units'),
      h('label', {}, h('input', Object.assign({ type: 'checkbox', onchange: (e) => { S.showSample = e.target.checked; renderCenter(); } }, S.showSample ? { checked: true } : {})), ' Show sample data')));
    if (!c.xKey || !c.yKey) {
      wrap.append(h('p', { class: 'muted' }, 'This section has no position columns, or they were not recognised. Open "Column mapping" above and choose the X and Y columns to see a preview.'));
      return wrap;
    }
    const unitPx = UNIT_PX[S.unit] * S.zoom;
    const paper = h('div', { class: 'paper', style: { width: pg.w * 3.7795 * S.zoom + 'px', height: pg.h * 3.7795 * S.zoom + 'px' } });
    recs.forEach((r, i) => paper.append(makeBox(c, r, i, unitPx)));
    wrap.append(h('div', { class: 'stage' }, paper),
      h('p', { class: 'muted' }, 'Drag to move, drag the corner to resize, arrow keys nudge the selected box (Shift = 10 units). If boxes look the wrong size, change "Units in file".'));
    return wrap;
  }

  function makeBox(c, r, i, unitPx) {
    const hasW = !!c.wKey && r[c.wKey] !== undefined, hasH = !!c.hKey && r[c.hKey] !== undefined;
    const b = h('div', { class: 'box' + (i === S.sel.idx ? ' sel' : ''), 'data-i': i, title: (c.bindKey ? IC.displayVal(r[c.bindKey]) : '') || (c.labelKey ? IC.displayVal(r[c.labelKey]) : '') || 'row ' + (i + 1) },
      sampleFor(r, c));
    const place = () => {
      b.style.left = IC.toNum(r[c.xKey]) * unitPx + 'px';
      b.style.top = IC.toNum(r[c.yKey]) * unitPx + 'px';
      b.style.width = (hasW ? IC.toNum(r[c.wKey]) * unitPx : 90) + 'px';
      b.style.height = (hasH ? IC.toNum(r[c.hKey]) * unitPx : 22) + 'px';
    };
    place();
    b.addEventListener('pointerdown', (e) => startDrag(e, 'move', r, c, unitPx, place, i));
    if (hasW && hasH) b.append(h('div', { class: 'rz', onpointerdown: (e) => startDrag(e, 'size', r, c, unitPx, place, i) }));
    return b;
  }

  function startDrag(e, mode, r, c, unitPx, place, i) {
    e.preventDefault(); e.stopPropagation();
    selectRow(i);
    const sx = e.clientX, sy = e.clientY, target = e.currentTarget;
    const o = { x: IC.toNum(r[c.xKey]), y: IC.toNum(r[c.yKey]), w: c.wKey ? IC.toNum(r[c.wKey]) : 0, h: c.hKey ? IC.toNum(r[c.hKey]) : 0 };
    let moved = false;
    try { target.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const sn = (v) => (S.snap ? Math.round(v) : Math.round(v * 100) / 100);
    const mv = (ev) => {
      if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 3) return;
      if (!moved) { moved = true; pushUndo(); }
      const dx = (ev.clientX - sx) / unitPx, dy = (ev.clientY - sy) / unitPx;
      if (mode === 'move') { IC.writeNum(r, c.xKey, Math.max(0, sn(o.x + dx))); IC.writeNum(r, c.yKey, Math.max(0, sn(o.y + dy))); }
      else { IC.writeNum(r, c.wKey, Math.max(1, sn(o.w + dx))); IC.writeNum(r, c.hKey, Math.max(1, sn(o.h + dy))); }
      place();
    };
    const up = () => {
      target.removeEventListener('pointermove', mv);
      target.removeEventListener('pointerup', up);
      if (moved) afterEdit({});
    };
    target.addEventListener('pointermove', mv);
    target.addEventListener('pointerup', up);
  }

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
    if ((e.ctrlKey || e.metaKey) && !typing && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (S.view !== 'layout' || typing || !/^Arrow/.test(e.key)) return;
    const g = curGroup(), r = curRec();
    if (!g || !r) return;
    const c = cfgOf(g);
    if (!c.xKey || !c.yKey) return;
    e.preventDefault();
    const step = e.shiftKey ? 10 : 1;
    edit(() => {
      if (e.key === 'ArrowLeft') IC.writeNum(r, c.xKey, Math.max(0, IC.toNum(r[c.xKey]) - step));
      if (e.key === 'ArrowRight') IC.writeNum(r, c.xKey, IC.toNum(r[c.xKey]) + step);
      if (e.key === 'ArrowUp') IC.writeNum(r, c.yKey, Math.max(0, IC.toNum(r[c.yKey]) - step));
      if (e.key === 'ArrowDown') IC.writeNum(r, c.yKey, IC.toNum(r[c.yKey]) + step);
    }, { center: true });
  });

  /* ------------------------------------------------------------- side pane */
  function renderSide() {
    $('#tab-row').classList.toggle('on', S.side === 'row');
    $('#tab-pos').classList.toggle('on', S.side === 'pos');
    const body = $('#sideBody');
    const active = document.activeElement;
    // don't wipe the pane while the user is typing in it
    if (active && body.contains(active) && /INPUT|TEXTAREA/.test(active.tagName)) return;
    body.replaceChildren(S.side === 'pos' ? posPane() : rowPane());
  }

  function rowPane() {
    const g = curGroup(), r = curRec();
    const box = h('div');
    if (!g || !r) { box.append(h('p', { class: 'muted' }, 'Select a row to see every property, including nested ones.')); return box; }
    const c = cfgOf(g);
    box.append(h('p', { class: 'muted' }, (g.kind === 'single' ? 'Settings' : 'Row ' + (S.sel.idx + 1)) + ' in ' + g.path));
    for (const k of Object.keys(r)) {
      const v = r[k];
      let input;
      if (IC.isScalar(v)) {
        if (typeof v === 'boolean') input = h('input', Object.assign({ type: 'checkbox', onchange: (e) => edit(() => { r[k] = e.target.checked; }, { center: true }) }, v ? { checked: true } : {}));
        else {
          input = h('input', { type: 'text', value: IC.displayVal(v), onchange: (e) => edit(() => { r[k] = IC.setValue(r[k], e.target.value); }, { center: true }) });
          if (k === c.bindKey) input.setAttribute('list', 'posfields');
        }
      } else {
        input = h('textarea', { onchange: (e) => {
          try { const parsed = IC.parseJson(e.target.value); edit(() => { r[k] = parsed; }, { center: true }); }
          catch (err) { toast('Not valid JSON for "' + k + '": ' + err.message, 'err'); }
        } }, IC.stringifyJson(v));
      }
      box.append(h('div', { class: 'f' }, h('label', {}, k), input));
    }
    const tok = c.bindKey && (IC.displayVal(r[c.bindKey]).match(IC.TOKEN_RE) || [])[0];
    const f = tok && S.catMap.get(tok);
    if (f) box.append(h('p', { class: 'muted' }, 'Bound to “', f.label, '” — ', f.desc, '. Sample: ', f.sample));
    return box;
  }

  function posPane() {
    const box = h('div');
    if (!S.catalog.length) { box.append(h('p', { class: 'muted' }, 'POS field list not available (open this page from the running server to load it).')); return box; }
    const g = curGroup(), c = g ? cfgOf(g) : {};
    const canBind = g && c.bindKey;
    box.append(h('input', { type: 'text', placeholder: 'Search POS fields…', style: { width: '100%', marginBottom: '8px' }, value: S.posFilter,
      oninput: (e) => { S.posFilter = e.target.value; const keep = e.target; const list = $('#posList'); list.replaceChildren(posList()); keep.focus(); } }));
    if (!canBind) box.append(h('p', { class: 'muted' }, 'Select a section with a “POS field binding” column to bind fields.'));
    box.append(h('div', { id: 'posList' }, posList()));
    return box;
  }

  function posList() {
    const g = curGroup(), c = g ? cfgOf(g) : {}, canBind = g && c.bindKey;
    const q = S.posFilter.trim().toLowerCase();
    const frag = document.createDocumentFragment();
    let lastCat = '';
    for (const f of S.catalog) {
      if (q && !(f.label + ' ' + f.colName + ' ' + f.category).toLowerCase().includes(q)) continue;
      if (f.category !== lastCat) { lastCat = f.category; frag.append(h('div', { class: 'cat' }, f.category)); }
      frag.append(h('div', { class: 'pf' }, h('div', { class: 'n' }, f.label), h('code', {}, f.colName), h('div', { class: 's muted' }, 'e.g. ', f.sample),
        h('div', { class: 'btns' },
          h('button', Object.assign({ onclick: () => bindField(f) }, canBind && curRec() ? {} : { disabled: true }), 'Bind to selected'),
          h('button', Object.assign({ onclick: () => addFieldRow(f) }, canBind && g.kind === 'array' && g.container.length ? {} : { disabled: true }), '＋ Add as new row'))));
    }
    return frag;
  }

  function bindField(f) {
    const g = curGroup(), r = curRec(); if (!g || !r) return;
    const c = cfgOf(g);
    edit(() => {
      r[c.bindKey] = f.colName;
      if (c.labelKey && typeof r[c.labelKey] === 'string' && !IC.displayVal(r[c.labelKey]).trim()) r[c.labelKey] = f.label;
    }, { center: true });
    toast('Bound to ' + f.colName);
  }

  function addFieldRow(f) {
    const g = curGroup(); if (!g || g.kind !== 'array') return;
    const c = cfgOf(g);
    const i = Math.min(S.sel.idx, g.container.length - 1);
    edit(() => {
      const copy = IC.cloneRecord(g.container, g.container[i], idPool(g));
      copy[c.bindKey] = f.colName;
      if (c.labelKey && typeof copy[c.labelKey] === 'string') copy[c.labelKey] = f.label;
      if (c.yKey) IC.writeNum(copy, c.yKey, IC.toNum(copy[c.yKey]) + (c.hKey ? IC.toNum(copy[c.hKey]) : 8) + 1);
      g.container.splice(i + 1, 0, copy);
      S.sel.idx = i + 1;
    }, { center: true });
    toast('Added row for ' + f.label);
  }

  /* ------------------------------------------------------- check & export */
  function runValidate() {
    const pg = PAGES[S.page];
    return IC.validate({
      files: S.files, groups: S.groups, cfgOf,
      catalog: S.catalog.length ? new Set(S.catalog.map((f) => f.colName)) : null,
      pageW: pg.w / UNIT_MM[S.unit], pageH: pg.roll ? null : pg.h / UNIT_MM[S.unit]
    });
  }

  function showCheck(res) {
    const box = $('#check');
    box.hidden = false;
    box.replaceChildren(
      h('div', { class: 'row' }, h('b', {}, 'Pre-export check'), h('span', { class: 'spacer' }), h('button', { onclick: () => { box.hidden = true; } }, '✕')),
      h('ul', {}, res.map((r) => h('li', {}, h('span', { class: 'lv ' + r.level }, r.level.toUpperCase()), r.msg))));
  }

  function fileName(inputId, fallback) {
    let n = ($('#' + inputId).value || '').trim() || fallback;
    n = n.replace(/[\\/:*?"<>|]+/g, '_');
    return /\.json$/i.test(n) ? n : n + '.json';
  }

  function download(blob, name) {
    const a = h('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function doExport(which) {
    const res = runValidate();
    const need = which === 'zip' ? ['profile', 'fields'] : [which];
    const blocking = need.some((k) => !S.files[k].root) || res.some((r) => r.level === 'error' && !/not loaded/.test(r.msg));
    showCheck(res);
    if (blocking) { toast('Fix the errors in the check list before exporting.', 'err'); return; }
    const out = {
      profile: { name: fileName('nameProfile', 'printProfileDetail.json'), text: S.files.profile.root ? IC.stringifyJson(S.files.profile.root) : '' },
      fields: { name: fileName('nameFields', 'printFieldDetails.json'), text: S.files.fields.root ? IC.stringifyJson(S.files.fields.root) : '' }
    };
    if (which === 'zip') {
      const enc = new TextEncoder();
      const parts = IC.makeZipParts([
        { name: out.profile.name, data: enc.encode(out.profile.text) },
        { name: out.fields.name, data: enc.encode(out.fields.text) }]);
      download(new Blob(parts, { type: 'application/zip' }), 'invoice-template.zip');
    } else download(new Blob([out[which].text], { type: 'application/json' }), out[which].name);
    toast('Exported. Import it with the Zoho Admin tool.');
  }

  /* -------------------------------------------------------------- autosave */
  function pack(k) { const f = S.files[k]; return f.root ? { name: f.name, orig: f.orig, snap: JSON.stringify(f.root) } : null; }
  function autosave() {
    try {
      if (!S.files.profile.root && !S.files.fields.root) return;
      localStorage.setItem(DRAFT_KEY, JSON.stringify({ t: Date.now(), profile: pack('profile'), fields: pack('fields') }));
    } catch (_) { /* storage unavailable */ }
  }
  function readDraft() { try { return JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null'); } catch (_) { return null; } }
  function resume() {
    const d = readDraft(); if (!d) return;
    for (const k of ['profile', 'fields']) {
      if (!d[k]) continue;
      let origSnap = '';
      try { origSnap = JSON.stringify(IC.parseJson(d[k].orig)); } catch (_) { /* keep blank */ }
      S.files[k] = { name: d[k].name, orig: d[k].orig, root: JSON.parse(d[k].snap), origSnap };
      $('#' + (k === 'profile' ? 'nameProfile' : 'nameFields')).value = d[k].name;
    }
    S.undo = []; S.redo = []; rebuild();
    toast('Previous session restored.');
  }

  function resetAll() {
    if (!confirm('Discard all edits and go back to the files as loaded?')) return;
    pushUndo();
    for (const k of ['profile', 'fields']) if (S.files[k].root) S.files[k].root = JSON.parse(S.files[k].origSnap);
    rebuild(true);
  }

  /* ------------------------------------------------------------------ init */
  function wireDrop(kind) {
    const dz = $('#dz-' + kind), inp = $('#file-' + kind);
    dz.addEventListener('click', () => inp.click());
    dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') inp.click(); });
    inp.addEventListener('change', () => { handleFiles(inp.files, kind); inp.value = ''; });
    dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); handleFiles(e.dataTransfer.files, kind); });
  }

  async function init() {
    wireDrop('profile'); wireDrop('fields');
    $('#undo').onclick = undo; $('#redo').onclick = redo;
    $('#loadPreset').onclick = loadPreset;
    $('#btnCheck').onclick = () => showCheck(runValidate());
    $('#expProfile').onclick = () => doExport('profile');
    $('#expFields').onclick = () => doExport('fields');
    $('#expZip').onclick = () => doExport('zip');
    $('#resetAll').onclick = resetAll;
    $('#resume').onclick = resume;
    $('#tab-row').onclick = () => { S.side = 'row'; renderSide(); };
    $('#tab-pos').onclick = () => { S.side = 'pos'; renderSide(); };
    renderChips();

    const d = readDraft();
    if (d && (d.profile || d.fields)) {
      const b = $('#resume'); b.hidden = false;
      b.textContent = 'Resume last session (' + new Date(d.t).toLocaleString() + ')';
    }

    try {
      const r = await fetch('/api/zoho/pos-fields');
      const j = await r.json();
      S.catalog = j.fields || [];
      S.catMap = new Map(S.catalog.map((f) => [f.colName, f]));
      $('#posfields').replaceChildren(...S.catalog.map((f) => h('option', { value: f.colName }, f.label)));
    } catch (_) { /* running without server: field picker disabled */ }

    const sel = $('#preset');
    sel.replaceChildren();
    try {
      const r = await fetch('/api/invoice-template/presets');
      const j = await r.json();
      const list = j.presets || [];
      if (!list.length) {
        sel.append(h('option', { value: '' }, 'No presets installed'));
        $('#presetNote').textContent = 'Put preset JSON pairs in public/assets/aistudio/ or just drop your exported files below.';
      } else {
        list.forEach((p) => sel.append(h('option', { value: p.id }, p.name)));
        $('#loadPreset').disabled = false;
      }
    } catch (_) {
      sel.append(h('option', { value: '' }, 'Presets unavailable'));
    }
  }

  init();
})();
