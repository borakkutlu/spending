// Spending — a private, on-device spending dashboard.
// All data lives in this browser's IndexedDB on this device. Nothing is ever uploaded:
// the page's Content-Security-Policy only allows loading this app's own files.
import { pdfToLines, parseStatement } from './statement.js';

const APP_VERSION = '1.0.0';
const NEEDS = 'Needs category', FEES = 'Fees & interest', UNCAT = 'Uncategorized';
const DEFAULT_GROUPS = [
  { name: 'Essentials', cats: ['Groceries', 'Gas', 'State'] },
  { name: 'Eating out', cats: ['Food', 'Coffee'] },
  { name: 'Lifestyle', cats: ['Entertainment', 'Movies', 'Clothes', 'Selfcare', 'Haircut'] },
  { name: 'Learning', cats: ['Education'] },
  { name: 'Travel', cats: ['Travel'] },
  { name: 'Other', cats: [FEES, NEEDS, UNCAT] },
];

// ---------------------------------------------------------------- storage (this device only)
const idb = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('spending', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => {
    const t = db.transaction('kv', mode), st = t.objectStore('kv'), out = fn(st);
    t.oncomplete = () => res(out && out.result); t.onerror = () => rej(t.error);
  }); };
  return { get: k => tx('readonly', s => s.get(k)), set: (k, v) => tx('readwrite', s => { s.put(v, k); }), del: k => tx('readwrite', s => { s.delete(k); }) };
})();

const emptyState = () => ({ v: 1, months: [], rules: [], groups: structuredClone(DEFAULT_GROUPS) });
let S = emptyState();
async function save() {
  await idb.set('state', S);
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
}

// ---------------------------------------------------------------- helpers
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
const fmt0 = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const parseDate = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const fmtDate = s => parseDate(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const fmtDay = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const isoOf = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const sum = arr => arr.reduce((s, t) => s + t.a, 0);
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('show'), ms);
}
const busy = (on, text = 'Reading…') => { $('busy').hidden = !on; $('busyText').textContent = text; };

