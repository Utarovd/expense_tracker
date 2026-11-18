'use strict';
// Бюджет: SPA на чистом JS. Данные в IndexedDB, очередь изменений уходит в /api/sync.
const TABLES = ['spaces', 'accounts', 'categories', 'transactions', 'budgets', 'settings'];
const TZ = 5 * 3600000;
const $app = document.getElementById('app');
const S = { user: null, db: {}, queue: {}, cursor: 0, space: null, route: '/', month: null, rates: null, me: null, online: navigator.onLine, syncing: false, lastSync: 0, q: '', accF: '', uncat: false, pending: 0 };
TABLES.forEach(t => { S.db[t] = {}; S.queue[t] = {}; });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 14);
const now = () => Date.now();
const tryLS = (f) => { try { return f(); } catch (e) { return null; } };

// ---------- хранилище ----------
const idb = {
  open() { return new Promise((res, rej) => { const r = indexedDB.open('budget', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async get(k) { try { const d = await this.open(); return await new Promise(res => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch (e) { return null; } },
  async set(k, v) { try { const d = await this.open(); await new Promise(res => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) { /* ignore */ } },
  async clear() { try { const d = await this.open(); d.transaction('kv', 'readwrite').objectStore('kv').clear(); } catch (e) { /* ignore */ } },
};
let persistT;
const persist = () => { clearTimeout(persistT); persistT = setTimeout(() => idb.set('state', { db: S.db, queue: S.queue, cursor: S.cursor, user: S.user, space: S.space, rates: S.rates, me: S.me }), 200); };
const rows = (t) => Object.values(S.db[t]).filter(r => !r.deleted_at);
const byId = (t, id) => S.db[t][id];
function put(t, row) { row.updated_at = now(); S.db[t][row.id] = row; S.queue[t][row.id] = row; persist(); scheduleSync(); }
function del(t, id) { const r = S.db[t][id]; if (r) put(t, { ...r, deleted_at: now() }); }

// ---------- сеть ----------
async function api(path, opt = {}, ms = 15000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(path, { ...opt, signal: ac.signal, headers: { 'content-type': 'application/json', ...(opt.headers || {}) }, credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/api/login') { await logoutLocal(); throw new Error('auth'); }
    return { ok: r.ok, status: r.status, data: j };
  } finally { clearTimeout(to); }
}
let syncT;
function scheduleSync() { clearTimeout(syncT); syncT = setTimeout(sync, 400); }
const pendingCount = () => TABLES.reduce((n, t) => n + Object.keys(S.queue[t]).length, 0);
async function sync() {
  if (S.syncing || !S.user || !navigator.onLine) return;
  S.syncing = true;
  try {
    const sent = {}; TABLES.forEach(t => { sent[t] = { ...S.queue[t] }; });
    const changes = {}; TABLES.forEach(t => { changes[t] = Object.values(sent[t]); });
    const { ok, data } = await api('/api/sync', { method: 'POST', body: JSON.stringify({ cursor: S.cursor, changes }) }, 30000);
    if (!ok) throw new Error('sync');
    TABLES.forEach(t => {
      for (const id in sent[t]) if (S.queue[t][id] && S.queue[t][id].updated_at === sent[t][id].updated_at) delete S.queue[t][id];
      for (const r of (data.changes[t] || [])) {
        const loc = S.db[t][r.id];
        if (S.queue[t][r.id] && S.queue[t][r.id].updated_at >= r.updated_at) continue;
        if (!loc || loc.updated_at <= r.updated_at) S.db[t][r.id] = r;
      }
    });
    S.cursor = data.cursor; S.lastSync = now();
    ensureSpace(); persist(); render(true);
  } catch (e) { /* оффлайн: повторим позже */ }
  S.syncing = false; updateBadge();
}
function updateBadge() { const n = pendingCount(); S.pending = n; const b = document.getElementById('sbadge'); if (b) b.textContent = syncText(); }
const syncText = () => !navigator.onLine ? '● offline' + (pendingCount() ? ` · ${pendingCount()} pending` : '') : pendingCount() ? `○ sending ${pendingCount()}` : '✓ synced';
let lastStamp = null;
async function poll() {
  if (!S.user || !navigator.onLine || document.hidden) return;
  try { const { data } = await api('/api/stamp', {}, 8000); if (data.stamp !== lastStamp) { lastStamp = data.stamp; await sync(); } } catch (e) { /* ignore */ }
}
setInterval(poll, 15000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); sync(); } });
window.addEventListener('online', () => { sync(); render(true); });
window.addEventListener('offline', () => render(true));

// ---------- данные ----------
function ensureSpace() {
  const sp = rows('spaces').sort((a, b) => a.sort - b.sort);
  if (!sp.length) return;
  if (!S.space || !byId('spaces', S.space) || byId('spaces', S.space).deleted_at) S.space = sp[0].id;
}
const setting = (k, d) => { const r = S.db.settings[k]; return r && !r.deleted_at && r.value != null ? r.value : d; };
const setSetting = (k, v) => put('settings', { id: k, value: String(v) });
const accounts = () => rows('accounts').filter(a => a.space_id === S.space).sort((a, b) => a.sort - b.sort);
const cats = (kind) => rows('categories').filter(c => c.space_id === S.space && (!kind || c.kind === kind)).sort((a, b) => a.sort - b.sort);
const monthKey = (ts) => { const d = new Date(ts + TZ); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0'); };
const curMonth = () => S.month || (S.month = monthKey(now()));
const monthRange = (m) => { const [y, mo] = m.split('-').map(Number); return [Date.UTC(y, mo - 1, 1) - TZ, Date.UTC(y, mo, 1) - TZ]; };
const shiftMonth = (m, d) => { const [y, mo] = m.split('-').map(Number); const x = new Date(Date.UTC(y, mo - 1 + d, 1)); return x.getUTCFullYear() + '-' + String(x.getUTCMonth() + 1).padStart(2, '0'); };
const MN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (m) => MN[+m.split('-')[1] - 1] + ' ' + m.split('-')[0];
function curRate() {
  const mode = setting('rate_mode', 'auto'); const man = parseFloat(setting('rate_manual', ''));
  if (mode === 'manual' && man > 0) return man;
  const r = S.rates || {}; const k = setting('rate_kind', 'buy');
  return r[k] || r.cbu || man || 12700;
}
function fmt(minor, cur) {
  const v = minor / 100;
  if (cur === 'USD') return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('ru-RU').replace(/ /g, ' ');
}
function balance(acc) {
  let b = acc.opening_balance || 0;
  for (const t of rows('transactions')) if (t.account_id === acc.id) b += t.type === 'income' ? t.amount : t.type === 'expense' ? -t.amount : t.amount;
  return b;
}
const toBase = (minor, cur) => cur === 'USD' ? Math.round(minor * curRate()) : minor;
function totalBase() { return accounts().filter(a => !a.hidden && !a.exclude_from_total).reduce((s, a) => s + toBase(balance(a), a.currency), 0); }
function catPath(id) { const c = byId('categories', id); if (!c) return ''; const p = c.parent_id && byId('categories', c.parent_id); return p ? p.name + ' › ' + c.name : c.name; }
const rootOf = (id) => { const c = byId('categories', id); return c && c.parent_id ? byId('categories', c.parent_id) : c; };
// ---------- иконки (inline SVG, линейные) ----------
const IC = {
  home: 'M3.5 10.5 12 3.5l8.5 7V19a1.5 1.5 0 0 1-1.5 1.5h-4v-6h-6v6H5A1.5 1.5 0 0 1 3.5 19z',
  list: 'M8.5 6.5h12M8.5 12h12M8.5 17.5h12M4 6.5h.01M4 12h.01M4 17.5h.01',
  chart: 'M20.5 13A8.5 8.5 0 1 1 11 3.5V13zM14.5 3.6a8.5 8.5 0 0 1 5.9 5.9h-5.9z',
  card: 'M4.5 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM2.5 10h19M6.5 15h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5a7.5 7.5 0 0 1 15 0',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 12h.01',
  grid: 'M5 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM15 4h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM5 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1zM15 14h4a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-4a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z',
  rate: 'M7 20V4M3.5 7.5 7 4l3.5 3.5M17 4v16M13.5 16.5 17 20l3.5-3.5',
  sliders: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  cash: 'M3.5 6.5h17a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-17a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 10v4M18 10v4',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.4 2.5 3.5 5.5 3.5 9s-1.1 6.5-3.5 9c-2.4-2.5-3.5-5.5-3.5-9S9.6 5.5 12 3z',
  transfer: 'M4 8.5h15.5M15.5 4.5l4 4-4 4M20 15.5H4.5M8.5 11.5l-4 4 4 4',
  food: 'M6 3v6.5a3 3 0 0 0 6 0V3M9 3v18M18 21V3c-2.2 1.2-3.5 3.8-3.5 7.5V13H18',
  game: 'M7 7.5h10a4.5 4.5 0 0 1 4.5 4.5v.5a4 4 0 0 1-7 2.7l-.6-.7h-3.8l-.6.7a4 4 0 0 1-7-2.7V12A4.5 4.5 0 0 1 7 7.5zM7.5 10.5v3M6 12h3M15.5 11h.01M17.5 13h.01',
  car: 'M5 16.5h14V12l-2-5H7l-2 5zM3.5 12h17M7 16.5V19M17 16.5V19M7.5 14h.01M16.5 14h.01',
  receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3',
  family: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20a6.5 6.5 0 0 1 13 0M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14a6.5 6.5 0 0 1 3.5 6',
  bag: 'M5 8h14l-1 12.5H6zM9 8V6.5a3 3 0 0 1 6 0V8',
  heart: 'M12 20s-8-4.6-8-10.6A4.4 4.4 0 0 1 12 6.6a4.4 4.4 0 0 1 8 2.8C20 15.4 12 20 12 20z',
  wallet: 'M4 7a2 2 0 0 1 2-2h11v4M4 7v11a2 2 0 0 0 2 2h14V9H6a2 2 0 0 1-2-2zM16.5 14.5h.01',
  plus: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 8v8M8 12h8',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0zM8 8h.01',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.3l2.7 2.7L16 9.5',
  bad: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
};
const svg = (n, sz = 22) => `<svg class="i" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const CATIC = { food: 'food', leisure: 'game', transport: 'car', expenses: 'receipt', family: 'family', shopping: 'bag', health: 'heart', salary: 'wallet', 'other income': 'plus' };
const rootIcon = (r, sz) => !r ? svg('tag', sz) : CATIC[String(r.name).toLowerCase()] ? svg(CATIC[String(r.name).toLowerCase()], sz) : r.icon ? `<span class="emo">${esc(r.icon)}</span>` : svg('tag', sz);
const accIcon = (a) => svg(a.type === 'cash' ? 'cash' : a.type === 'card_visa' ? 'globe' : 'card');
const catIcon = (id) => rootIcon(rootOf(id));
function spentByRoot(m, space = S.space) {
  const [a, b] = monthRange(m); const out = {}; let total = 0;
  for (const t of rows('transactions')) {
    if (t.space_id !== space || t.type !== 'expense' || t.occurred_at < a || t.occurred_at >= b) continue;
    const r = rootOf(t.category_id); const k = r ? r.id : '_none';
    out[k] = (out[k] || 0) + t.amount_base; total += t.amount_base;
  }
  return { out, total };
}
function budgetFor(cat, m = curMonth()) {
  const key = cat || null; let best = null;
  for (const b of rows('budgets')) if (b.space_id === S.space && (b.category_id || null) === key && b.month <= m && (!best || b.month > best.month)) best = b;
  return best;
}
const dtLocal = (ts) => { const d = new Date(ts + TZ); const p = n => String(n).padStart(2, '0'); return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const fromLocal = (s) => { const m = s.match(/(\d+)-(\d+)-(\d+)T(\d+):(\d+)/); return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - TZ; };
const dd = (ts) => { const d = new Date(ts + TZ); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)}`; };
const hm = (ts) => { const d = new Date(ts + TZ); const p = n => String(n).padStart(2, '0'); return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
const num = (s) => { s = String(s ?? '').replace(/\s/g, ''); if (/,\d{1,2}$/.test(s)) s = s.replace(',', '.'); else s = s.replace(/,/g, ''); const n = parseFloat(s); return isNaN(n) ? NaN : n; };

// ---------- создание операций ----------
function makeTx({ type, account, amount, category, note, ts, merchant, source }) {
  const usd = account.currency === 'USD'; const fx = usd ? curRate() : 1;
  return { id: rid(), space_id: S.space, type, account_id: account.id, amount, currency: account.currency, fx_rate: fx, amount_base: usd ? Math.round(amount * fx) : amount, category_id: category || null, note: note || '', merchant: merchant || '', occurred_at: ts || now(), source: source || 'app' };
}
function parseQuick(text) {
  let t = text.trim(); let income = false;
  if (t.startsWith('+')) { income = true; t = t.slice(1).trim(); }
  const m = t.match(/(\d[\d ]*(?:[.,]\d+)?)\s*(к|k|тыс\w*|млн|mln)?/i); if (!m) return null;
  let n = num(m[1]); if (!(n > 0)) return null;
  if (m[2]) n *= /млн|mln/i.test(m[2]) ? 1e6 : 1e3;
  const usd = /\$|usd|доллар/i.test(t);
  const kind = /нал|cash/i.test(t) ? 'cash' : /visa|виз/i.test(t) ? 'card_visa' : /карт|card/i.test(t) ? 'card_uzs' : null;
  const note = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\$|usd|доллар\w*|сум\w*|uzs|нал\w*|cash|visa|виза|карт\w*|card/ig, ' ').replace(/\s+/g, ' ').trim();
  return { income, usd, amount: Math.round(n * 100), kind, note };
}
function quickAdd(text) {
  const q = parseQuick(text); if (!q) return toast('Didn’t get that. Example: “lunch 58000”');
  const accs = accounts();
  let acc = accs.find(a => a.type === q.kind) || (q.usd ? accs.find(a => a.type === 'card_visa') : accs.find(a => a.type === 'cash')) || accs[0];
  if (!acc) return;
  // категория по прошлым операциям с той же заметкой
  let cat = null;
  if (q.note) { const same = rows('transactions').filter(t => (t.note || t.merchant || '').toLowerCase() === q.note.toLowerCase() && t.category_id).sort((a, b) => b.occurred_at - a.occurred_at)[0]; if (same) cat = same.category_id; }
  const tx = makeTx({ type: q.income ? 'income' : 'expense', account: acc, amount: q.amount, category: cat, note: q.note });
  put('transactions', tx);
  toast(`${q.income ? '+' : '−'}${fmt(q.amount, acc.currency)} · ${acc.name}` + (cat ? '' : ' · tap to pick a category'), cat ? null : () => openTx(tx.id));
}

// ---------- UI-утилиты ----------
let toastT;
function toast(msg, onTap) {
  let el = document.getElementById('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg; el.onclick = onTap || null; el.style.pointerEvents = onTap ? 'auto' : 'none'; requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), onTap ? 5000 : 2600);
}
let ovEl = null;
function openSheet(html) {
  if (!ovEl) { ovEl = document.createElement('div'); ovEl.className = 'ov'; ovEl.innerHTML = '<div class="sheet"></div>'; ovEl.addEventListener('mousedown', e => { if (e.target === ovEl) closeSheet(); }); document.body.appendChild(ovEl); requestAnimationFrame(() => requestAnimationFrame(() => ovEl && ovEl.classList.add('open'))); }
  ovEl.firstChild.innerHTML = html;
}
function closeSheet() { const el = ovEl; if (!el) return; ovEl = null; el.classList.remove('open'); setTimeout(() => el.remove(), 300); }
const sheetEl = () => ovEl && ovEl.firstChild;

// ---------- роутинг ----------
const MAIN = ['/', '/transactions', '/stats', '/accounts', '/more'];
let slideDir = '';
function go(path, replace) { const a = MAIN.indexOf(S.route), b = MAIN.indexOf(path); slideDir = a > -1 && b > -1 ? (b > a ? 'pg-next' : 'pg-prev') : ''; if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path); S.route = path; render(); window.scrollTo(0, 0); }
window.addEventListener('popstate', () => { slideDir = ''; closeSheet(); S.route = location.pathname; render(); });
let lastRoute = null;
function render(soft) {
  if (!S.user) { if (S.route !== '/login') { S.route = '/login'; history.replaceState({}, '', '/login'); } return renderLogin(); }
  if (S.route === '/login') { S.route = '/'; history.replaceState({}, '', '/'); }
  const r = S.route;
  const pages = { '/': pgHome, '/transactions': pgTrans, '/stats': pgStats, '/accounts': pgAccounts, '/more': pgMore, '/budget': pgBudget, '/categories': pgCats, '/rate': pgRate, '/settings': pgSettings };
  const fn = pages[r] || pgHome;
  const main = ['/', '/transactions', '/stats', '/accounts', '/more'].includes(r) ? r : '/more';
  const scroll = soft ? window.scrollY : 0;
  const focus = document.activeElement && document.activeElement.id;
  const keep = soft && document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest('#app');
  if (keep) return; // не перерисовываем поверх вводимого текста
  $app.innerHTML = `<div class="${lastRoute !== r && !soft ? 'pg ' + slideDir : ''}">${fn()}</div>` + nav(main) + (['/', '/transactions'].includes(r) ? '<button class="fab" data-act="add">+</button>' : '');
  lastRoute = r;
  if (soft) window.scrollTo(0, scroll);
  if (focus) { const e = document.getElementById(focus); if (e) e.focus(); }
}
function nav(on) {
  const it = [['/', 'home', 'Home'], ['/transactions', 'list', 'Transactions'], ['/stats', 'chart', 'Stats'], ['/accounts', 'card', 'Accounts'], ['/more', 'user', 'Profile']];
  return `<div class="nav"><div>${it.map(([p, i, n]) => `<a href="${p}" data-go="${p}" class="${p === on ? 'on' : ''}"><span>${svg(i, 24)}</span>${n}</a>`).join('')}</div></div>`;
}
const spaceSwitch = () => `<div class="seg">${rows('spaces').sort((a, b) => a.sort - b.sort).map(s => `<button class="${s.id === S.space ? 'on' : ''}" data-act="space" data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>`;
const mnav = () => `<div class="mnav"><button data-act="mprev">‹</button><b>${monthName(curMonth())}</b><button data-act="mnext">›</button></div>`;
const srcIco = { sms: '📱', wallet: '', payme: '🧾', telegram: '✈️' };
function txRow(t) {
  const acc = byId('accounts', t.account_id); const isT = t.type === 'transfer';
  const title = isT ? 'Transfer' : (t.note || t.merchant || catPath(t.category_id) || 'Untitled');
  const sub = isT ? (t.note || '') : (catPath(t.category_id) || 'no category');
  const sign = t.type === 'income' || (isT && t.amount > 0) ? '+' : '−'; const cls = sign === '+' ? 'pos' : 'neg';
  const src = t.source === 'wallet' ? ' · Wallet' : t.source === 'sms' ? ' · SMS' : t.source === 'payme' ? ' · Payme' : t.source === 'telegram' ? ' · bot' : '';
  return `<div class="row" data-act="tx" data-id="${t.id}"><div class="ico">${isT ? svg('transfer') : catIcon(t.category_id)}</div><div class="grow"><b>${esc(title)}</b><span class="sub">${esc(sub)} · ${esc(acc ? acc.name : '?')} · ${hm(t.occurred_at)}${src}</span></div><div class="amt ${cls}">${sign}${fmt(Math.abs(t.amount), t.currency)}</div></div>`;
}

// ---------- страницы ----------
const uncatList = () => rows('transactions').filter(t => t.space_id === S.space && (t.type === 'expense' || t.type === 'income') && !t.category_id);
function pgHome() {
  const m = monthKey(now()); const bud = budgetFor(null, m); const sp = spentByRoot(m);
  const accs = accounts().filter(a => !a.hidden); const tot = totalBase(); const rate = curRate();
  const recent = rows('transactions').filter(t => t.space_id === S.space).sort((a, b) => b.occurred_at - a.occurred_at).slice(0, 8);
  const [, e] = monthRange(m); const daysLeft = Math.max(1, Math.ceil((e - now()) / 86400000));
  const pct = bud ? Math.min(100, Math.round(sp.total / bud.limit_amount * 100)) : 0;
  return `<div class="top"><h1>Home</h1>${spaceSwitch()}</div>
  <div class="quick"><input id="qa" placeholder="Quick: “lunch 58000” or “taxi 25k”" enterkeyhint="done" autocomplete="off"><button data-act="qa">＋</button></div>
  <div class="card"><div class="lbl">Balance</div><div class="big">${fmt(tot, 'UZS')} UZS</div><div class="sub">≈ $${(tot / rate / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} at ${Math.round(rate)}${S.rates && S.rates.fetched_at ? ' · updated ' + dd(S.rates.fetched_at) + ' ' + hm(S.rates.fetched_at) : ''}</div></div>
  ${uncatList().length ? `<div class="card" data-act="uncat" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center"><div><b>${uncatList().length} without category</b><div class="sub">Tap to sort them</div></div><span class="sub">›</span></div>` : ''}
  <div class="card" data-go="/budget" style="cursor:pointer"><div class="lbl">Monthly budget</div>${bud ? `<div style="display:flex;justify-content:space-between;font-weight:600;margin-top:4px"><span>${fmt(sp.total, 'UZS')} / ${fmt(bud.limit_amount, 'UZS')}</span><span class="lbl">${pct}%</span></div><div class="bar"><i class="${sp.total > bud.limit_amount ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">Left ${fmt(bud.limit_amount - sp.total, 'UZS')} · ${daysLeft} d</div>` : `<div class="sub" style="margin-top:6px">No limit set. Spent: ${fmt(sp.total, 'UZS')}. Tap to set.</div>`}</div>
  <div class="card">${accs.map(a => `<div class="row" data-act="acc" data-id="${a.id}"><div class="ico">${accIcon(a)}</div><div class="grow"><b>${esc(a.name)}</b>${a.currency === 'USD' ? '<span class="sub">USD</span>' : ''}</div><div class="amt">${a.currency === 'USD' ? fmt(balance(a), 'USD') : fmt(balance(a), 'UZS')}</div></div>`).join('') || '<div class="sub">No accounts</div>'}</div>
  <div class="card"><div class="lbl">Recent</div>${recent.map(txRow).join('') || '<div class="sub" style="padding:10px 0">Nothing yet</div>'}</div>`;
}
function pgTrans() {
  const [a, b] = monthRange(curMonth()); const q = S.q.toLowerCase();
  const list = rows('transactions').filter(t => t.space_id === S.space && (S.uncat ? (t.type !== 'transfer' && !t.category_id) : (t.occurred_at >= a && t.occurred_at < b)) && (!S.accF || t.account_id === S.accF) &&
    (!q || (t.note + ' ' + t.merchant + ' ' + catPath(t.category_id)).toLowerCase().includes(q))).sort((x, y) => y.occurred_at - x.occurred_at);
  const days = {}; list.forEach(t => { const k = dd(t.occurred_at); (days[k] = days[k] || []).push(t); });
  const exp = list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_base, 0), inc = list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount_base, 0);
  return `<div class="top"><h1>Transactions</h1>${spaceSwitch()}</div>${mnav()}
  <div class="card" style="display:flex;justify-content:space-around;text-align:center"><div><div class="lbl">Expenses</div><b class="neg">${fmt(exp, 'UZS')}</b></div><div><div class="lbl">Income</div><b class="pos">${fmt(inc, 'UZS')}</b></div></div>
  <input id="srch" class="f" style="background:var(--card)" placeholder="Search" value="${esc(S.q)}">
  <div class="chips"><button class="chip ${S.uncat ? 'on' : ''}" data-act="uncatf">No category (${uncatList().length})</button><button class="chip ${!S.accF ? 'on' : ''}" data-act="accf" data-id="">All</button>${accounts().map(x => `<button class="chip ${S.accF === x.id ? 'on' : ''}" data-act="accf" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
  ${Object.keys(days).map(k => `<div class="day"><span>${k}</span><span>${fmt(days[k].filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_base, 0), 'UZS')}</span></div><div class="card" style="padding:4px 16px">${days[k].map(txRow).join('')}</div>`).join('') || '<div class="sub" style="text-align:center;padding:30px">No transactions</div>'}`;
}
const PAL = ['#3b6ef6', '#22a06b', '#f5a623', '#e5484d', '#9b6cf0', '#18b4c9', '#e26ba5', '#8b92a3'];
function pgStats() {
  const m = curMonth(); const sp = spentByRoot(m); const disp = S.dispCur || 'UZS'; const rate = curRate();
  const conv = (v) => disp === 'USD' ? v / rate : v; const f = (v) => disp === 'USD' ? fmt(Math.round(conv(v)), 'USD') : fmt(v, 'UZS');
  const items = Object.entries(sp.out).map(([id, v]) => ({ id, v, c: byId('categories', id) })).sort((a, b) => b.v - a.v);
  let acc = 0; const R = 70, C = 2 * Math.PI * R;
  const donut = sp.total ? `<svg viewBox="0 0 200 200" width="190" height="190" style="transform:rotate(-90deg)">${items.map((it, i) => { const len = it.v / sp.total * C; const s = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${PAL[i % PAL.length]}" stroke-width="36" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}"/>`; acc += len; return s; }).join('')}</svg>` : '<div class="sub">No expenses</div>';
  // столбцы по дням
  const [a, b] = monthRange(m); const nd = Math.round((b - a) / 86400000); const days = Array(nd).fill(0);
  rows('transactions').forEach(t => { if (t.space_id === S.space && t.type === 'expense' && t.occurred_at >= a && t.occurred_at < b) days[Math.floor((t.occurred_at - a) / 86400000)] += t.amount_base; });
  const mx = Math.max(1, ...days); const bw = 300 / nd;
  const bars = `<svg viewBox="0 0 300 100" width="100%" height="110" preserveAspectRatio="none">${days.map((v, i) => `<rect x="${i * bw + 1}" y="${100 - v / mx * 96}" width="${bw - 2}" height="${v / mx * 96}" rx="2" fill="var(--pri)"/>`).join('')}</svg>`;
  const bud = budgetFor(null, m);
  return `<div class="top"><h1>Stats</h1>${spaceSwitch()}</div>${mnav()}
  <div class="seg" style="width:max-content;margin-bottom:12px">${['UZS', 'USD'].map(c => `<button class="${disp === c ? 'on' : ''}" data-act="disp" data-id="${c}">${c}</button>`).join('')}</div>
  <div class="card" style="text-align:center"><div class="lbl">Spent this month</div><div class="big">${f(sp.total)}</div>${bud ? `<div class="sub">budget ${f(bud.limit_amount)} · used ${Math.round(sp.total / bud.limit_amount * 100)}%</div>` : ''}<div style="display:flex;justify-content:center;margin:12px 0">${donut}</div>
  ${items.map((it, i) => `<div class="legend"><i style="background:${PAL[i % PAL.length]}"></i><span class="grow">${it.c ? esc(it.c.name) : 'No category'}</span><b>${f(it.v)}</b><span class="sub" style="width:42px;text-align:right">${Math.round(it.v / sp.total * 100)}%</span></div>`).join('')}</div>
  <div class="card"><div class="lbl">By day</div>${bars}</div>`;
}
function pgAccounts() {
  const accs = accounts();
  return `<div class="top"><h1>Accounts</h1>${spaceSwitch()}</div>
  <div class="card">${accs.map(a => `<div class="row" data-act="accedit" data-id="${a.id}"><div class="ico">${accIcon(a)}</div><div class="grow"><b>${esc(a.name)}${a.card_last4 ? ' ···' + esc(a.card_last4) : ''}</b><span class="sub">${a.currency}${a.hidden ? ' · hidden' : ''}${a.exclude_from_total ? ' · excluded' : ''}</span></div><div class="amt">${fmt(balance(a), a.currency)}</div></div>`).join('')}</div>
  <div style="display:flex;gap:10px"><button class="btn sec full" data-act="accnew">+ Account</button><button class="btn full" data-act="addtransfer">Transfer</button></div>`;
}
function pgMore() {
  const l = [['/budget', 'target', 'Budget & limits'], ['/categories', 'grid', 'Categories'], ['/rate', 'rate', 'USD rate'], ['/settings', 'sliders', 'Settings, Telegram']];
  return `<div class="top"><h1>Profile</h1></div><div class="card">${l.map(([p, i, n]) => `<div class="row" data-go="${p}"><div class="ico">${svg(i)}</div><div class="grow"><b>${n}</b></div><span class="sub">›</span></div>`).join('')}</div><div class="stat" id="sbadge">${syncText()}</div>`;
}
function pgBudget() {
  const m = curMonth(); const sp = spentByRoot(m); const tot = budgetFor(null, m);
  const roots = cats('expense').filter(c => !c.parent_id && !c.archived);
  const line = (name, spent, b, cat) => { const lim = b ? b.limit_amount : 0; const pct = lim ? Math.min(100, Math.round(spent / lim * 100)) : 0; return `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b class="grow">${name}</b><input class="f" style="width:130px;margin:0;text-align:right" inputmode="decimal" data-bud="${cat || ''}" placeholder="limit" value="${lim ? Math.round(lim / 100) : ''}"></div><div class="bar"><i class="${lim && spent > lim ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">spent ${fmt(spent, 'UZS')}${lim ? ' · left ' + fmt(lim - spent, 'UZS') : ''}</div></div>`; };
  return `<div class="top"><h1>Budget</h1>${spaceSwitch()}</div>${mnav()}<div class="card"><div class="lbl">The limit applies to this and following months</div>${line('Whole month', sp.total, tot, '')}${roots.map(c => line(`<span class="lic">${rootIcon(c, 18)}</span>` + esc(c.name), sp.out[c.id] || 0, budgetFor(c.id, m), c.id)).join('')}</div>`;
}
function pgCats() {
  const roots = cats('expense').concat(cats('income')).filter(c => !c.parent_id && !c.archived);
  return `<div class="top"><h1>Categories</h1>${spaceSwitch()}</div>${roots.map(r => `<div class="card"><div class="row" data-act="catedit" data-id="${r.id}" style="padding-top:0"><div class="ico">${rootIcon(r)}</div><div class="grow"><b>${esc(r.name)}</b><span class="sub">${r.kind === 'income' ? 'income' : 'expense'}</span></div><span class="sub">✎</span></div>${cats().filter(c => c.parent_id === r.id && !c.archived).map(c => `<div class="row" data-act="catedit" data-id="${c.id}" style="padding-left:56px"><div class="grow">${esc(c.name)}</div><span class="sub">✎</span></div>`).join('')}<div class="row" data-act="catnew" data-id="${r.id}" style="padding-left:56px;color:var(--pri)">+ subcategory</div></div>`).join('')}<button class="btn sec full" data-act="catnew" data-id="">+ Category</button>`;
}
function pgRate() {
  const mode = setting('rate_mode', 'auto'), kind = setting('rate_kind', 'buy'); const r = S.rates || {};
  return `<div class="top"><h1>USD rate</h1></div><div class="card">
  <div class="row" style="cursor:default"><div class="grow"><b>Auto rate (Ipak Yuli)</b><span class="sub">fetched from the bank’s website</span></div><div class="sw ${mode === 'auto' ? 'on' : ''}" data-act="ratemode"></div></div>
  <div class="lbl" style="margin-top:12px">Which rate to use</div><div class="seg" style="margin:6px 0 12px;width:max-content"><button class="${kind === 'buy' ? 'on' : ''}" data-act="ratekind" data-id="buy">Bank buys</button><button class="${kind === 'sell' ? 'on' : ''}" data-act="ratekind" data-id="sell">Bank sells</button></div>
  <div class="sub">Buy is lower (the bank buys dollars from you). Sell is what you pay to buy dollars.</div>
  <div class="lbl" style="margin-top:14px">Manual rate (UZS per $1)</div><input class="f" id="ratem" inputmode="decimal" value="${esc(setting('rate_manual', ''))}" placeholder="e.g. 12700"></div>
  <div class="card"><div class="lbl">Now on the website</div><div style="margin-top:6px">Buy: <b>${r.buy ? Math.round(r.buy) : '—'}</b> · Sell: <b>${r.sell ? Math.round(r.sell) : '—'}</b> · CBU: <b>${r.cbu ? Math.round(r.cbu) : '—'}</b></div><div class="sub">Source: ${r.source === 'ipakyuli' ? 'Ipak Yuli' : r.source === 'cbu' ? 'cbu.uz (fallback)' : '—'}${r.fetched_at ? ' · ' + dd(r.fetched_at) + ' ' + hm(r.fetched_at) : ''}</div><div style="margin-top:10px">In use: <b>${Math.round(curRate())}</b></div><button class="btn sec" style="margin-top:12px" data-act="raterefresh">Refresh</button></div>`;
}
const TG_WHY = { no_token: '', tg_unreachable: ' · Telegram not reachable', no_webhook: ' · webhook not connected', error: ' · last delivery failed', check_failed: ' · status check failed', not_linked: '' };
const tgBadge = () => S.tgst ? (S.tgst.ok ? `<i class="okc">${svg('ok', 20)}</i>` : `<i class="badc">${svg('bad', 20)}</i>`) : '<i class="wait">…</i>';
const tgWhy = () => S.tgst && !S.tgst.ok ? (TG_WHY[S.tgst.reason] || '') : '';
async function checkTg() {
  S.tgstAt = now();
  const r = await api('/api/tg/status').catch(() => null);
  S.tgst = r && r.ok ? r.data : { ok: false, reason: 'check_failed' }; const el = document.getElementById('tgst'), why = document.getElementById('tgwhy');
  if (el) { el.innerHTML = tgBadge(); requestAnimationFrame(() => el.classList.add('on')); }
  if (why) why.textContent = tgWhy();
}
function pgSettings() {
  if (!S.tgstAt || now() - S.tgstAt > 60000) checkTg();
  const th = tryLS(() => localStorage.getItem('theme')) || 'auto'; const me = S.me || {};
  return `<div class="top"><h1>Settings</h1></div>
  <div class="card"><div class="lbl">Theme</div><div class="seg" style="margin-top:8px;width:max-content">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, n]) => `<button class="${th === k ? 'on' : ''}" data-act="theme" data-id="${k}">${n}</button>`).join('')}</div></div>
  <div class="card"><b>Telegram bot <span id="tgst" class="tgst on">${tgBadge()}</span></b><div class="sub" style="margin:4px 0 10px">${me.tg_ready ? (me.tg_linked ? `Linked chats: ${me.tg_linked}` : 'Not linked yet') : 'Bot token is not set on the server'}<span id="tgwhy">${tgWhy()}</span></div>
  <button class="btn sec" data-act="tgsetup">1. Connect webhook</button> <button class="btn" data-act="tgcode">2. Get code</button><div id="tgout" class="sub" style="margin-top:10px"></div></div>
  <div class="card"><b>URL for Shortcuts (SMS and Wallet)</b><div class="sub" style="margin:4px 0 8px">Secret. Don’t share it.</div>${me.hook_url ? `<code id="hook">${esc(me.hook_url)}</code><div style="margin-top:10px"><button class="btn sec" data-act="copyhook">Copy</button></div>` : '<div class="sub">Not set (WEBHOOK_SECRET)</div>'}</div>
  <div class="card"><b>Data</b><div class="sub" id="sbadge" style="margin:4px 0 10px">${syncText()}</div><button class="btn sec" data-act="syncnow">Sync now</button> <button class="btn sec" data-act="csv">Export CSV</button></div>
  <button class="btn red full" data-act="logout">Log out</button><div class="stat">${esc(me.login || '')}</div>`;
}
function renderLogin() {
  $app.innerHTML = `<div class="center pg"><h1 style="margin:0 0 4px">Budget</h1><div class="sub" style="margin-bottom:20px">Sign in</div><input class="f" style="background:var(--card)" id="lg" placeholder="Login" autocapitalize="none" autocomplete="username"><input class="f" style="background:var(--card)" id="pw" type="password" placeholder="Password" autocomplete="current-password"><div class="err" id="lgerr"></div><button class="btn full" data-act="login">Sign in</button></div>`;
}

// ---------- окна ----------
let F = {};
function openTx(id, type) {
  const t = id ? byId('transactions', id) : null;
  if (t && t.type === 'transfer') {
    const legs = rows('transactions').filter(x => x.transfer_group_id && x.transfer_group_id === t.transfer_group_id);
    const out = legs.find(x => x.amount < 0) || t, inn = legs.find(x => x.amount > 0);
    F = { id: t.id, group: t.transfer_group_id, legs, type: 'transfer', from: out.account_id, to: inn ? inn.account_id : '', amount: String(Math.abs(out.amount) / 100), amount2: inn ? String(inn.amount / 100) : '', note: t.note, date: dtLocal(t.occurred_at) };
  } else if (t) F = { id: t.id, type: t.type, account: t.account_id, amount: String(t.amount / 100), category: t.category_id || '', note: t.note || t.merchant || '', date: dtLocal(t.occurred_at) };
  else { const def = accounts().find(a => a.type === 'cash') || accounts()[0]; F = { type: type || 'expense', account: def && def.id, from: def && def.id, to: '', amount: '', amount2: '', category: '', note: '', date: dtLocal(now()) }; }
  drawTx();
}
function drawTx() {
  const accs = accounts(); const isT = F.type === 'transfer';
  const opts = (sel) => accs.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} (${a.currency})</option>`).join('');
  const kind = F.type === 'income' ? 'income' : 'expense';
  const catOpts = cats(kind).filter(c => !c.parent_id && !c.archived).map(p => `<optgroup label="${esc(p.name)}"><option value="${p.id}" ${F.category === p.id ? 'selected' : ''}>${esc(p.name)}</option>${cats(kind).filter(c => c.parent_id === p.id && !c.archived).map(c => `<option value="${c.id}" ${F.category === c.id ? 'selected' : ''}>${esc(p.name)} › ${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  const fa = isT ? byId('accounts', F.from) : byId('accounts', F.account), ta = isT ? byId('accounts', F.to) : null;
  const cross = isT && fa && ta && fa.currency !== ta.currency;
  openSheet(`<h2>${F.id ? 'Edit' : 'New transaction'}</h2>
  <div class="seg" style="margin-bottom:10px">${[['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']].map(([k, n]) => `<button style="flex:1" class="${F.type === k ? 'on' : ''}" data-act="ftype" data-id="${k}" ${F.id && F.type !== k && (F.type === 'transfer' || k === 'transfer') ? 'disabled' : ''}>${n}</button>`).join('')}</div>
  <input class="f amtin" id="f-amount" inputmode="decimal" placeholder="0" value="${esc(F.amount)}" data-f="amount" ${''}>
  ${isT ? `<div class="lbl">From</div><select class="f" data-f="from">${opts(F.from)}</select><div class="lbl">To</div><select class="f" data-f="to"><option value="">—</option>${opts(F.to)}</select>${cross ? `<div class="lbl">Amount received (${ta.currency})</div><input class="f" inputmode="decimal" data-f="amount2" value="${esc(F.amount2)}" placeholder="amount received">` : ''}`
      : `<div class="lbl">Account</div><select class="f" data-f="account">${opts(F.account)}</select><div class="lbl">Category</div><select class="f" data-f="category"><option value="">No category</option>${catOpts}</select>`}
  <div class="lbl">Note</div><input class="f" data-f="note" value="${esc(F.note)}" placeholder="What was it">
  <div class="lbl">Date and time</div><input class="f" type="datetime-local" data-f="date" value="${F.date}">
  ${!isT && fa && fa.currency === 'USD' ? `<div class="sub" style="margin-bottom:10px">Rate: ${Math.round(curRate())} (from settings)</div>` : ''}
  <div style="display:flex;gap:10px">${F.id ? '<button class="btn red" data-act="txdel">Delete</button>' : ''}<button class="btn full" data-act="txsave">Save</button></div>`);
  const am = document.getElementById('f-amount'); if (am && !F.id && !F.amount) setTimeout(() => am.focus(), 320);
}
function saveTx() {
  const amt = num(F.amount); if (!(amt > 0)) return toast('Enter an amount');
  const minor = Math.round(amt * 100); const ts = fromLocal(F.date);
  if (F.type === 'transfer') {
    const fa = byId('accounts', F.from), ta = byId('accounts', F.to); if (!fa || !ta || fa.id === ta.id) return toast('Pick two different accounts');
    let minor2 = minor; if (fa.currency !== ta.currency) { const a2 = num(F.amount2); if (!(a2 > 0)) return toast('Enter the amount received'); minor2 = Math.round(a2 * 100); }
    const g = F.group || rid(); const old = F.legs || [];
    const base = fa.currency === 'UZS' ? minor : minor2; const usd = fa.currency === 'USD' ? minor : ta.currency === 'USD' ? minor2 : 0; const fx = usd ? base / usd : 1;
    const mk = (prev, acc, amount) => ({ ...(prev || {}), id: prev ? prev.id : rid(), space_id: S.space, type: 'transfer', account_id: acc.id, amount, currency: acc.currency, fx_rate: fx, amount_base: acc.currency === 'USD' ? Math.round(amount * fx) : amount, category_id: null, note: F.note, merchant: '', occurred_at: ts, transfer_group_id: g, source: (prev && prev.source) || 'app' });
    const o = old.find(x => x.amount < 0), i = old.find(x => x.amount > 0);
    put('transactions', mk(o, fa, -minor)); put('transactions', mk(i, ta, minor2));
  } else {
    const acc = byId('accounts', F.account); if (!acc) return toast('Pick an account');
    const prev = F.id ? byId('transactions', F.id) : null;
    const tx = prev ? { ...prev } : makeTx({ type: F.type, account: acc, amount: minor });
    const usd = acc.currency === 'USD'; const fx = prev && prev.account_id === acc.id && prev.fx_rate ? prev.fx_rate : (usd ? curRate() : 1);
    Object.assign(tx, { type: F.type, account_id: acc.id, amount: minor, currency: acc.currency, fx_rate: fx, amount_base: usd ? Math.round(minor * fx) : minor, category_id: F.category || null, note: F.note, occurred_at: ts });
    put('transactions', tx);
    if (tx.merchant && tx.category_id) { /* память мерчант→категория ведёт бот; здесь не трогаем */ }
  }
  closeSheet(); toast('Saved');
}
function deleteTx() {
  if (F.type === 'transfer') (F.legs || []).forEach(l => del('transactions', l.id)); else del('transactions', F.id);
  closeSheet(); toast('Deleted');
}
function openAcc(id) {
  const a = id ? byId('accounts', id) : { type: 'card_uzs', currency: 'UZS', name: '', card_last4: '', opening_balance: 0, hidden: 0, exclude_from_total: 0 };
  F = { acc: id, ...a, opening: String((a.opening_balance || 0) / 100) };
  openSheet(`<h2>${id ? 'Account' : 'New account'}</h2><div class="lbl">Name</div><input class="f" data-f="name" value="${esc(a.name)}">
  <div class="lbl">Type</div><select class="f" data-f="type" ${id ? 'disabled' : ''}><option value="cash" ${a.type === 'cash' ? 'selected' : ''}>Cash</option><option value="card_uzs" ${a.type === 'card_uzs' ? 'selected' : ''}>UZS card</option><option value="card_visa" ${a.type === 'card_visa' ? 'selected' : ''}>Visa / USD</option></select>
  <div class="lbl">Card last 4 digits (for auto-import)</div><input class="f" data-f="card_last4" maxlength="4" inputmode="numeric" value="${esc(a.card_last4)}">
  <div class="lbl">Opening balance</div><input class="f" data-f="opening" inputmode="decimal" value="${esc(F.opening)}">
  <div class="row" style="cursor:default"><div class="grow">Hide</div><div class="sw ${a.hidden ? 'on' : ''}" data-act="fflag" data-id="hidden"></div></div>
  <div class="row" style="cursor:default"><div class="grow">Exclude from total</div><div class="sw ${a.exclude_from_total ? 'on' : ''}" data-act="fflag" data-id="exclude_from_total"></div></div>
  <div style="display:flex;gap:10px;margin-top:14px">${id ? '<button class="btn red" data-act="accdel">Delete</button>' : ''}<button class="btn full" data-act="accsave">Save</button></div>`);
}
function saveAcc() {
  if (!F.name.trim()) return toast('Enter a name');
  const cur = F.type === 'card_visa' ? 'USD' : 'UZS'; const prev = F.acc ? byId('accounts', F.acc) : null;
  put('accounts', { ...(prev || {}), id: prev ? prev.id : rid(), space_id: S.space, name: F.name.trim(), type: F.type, currency: prev ? prev.currency : cur, opening_balance: Math.round((num(F.opening) || 0) * 100), card_last4: F.card_last4 || '', sort: prev ? prev.sort : accounts().length, hidden: F.hidden ? 1 : 0, exclude_from_total: F.exclude_from_total ? 1 : 0 });
  closeSheet();
}
function openCat(id, parent) {
  const c = id ? byId('categories', id) : { name: '', icon: '', parent_id: parent || null, kind: parent ? (byId('categories', parent) || {}).kind : 'expense' };
  F = { cat: id, ...c };
  openSheet(`<h2>${id ? 'Category' : 'New category'}</h2><div class="lbl">Name</div><input class="f" data-f="name" value="${esc(c.name)}">
  ${c.parent_id ? '' : `<div class="lbl">Icon (emoji)</div><input class="f" data-f="icon" value="${esc(c.icon)}"><div class="lbl">Type</div><select class="f" data-f="kind" ${id ? 'disabled' : ''}><option value="expense" ${c.kind === 'expense' ? 'selected' : ''}>Expense</option><option value="income" ${c.kind === 'income' ? 'selected' : ''}>Income</option></select>`}
  <div style="display:flex;gap:8px;margin:6px 0 14px">${id ? '<button class="btn sec" data-act="catup">↑</button><button class="btn sec" data-act="catdown">↓</button><button class="btn sec" data-act="catarch">Archive</button>' : ''}</div>
  <button class="btn full" data-act="catsave">Save</button>`);
}
function saveCat() {
  if (!F.name.trim()) return toast('Enter a name');
  const prev = F.cat ? byId('categories', F.cat) : null;
  const sibs = cats().filter(x => (x.parent_id || null) === (F.parent_id || null));
  put('categories', { ...(prev || {}), id: prev ? prev.id : rid(), space_id: S.space, parent_id: F.parent_id || null, name: F.name.trim(), kind: F.kind || 'expense', sort: prev ? prev.sort : sibs.length + 1, icon: F.icon || '', archived: prev ? prev.archived || 0 : 0 });
  closeSheet();
}
function moveCat(d) {
  const c = byId('categories', F.cat); const sibs = cats().filter(x => (x.parent_id || null) === (c.parent_id || null) && x.kind === c.kind);
  const i = sibs.findIndex(x => x.id === c.id), j = i + d; if (j < 0 || j >= sibs.length) return;
  sibs.splice(j, 0, sibs.splice(i, 1)[0]); sibs.forEach((x, k) => { if (x.sort !== k) put('categories', { ...x, sort: k }); }); closeSheet();
}

// ---------- события ----------
document.addEventListener('click', async (e) => {
  const a = e.target.closest('[data-act]'); const g = e.target.closest('[data-go]');
  if (!a && g) { e.preventDefault(); return go(g.dataset.go); }
  if (!a) return; const act = a.dataset.act, id = a.dataset.id;
  switch (act) {
    case 'login': { const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ login: document.getElementById('lg').value.trim(), password: document.getElementById('pw').value }) }).catch(() => null);
      const er = document.getElementById('lgerr');
      if (!r) return er.textContent = 'No connection to the server';
      if (!r.ok) return er.textContent = r.data.error === 'locked' ? 'Too many attempts, wait 15 minutes' : 'Wrong login or password';
      S.user = document.getElementById('lg').value.trim(); S.route = '/'; history.replaceState({}, '', '/'); await boot(true); break; }
    case 'logout': await api('/api/logout', { method: 'POST' }).catch(() => 0); await logoutLocal(); break;
    case 'add': openTx(null); break;
    case 'qa': { const i = document.getElementById('qa'); if (i.value.trim()) { quickAdd(i.value); i.value = ''; } break; }
    case 'space': S.space = id; persist(); render(); break;
    case 'mprev': S.month = shiftMonth(curMonth(), -1); render(); break;
    case 'mnext': S.month = shiftMonth(curMonth(), 1); render(); break;
    case 'accf': S.accF = id; render(); break;
    case 'uncat': S.uncat = true; S.accF = ''; S.q = ''; go('/transactions'); break;
    case 'uncatf': S.uncat = !S.uncat; render(); break;
    case 'disp': S.dispCur = id; render(); break;
    case 'tx': openTx(id); break;
    case 'acc': go('/transactions'); S.accF = id; render(); break;
    case 'addtransfer': openTx(null, 'transfer'); break;
    case 'ftype': F.type = id; if (id === 'income' || id === 'expense') F.category = ''; drawTx(); break;
    case 'txsave': saveTx(); break;
    case 'txdel': deleteTx(); break;
    case 'accedit': openAcc(id); break;
    case 'accnew': openAcc(null); break;
    case 'fflag': F[id] = F[id] ? 0 : 1; a.classList.toggle('on'); break;
    case 'accsave': saveAcc(); break;
    case 'accdel': del('accounts', F.acc); closeSheet(); break;
    case 'catedit': openCat(id); break;
    case 'catnew': openCat(null, id || null); break;
    case 'catsave': saveCat(); break;
    case 'catarch': put('categories', { ...byId('categories', F.cat), archived: 1 }); closeSheet(); break;
    case 'catup': moveCat(-1); break;
    case 'catdown': moveCat(1); break;
    case 'ratemode': setSetting('rate_mode', setting('rate_mode', 'auto') === 'auto' ? 'manual' : 'auto'); render(true); break;
    case 'ratekind': setSetting('rate_kind', id); render(true); break;
    case 'raterefresh': { const r = await api('/api/rate?force=1').catch(() => null); if (r && r.ok) { S.rates = r.data; persist(); render(true); toast('Rate updated'); } else toast('Couldn’t update'); break; }
    case 'theme': tryLS(() => localStorage.setItem('theme', id)); applyTheme(); render(true); break;
    case 'syncnow': await sync(); toast('Done'); break;
    case 'copyhook': tryLS(() => navigator.clipboard.writeText(S.me.hook_url)); toast('Copied'); break;
    case 'tgsetup': { const r = await api('/api/tg/setup', { method: 'POST' }).catch(() => null); document.getElementById('tgout').textContent = r && r.data.ok ? 'Webhook connected: @' + r.data.bot : 'Error: ' + (r ? (r.data.desc || r.data.error) : 'no connection'); checkTg(); break; }
    case 'tgcode': { const r = await api('/api/tg/code', { method: 'POST' }).catch(() => null); document.getElementById('tgout').innerHTML = r && r.ok ? `Send this code to the bot (10 minutes): <b style="font-size:22px">${r.data.code}</b>` : 'Error'; break; }
    case 'csv': exportCsv(); break;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.f) { F[el.dataset.f] = el.value; if (['from', 'to', 'account'].includes(el.dataset.f) && F.type === 'transfer' || el.dataset.f === 'account') { if (F.type === 'transfer') drawTx(); } }
  if (el.id === 'srch') { S.q = el.value; const p = el.selectionStart; render(); const n = document.getElementById('srch'); if (n) { n.focus(); n.setSelectionRange(p, p); } }
  if (el.dataset.bud !== undefined) { clearTimeout(el._t); el._t = setTimeout(() => saveBudget(el.dataset.bud, el.value), 700); }
  if (el.id === 'ratem') { clearTimeout(el._t); el._t = setTimeout(() => setSetting('rate_manual', el.value.replace(',', '.')), 600); }
});
document.addEventListener('change', (e) => { const el = e.target; if (el.dataset.f && F.type === 'transfer' && ['from', 'to'].includes(el.dataset.f)) drawTx(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'qa' && e.target.value.trim()) { quickAdd(e.target.value); e.target.value = ''; } if (e.key === 'Enter' && e.target.id === 'pw') document.querySelector('[data-act=login]').click(); });
function saveBudget(cat, val) {
  const m = curMonth(); const key = `${S.space}:${m}:${cat || 'all'}`; const v = num(val); const prev = S.db.budgets[key];
  if (!(v > 0)) { if (prev && !prev.deleted_at) put('budgets', { ...prev, limit_amount: 0 }); else if (budgetFor(cat || null, m)) put('budgets', { id: key, space_id: S.space, month: m, category_id: cat || null, limit_amount: 0, currency: 'UZS' }); return; }
  put('budgets', { ...(prev || {}), id: key, space_id: S.space, month: m, category_id: cat || null, limit_amount: Math.round(v * 100), currency: 'UZS', deleted_at: null });
}
function exportCsv() {
  const L = ['Date;Type;Account;Amount;Currency;Category;Note;Source'];
  rows('transactions').filter(t => t.space_id === S.space).sort((a, b) => a.occurred_at - b.occurred_at).forEach(t => L.push([dd(t.occurred_at) + ' ' + hm(t.occurred_at), t.type, (byId('accounts', t.account_id) || {}).name, t.amount / 100, t.currency, catPath(t.category_id), (t.note || t.merchant || '').replace(/;/g, ','), t.source].join(';')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + L.join('\n')], { type: 'text/csv' })); a.download = 'budget.csv'; a.click();
}
function applyTheme() {
  const th = tryLS(() => localStorage.getItem('theme')) || 'auto';
  const dark = th === 'dark' || (th === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  const mt = document.querySelector('meta[name=theme-color]'); if (mt) mt.content = dark ? '#0f1115' : '#f3f4f8';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
async function logoutLocal() { S.user = null; TABLES.forEach(t => { S.db[t] = {}; S.queue[t] = {}; }); S.cursor = 0; S.space = null; S.me = null; await idb.clear(); closeSheet(); render(); }

// ---------- старт ----------
async function boot(fresh) {
  applyTheme();
  if (!fresh) {
    const st = await idb.get('state');
    if (st && st.user) { Object.assign(S, { db: { ...S.db, ...st.db }, queue: { ...S.queue, ...st.queue }, cursor: st.cursor || 0, user: st.user, space: st.space, rates: st.rates, me: st.me }); TABLES.forEach(t => { S.db[t] = S.db[t] || {}; S.queue[t] = S.queue[t] || {}; }); }
    S.route = location.pathname;
  }
  ensureSpace(); render();
  if (navigator.onLine) {
    try {
      const [me, rate] = await Promise.all([api('/api/me', {}, 10000), api('/api/rate', {}, 15000).catch(() => null)]);
      if (me.ok) { S.me = me.data; S.user = me.data.login; lastStamp = me.data.stamp; }
      if (rate && rate.ok) S.rates = rate.data;
      await sync(); ensureSpace(); persist(); render();
    } catch (e) { /* без сети остаёмся на кэше; 401 обработан в api() */ }
  }
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => 0);
boot();

// свайпы между разделами
(() => {
  let x0 = 0, y0 = 0, t0 = 0, ok = false;
  document.addEventListener('touchstart', (e) => {
    const t = e.touches[0]; x0 = t.clientX; y0 = t.clientY; t0 = Date.now();
    ok = e.touches.length === 1 && !ovEl && S.user && MAIN.includes(S.route) && !e.target.closest('input,select,textarea,.chips,.ov');
  }, { passive: true });
  document.addEventListener('touchend', (e) => {
    if (!ok) return; ok = false;
    const t = e.changedTouches[0]; const dx = t.clientX - x0, dy = t.clientY - y0;
    if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5 || Date.now() - t0 > 700) return;
    const i = MAIN.indexOf(S.route), j = i + (dx < 0 ? 1 : -1);
    if (j >= 0 && j < MAIN.length) go(MAIN[j]);
  }, { passive: true });
})();
