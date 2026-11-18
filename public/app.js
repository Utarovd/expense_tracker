'use strict';
// Бюджет: SPA на чистом JS. Данные в IndexedDB, очередь изменений уходит в /api/sync.
const TABLES = ['spaces', 'accounts', 'categories', 'transactions', 'budgets', 'settings'];
const TZ = 5 * 3600000;
const $app = document.getElementById('app');
const tryLS = (f) => { try { return f(); } catch (e) { return null; } };
const S = { user: null, db: {}, queue: {}, cursor: 0, space: null, route: '/', month: null, rates: null, me: null, online: navigator.onLine, syncing: false, lastSync: 0, q: '', accF: '', uncat: false, pending: 0, per: '1M', hide: tryLS(() => localStorage.getItem('hideAmt')) === '1' };
TABLES.forEach(t => { S.db[t] = {}; S.queue[t] = {}; });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const rid = () => crypto.randomUUID().replace(/-/g, '').slice(0, 14);
const now = () => Date.now();

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
// разовая перестановка: Visa в конец списка счетов (Doniyor, 19.11)
function migrateVisaLast() {
  if (setting('m_visa_last', '')) return;
  const all = rows('accounts'); if (!all.length) return;
  [...new Set(all.map(a => a.space_id))].forEach(sp => {
    const list = all.filter(a => a.space_id === sp); const mx = Math.max(...list.map(a => a.sort || 0));
    list.filter(a => a.type === 'card_visa').forEach((v, i) => { if ((v.sort || 0) < mx || list.filter(a => (a.sort || 0) === mx).length > 1) put('accounts', { ...v, sort: mx + 1 + i }); });
  });
  setSetting('m_visa_last', '1');
}
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
    migrateVisaLast();
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
const fmtRate = (r) => Math.round(r).toLocaleString('ru-RU').replace(/\s/g, ' ') + ' UZS';
function fmt(minor, cur, bare) {
  const u = cur === 'USD' || bare ? '' : ' UZS';
  if (S.hide) return cur === 'USD' ? '$*****' : '*****' + u;
  const v = minor / 100;
  if (cur === 'USD') return (v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '−' : '') + Math.abs(Math.round(v)).toLocaleString('ru-RU').replace(/ /g, ' ') + u;
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
  add: 'M12 5v14M5 12h14',
  grip: 'M5 8h14M5 12h14M5 16h14',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeoff: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM4 4l16 16',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0zM8 8h.01',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.3l2.7 2.7L16 9.5',
  bad: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
};
const svg = (n, sz = 22) => `<svg class="i i-${n}" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const CATIC = { food: 'food', leisure: 'game', transport: 'car', expenses: 'receipt', family: 'family', shopping: 'bag', health: 'heart', salary: 'wallet', 'other income': 'plus' };
const rootIcon = (r, sz) => !r ? svg('tag', sz) : CATIC[String(r.name).toLowerCase()] ? svg(CATIC[String(r.name).toLowerCase()], sz) : r.icon ? `<span class="emo">${esc(r.icon)}</span>` : svg('tag', sz);
const accIcon = (a) => svg(a.type === 'cash' ? 'cash' : a.type === 'card_visa' ? 'globe' : 'card');
const catIcon = (id) => rootIcon(rootOf(id));
function spentByRoot(m, space = S.space, rng) {
  const [a, b] = rng || monthRange(m); const out = {}; let total = 0;
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
// группировка разрядов: 1234567,5 → 1 234 567,5
const grp = (v) => { v = String(v ?? '').replace(/\s/g, ''); const i = v.search(/[.,]/); const int = i > -1 ? v.slice(0, i) : v; const rest = i > -1 ? v.slice(i) : ''; return int.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + rest; };
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
  haptic(); toast(`${q.income ? '+' : '−'}${fmt(q.amount, acc.currency)} · ${acc.name}` + (cat ? '' : ' · tap to pick a category'), cat ? null : () => openTx(tx.id));
}

// ---------- UI-утилиты ----------
let toastT;
// отклик вибрацией: Android через vibrate, iPhone (Safari 18+) через системный переключатель
let hapEl;
function haptic() {
  try {
    if (navigator.vibrate) { navigator.vibrate(12); return; }
    if (!hapEl) { hapEl = document.createElement('label'); hapEl.style.cssText = 'position:fixed;left:-99px;top:0;opacity:0;pointer-events:none'; hapEl.innerHTML = '<input type="checkbox" switch>'; document.body.appendChild(hapEl); }
    hapEl.click();
  } catch (e) { /* нет поддержки */ }
}
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
// подтверждение (как alert в iOS): Promise<boolean>
function ask(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'cf';
    el.innerHTML = `<div class="cfb" role="alertdialog"><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}<div class="cfa"><button data-r="0">Cancel</button><button data-r="1" class="dng">${esc(okLabel)}</button></div></div>`;
    const done = (v) => { document.removeEventListener('keydown', key, true); el.classList.remove('open'); setTimeout(() => el.remove(), 250); res(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    el.addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('button'); if (b) done(b.dataset.r === '1'); else if (e.target === el) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(el); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  });
}

// ---------- роутинг ----------
const MAIN = ['/', '/transactions', '/stats', '/more'];
let slideDir = '';
const PAGES = () => ({ '/': pgHome, '/transactions': pgTrans, '/stats': pgStats, '/accounts': pgAccounts, '/more': pgMore, '/budget': pgBudget, '/categories': pgCats, '/rate': pgRate, '/settings': pgSettings });
function go(path, replace) { const a = MAIN.indexOf(S.route), b = MAIN.indexOf(path); slideDir = a > -1 && b > -1 ? (b > a ? 'pg-next' : 'pg-prev') : ''; if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path); S.route = path; render(); window.scrollTo(0, 0); }
window.addEventListener('popstate', () => { slideDir = ''; closeSheet(); S.route = location.pathname; render(); });
let lastRoute = null;
function render(soft) {
  if (!S.user) { if (S.route !== '/login') { S.route = '/login'; history.replaceState({}, '', '/login'); } return renderLogin(); }
  if (S.route === '/login') { S.route = '/'; history.replaceState({}, '', '/'); }
  const r = S.route;
  const fn = PAGES()[r] || pgHome;
  const main = MAIN.includes(r) ? r : '/more';
  const scroll = soft ? window.scrollY : 0;
  const focus = document.activeElement && document.activeElement.id;
  const keep = soft && document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest('#app');
  if (keep) return; // не перерисовываем поверх вводимого текста
  $app.innerHTML = `<div class="${lastRoute !== r && !soft ? 'pg ' + slideDir : ''}">${fn()}</div>` + nav(main) ;
  lastRoute = r;
  animateBalance();
  if (soft) window.scrollTo(0, scroll);
  if (focus) { const e = document.getElementById(focus); if (e) e.focus(); }
}
function nav(on) {
  const it = [['/', 'home', 'Home'], ['/transactions', 'list', 'Transactions'], ['/stats', 'chart', 'Stats'], ['/more', 'user', 'Profile']];
  const a = ([p, i, n]) => `<a href="${p}" data-go="${p}" class="${p === on ? 'on' : ''}"><span>${svg(i, 24)}</span>${n}</a>`;
  return `<div class="nav"><div>${it.slice(0, 2).map(a).join('')}<div class="navadd"><button data-act="add" aria-label="Add">${svg('add', 28)}</button></div>${it.slice(2).map(a).join('')}</div></div>`;
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

// ---------- Home: лимиты, пустые состояния, анимация баланса ----------
function limitsCard(m, sp) {
  const rs = cats('expense').filter(c => !c.parent_id && !c.archived).map(c => { const b = budgetFor(c.id, m); return b && b.limit_amount > 0 ? { c, b, v: sp.out[c.id] || 0 } : null; }).filter(Boolean)
    .map(x => ({ ...x, p: Math.round(x.v / x.b.limit_amount * 100) })).sort((a, b) => b.p - a.p).slice(0, 3);
  if (!rs.length) return '';
  return `<div class="card" data-go="/budget" style="cursor:pointer"><div class="lbl">Category limits</div>${rs.map(x => `<div class="lim"><div class="limh"><div class="ico sm">${rootIcon(x.c, 18)}</div><b class="grow">${esc(x.c.name)}</b><span class="sub">${fmt(x.v, 'UZS', 1)} / ${fmt(x.b.limit_amount, 'UZS')}</span></div><div class="bar"><i class="${x.p >= 90 ? 'gr-red' : x.p >= 50 ? 'gr-ylw' : 'gr-grn'}" style="width:${Math.min(100, x.p)}%"></i></div><div class="sub limp">${x.p}%${x.p >= 100 ? ' · over the limit' : x.p >= 90 ? ' · almost at the limit' : ''}</div></div>`).join('')}</div>`;
}
const emptyState = () => `<div class="empty"><svg width="112" height="90" viewBox="0 0 120 96" fill="none" aria-hidden="true"><ellipse cx="60" cy="88" rx="38" ry="5" fill="var(--line)"/><rect x="22" y="24" width="76" height="52" rx="12" fill="#1b2f5e"/><path d="M22 38c0-7 5-12 12-12h52c7 0 12 5 12 12" stroke="#5b7bc4" stroke-width="3" stroke-linecap="round"/><rect x="70" y="46" width="30" height="18" rx="7" fill="#f5c518"/><circle cx="79" cy="55" r="3.2" fill="#1b2f5e"/><path d="M95 8l2.5 6 6 2.5-6 2.5-2.5 6-2.5-6-6-2.5 6-2.5z" fill="#f5c518"/><path d="M27 6l1.5 3.5L32 11l-3.5 1.5L27 16l-1.5-3.5L22 11l3.5-1.5z" fill="#f5c518" opacity=".7"/></svg><b>Your expenses will appear here</b><span class="sub">Add one with the yellow + or send it to the bot</span></div>`;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(ts) {
  const day = (x) => Math.floor((x + TZ) / 86400000); const d = day(ts), t = day(now());
  if (d === t) return 'Today'; if (d === t - 1) return 'Yesterday';
  const x = new Date(ts + TZ); return `${MS[x.getUTCMonth()]} ${x.getUTCDate()} (${WD[x.getUTCDay()]})`;
}
function dayNet(list) {
  const n = list.reduce((s, t) => s + (t.type === 'income' ? t.amount_base : t.type === 'expense' ? -t.amount_base : 0), 0);
  return n === 0 ? '<span class="sub">0</span>' : `<span class="${n > 0 ? 'pos' : 'neg'}">${n > 0 ? '+' : '−'}${fmt(Math.abs(n), 'UZS')}</span>`;
}
let balAnim;
function animateBalance() {
  const el = document.getElementById('bal'); if (!el) { S.balShown = null; return; }
  const to = +el.dataset.v; const from = S.balShown ?? to; S.balShown = to;
  if (from === to || S.hide) return; cancelAnimationFrame(balAnim);
  const t0 = performance.now(), dur = 600;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); const v = Math.round((from + (to - from) * e) / 100) * 100; const n = document.getElementById('bal'); if (!n) return; n.textContent = fmt(v, 'UZS'); if (k < 1) balAnim = requestAnimationFrame(step); };
  balAnim = requestAnimationFrame(step);
}
function pgHome() {
  const m = monthKey(now()); const bud = budgetFor(null, m); const sp = spentByRoot(m);
  const accs = accounts().filter(a => !a.hidden); const tot = totalBase(); const rate = curRate();
  const recent = rows('transactions').filter(t => t.space_id === S.space).sort((a, b) => b.occurred_at - a.occurred_at).slice(0, 8);
  const [, e] = monthRange(m); const daysLeft = Math.max(1, Math.ceil((e - now()) / 86400000));
  const pct = bud ? Math.min(100, Math.round(sp.total / bud.limit_amount * 100)) : 0;
  return `<div class="top"><h1>Home</h1>${spaceSwitch()}</div>
  <div class="quick"><input id="qa" placeholder="Quick: “lunch 58000” or “taxi 25k”" enterkeyhint="done" autocomplete="off"><button data-act="qa">＋</button></div>
  <div class="card hero"><button class="eyeb" data-act="hide" aria-label="${S.hide ? 'Show amounts' : 'Hide amounts'}">${svg(S.hide ? 'eye' : 'eyeoff', 22)}</button><div class="lbl">Balance</div><div class="big" id="bal" data-v="${tot}">${fmt(S.balShown ?? tot, 'UZS')}</div><div class="sub">≈ $${S.hide ? '*****' : (tot / rate / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} at ${fmtRate(rate)}${S.rates && S.rates.fetched_at ? ' · updated ' + dd(S.rates.fetched_at) + ' ' + hm(S.rates.fetched_at) : ''}</div></div>
  ${uncatList().length ? `<div class="card" data-act="uncat" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center"><div><b>${uncatList().length} without category</b><div class="sub">Tap to sort them</div></div><span class="sub">›</span></div>` : ''}
  <div class="card" data-go="/budget" style="cursor:pointer"><div class="lbl">Monthly budget</div>${bud ? `<div style="display:flex;justify-content:space-between;font-weight:600;margin-top:4px"><span>${fmt(sp.total, 'UZS', 1)} / ${fmt(bud.limit_amount, 'UZS')}</span><span class="lbl">${pct}%</span></div><div class="bar"><i class="${sp.total > bud.limit_amount ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">Left ${fmt(bud.limit_amount - sp.total, 'UZS')} · ${daysLeft} d</div>` : `<div class="sub" style="margin-top:6px">No limit set. Spent: ${fmt(sp.total, 'UZS')}. Tap to set.</div>`}</div>
  ${limitsCard(m, sp)}
  <div class="card">${accs.map(a => `<div class="row" data-act="acc" data-id="${a.id}"><div class="ico">${accIcon(a)}</div><div class="grow"><b>${esc(a.name)}</b>${a.currency === 'USD' ? '<span class="sub">USD</span>' : ''}</div><div class="amt">${a.currency === 'USD' ? fmt(balance(a), 'USD') : fmt(balance(a), 'UZS')}</div></div>`).join('') || '<div class="sub">No accounts</div>'}</div>
  <div class="card"><div class="lbl">Recent</div>${recent.map(txRow).join('') || emptyState()}</div>`;
}
function pgTrans() {
  const [a, b] = monthRange(curMonth()); const q = S.q.toLowerCase();
  const list = rows('transactions').filter(t => t.space_id === S.space && (S.uncat ? (t.type !== 'transfer' && !t.category_id) : (t.occurred_at >= a && t.occurred_at < b)) && (!S.accF || t.account_id === S.accF) &&
    (!q || (t.note + ' ' + t.merchant + ' ' + catPath(t.category_id)).toLowerCase().includes(q))).sort((x, y) => y.occurred_at - x.occurred_at);
  const days = {}; list.forEach(t => { const k = dayLabel(t.occurred_at); (days[k] = days[k] || []).push(t); });
  const exp = list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_base, 0), inc = list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount_base, 0);
  return `<div class="top"><h1>Transactions</h1>${spaceSwitch()}</div>${mnav()}
  <div class="card" style="display:flex;justify-content:space-around;text-align:center"><div><div class="lbl">Expenses</div><b class="neg">${fmt(exp, 'UZS')}</b></div><div><div class="lbl">Income</div><b class="pos">${fmt(inc, 'UZS')}</b></div></div>
  <input id="srch" class="f" style="background:var(--card)" placeholder="Search" value="${esc(S.q)}">
  <div class="chips"><button class="chip ${S.uncat ? 'on' : ''}" data-act="uncatf">No category (${uncatList().length})</button><button class="chip ${!S.accF ? 'on' : ''}" data-act="accf" data-id="">All</button>${accounts().map(x => `<button class="chip ${S.accF === x.id ? 'on' : ''}" data-act="accf" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
  ${Object.keys(days).map(k => `<div class="day"><span>${k}</span>${dayNet(days[k])}</div><div class="card" style="padding:4px 16px">${days[k].map(txRow).join('')}</div>`).join('') || `<div class="card">${emptyState()}</div>`}`;
}
const PAL = ['#3b6ef6', '#22a06b', '#f5a623', '#e5484d', '#9b6cf0', '#18b4c9', '#e26ba5', '#8b92a3'];
const CATCOL = { food: '#f97316', leisure: '#8b5cf6', transport: '#3b82f6', expenses: '#0d9488', family: '#ec4899', shopping: '#d97706', health: '#ef4444', salary: '#16a34a', 'other income': '#16a34a' };
const colOf = (it, i) => (it.c && CATCOL[String(it.c.name).toLowerCase()]) || PAL[i % PAL.length];
function selSlice(id) {
  const box = document.querySelector('.dwrap'); if (!box) return;
  const cur = box.dataset.sel || ''; const nx = cur === id ? '' : id; box.dataset.sel = nx; box.classList.toggle('has', !!nx);
  box.querySelectorAll('.sl').forEach(c => c.classList.toggle('on', c.dataset.id === nx));
  box.querySelectorAll('.dc,.sdet').forEach(c => c.classList.toggle('on', c.dataset.for === nx));
  document.querySelectorAll('.legend').forEach(l => l.classList.toggle('on', l.dataset.id === nx));
  haptic();
}
const PERN = { '1M': 1, '3M': 3, '1Y': 12 };
function perRange(m, per) {
  if (per === 'All') return [-Infinity, Infinity];
  const n = PERN[per] || 1; return [monthRange(shiftMonth(m, 1 - n))[0], monthRange(m)[1]];
}
const MSH = (m) => MN[+m.split('-')[1] - 1].slice(0, 3);
function perLabel(m, per) {
  if (per === '1M') return monthName(m);
  const f = shiftMonth(m, 1 - PERN[per]); return `${MSH(f)} ${f.split('-')[0] !== m.split('-')[0] ? f.split('-')[0] + ' ' : ''}– ${MSH(m)} ${m.split('-')[0]}`;
}
function shortAmt(minor, disp, rate) {
  if (S.hide) return '***';
  let v = minor / 100; if (disp === 'USD') v = v / rate;
  const a = Math.abs(v); const s = a >= 1e9 ? (a / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? Math.round(a / 1e3) + 'k' : String(Math.round(a));
  return (disp === 'USD' ? '$' : '') + s.replace('.0', '');
}
function trendChart(m, disp, rate) {
  const ms = []; for (let i = 5; i >= 0; i--) ms.push(shiftMonth(m, -i));
  const vals = ms.map(x => { const [a, b] = monthRange(x); let e = 0, inc = 0; rows('transactions').forEach(t => { if (t.space_id === S.space && t.occurred_at >= a && t.occurred_at < b) { if (t.type === 'expense') e += t.amount_base; else if (t.type === 'income') inc += t.amount_base; } }); return { m: x, e, inc }; });
  const mx = Math.max(1, ...vals.map(v => v.e)); const H = 100, top = 22;
  const bars = vals.map((v, i) => { const he = v.e / mx * H; const cur = v.m === m;
    return `<g data-act="trendm" data-id="${v.m}" style="cursor:pointer"><rect x="${i * 50}" y="0" width="50" height="${top + H + 24}" fill="transparent"/>
    <rect class="bx${cur ? ' on' : ''}" x="${i * 50 + 11}" y="${top + H - he}" width="28" height="${he}" rx="5"/>
    <text x="${i * 50 + 25}" y="${top + H - he - 6}" text-anchor="middle" class="tv${cur ? ' on' : ''}">${v.e ? shortAmt(v.e, disp, rate) : ''}</text>
    <text x="${i * 50 + 25}" y="${top + H + 17}" text-anchor="middle" class="tm${cur ? ' on' : ''}">${MSH(v.m)}</text></g>`; }).join('');
  const avg = vals.reduce((x, v) => x + v.e, 0) / 6;
  return `<div class="card"><div class="lbl">Expenses · last 6 months</div><svg class="trend" viewBox="0 0 300 ${top + H + 24}" width="100%">${bars}</svg><div class="tleg">Average ${shortAmt(avg, disp, rate)} / month · tap a month to open it</div></div>`;
}
function pgStats() {
  const m = curMonth(); const per = S.per || '1M'; const rng = perRange(m, per); const sp = spentByRoot(m, S.space, rng); const disp = S.dispCur || 'UZS'; const rate = curRate();
  const conv = (v) => disp === 'USD' ? v / rate : v; const f = (v) => disp === 'USD' ? fmt(Math.round(conv(v)), 'USD') : fmt(v, 'UZS');
  const items = Object.entries(sp.out).map(([id, v]) => ({ id, v, c: byId('categories', id) })).sort((a, b) => b.v - a.v);
  let acc = 0; const R = 70, C = 2 * Math.PI * R; const [a0, b0] = rng;
  const pct = (v) => Math.round(v / sp.total * 100);
  const donut = sp.total ? `<div class="donut"><svg viewBox="0 0 200 200" width="200" height="200" style="transform:rotate(-90deg)">${items.map((it, i) => { const len = it.v / sp.total * C; const gap = items.length > 1 ? 1.5 : 0; const s = `<circle data-act="slice" data-id="${it.id}" class="sl" r="${R}" cx="100" cy="100" fill="none" stroke="${colOf(it, i)}" stroke-width="34" stroke-dasharray="${Math.max(0.1, len - gap)} ${C - len + gap}" stroke-dashoffset="${-acc}"/>`; acc += len; return s; }).join('')}</svg>
    <div class="dc" data-for=""><b>${f(sp.total)}</b><span>total</span></div>${items.map((it, i) => `<div class="dc" data-for="${it.id}"><b style="color:${colOf(it, i)}">${pct(it.v)}%</b><span>${it.c ? esc(it.c.name) : 'No category'}</span></div>`).join('')}</div>`
    + items.map((it, i) => { const subs = {}; rows('transactions').forEach(t => { if (t.space_id === S.space && t.type === 'expense' && t.occurred_at >= a0 && t.occurred_at < b0 && (rootOf(t.category_id) ? rootOf(t.category_id).id : '_none') === it.id) { const k = t.category_id && t.category_id !== it.id ? byId('categories', t.category_id).name : 'General'; subs[k] = (subs[k] || 0) + t.amount_base; } });
      return `<div class="sdet" data-for="${it.id}"><div class="sdh"><b>${it.c ? esc(it.c.name) : 'No category'}</b><b>${f(it.v)}</b></div>${Object.entries(subs).sort((x, y) => y[1] - x[1]).map(([k, v]) => `<div class="sdr"><span>${esc(k)}</span><span>${f(v)}</span></div>`).join('')}</div>`; }).join('')
    : '<div class="sub">No expenses</div>';
  // столбцы по дням
  const [a, b] = monthRange(m); const nd = Math.round((b - a) / 86400000); const days = Array(nd).fill(0);
  rows('transactions').forEach(t => { if (t.space_id === S.space && t.type === 'expense' && t.occurred_at >= a && t.occurred_at < b) days[Math.floor((t.occurred_at - a) / 86400000)] += t.amount_base; });
  const mx = Math.max(1, ...days); const bw = 300 / nd;
  const bars = `<svg viewBox="0 0 300 100" width="100%" height="110" preserveAspectRatio="none">${days.map((v, i) => `<rect x="${i * bw + 1}" y="${100 - v / mx * 96}" width="${bw - 2}" height="${v / mx * 96}" rx="2" fill="var(--pri)"/>`).join('')}</svg>`;
  const bud = per === '1M' ? budgetFor(null, m) : null;
  const step = PERN[per] || 1; const ttl = { '1M': 'Spent this month', '3M': 'Spent in 3 months', '1Y': 'Spent in 12 months', All: 'Spent all time' }[per];
  return `<div class="top"><h1>Stats</h1>${spaceSwitch()}</div>
  <div class="seg per">${['1M', '3M', '1Y', 'All'].map(c => `<button class="${per === c ? 'on' : ''}" data-act="per" data-id="${c}">${c}</button>`).join('')}</div>
  ${per === 'All' ? '<div class="mnav"><b>All time</b></div>' : `<div class="mnav"><button data-act="mprev" data-id="${step}">‹</button><b>${perLabel(m, per)}</b><button data-act="mnext" data-id="${step}">›</button></div>`}
  <div class="seg" style="width:max-content;margin-bottom:12px">${['UZS', 'USD'].map(c => `<button class="${disp === c ? 'on' : ''}" data-act="disp" data-id="${c}">${c}</button>`).join('')}</div>
  <div class="card" style="text-align:center"><div class="lbl">${ttl}</div><div class="big">${f(sp.total)}</div>${bud ? `<div class="sub">budget ${f(bud.limit_amount)} · used ${Math.round(sp.total / bud.limit_amount * 100)}%</div>` : ''}<div class="dwrap">${donut}</div>
  ${items.map((it, i) => `<div class="legend" data-act="slice" data-id="${it.id}"><i style="background:${colOf(it, i)}"></i><span class="grow">${it.c ? esc(it.c.name) : 'No category'}</span><b>${f(it.v)}</b><span class="sub" style="width:42px;text-align:right">${Math.round(it.v / sp.total * 100)}%</span></div>`).join('')}</div>
  ${trendChart(m, disp, rate)}
  ${per === '1M' ? `<div class="card"><div class="lbl">By day</div>${bars}</div>` : ''}`;
}
function pgAccounts() {
  const accs = accounts();
  return `<div class="top"><h1>Accounts</h1>${spaceSwitch()}</div>
  <div class="card"><div class="dz" data-table="accounts">${accs.map(a => `<div class="row dr" data-act="accedit" data-id="${a.id}"><div class="ico">${accIcon(a)}</div><div class="grow"><b>${esc(a.name)}${a.card_last4 ? ' ···' + esc(a.card_last4) : ''}</b><span class="sub">${a.currency}${a.hidden ? ' · hidden' : ''}${a.exclude_from_total ? ' · excluded' : ''}</span></div><div class="amt">${fmt(balance(a), a.currency)}</div><span class="hdl" data-hdl aria-label="Drag to reorder">${svg('grip', 20)}</span></div>`).join('')}</div></div>
  <div style="display:flex;gap:10px"><button class="btn sec full" data-act="accnew">+ Account</button><button class="btn full" data-act="addtransfer">Transfer</button></div>`;
}
function pgMore() {
  const l = [['/accounts', 'card', 'Accounts'], ['/budget', 'target', 'Budget & limits'], ['/categories', 'grid', 'Categories'], ['/rate', 'rate', 'USD rate'], ['/settings', 'sliders', 'Settings, Telegram']];
  return `<div class="top"><h1>Profile</h1></div><div class="card">${l.map(([p, i, n]) => `<div class="row" data-go="${p}"><div class="ico">${svg(i)}</div><div class="grow"><b>${n}</b></div><span class="sub">›</span></div>`).join('')}</div><div class="stat" id="sbadge">${syncText()}</div>`;
}
function pgBudget() {
  const m = curMonth(); const sp = spentByRoot(m); const tot = budgetFor(null, m);
  const roots = cats('expense').filter(c => !c.parent_id && !c.archived);
  const line = (name, spent, b, cat) => { const lim = b ? b.limit_amount : 0; const pct = lim ? Math.min(100, Math.round(spent / lim * 100)) : 0; return `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b class="grow">${name}</b><input class="f" style="width:130px;margin:0;text-align:right" inputmode="decimal" data-bud="${cat || ''}" placeholder="limit" value="${lim ? grp(Math.round(lim / 100)) : ''}"></div><div class="bar"><i class="${lim && spent > lim ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">spent ${fmt(spent, 'UZS')}${lim ? ' · left ' + fmt(lim - spent, 'UZS') : ''}</div></div>`; };
  return `<div class="top"><h1>Budget</h1>${spaceSwitch()}</div>${mnav()}<div class="card"><div class="lbl">The limit applies to this and following months</div>${line('Whole month', sp.total, tot, '')}${roots.map(c => line(`<span class="lic">${rootIcon(c, 18)}</span>` + esc(c.name), sp.out[c.id] || 0, budgetFor(c.id, m), c.id)).join('')}</div>`;
}
function pgCats() {
  const roots = cats('expense').concat(cats('income')).filter(c => !c.parent_id && !c.archived);
  const hdl = `<span class="hdl" data-hdl aria-label="Drag to reorder">${svg('grip', 20)}</span>`;
  return `<div class="top"><h1>Categories</h1>${spaceSwitch()}</div><div class="dz" data-group="root">${roots.map(r => `<div class="card dr" data-id="${r.id}"><div class="row" data-act="catedit" data-id="${r.id}" style="padding-top:0"><div class="ico">${rootIcon(r)}</div><div class="grow"><b>${esc(r.name)}</b><span class="sub">${r.kind === 'income' ? 'income' : 'expense'}</span></div>${hdl}</div><div class="dz" data-group="${r.id}">${cats().filter(c => c.parent_id === r.id && !c.archived).map(c => `<div class="row dr" data-act="catedit" data-id="${c.id}" style="padding-left:56px"><div class="grow">${esc(c.name)}</div>${hdl}</div>`).join('')}</div><button class="addsub" data-act="catnew" data-id="${r.id}">${svg('add', 18)}<span>Add subcategory</span></button></div>`).join('')}</div><button class="btn sec full" data-act="catnew" data-id="">+ Category</button>`;
}
// перетаскивание за ручку ☰ (мышь и палец), соседи сдвигаются плавно
let drag = null;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('[data-hdl]'); if (!h) return;
  e.preventDefault(); e.stopPropagation();
  const el = h.closest('.dr'); const box = el.parentElement;
  drag = { el, box, y0: e.clientY, top0: el.offsetTop, moved: false };
  el.classList.add('dragging'); try { h.setPointerCapture(e.pointerId); } catch (x) { /* */ }
}, true);
document.addEventListener('pointermove', (e) => {
  if (!drag) return; e.preventDefault();
  const { el, box } = drag; const vis = drag.top0 + (e.clientY - drag.y0); drag.moved = true;
  const center = vis + el.offsetHeight / 2;
  const sibs = [...box.children].filter(x => x.classList.contains('dr') && x !== el);
  for (const sb of sibs) {
    const mid = sb.offsetTop + sb.offsetHeight / 2; const after = el.compareDocumentPosition(sb) & Node.DOCUMENT_POSITION_FOLLOWING;
    if ((after && center > mid) || (!after && center < mid)) {
      const before = sibs.map(x => [x, x.offsetTop]);
      if (after) box.insertBefore(el, sb.nextSibling); else box.insertBefore(el, sb);
      before.forEach(([x, t]) => { const d = t - x.offsetTop; if (d) { x.style.transition = 'none'; x.style.transform = `translateY(${d}px)`; requestAnimationFrame(() => { x.style.transition = 'transform .2s ease'; x.style.transform = ''; }); } });
      break;
    }
  }
  el.style.transform = `translateY(${vis - el.offsetTop}px)`;
}, { passive: false });
function endDrag() {
  if (!drag) return; const { el, box, moved } = drag; drag = null;
  el.style.transition = 'transform .2s ease'; el.style.transform = ''; el.classList.remove('dragging');
  setTimeout(() => { el.style.transition = ''; }, 220);
  if (!moved) return;
  const ids = [...box.children].filter(x => x.classList.contains('dr')).map(x => x.dataset.id);
  const tb = box.dataset.table || 'categories';
  setTimeout(() => { ids.forEach((id, k) => { const c = byId(tb, id); if (c && c.sort !== k) put(tb, { ...c, sort: k }); }); haptic(); }, 220);
}
document.addEventListener('pointerup', endDrag); document.addEventListener('pointercancel', endDrag);
function pgRate() {
  const mode = setting('rate_mode', 'auto'), kind = setting('rate_kind', 'buy'); const r = S.rates || {};
  return `<div class="top"><h1>USD rate</h1></div><div class="card">
  <div class="row" style="cursor:default"><div class="grow"><b>Auto rate (Ipak Yuli)</b><span class="sub">fetched from the bank’s website</span></div><div class="sw ${mode === 'auto' ? 'on' : ''}" data-act="ratemode"></div></div>
  <div class="lbl" style="margin-top:12px">Which rate to use</div><div class="seg" style="margin:6px 0 12px;width:max-content"><button class="${kind === 'buy' ? 'on' : ''}" data-act="ratekind" data-id="buy">Bank buys</button><button class="${kind === 'sell' ? 'on' : ''}" data-act="ratekind" data-id="sell">Bank sells</button></div>
  <div class="sub">Buy is lower (the bank buys dollars from you). Sell is what you pay to buy dollars.</div>
  <div class="lbl" style="margin-top:14px">Manual rate (UZS per $1)</div><input class="f" id="ratem" inputmode="decimal" value="${esc(grp(setting('rate_manual', '')))}" placeholder="e.g. 12700"></div>
  <div class="card"><div class="lbl">Now on the website</div><div style="margin-top:6px">Buy: <b>${r.buy ? fmtRate(r.buy) : '—'}</b> · Sell: <b>${r.sell ? fmtRate(r.sell) : '—'}</b> · CBU: <b>${r.cbu ? fmtRate(r.cbu) : '—'}</b></div><div class="sub">Source: ${r.source === 'ipakyuli' ? 'Ipak Yuli' : r.source === 'cbu' ? 'cbu.uz (fallback)' : '—'}${r.fetched_at ? ' · ' + dd(r.fetched_at) + ' ' + hm(r.fetched_at) : ''}</div><div style="margin-top:10px">In use: <b>${fmtRate(curRate())}</b></div><button class="btn sec" style="margin-top:12px" data-act="raterefresh">Refresh</button></div>`;
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
  <div class="card"><div class="lbl">Menu style</div><div class="seg" style="margin-top:8px;width:max-content">${[['glass', 'Liquid Glass'], ['solid', 'Solid']].map(([k, n]) => `<button class="${(tryLS(() => localStorage.getItem('navstyle')) || 'glass') === k ? 'on' : ''}" data-act="navstyle" data-id="${k}">${n}</button>`).join('')}</div></div>
  <div class="card"><b>Telegram bot <span id="tgst" class="tgst on">${tgBadge()}</span></b><div class="sub" style="margin:4px 0 10px">${me.tg_ready ? (me.tg_linked ? `Linked chats: ${me.tg_linked}` : 'Not linked yet') : 'Bot token is not set on the server'}<span id="tgwhy">${tgWhy()}</span></div>
  <button class="btn sec" data-act="tgsetup">1. Connect webhook</button> <button class="btn" data-act="tgcode">2. Get code</button><div id="tgout" class="sub" style="margin-top:10px"></div></div>
  <div class="card"><b>URL for Shortcuts (SMS and Wallet)</b><div class="sub" style="margin:4px 0 8px">Secret. Don’t share it.</div>${me.hook_url ? `<code id="hook">${esc(me.hook_url)}</code><div style="margin-top:10px"><button class="btn sec" data-act="copyhook">Copy</button></div>` : '<div class="sub">Not set (WEBHOOK_SECRET)</div>'}</div>
  <div class="card"><b>Password</b><div class="sub" style="margin:4px 0 10px">Other devices will be signed out, this one stays signed in.</div><input class="f" type="password" id="pw0" placeholder="Current password" autocomplete="current-password"><input class="f" type="password" id="pw1" placeholder="New password (8+ characters)" autocomplete="new-password"><input class="f" type="password" id="pw2" placeholder="Repeat new password" autocomplete="new-password"><div class="err" id="pwerr"></div><button class="btn" data-act="pwsave">Change password</button></div>
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
  if (!id) { const i = sheetEl() && sheetEl().querySelector('[data-f=amount]'); if (i) i.focus({ preventScroll: true }); }
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
  <input class="f amtin" id="f-amount" inputmode="decimal" placeholder="0" value="${esc(grp(F.amount))}" data-f="amount" ${''}>
  ${isT ? `<div class="lbl">From</div><select class="f" data-f="from">${opts(F.from)}</select><div class="lbl">To</div><select class="f" data-f="to"><option value="">—</option>${opts(F.to)}</select>${cross ? `<div class="lbl">Amount received (${ta.currency})</div><input class="f" inputmode="decimal" data-f="amount2" value="${esc(grp(F.amount2))}" placeholder="amount received">` : ''}`
      : `<div class="lbl">Account</div><select class="f" data-f="account">${opts(F.account)}</select><div class="lbl">Category</div><select class="f" data-f="category"><option value="">No category</option>${catOpts}</select>`}
  <div class="lbl">Note</div><input class="f" data-f="note" value="${esc(F.note)}" placeholder="What was it">
  <div class="lbl">Date and time</div><input class="f" type="datetime-local" data-f="date" value="${F.date}">
  ${!isT && fa && fa.currency === 'USD' ? `<div class="sub" style="margin-bottom:10px">Rate: ${fmtRate(curRate())} (from settings)</div>` : ''}
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
  closeSheet(); haptic(); toast('Saved');
}
function deleteTx() {
  if (F.type === 'transfer') (F.legs || []).forEach(l => del('transactions', l.id)); else del('transactions', F.id);
  closeSheet(); haptic(); toast('Deleted');
}
function openAcc(id) {
  const a = id ? byId('accounts', id) : { type: 'card_uzs', currency: 'UZS', name: '', card_last4: '', opening_balance: 0, hidden: 0, exclude_from_total: 0 };
  F = { acc: id, ...a, opening: String((a.opening_balance || 0) / 100) };
  openSheet(`<h2>${id ? 'Account' : 'New account'}</h2><div class="lbl">Name</div><input class="f" data-f="name" value="${esc(a.name)}">
  <div class="lbl">Type</div><select class="f" data-f="type" ${id ? 'disabled' : ''}><option value="cash" ${a.type === 'cash' ? 'selected' : ''}>Cash</option><option value="card_uzs" ${a.type === 'card_uzs' ? 'selected' : ''}>UZS card</option><option value="card_visa" ${a.type === 'card_visa' ? 'selected' : ''}>Visa / USD</option></select>
  <div class="lbl">Card last 4 digits (for auto-import)</div><input class="f" data-f="card_last4" maxlength="4" inputmode="numeric" value="${esc(a.card_last4)}">
  <div class="lbl">Opening balance</div><input class="f" data-f="opening" inputmode="decimal" value="${esc(grp(F.opening))}">
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
  <div style="display:flex;gap:8px;margin:6px 0 14px">${id ? '<button class="btn sec" data-act="catarch">Archive</button>' : ''}</div>
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
  if (e.target.closest('[data-hdl]')) return;
  const a = e.target.closest('[data-act]'); const g = e.target.closest('[data-go]');
  if (!a && g) { e.preventDefault(); return go(g.dataset.go); }
  if (!a) return; const act = a.dataset.act, id = a.dataset.id;
  switch (act) {
    case 'login': { const r = await api('/api/login', { method: 'POST', body: JSON.stringify({ login: document.getElementById('lg').value.trim(), password: document.getElementById('pw').value }) }).catch(() => null);
      const er = document.getElementById('lgerr');
      if (!r) return er.textContent = 'No connection to the server';
      if (!r.ok) return er.textContent = r.data.error === 'locked' ? 'Too many attempts, wait 15 minutes' : 'Wrong login or password';
      S.user = document.getElementById('lg').value.trim(); S.route = '/'; history.replaceState({}, '', '/'); await boot(true); break; }
    case 'logout': if (!(await ask('Log out?', 'You’ll need to sign in again on this device.', 'Log out'))) break; await api('/api/logout', { method: 'POST' }).catch(() => 0); await logoutLocal(); break;
    case 'add': openTx(null); break;
    case 'slice': selSlice(id); break;
    case 'qa': { const i = document.getElementById('qa'); if (i.value.trim()) { quickAdd(i.value); i.value = ''; } break; }
    case 'space': S.space = id; S.balShown = null; persist(); render(); break;
    case 'mprev': S.month = shiftMonth(curMonth(), -(+id || 1)); render(); break;
    case 'mnext': S.month = shiftMonth(curMonth(), +id || 1); render(); break;
    case 'per': S.per = id; haptic(); render(); break;
    case 'trendm': S.month = id; S.per = '1M'; haptic(); render(); break;
    case 'hide': S.hide = !S.hide; tryLS(() => localStorage.setItem('hideAmt', S.hide ? '1' : '0')); haptic(); render(); break;
    case 'accf': S.accF = id; render(); break;
    case 'uncat': S.uncat = true; S.accF = ''; S.q = ''; go('/transactions'); break;
    case 'uncatf': S.uncat = !S.uncat; render(); break;
    case 'disp': S.dispCur = id; render(); break;
    case 'tx': openTx(id); break;
    case 'acc': go('/transactions'); S.accF = id; render(); break;
    case 'addtransfer': openTx(null, 'transfer'); break;
    case 'ftype': F.type = id; if (id === 'income' || id === 'expense') F.category = ''; drawTx(); break;
    case 'txsave': saveTx(); break;
    case 'txdel': if (await ask(F.type === 'transfer' ? 'Delete this transfer?' : 'Delete this transaction?', 'This can’t be undone.')) deleteTx(); break;
    case 'accedit': openAcc(id); break;
    case 'accnew': openAcc(null); break;
    case 'fflag': F[id] = F[id] ? 0 : 1; a.classList.toggle('on'); break;
    case 'accsave': saveAcc(); break;
    case 'accdel': if (await ask('Delete this account?', 'Its transactions stay in history.')) { del('accounts', F.acc); closeSheet(); haptic(); toast('Deleted'); } break;
    case 'catedit': openCat(id); break;
    case 'catnew': openCat(null, id || null); break;
    case 'catsave': saveCat(); break;
    case 'catarch': if (!(await ask('Archive this category?', 'It will be hidden from lists. Past transactions keep it.', 'Archive'))) break; put('categories', { ...byId('categories', F.cat), archived: 1 }); closeSheet(); break;
    case 'catup': moveCat(-1); break;
    case 'catdown': moveCat(1); break;
    case 'ratemode': setSetting('rate_mode', setting('rate_mode', 'auto') === 'auto' ? 'manual' : 'auto'); render(true); break;
    case 'ratekind': setSetting('rate_kind', id); render(true); break;
    case 'raterefresh': { const r = await api('/api/rate?force=1').catch(() => null); if (r && r.ok) { S.rates = r.data; persist(); render(true); toast('Rate updated'); } else toast('Couldn’t update'); break; }
    case 'theme': tryLS(() => localStorage.setItem('theme', id)); applyTheme(); render(true); break;
    case 'navstyle': tryLS(() => localStorage.setItem('navstyle', id)); applyTheme(); haptic(); render(true); break;
    case 'pwsave': {
      const v = (i) => document.getElementById(i).value; const er = document.getElementById('pwerr'); er.textContent = '';
      if (v('pw1').length < 8) { er.textContent = 'New password must be at least 8 characters'; break; }
      if (v('pw1') !== v('pw2')) { er.textContent = 'New passwords don’t match'; break; }
      const r = await api('/api/password', { method: 'POST', body: JSON.stringify({ current: v('pw0'), next: v('pw1') }) }).catch(() => null);
      if (!r) { er.textContent = 'No connection to the server'; break; }
      if (!r.ok) { er.textContent = r.data.error === 'wrong_current' ? 'Current password is wrong' : 'Couldn’t change the password'; break; }
      ['pw0', 'pw1', 'pw2'].forEach(i => { document.getElementById(i).value = ''; }); haptic(); toast('Password changed'); break;
    }
    case 'syncnow': await sync(); toast('Done'); break;
    case 'copyhook': tryLS(() => navigator.clipboard.writeText(S.me.hook_url)); toast('Copied'); break;
    case 'tgsetup': { const r = await api('/api/tg/setup', { method: 'POST' }).catch(() => null); document.getElementById('tgout').textContent = r && r.data.ok ? 'Webhook connected: @' + r.data.bot : 'Error: ' + (r ? (r.data.desc || r.data.error) : 'no connection'); checkTg(); break; }
    case 'tgcode': { const r = await api('/api/tg/code', { method: 'POST' }).catch(() => null); document.getElementById('tgout').innerHTML = r && r.ok ? `Send this code to the bot (10 minutes): <b style="font-size:22px">${r.data.code}</b>` : 'Error'; break; }
    case 'csv': exportCsv(); break;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  // поля сумм: только цифры, пробелы и один разделитель
  if (el.inputMode === 'decimal' || el.inputMode === 'numeric') {
    let v = el.value, c = v;
    if (el.inputMode === 'numeric') c = v.replace(/\D/g, '');
    else { c = v.replace(/[^\d.,\s]/g, ''); const i = c.search(/[.,]/); if (i > -1) c = c.slice(0, i + 1) + c.slice(i + 1).replace(/[.,]/g, ''); }
    if (el.inputMode === 'decimal') {
      const caret = el.selectionStart ?? v.length; const before = v.slice(0, caret).replace(/[^\d.,]/g, '').length;
      c = grp(c);
      if (c !== v) { el.value = c; let k = 0, p = 0; while (p < c.length && k < before) { if (/[\d.,]/.test(c[p])) k++; p++; } try { el.setSelectionRange(p, p); } catch (x) { /* */ } }
    } else if (c !== v) { const p = Math.max(0, (el.selectionStart || c.length) - (v.length - c.length)); el.value = c; try { el.setSelectionRange(p, p); } catch (x) { /* */ } }
  }
  if (el.dataset.f) { F[el.dataset.f] = el.value; if (['from', 'to', 'account'].includes(el.dataset.f) && F.type === 'transfer' || el.dataset.f === 'account') { if (F.type === 'transfer') drawTx(); } }
  if (el.id === 'srch') { S.q = el.value; const p = el.selectionStart; render(); const n = document.getElementById('srch'); if (n) { n.focus(); n.setSelectionRange(p, p); } }
  if (el.dataset.bud !== undefined) { clearTimeout(el._t); el._t = setTimeout(() => saveBudget(el.dataset.bud, el.value), 700); }
  if (el.id === 'ratem') { clearTimeout(el._t); el._t = setTimeout(() => setSetting('rate_manual', el.value.replace(/\s/g, '').replace(',', '.')), 600); }
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
  document.documentElement.dataset.nav = tryLS(() => localStorage.getItem('navstyle')) || 'glass';
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

// свайпы между разделами: страница едет за пальцем, соседняя въезжает рядом
(() => {
  let st = null;
  const W = () => Math.min(window.innerWidth, 560);
  const cur = () => $app.firstElementChild;
  function cleanup() { if (!st) return; if (st.nb) st.nb.remove(); const c = cur(); if (c) { c.style.transition = ''; c.style.transform = ''; } st = null; }
  document.addEventListener('touchstart', (e) => {
    cleanup();
    if (e.touches.length !== 1 || ovEl || !S.user || !MAIN.includes(S.route) || e.target.closest('input,select,textarea,.chips,.ov,.dwrap,[data-hdl],.trend')) return;
    const t = e.touches[0]; st = { x0: t.clientX, y0: t.clientY, t0: Date.now(), lock: null, dx: 0, j: -1, nb: null };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!st) return; const t = e.touches[0]; const dx = t.clientX - st.x0, dy = t.clientY - st.y0;
    if (st.lock === null) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; st.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'; if (st.lock === 'y') { st = null; return; } }
    e.preventDefault();
    const i = MAIN.indexOf(S.route); const j = i + (dx < 0 ? 1 : -1);
    if (j !== st.j) { if (st.nb) { st.nb.remove(); st.nb = null; } st.j = j;
      if (j >= 0 && j < MAIN.length) { const nb = document.createElement('div'); nb.className = 'swnb'; nb.innerHTML = PAGES()[MAIN[j]](); document.body.appendChild(nb); st.nb = nb; } }
    const edge = !(j >= 0 && j < MAIN.length); st.dx = edge ? dx * 0.25 : dx;
    const c = cur(); if (c) { c.style.transition = 'none'; c.style.transform = `translateX(${st.dx}px)`; }
    if (st.nb) { st.nb.style.transition = 'none'; st.nb.style.transform = `translateX(${st.dx + (dx < 0 ? W() : -W()) + (dx < 0 ? 16 : -16)}px)`; }
  }, { passive: false });
  function end() {
    if (!st || st.lock !== 'x') { st = null; return; }
    const s0 = st; const v = Math.abs(s0.dx) / Math.max(1, Date.now() - s0.t0); const c = cur();
    const done = s0.nb && (Math.abs(s0.dx) > W() * 0.3 || (v > 0.5 && Math.abs(s0.dx) > 40));
    const ease = 'transform .3s cubic-bezier(.2,.8,.2,1)'; const sign = s0.dx < 0 ? -1 : 1;
    if (c) { c.style.transition = ease; c.style.transform = done ? `translateX(${sign * (W() + 16)}px)` : ''; }
    if (s0.nb) { s0.nb.style.transition = ease; s0.nb.style.transform = done ? 'translateX(0)' : `translateX(${-sign * (W() + 16)}px)`; }
    setTimeout(() => {
      if (done) { haptic(); slideDir = ''; lastRoute = MAIN[s0.j]; history.pushState({}, '', MAIN[s0.j]); S.route = MAIN[s0.j]; window.scrollTo(0, 0); render(); }
      if (s0.nb) s0.nb.remove(); if (st === s0) st = null;
    }, 310);
  }
  document.addEventListener('touchend', end, { passive: true }); document.addEventListener('touchcancel', end, { passive: true });
})();