// ---------------------------------------------------------------- rules
function guessMerchant(desc) {
  const s = desc.toUpperCase().replace(/^(TST\* ?|SQ \*|FSP\*|SPO\*|DD \*|PY \*|SP |PAYPAL \*)/, '');
  const words = [];
  for (const w of s.split(/\s+/)) {
    if (/[0-9#]/.test(w) || w === '-') break;
    words.push(w);
    if (words.length === 3) break;
  }
  while (words.length > 1 && ['OF', 'THE', 'AND', '&', 'AT'].includes(words[words.length - 1])) words.pop();
  const pattern = words.slice(0, 2).join(' ') || s.split(/\s+/)[0];
  const name = (words.join(' ') || pattern).toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (m, a, b) => a + b.toUpperCase()).replace(/\.Com/g, '.com');
  return { pattern, name };
}
let SORTED_RULES = [];
const sortRules = () => { SORTED_RULES = S.rules.slice().sort((a, b) => b.pattern.length - a.pattern.length); };
const matchRule = desc => { const up = desc.toUpperCase(); return SORTED_RULES.find(r => up.includes(r.pattern.toUpperCase())) || null; };

// ---------------------------------------------------------------- derived data
let MONTHS = [], ALL_TX = [], YEARS = [], MULTI_YEAR = false, GROUPS = [], GROUP_OF = {}, CATS = [], ALL_CATS = [];
let monthTotals = [], avgEvery = 0, SUBS = [], NEEDS_RULES = [];
const state = { month: 'all', cat: null, q: '', hideOne: false, sort: { k: 'dt', dir: -1 } };

function derive() {
  sortRules();
  MONTHS = S.months.slice().sort((a, b) => a.year - b.year || a.month - b.month);
  YEARS = [...new Set(MONTHS.map(m => m.year))];
  MULTI_YEAR = YEARS.length > 1;
  GROUPS = S.groups.map(g => g.name); if (!GROUPS.includes('Other')) GROUPS.push('Other');
  GROUP_OF = {}; S.groups.forEach(g => g.cats.forEach(c => GROUP_OF[c] = g.name));
  ALL_TX = [];
  const needSet = new Set();
  MONTHS.forEach((m, mi) => m.tx.forEach((t, j) => {
    const r = t.fee ? null : matchRule(t.d);
    let c;
    if (t.fee) c = FEES;
    else if (m.source === 'workbook') c = t.c || UNCAT;
    else c = (r && r.category) || NEEDS;
    if (c === NEEDS) needSet.add(r ? r.pattern : guessMerchant(t.d).pattern);
    ALL_TX.push({ d: t.d, a: t.a, dt: t.dt || null, c, m: (r && r.merchant) || guessMerchant(t.d).name, o: !!(r && r.one_off), s: !!(r && r.subscription), mi, j, rule: r });
  }));
  NEEDS_RULES = S.rules.filter(r => needSet.has(r.pattern));
  const tot = {};
  ALL_TX.forEach(t => tot[t.c] = (tot[t.c] || 0) + t.a);
  CATS = Object.keys(tot).sort((a, b) => GROUPS.indexOf(groupOf(a)) - GROUPS.indexOf(groupOf(b)) || tot[b] - tot[a]);
  ALL_CATS = S.groups.flatMap(g => g.cats).filter(c => c !== NEEDS && c !== FEES);
  monthTotals = MONTHS.map((m, i) => {
    const tx = ALL_TX.filter(t => t.mi === i), all = sum(tx), one = sum(tx.filter(t => t.o));
    return { all, one, every: all - one, n: tx.length };
  });
  avgEvery = MONTHS.length ? monthTotals.reduce((s, t) => s + t.every, 0) / MONTHS.length : 0;
  SUBS = subscriptions();
  if (state.month !== 'all' && !MONTHS[state.month]) state.month = 'all';
}
const groupOf = c => GROUP_OF[c] || 'Other';
const groupColor = g => { const i = GROUPS.filter(x => x !== 'Other').indexOf(g); return g === 'Other' || i < 0 || i > 4 ? 'var(--g-other)' : `var(--g${i + 1})`; };
const catColor = c => groupColor(groupOf(c));
const dot = c => `<i class="dot" style="background:${catColor(c)}"></i>`;
const short = m => m.name.slice(0, 3) + (MULTI_YEAR ? ` ’${String(m.year).slice(2)}` : '');
const label = m => MULTI_YEAR ? `${m.name} ${m.year}` : m.name;
const range = m => m.start ? `${fmtDate(m.start)} – ${fmtDate(m.end)}` : '';
const selTx = () => state.month === 'all' ? ALL_TX : ALL_TX.filter(t => t.mi === state.month);

function subscriptions() {
  const by = new Map(), last = MONTHS.length - 1;
  ALL_TX.forEach(t => {
    if (!t.s) return;
    if (!by.has(t.m)) by.set(t.m, { per: new Array(MONTHS.length).fill(0), c: t.c });
    by.get(t.m).per[t.mi] += t.a;
  });
  return [...by.entries()].map(([m, { per, c }]) => {
    const charged = per.map((v, i) => v ? i : -1).filter(i => i >= 0);
    const cur = per[last];
    let prev = 0; for (let i = last - 1; i >= 0; i--) if (per[i]) { prev = per[i]; break; }
    return { m, c, now: cur, last: per[charged[charged.length - 1]], lastMonth: charged[charged.length - 1], n: charged.length,
      paid: per.reduce((a, b) => a + b, 0), prev: cur && prev && Math.abs(cur - prev) > 0.005 ? prev : null };
  }).sort((a, b) => b.last - a.last);
}

// ---------------------------------------------------------------- tooltip (hover, focus, tap)
const tip = $('tip');
let tipOwner = null, tipTimer;
function placeTip(x, y) {
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let left = Math.min(Math.max(8, x - w / 2), innerWidth - w - 8), top = y - h - 10;
  if (top < 8) top = y + 18;
  tip.style.left = left + 'px'; tip.style.top = top + 'px';
}
function showTip(html, x, y, owner) { tip.innerHTML = html; tip.classList.add('show'); tipOwner = owner; placeTip(x, y); }
function showTipAt(el, html) { const r = el.getBoundingClientRect(); showTip(html, r.left + r.width / 2, r.top, el); }
function hideTip() { tip.classList.remove('show'); tipOwner = null; }
function bindTip(el, fn) {
  el.addEventListener('pointermove', e => { if (e.pointerType === 'mouse') showTip(fn(), e.clientX, e.clientY, el); });
  el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hideTip(); });
  el.addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') { showTipAt(el, fn()); clearTimeout(tipTimer); tipTimer = setTimeout(hideTip, 3500); } });
  el.addEventListener('focus', () => { if (el.matches(':focus-visible')) showTipAt(el, fn()); });
  el.addEventListener('blur', hideTip);
}
addEventListener('scroll', hideTip, { passive: true });
document.addEventListener('pointerdown', e => { if (tipOwner && !tipOwner.contains(e.target)) hideTip(); });
const activate = el => el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click(); } });

// ---------------------------------------------------------------- render
function render() {
  hideTip();
  const has = MONTHS.length > 0;
  $('welcome').hidden = has; $('dash').hidden = !has; $('chips').hidden = !has;
  if (!has) { $('title').textContent = 'Spending'; return; }
  refreshCatSelect();
  const yearText = YEARS.length > 1 ? `${YEARS[0]}–${YEARS[YEARS.length - 1]}` : YEARS[0];
  $('title').textContent = `Spending ${yearText}`;
  $('subtitle').textContent = `${label(MONTHS[0])} – ${label(MONTHS[MONTHS.length - 1])} · ${plural(ALL_TX.length, 'purchase')} · ${fmt(sum(ALL_TX))}`;
  renderAlert(); renderChips(); renderKpis(); renderCols(); renderCats(); renderHeat(); renderMerch(); renderDays(); renderSubs(); renderTable(); renderBills();
  $('footer').textContent = `Stored only on this device · ${plural(MONTHS.length, 'month')} · Spending ${APP_VERSION}`;
}

function renderAlert() {
  const n = NEEDS_RULES.length;
  $('alert').hidden = !n;
  if (n) {
    $('alert').innerHTML = `<div><b>${plural(n, 'new merchant')} need${n === 1 ? 's' : ''} a category</b></div><button class="btn small" type="button" id="fixBtn">Sort now</button>`;
    $('fixBtn').onclick = openNeedsSheet;
  }
}

function renderChips() {
  const opts = [['all', MULTI_YEAR ? 'All months' : 'Full year', '']].concat(MONTHS.map((m, i) => [i, label(m), range(m)]));
  $('chips').innerHTML = opts.map(([v, l, r]) => `<button class="chip" type="button" data-v="${v}" aria-pressed="${state.month === v}"${r ? ` title="Statement period ${r}"` : ''}>${esc(l)}</button>`).join('');
  $('chips').querySelectorAll('.chip').forEach(b => b.onclick = () => { state.month = b.dataset.v === 'all' ? 'all' : +b.dataset.v; render(); });
  const sel = $('chips').querySelector('[aria-pressed="true"]');
  if (sel) sel.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function deltaHtml(d, base, what) {
  if (!base) return '';
  return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmt0(Math.abs(d))} (${Math.abs(d / base * 100).toFixed(0)}%)</span> ${what}`;
}

function renderKpis() {
  const tx = selTx(), total = sum(tx), one = sum(tx.filter(t => t.o)), every = total - one;
  if (state.month === 'all') {
    $('k1l').textContent = MULTI_YEAR ? 'Card spend' : 'Card spend, year to date';
    $('k1').textContent = fmt0(total);
    $('k1f').textContent = `${plural(tx.length, 'purchase')} · ${fmt0(one)} one-off`;
    $('k2l').textContent = 'Everyday per month';
    $('k2').textContent = fmt0(avgEvery);
    $('k2f').textContent = 'Average, without one-offs';
  } else {
    const m = MONTHS[state.month];
    $('k1l').textContent = `Card spend, ${label(m)}`;
    $('k1').textContent = fmt(total);
    $('k1f').innerHTML = `${plural(tx.length, 'purchase')}${one ? ` · <b>${fmt0(one)}</b> one-off` : ''}`;
    $('k2l').textContent = `Everyday, ${label(m)}`;
    $('k2').textContent = fmt(every);
    $('k2f').innerHTML = deltaHtml(every - avgEvery, avgEvery, 'vs average');
  }
  const byCat = {};
  tx.forEach(t => byCat[t.c] = (byCat[t.c] || 0) + t.a);
  const top = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  $('k3').textContent = top ? top[0] : '—';
  $('k3f').textContent = top ? `${fmt(top[1])} · ${(top[1] / total * 100).toFixed(0)}% of spend` : '';
  const lastI = MONTHS.length - 1, monthly = SUBS.filter(s => s.lastMonth === lastI).reduce((a, s) => a + s.now, 0);
  $('k4').textContent = SUBS.length ? `${fmt(monthly)}` : '—';
  $('k4f').textContent = SUBS.length ? `per month · ≈ ${fmt0(monthly * 12)} a year` : 'None marked yet';
}

let colsKey = '';
function renderCols() {
  const el = $('cols');
  const max = Math.max(1, ...monthTotals.map(t => t.all)) * 1.08;
  const key = MONTHS.map(m => m.year + '-' + m.month).join(',') + '|' + monthTotals.map(t => t.all.toFixed(2) + '/' + t.one.toFixed(2)).join(',');
  el.classList.toggle('all', state.month === 'all');
  if (key !== colsKey) {
    colsKey = key;
    el.innerHTML = MONTHS.map((m, i) => `<div class="col" data-i="${i}" role="button" tabindex="0" aria-label="${esc(label(m))}: ${fmt(monthTotals[i].all)}">
      <div class="v"></div><div class="stack"><div class="seg solid" style="height:0"></div><div class="seg hatch" style="height:0"></div></div></div>`).join('') + '<div class="avgline"></div>';
    el.querySelectorAll('.col').forEach(c => {
      const i = +c.dataset.i;
      c.onclick = () => { state.month = state.month === i ? 'all' : i; render(); };
      activate(c);
      bindTip(c, () => {
        const t = monthTotals[i], m = MONTHS[i], d = t.every - avgEvery;
        return `<div>${esc(label(m))}${m.start ? ` <span class="tl">· ${range(m)}</span>` : ''}</div><b>${fmt(t.all)}</b> · ${plural(t.n, 'purchase')}`
          + (t.one ? `<br>Everyday ${fmt(t.every)} · one-off ${fmt(t.one)}` : '') + `<br><span class="tl">Everyday ${d >= 0 ? '+' : '−'}${fmt(Math.abs(d))} vs average</span>`;
      });
    });
  }
  const plotH = el.clientHeight - 22 - 20;
  el.querySelectorAll('.col').forEach((c, i) => {
    const t = monthTotals[i];
    c.classList.toggle('sel', state.month === i);
    c.querySelector('.v').textContent = fmt0(t.all);
    const [ev, on] = c.querySelectorAll('.seg');
    c.querySelector('.stack').classList.toggle('has-one', t.one > 0);
    requestAnimationFrame(() => {
      ev.style.height = Math.max(0, t.every / max * plotH - (t.one ? 2 : 0)) + 'px';
      on.style.height = (t.one / max * plotH) + 'px'; on.style.display = t.one ? '' : 'none';
    });
  });
  el.querySelector('.avgline').style.bottom = (avgEvery / max * plotH) + 'px';
  $('avgLabel').textContent = `Avg everyday ${fmt0(avgEvery)}`;
  const tiny = MONTHS.length > 9 && innerWidth < 600;
  $('xlabels').innerHTML = MONTHS.map((m, i) => `<div class="${state.month === i ? 'sel' : ''}">${tiny ? m.name.slice(0, 1) : short(m)}</div>`).join('');
}

function renderCats() {
  const tx = selTx(), total = sum(tx) || 1, byCat = {}, cnt = {}, byGroup = {};
  tx.forEach(t => { byCat[t.c] = (byCat[t.c] || 0) + t.a; cnt[t.c] = (cnt[t.c] || 0) + 1; const g = groupOf(t.c); byGroup[g] = (byGroup[g] || 0) + t.a; });
  const groups = GROUPS.filter(g => byGroup[g] > 0);
  $('share').innerHTML = groups.map(g => `<div style="flex-grow:${byGroup[g]};background:${groupColor(g)}"></div>`).join('');
  $('shareLegend').innerHTML = groups.map(g => `<span><i class="sw" style="background:${groupColor(g)}"></i>${esc(g)} <b>${(byGroup[g] / total * 100).toFixed(0)}%</b></span>`).join('');
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? Math.max(rows[0][1], 1) : 1;
  $('cats').innerHTML = rows.map(([c, v]) => `<div class="cat-row ${state.cat === c ? 'active' : state.cat ? 'dim' : ''}" data-c="${esc(c)}" role="button" tabindex="0" aria-pressed="${state.cat === c}">
      <div class="cat-name">${dot(c)}${esc(c)}</div>
      <div class="track"><div class="fill" data-w="${Math.max(0, v / max * 100)}" style="background:${catColor(c)}"></div></div>
      <div class="cat-val">${fmt0(v)}<small>${(v / total * 100).toFixed(0)}%</small></div></div>`).join('');
  $('cats').querySelectorAll('.cat-row').forEach(r => {
    const c = r.dataset.c;
    r.onclick = () => { state.cat = state.cat === c ? null : c; $('catSel').value = state.cat || ''; renderCats(); renderTable(); renderHeat(); };
    activate(r);
    bindTip(r, () => `<div>${esc(c)} <span class="tl">· ${esc(groupOf(c))}</span></div><b>${fmt(byCat[c])}</b> · ${plural(cnt[c], 'purchase')}`);
    requestAnimationFrame(() => requestAnimationFrame(() => { const f = r.querySelector('.fill'); f.style.width = f.dataset.w + '%'; }));
  });
  $('catHint').textContent = state.cat ? `Showing ${state.cat}. Tap again to clear.` : 'Tap a category to filter the transactions.';
}

function renderHeat() {
  const grid = {}, cnt = {}; let max = 0;
  ALL_TX.forEach(t => { const k = t.c + '|' + t.mi; grid[k] = (grid[k] || 0) + t.a; cnt[k] = (cnt[k] || 0) + 1; });
  Object.values(grid).forEach(v => max = Math.max(max, v));
  const el = $('heat');
  el.style.gridTemplateColumns = `minmax(104px, auto) repeat(${MONTHS.length}, minmax(40px, 1fr))`;
  const dark = curTheme() === 'dark';
  let html = '<div class="rl"></div>' + MONTHS.map((m, i) => `<div class="h ${state.month === i ? 'sel' : ''}">${short(m)}</div>`).join('');
  CATS.forEach(c => {
    html += `<div class="rl" style="${state.cat && state.cat !== c ? 'opacity:.45' : ''}">${dot(c)}${esc(c)}</div>`;
    MONTHS.forEach((m, i) => {
      const v = grid[c + '|' + i];
      const dim = (state.month !== 'all' && state.month !== i) || (state.cat && state.cat !== c) ? ' coldim' : '';
      if (!v) { html += `<div class="c empty${dim}">–</div>`; return; }
      const a = 0.1 + 0.9 * Math.sqrt(Math.max(0, v) / max);
      html += `<div class="c${dim}" data-c="${esc(c)}" data-i="${i}" tabindex="0" role="button" aria-label="${esc(c)}, ${esc(label(m))}: ${fmt(v)}" style="background:rgba(var(--heat-rgb),${a.toFixed(3)});color:${!dark && a > 0.55 ? '#fff' : 'var(--ink)'}">${Math.round(v)}</div>`;
    });
  });
  el.innerHTML = html;
  el.querySelectorAll('.c[data-c]').forEach(cell => {
    const c = cell.dataset.c, i = +cell.dataset.i, k = c + '|' + i;
    bindTip(cell, () => `<div>${esc(c)} · ${esc(label(MONTHS[i]))}</div><b>${fmt(grid[k])}</b> · ${plural(cnt[k], 'purchase')}`);
    cell.onclick = () => { state.month = i; state.cat = c; $('catSel').value = c; render(); };
    activate(cell);
  });
}

function renderMerch() {
  const by = {};
  selTx().forEach(t => { by[t.m] = by[t.m] || { a: 0, n: 0, c: t.c }; by[t.m].a += t.a; by[t.m].n++; });
  const rows = Object.entries(by).sort((a, b) => b[1].a - a[1].a).slice(0, 8);
  $('merchHint').textContent = `${state.month === 'all' ? 'All months' : label(MONTHS[state.month])}, by total spent`;
  $('merch').innerHTML = rows.map(([n, o], i) => `<div class="list-row"><div class="rank">${i + 1}</div>
    <div class="name">${esc(n)}<small>${dot(o.c)} ${esc(o.c)} · ${plural(o.n, 'visit')}</small></div><div class="amt">${fmt(o.a)}</div></div>`).join('');
}

function renderDays() {
  let mi = state.month === 'all' ? -1 : state.month;
  const dated = MONTHS.map((m, i) => m.start ? i : -1).filter(i => i >= 0);
  const fallback = mi < 0 || !MONTHS[mi].start;
  if (fallback) mi = dated.length ? dated[dated.length - 1] : -1;
  const body = $('dayBody');
  if (mi < 0) { $('dayHint').textContent = ''; body.innerHTML = '<div class="empty-note">Daily detail appears for months added from statement PDFs.</div>'; return; }
  const m = MONTHS[mi];
  $('dayHint').textContent = fallback && state.month !== 'all'
    ? `${label(MONTHS[state.month])} has no dates. Showing ${label(m)}.` : `${label(m)} statement · ${range(m)}`;
  const tx = ALL_TX.filter(t => t.mi === mi && t.dt);
  const first = parseDate([m.start, ...tx.map(t => t.dt)].sort()[0]), last = parseDate(m.end);
  const per = [];
  for (let d = new Date(first); d <= last; d.setDate(d.getDate() + 1)) {
    const k = isoOf(d), list = tx.filter(t => t.dt === k);
    per.push({ d: new Date(d), list, all: sum(list), one: sum(list.filter(t => t.o)) });
  }
  const max = Math.max(1, ...per.map(p => p.all)), H = 162;
  body.innerHTML = `<div class="days">${per.map((p, k) => `<div class="day" data-k="${k}" tabindex="${p.list.length ? 0 : -1}" aria-label="${fmtDay(p.d)}: ${fmt(p.all)}">
      <div class="seg solid" style="height:${Math.max(0, (p.all - p.one) / max * H - (p.one && p.all > p.one ? 1 : 0))}px"></div>${p.one ? `<div class="seg hatch" style="height:${p.one / max * H}px"></div>` : ''}</div>`).join('')}</div>
    <div class="daylabels">${per.map((p, k) => `<div>${(k % 7 === 0 && per.length - 1 - k >= 4) || k === per.length - 1 ? fmtDate(isoOf(p.d)) : ''}</div>`).join('')}</div>`;
  body.querySelectorAll('.day').forEach(el => {
    const p = per[+el.dataset.k];
    bindTip(el, () => `<div>${fmtDay(p.d)}</div><b>${fmt(p.all)}</b>${p.list.length ? ' · ' + plural(p.list.length, 'purchase') : ''}`
      + p.list.slice(0, 5).map(t => `<br><span class="tl">${esc(t.m)} ${fmt(t.a)}${t.o ? ' (one-off)' : ''}</span>`).join('') + (p.list.length > 5 ? `<br><span class="tl">+${p.list.length - 5} more</span>` : ''));
  });
  const spendDays = per.filter(p => p.list.length).length, peak = per.reduce((a, b) => b.all > a.all ? b : a);
  const wk = [0, 0, 0, 0, 0, 0, 0]; per.forEach(p => wk[p.d.getDay()] += p.all - p.one);
  body.insertAdjacentHTML('beforeend', `<div class="day-facts"><span>Days with spending <b>${spendDays} of ${per.length}</b></span>
    <span>Biggest day <b>${fmtDate(isoOf(peak.d))} · ${fmt0(peak.all)}</b></span>
    <span>Busiest weekday <b>${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wk.indexOf(Math.max(...wk))]}</b></span></div>`);
}

function renderSubs() {
  const lastI = MONTHS.length - 1;
  if (!SUBS.length) { $('subs').innerHTML = '<div class="empty-note">Tap any purchase in Transactions and switch on “Subscription”.</div>'; return; }
  const monthly = SUBS.filter(s => s.lastMonth === lastI).reduce((a, s) => a + s.now, 0);
  $('subs').innerHTML = '<div class="list">' + SUBS.map(s => {
    const notes = [];
    if (s.prev) notes.push(`<span class="tag ${s.now > s.prev ? 'up' : ''}">${s.now > s.prev ? '▲' : '▼'} was ${fmt(s.prev)}</span>`);
    if (s.lastMonth !== lastI) notes.push(`<span class="tag">not in ${esc(MONTHS[lastI].name)}</span>`);
    return `<div class="list-row"><i class="dot" style="background:${catColor(s.c)};justify-self:center"></i>
      <div class="name">${esc(s.m)}${notes.join('')}<small>${esc(s.c)} · ${s.n} of ${MONTHS.length} months · ${fmt0(s.paid)} so far</small></div>
      <div class="amt">${fmt(s.last)}<small>per month</small></div></div>`;
  }).join('') + `</div><div class="sub-total"><span>Total <small>(in ${esc(MONTHS[lastI].name)})</small></span><span>${fmt(monthly)}/mo <small>≈ ${fmt0(monthly * 12)}/yr</small></span></div>`;
}

let TABLE_ROWS = [];
function renderTable() {
  let tx = selTx();
  if (state.cat) tx = tx.filter(t => t.c === state.cat);
  if (state.hideOne) tx = tx.filter(t => !t.o);
  if (state.q) { const q = state.q.toLowerCase(); tx = tx.filter(t => t.d.toLowerCase().includes(q) || t.m.toLowerCase().includes(q)); }
  const { k, dir } = state.sort;
  const key = t => k === 'dt' ? [t.mi, t.dt || '', t.j] : k === 'a' ? [t.a] : [String(t[k]).toLowerCase()];
  tx = tx.slice().sort((a, b) => { const A = key(a), B = key(b); for (let i = 0; i < A.length; i++) if (A[i] !== B[i]) return (A[i] > B[i] ? 1 : -1) * dir; return 0; });
  TABLE_ROWS = tx;
  $('tbody').innerHTML = tx.map((t, i) => `<tr class="tap" data-r="${i}" tabindex="0">
      <td>${t.dt ? fmtDate(t.dt) : `<span class="muted">${short(MONTHS[t.mi])}</span>`}</td>
      <td class="desc">${esc(t.m)}${t.c === NEEDS ? '<span class="tag warn">needs category</span>' : ''}${t.o ? '<span class="tag">one-off</span>' : ''}${t.s ? '<span class="tag">sub</span>' : ''}<small>${esc(t.d)}</small></td>
      <td class="hide-sm"><span class="pill">${dot(t.c)}${esc(t.c)}</span></td>
      <td class="num">${fmt(t.a)}</td></tr>`).join('') || `<tr><td colspan="4" class="muted" style="text-align:center;padding:24px">No transactions match.</td></tr>`;
  $('tbody').querySelectorAll('tr.tap').forEach(tr => { tr.onclick = () => openTxSheet(TABLE_ROWS[+tr.dataset.r]); activate(tr); });
  $('tfootL').textContent = plural(tx.length, 'transaction');
  $('tfootR').textContent = fmt(sum(tx));
  const parts = [state.month === 'all' ? 'All months' : label(MONTHS[state.month])];
  if (state.cat) parts.push(state.cat);
  if (state.hideOne) parts.push('everyday only');
  if (state.q) parts.push(`matching “${state.q}”`);
  $('txHint').textContent = parts.join(' · ') + ' · tap a row to edit';
  document.querySelectorAll('th button').forEach(b => {
    const on = b.dataset.sort === k;
    b.textContent = b.textContent.replace(/ [▲▼]$/, '') + (on ? (dir > 0 ? ' ▲' : ' ▼') : '');
  });
}

function renderBills() {
  const has = MONTHS.some(m => Object.values(m.bills || {}).some(v => v));
  $('billsCard').hidden = !has;
  if (!has) return;
  const types = [...new Set(MONTHS.flatMap(m => Object.keys(m.bills || {})))];
  const total = m => Object.values(m.bills || {}).reduce((s, v) => s + (v || 0), 0);
  let h = `<thead><tr><th>Month</th>${types.map(t => `<th class="num">${esc(t)}</th>`).join('')}<th class="num">Total</th></tr></thead><tbody>`;
  MONTHS.forEach((m, i) => {
    h += `<tr${state.month === i ? ' style="background:var(--accent-soft)"' : ''}><td>${esc(short(m))}</td>${types.map(t => `<td class="num">${(m.bills || {})[t] ? fmt(m.bills[t]) : '<span class="na">—</span>'}</td>`).join('')}<td class="num"><b>${total(m) ? fmt(total(m)) : '<span class="na">—</span>'}</b></td></tr>`;
  });
  $('bills').innerHTML = h + '</tbody>';
}

// ---------------------------------------------------------------- sheets
const sheet = $('sheet');
function openSheet(title, html, onReady) {
  hideTip();
  $('sheetTitle').textContent = title; $('sheetBody').innerHTML = html;
  if (!sheet.open) sheet.showModal();
  if (onReady) onReady($('sheetBody'));
}
const closeSheet = () => sheet.open && sheet.close();
$('sheetClose').onclick = closeSheet;
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function categoryOptions(selected) {
  const groups = S.groups.filter(g => g.cats.some(c => c !== NEEDS && c !== FEES && c !== UNCAT));
  return `<option value="">Choose…</option>` + groups.map(g => `<optgroup label="${esc(g.name)}">${g.cats.filter(c => c !== NEEDS && c !== FEES && c !== UNCAT)
    .map(c => `<option${c === selected ? ' selected' : ''}>${esc(c)}</option>`).join('')}</optgroup>`).join('') + '<option value="__new">New category…</option>';
}
function newCategoryFields() {
  return `<div class="field newcat" hidden><label>New category name</label><input type="text" class="newcat-name" maxlength="30" autocomplete="off">
    <label>Group</label><select class="newcat-group">${S.groups.map(g => `<option>${esc(g.name)}</option>`).join('')}</select></div>`;
}
function wireNewCategory(root) {
  root.querySelectorAll('select.catpick').forEach(sel => {
    const box = sel.closest('.catwrap').querySelector('.newcat');
    sel.onchange = () => { box.hidden = sel.value !== '__new'; if (!box.hidden) box.querySelector('input').focus(); };
  });
}
function readCategory(wrap) {
  const sel = wrap.querySelector('select.catpick');
  if (sel.value !== '__new') return sel.value;
  const name = wrap.querySelector('.newcat-name').value.trim();
  if (!name) return '';
  const g = wrap.querySelector('.newcat-group').value;
  if (!S.groups.some(x => x.cats.includes(name))) S.groups.find(x => x.name === g).cats.push(name);
  return name;
}

function ruleFor(t) {
  let r = t.rule;
  if (!r) {
    const g = guessMerchant(t.d);
    r = S.rules.find(x => x.pattern === g.pattern);
    if (!r) { r = { pattern: g.pattern, merchant: g.name, category: '', one_off: false, subscription: false }; S.rules.push(r); }
  }
  return r;
}

function openTxSheet(t) {
  const fixed = MONTHS[t.mi].source === 'workbook';
  const r = t.rule;
  openSheet(t.m, `
    <div class="muted" style="font-size:13px">${t.dt ? fmtDate(t.dt) : esc(label(MONTHS[t.mi]))} · ${fmt(t.a)}<br>${esc(t.d)}</div>
    <div class="field"><label>Name to show</label><input type="text" id="fName" value="${esc(r ? r.merchant : t.m)}" maxlength="40" autocomplete="off"></div>
    <div class="catwrap"><div class="field"><label>Category</label><select class="catpick" id="fCat">${categoryOptions(t.c)}</select></div>${newCategoryFields()}</div>
    ${fixed ? '<div class="muted" style="font-size:12.5px;margin-top:-4px">This month came from your old workbook, so it keeps the category you typed there. The new category applies to this merchant in statements you add.</div>' : ''}
    <label class="toggle"><span>One-off<small>Trips, repairs, fees. Kept out of everyday spending.</small></span><input type="checkbox" id="fOne"${r && r.one_off ? ' checked' : ''}></label>
    <label class="toggle"><span>Subscription<small>Listed in the Subscriptions card.</small></span><input type="checkbox" id="fSub"${r && r.subscription ? ' checked' : ''}></label>
    <p class="muted" style="font-size:12.5px">Changes apply to every purchase at this merchant.</p>
    <button class="btn primary block" type="button" id="fSave">Save</button>`, root => {
    wireNewCategory(root);
    $('fSave').onclick = async () => {
      const rule = ruleFor(t), cat = readCategory(root.querySelector('.catwrap'));
      rule.merchant = $('fName').value.trim() || rule.merchant;
      if (cat) rule.category = cat;
      rule.one_off = $('fOne').checked; rule.subscription = $('fSub').checked;
      await save(); derive(); render(); closeSheet(); toast('Saved');
    };
  });
}

function openNeedsSheet() {
  const rows = NEEDS_RULES.map((r, i) => {
    const ex = ALL_TX.filter(t => t.rule === r || (!t.rule && guessMerchant(t.d).pattern === r.pattern));
    return `<div class="need-row catwrap" data-i="${i}"><div class="top"><b>${esc(r.merchant)}</b><span class="amt">${fmt(sum(ex))}</span></div>
      <small>${esc(ex[0] ? ex[0].d : r.pattern)}${ex.length > 1 ? ` · ${ex.length} purchases` : ''}</small>
      <select class="catpick" aria-label="Category for ${esc(r.merchant)}">${categoryOptions('')}</select>${newCategoryFields()}</div>`;
  }).join('');
  openSheet('New merchants', `<p class="muted" style="font-size:13px;margin-top:0">Pick a category for each. They’ll be remembered next time.</p>${rows}
    <button class="btn primary block" type="button" id="needSave" style="margin-top:14px">Save</button>`, root => {
    wireNewCategory(root);
    $('needSave').onclick = async () => {
      let n = 0;
      root.querySelectorAll('.need-row').forEach(row => { const c = readCategory(row); if (c) { NEEDS_RULES[+row.dataset.i].category = c; n++; } });
      await save(); derive(); render(); closeSheet(); toast(n ? `Saved ${plural(n, 'category')}` : 'Nothing changed');
    };
  });
}

function openMenu() {
  const months = MONTHS.map((m, i) => `<div class="row-item"><div>${esc(label(m))}<small>${m.source === 'workbook' ? 'From your old workbook' : `Statement ${range(m)}`} · ${fmt(monthTotals[i].all)}</small></div>
    <button class="btn small danger" type="button" data-del="${m.year}-${m.month}">Remove</button></div>`).join('');
  const t = curTheme();
  openSheet('Menu', `
    <div class="menu-list">
      <button class="btn block" type="button" data-act="add">Add statement PDF</button>
      <button class="btn block" type="button" data-act="backup">Back up data</button>
      <button class="btn block" type="button" data-act="restore">Restore from backup</button>
      <button class="btn block" type="button" data-act="theme">${t === 'dark' ? 'Use light theme' : 'Use dark theme'}</button>
    </div>
    <h4>Months on this phone</h4>${months || '<div class="muted">None yet.</div>'}
    <h4>Categories</h4>${S.groups.map((g, gi) => `<div class="row-item"><div>${esc(g.name)}<small>${esc(g.cats.join(', '))}</small></div></div>`).join('')}
    <h4>Privacy</h4>
    <div class="muted" style="font-size:13px">Everything is stored only in this app on this iPhone. Nothing is uploaded, and the app can’t contact any other website. Back up after adding a statement: deleting the app or resetting the phone erases its data.<br><br><span id="persistInfo"></span></div>
    <h4>Danger zone</h4><button class="btn block danger" type="button" id="eraseBtn">Erase all data on this phone</button>
    <p class="muted" style="font-size:12px;text-align:center">Spending ${APP_VERSION}</p>`, root => {
    root.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      const [y, mo] = b.dataset.del.split('-').map(Number);
      if (!confirm(`Remove ${MONTH_NAMES[mo - 1]} ${y} from this phone?`)) return;
      S.months = S.months.filter(m => !(m.year === y && m.month === mo));
      await save(); derive(); render(); openMenu(); toast('Removed');
    });
    $('eraseBtn').onclick = async () => {
      if (!confirm('Erase every month, category and setting stored in this app? This can’t be undone unless you have a backup.')) return;
      S = emptyState(); await idb.del('state'); derive(); render(); closeSheet(); toast('All data erased');
    };
    if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then(p => { const el = $('persistInfo'); if (el) el.textContent = p ? 'Storage is marked as persistent.' : ''; });
  });
}

// ---------------------------------------------------------------- actions
async function act(a) {
  if (a === 'add') { $('pdfIn').value = ''; $('pdfIn').click(); }
  else if (a === 'restore') { $('jsonIn').value = ''; $('jsonIn').click(); }
  else if (a === 'backup') await backup();
  else if (a === 'theme') { const next = curTheme() === 'dark' ? 'light' : 'dark'; document.documentElement.dataset.theme = next; try { localStorage.setItem('theme', next); } catch (e) {} closeSheet(); renderHeat(); }
}
document.querySelectorAll('[data-act]').forEach(b => b.onclick = () => act(b.dataset.act));
$('addBtn').onclick = () => act('add');
$('menuBtn').onclick = openMenu;

let pdfjsP = null;
const loadPdfjs = () => pdfjsP || (pdfjsP = import('./vendor/pdf.min.mjs').then(m => { m.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href; return m; }));

$('pdfIn').onchange = async e => {
  const files = [...e.target.files];
  if (!files.length) return;
  closeSheet(); busy(true, 'Reading statement…');
  const results = [];
  try {
    const pdfjs = await loadPdfjs();
    for (const f of files) {
      try {
        const s = parseStatement(await pdfToLines(pdfjs, new Uint8Array(await f.arrayBuffer())));
        const prev = S.months.find(m => m.year === s.year && m.month === s.month);
        sortRules();
        let fresh = 0;
        for (const t of s.tx) {
          if (t.fee || matchRule(t.d)) continue;
          const g = guessMerchant(t.d);
          if (!S.rules.some(r => r.pattern === g.pattern)) { S.rules.push({ pattern: g.pattern, merchant: g.name, category: '', one_off: false, subscription: false }); fresh++; sortRules(); }
        }
        const month = { year: s.year, month: s.month, name: s.name, start: s.start, end: s.end, source: 'pdf', file: f.name,
          tx: s.tx.map(t => t.fee ? { d: t.d, a: t.a, dt: t.dt, fee: true } : { d: t.d, a: t.a, dt: t.dt }), bills: prev ? prev.bills || {} : {} };
        S.months = S.months.filter(m => m !== prev).concat(month);
        results.push({ ok: true, text: `<b>${s.name} ${s.year}</b> · ${plural(s.tx.length, 'purchase')} · ${fmt(s.stated)} ✓ matches the statement${prev ? ' (replaced the earlier copy)' : ''}${fresh ? ` · ${plural(fresh, 'new merchant')}` : ''}` });
      } catch (err) {
        results.push({ ok: false, text: `<b>${esc(f.name)}</b>: ${esc(err.message || err)}` });
      }
    }
    await save(); derive();
    const added = results.filter(r => r.ok);
    if (added.length) { const last = MONTHS.length - 1; state.month = last >= 0 ? last : 'all'; }
    render();
  } catch (err) {
    results.push({ ok: false, text: `Couldn’t open the PDF reader: ${esc(err.message || err)}` });
  } finally { busy(false); }
  openSheet('Statement added', results.map(r => `<div class="result ${r.ok ? '' : 'bad'}">${r.text}</div>`).join('')
    + (NEEDS_RULES.length ? `<button class="btn primary block" type="button" id="goNeeds" style="margin-top:10px">Sort ${plural(NEEDS_RULES.length, 'new merchant')}</button>` : '')
    + `<p class="muted" style="font-size:12.5px;margin-top:14px">Tip: back up now (Menu → Back up data) so this month is safe if the phone is reset.</p>`,
    () => { const b = $('goNeeds'); if (b) b.onclick = openNeedsSheet; });
};

async function backup() {
  const payload = JSON.stringify({ app: 'spending', v: 1, exported: new Date().toISOString(), state: S });
  const name = `spending-backup-${isoOf(new Date())}.json`;
  const file = new File([payload], name, { type: 'application/json' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); toast('Backup ready'); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('Backup saved');
}

function validState(x) {
  return x && Array.isArray(x.months) && Array.isArray(x.rules) && Array.isArray(x.groups)
    && x.months.every(m => Number.isInteger(m.year) && m.month >= 1 && m.month <= 12 && Array.isArray(m.tx) && m.tx.every(t => typeof t.d === 'string' && typeof t.a === 'number'))
    && x.rules.every(r => typeof r.pattern === 'string' && r.pattern.length > 0);
}
$('jsonIn').onchange = async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const st = j && j.app === 'spending' ? j.state : null;
    if (!validState(st)) throw new Error('This isn’t a Spending backup file.');
    if (S.months.length && !confirm(`Replace the ${plural(S.months.length, 'month')} on this phone with this backup (${plural(st.months.length, 'month')})?`)) return;
    S = { v: 1, months: st.months, rules: st.rules.map(r => ({ ...r, one_off: !!r.one_off, subscription: !!r.subscription })), groups: st.groups };
    await save(); derive(); state.month = 'all'; render(); closeSheet();
    toast(`Restored ${plural(S.months.length, 'month')}`);
  } catch (err) { toast(err.message || 'Couldn’t read that file', 4000); }
};

// ---------------------------------------------------------------- theme + controls
const curTheme = () => document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => MONTHS.length && renderHeat());
$('catSel').onchange = e => { state.cat = e.target.value || null; renderCats(); renderTable(); renderHeat(); };
$('hideOne').onchange = e => { state.hideOne = e.target.checked; renderTable(); };
let qt; $('q').oninput = e => { clearTimeout(qt); qt = setTimeout(() => { state.q = e.target.value.trim(); renderTable(); }, 150); };
document.querySelectorAll('th button').forEach(b => b.onclick = () => {
  const k = b.dataset.sort;
  state.sort = { k, dir: state.sort.k === k ? -state.sort.dir : (k === 'a' || k === 'dt' ? -1 : 1) };
  renderTable();
});
let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => MONTHS.length && renderCols(), 120); });

function refreshCatSelect() {
  $('catSel').innerHTML = '<option value="">All categories</option>' + CATS.map(c => `<option${state.cat === c ? ' selected' : ''}>${esc(c)}</option>`).join('');
}

// ---------------------------------------------------------------- start
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
(async () => {
  try { const st = await idb.get('state'); if (validState(st)) S = st; } catch (e) { toast('Couldn’t open saved data'); }
  derive(); render();
})();
