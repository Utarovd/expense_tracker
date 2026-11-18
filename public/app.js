'use strict';
// Бюджет: SPA на чистом JS. Данные в IndexedDB, очередь изменений уходит в /api/sync.
const TABLES = ['spaces', 'accounts', 'categories', 'transactions', 'budgets', 'settings'];
const TZ = 5 * 3600000;
const $app = document.getElementById('app');
const S = { user: null, db: {}, queue: {}, cursor: 0, space: null, route: '/', month: null, rates: null, me: null, online: navigator.onLine, syncing: false, lastSync: 0, q: '', accF: '', pending: 0 };
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
const syncText = () => !navigator.onLine ? '● оффлайн' + (pendingCount() ? ` · ждёт ${pendingCount()}` : '') : pendingCount() ? `○ отправка ${pendingCount()}` : '✓ синхронизировано';
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
const MN = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
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
const catIcon = (id) => { const r = rootOf(id); return (r && r.icon) || '•'; };
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
  const kind = /нал/i.test(t) ? 'cash' : /visa|виз/i.test(t) ? 'card_visa' : /карт|card/i.test(t) ? 'card_uzs' : null;
  const note = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\$|usd|доллар\w*|сум\w*|uzs|нал\w*|visa|виза|карт\w*|card/ig, ' ').replace(/\s+/g, ' ').trim();
  return { income, usd, amount: Math.round(n * 100), kind, note };
}
function quickAdd(text) {
  const q = parseQuick(text); if (!q) return toast('Не понял. Пример: «обед 58000»');
  const accs = accounts();
  let acc = accs.find(a => a.type === q.kind) || (q.usd ? accs.find(a => a.type === 'card_visa') : accs.find(a => a.type === 'cash')) || accs[0];
  if (!acc) return;
  // категория по прошлым операциям с той же заметкой
  let cat = null;
  if (q.note) { const same = rows('transactions').filter(t => (t.note || t.merchant || '').toLowerCase() === q.note.toLowerCase() && t.category_id).sort((a, b) => b.occurred_at - a.occurred_at)[0]; if (same) cat = same.category_id; }
  const tx = makeTx({ type: q.income ? 'income' : 'expense', account: acc, amount: q.amount, category: cat, note: q.note });
  put('transactions', tx);
  toast(`${q.income ? '+' : '−'}${fmt(q.amount, acc.currency)} · ${acc.name}` + (cat ? '' : ' · нажми, чтобы выбрать категорию'), cat ? null : () => openTx(tx.id));
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
  const it = [['/', '🏠', 'Главная'], ['/transactions', '☰', 'Операции'], ['/stats', '📊', 'Статистика'], ['/accounts', '💳', 'Счета'], ['/more', '⋯', 'Ещё']];
  return `<div class="nav"><div>${it.map(([p, i, n]) => `<a href="${p}" data-go="${p}" class="${p === on ? 'on' : ''}"><span>${i}</span>${n}</a>`).join('')}</div></div>`;
}
const spaceSwitch = () => `<div class="seg">${rows('spaces').sort((a, b) => a.sort - b.sort).map(s => `<button class="${s.id === S.space ? 'on' : ''}" data-act="space" data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>`;
const mnav = () => `<div class="mnav"><button data-act="mprev">‹</button><b>${monthName(curMonth())}</b><button data-act="mnext">›</button></div>`;
const srcIco = { sms: '📱', wallet: '', payme: '🧾', telegram: '✈️' };
function txRow(t) {
  const acc = byId('accounts', t.account_id); const isT = t.type === 'transfer';
  const title = isT ? 'Перевод' : (t.note || t.merchant || catPath(t.category_id) || 'Без названия');
  const sub = isT ? (t.note || '') : (catPath(t.category_id) || 'без категории');
  const sign = t.type === 'income' || (isT && t.amount > 0) ? '+' : '−'; const cls = sign === '+' ? 'pos' : 'neg';
  const src = t.source === 'wallet' ? ' · Wallet' : t.source === 'sms' ? ' · СМС' : t.source === 'payme' ? ' · Payme' : t.source === 'telegram' ? ' · бот' : '';
  return `<div class="row" data-act="tx" data-id="${t.id}"><div class="ico">${isT ? '🔁' : catIcon(t.category_id)}</div><div class="grow"><b>${esc(title)}</b><span class="sub">${esc(sub)} · ${esc(acc ? acc.name : '?')} · ${hm(t.occurred_at)}${src}</span></div><div class="amt ${cls}">${sign}${fmt(Math.abs(t.amount), t.currency)}</div></div>`;
}

// ---------- страницы ----------
function pgHome() {
  const m = monthKey(now()); const bud = budgetFor(null, m); const sp = spentByRoot(m);
  const accs = accounts().filter(a => !a.hidden); const tot = totalBase(); const rate = curRate();
  const recent = rows('transactions').filter(t => t.space_id === S.space).sort((a, b) => b.occurred_at - a.occurred_at).slice(0, 8);
  const [, e] = monthRange(m); const daysLeft = Math.max(1, Math.ceil((e - now()) / 86400000));
  const pct = bud ? Math.min(100, Math.round(sp.total / bud.limit_amount * 100)) : 0;
  return `<div class="top"><h1>Главная</h1>${spaceSwitch()}</div>
  <div class="quick"><input id="qa" placeholder="Быстро: «обед 58000» или «такси 25к»" enterkeyhint="done" autocomplete="off"><button data-act="qa">＋</button></div>
  <div class="card"><div class="lbl">Баланс</div><div class="big">${fmt(tot, 'UZS')} сум</div><div class="sub">≈ $${(tot / rate / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} по курсу ${Math.round(rate)}${S.rates && S.rates.fetched_at ? ' · обновлён ' + dd(S.rates.fetched_at) + ' ' + hm(S.rates.fetched_at) : ''}</div></div>
  <div class="card" data-go="/budget" style="cursor:pointer"><div class="lbl">Бюджет на месяц</div>${bud ? `<div style="display:flex;justify-content:space-between;font-weight:600;margin-top:4px"><span>${fmt(sp.total, 'UZS')} / ${fmt(bud.limit_amount, 'UZS')}</span><span class="lbl">${pct}%</span></div><div class="bar"><i class="${sp.total > bud.limit_amount ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">Осталось ${fmt(bud.limit_amount - sp.total, 'UZS')} · ${daysLeft} дн.</div>` : `<div class="sub" style="margin-top:6px">Лимит не задан. Потрачено: ${fmt(sp.total, 'UZS')}. Нажми, чтобы задать.</div>`}</div>
  <div class="card">${accs.map(a => `<div class="row" data-act="acc" data-id="${a.id}"><div class="ico">${a.type === 'cash' ? '💵' : a.type === 'card_visa' ? '🌐' : '💳'}</div><div class="grow"><b>${esc(a.name)}</b>${a.currency === 'USD' ? '<span class="sub">USD</span>' : ''}</div><div class="amt">${a.currency === 'USD' ? fmt(balance(a), 'USD') : fmt(balance(a), 'UZS')}</div></div>`).join('') || '<div class="sub">Нет счетов</div>'}</div>
  <div class="card"><div class="lbl">Последние</div>${recent.map(txRow).join('') || '<div class="sub" style="padding:10px 0">Пока пусто</div>'}</div>`;
}
function pgTrans() {
  const [a, b] = monthRange(curMonth()); const q = S.q.toLowerCase();
  const list = rows('transactions').filter(t => t.space_id === S.space && t.occurred_at >= a && t.occurred_at < b && (!S.accF || t.account_id === S.accF) &&
    (!q || (t.note + ' ' + t.merchant + ' ' + catPath(t.category_id)).toLowerCase().includes(q))).sort((x, y) => y.occurred_at - x.occurred_at);
  const days = {}; list.forEach(t => { const k = dd(t.occurred_at); (days[k] = days[k] || []).push(t); });
  const exp = list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_base, 0), inc = list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount_base, 0);
  return `<div class="top"><h1>Операции</h1>${spaceSwitch()}</div>${mnav()}
  <div class="card" style="display:flex;justify-content:space-around;text-align:center"><div><div class="lbl">Расходы</div><b class="neg">${fmt(exp, 'UZS')}</b></div><div><div class="lbl">Доходы</div><b class="pos">${fmt(inc, 'UZS')}</b></div></div>
  <input id="srch" class="f" style="background:var(--card)" placeholder="Поиск" value="${esc(S.q)}">
  <div class="chips"><button class="chip ${!S.accF ? 'on' : ''}" data-act="accf" data-id="">Все</button>${accounts().map(x => `<button class="chip ${S.accF === x.id ? 'on' : ''}" data-act="accf" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
  ${Object.keys(days).map(k => `<div class="day"><span>${k}</span><span>${fmt(days[k].filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_base, 0), 'UZS')}</span></div><div class="card" style="padding:4px 16px">${days[k].map(txRow).join('')}</div>`).join('') || '<div class="sub" style="text-align:center;padding:30px">Нет операций</div>'}`;
}
const PAL = ['#3b6ef6', '#22a06b', '#f5a623', '#e5484d', '#9b6cf0', '#18b4c9', '#e26ba5', '#8b92a3'];
function pgStats() {
  const m = curMonth(); const sp = spentByRoot(m); const disp = S.dispCur || 'UZS'; const rate = curRate();
  const conv = (v) => disp === 'USD' ? v / rate : v; const f = (v) => disp === 'USD' ? fmt(Math.round(conv(v)), 'USD') : fmt(v, 'UZS');
  const items = Object.entries(sp.out).map(([id, v]) => ({ id, v, c: byId('categories', id) })).sort((a, b) => b.v - a.v);
  let acc = 0; const R = 70, C = 2 * Math.PI * R;
  const donut = sp.total ? `<svg viewBox="0 0 200 200" width="190" height="190" style="transform:rotate(-90deg)">${items.map((it, i) => { const len = it.v / sp.total * C; const s = `<circle r="${R}" cx="100" cy="100" fill="none" stroke="${PAL[i % PAL.length]}" stroke-width="36" stroke-dasharray="${len} ${C - len}" stroke-dashoffset="${-acc}"/>`; acc += len; return s; }).join('')}</svg>` : '<div class="sub">Нет расходов</div>';
  // столбцы по дням
  const [a, b] = monthRange(m); const nd = Math.round((b - a) / 86400000); const days = Array(nd).fill(0);
  rows('transactions').forEach(t => { if (t.space_id === S.space && t.type === 'expense' && t.occurred_at >= a && t.occurred_at < b) days[Math.floor((t.occurred_at - a) / 86400000)] += t.amount_base; });
  const mx = Math.max(1, ...days); const bw = 300 / nd;
  const bars = `<svg viewBox="0 0 300 100" width="100%" height="110" preserveAspectRatio="none">${days.map((v, i) => `<rect x="${i * bw + 1}" y="${100 - v / mx * 96}" width="${bw - 2}" height="${v / mx * 96}" rx="2" fill="var(--pri)"/>`).join('')}</svg>`;
  const bud = budgetFor(null, m);
  return `<div class="top"><h1>Статистика</h1>${spaceSwitch()}</div>${mnav()}
  <div class="seg" style="width:max-content;margin-bottom:12px">${['UZS', 'USD'].map(c => `<button class="${disp === c ? 'on' : ''}" data-act="disp" data-id="${c}">${c}</button>`).join('')}</div>
  <div class="card" style="text-align:center"><div class="lbl">Расходы за месяц</div><div class="big">${f(sp.total)}</div>${bud ? `<div class="sub">бюджет ${f(bud.limit_amount)} · факт ${Math.round(sp.total / bud.limit_amount * 100)}%</div>` : ''}<div style="display:flex;justify-content:center;margin:12px 0">${donut}</div>
  ${items.map((it, i) => `<div class="legend"><i style="background:${PAL[i % PAL.length]}"></i><span class="grow">${it.c ? esc((it.c.icon || '') + ' ' + it.c.name) : 'Без категории'}</span><b>${f(it.v)}</b><span class="sub" style="width:42px;text-align:right">${Math.round(it.v / sp.total * 100)}%</span></div>`).join('')}</div>
  <div class="card"><div class="lbl">По дням</div>${bars}</div>`;
}
function pgAccounts() {
  const accs = accounts();
  return `<div class="top"><h1>Счета</h1>${spaceSwitch()}</div>
  <div class="card">${accs.map(a => `<div class="row" data-act="accedit" data-id="${a.id}"><div class="ico">${a.type === 'cash' ? '💵' : a.type === 'card_visa' ? '🌐' : '💳'}</div><div class="grow"><b>${esc(a.name)}${a.card_last4 ? ' ···' + esc(a.card_last4) : ''}</b><span class="sub">${a.currency}${a.hidden ? ' · скрыт' : ''}${a.exclude_from_total ? ' · вне итога' : ''}</span></div><div class="amt">${fmt(balance(a), a.currency)}</div></div>`).join('')}</div>
  <div style="display:flex;gap:10px"><button class="btn sec full" data-act="accnew">+ Счёт</button><button class="btn full" data-act="addtransfer">Перевод</button></div>`;
}
function pgMore() {
  const l = [['/budget', '🎯', 'Бюджет и лимиты'], ['/categories', '🗂', 'Категории'], ['/rate', '💱', 'Курс доллара'], ['/settings', '⚙️', 'Настройки, Telegram']];
  return `<div class="top"><h1>Ещё</h1>${spaceSwitch()}</div><div class="card">${l.map(([p, i, n]) => `<div class="row" data-go="${p}"><div class="ico">${i}</div><div class="grow"><b>${n}</b></div><span class="sub">›</span></div>`).join('')}</div><div class="stat" id="sbadge">${syncText()}</div>`;
}
function pgBudget() {
  const m = curMonth(); const sp = spentByRoot(m); const tot = budgetFor(null, m);
  const roots = cats('expense').filter(c => !c.parent_id && !c.archived);
  const line = (name, spent, b, cat) => { const lim = b ? b.limit_amount : 0; const pct = lim ? Math.min(100, Math.round(spent / lim * 100)) : 0; return `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b class="grow">${name}</b><input class="f" style="width:130px;margin:0;text-align:right" inputmode="decimal" data-bud="${cat || ''}" placeholder="лимит" value="${lim ? Math.round(lim / 100) : ''}"></div><div class="bar"><i class="${lim && spent > lim ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">потрачено ${fmt(spent, 'UZS')}${lim ? ' · осталось ' + fmt(lim - spent, 'UZS') : ''}</div></div>`; };
  return `<div class="top"><h1>Бюджет</h1>${spaceSwitch()}</div>${mnav()}<div class="card"><div class="lbl">Лимит меняется для этого и следующих месяцев</div>${line('Весь месяц', sp.total, tot, '')}${roots.map(c => line(esc((c.icon || '') + ' ' + c.name), sp.out[c.id] || 0, budgetFor(c.id, m), c.id)).join('')}</div>`;
}
function pgCats() {
  const roots = cats('expense').concat(cats('income')).filter(c => !c.parent_id && !c.archived);
  return `<div class="top"><h1>Категории</h1>${spaceSwitch()}</div>${roots.map(r => `<div class="card"><div class="row" data-act="catedit" data-id="${r.id}" style="padding-top:0"><div class="ico">${r.icon || '•'}</div><div class="grow"><b>${esc(r.name)}</b><span class="sub">${r.kind === 'income' ? 'доход' : 'расход'}</span></div><span class="sub">✎</span></div>${cats().filter(c => c.parent_id === r.id && !c.archived).map(c => `<div class="row" data-act="catedit" data-id="${c.id}" style="padding-left:56px"><div class="grow">${esc(c.name)}</div><span class="sub">✎</span></div>`).join('')}<div class="row" data-act="catnew" data-id="${r.id}" style="padding-left:56px;color:var(--pri)">+ подкатегория</div></div>`).join('')}<button class="btn sec full" data-act="catnew" data-id="">+ Категория</button>`;
}
function pgRate() {
  const mode = setting('rate_mode', 'auto'), kind = setting('rate_kind', 'buy'); const r = S.rates || {};
  return `<div class="top"><h1>Курс USD</h1></div><div class="card">
  <div class="row" style="cursor:default"><div class="grow"><b>Авто-курс (Ipak Yuli)</b><span class="sub">подтягивается с сайта банка</span></div><div class="sw ${mode === 'auto' ? 'on' : ''}" data-act="ratemode"></div></div>
  <div class="lbl" style="margin-top:12px">Какой курс использовать</div><div class="seg" style="margin:6px 0 12px;width:max-content"><button class="${kind === 'buy' ? 'on' : ''}" data-act="ratekind" data-id="buy">Покупка банка</button><button class="${kind === 'sell' ? 'on' : ''}" data-act="ratekind" data-id="sell">Продажа банка</button></div>
  <div class="sub">Покупка — дешевле (банк покупает у тебя доллары). Продажа — по ней ты сам покупаешь доллары.</div>
  <div class="lbl" style="margin-top:14px">Ручной курс (сум за $1)</div><input class="f" id="ratem" inputmode="decimal" value="${esc(setting('rate_manual', ''))}" placeholder="например 12700"></div>
  <div class="card"><div class="lbl">Сейчас на сайте</div><div style="margin-top:6px">Покупка: <b>${r.buy ? Math.round(r.buy) : '—'}</b> · Продажа: <b>${r.sell ? Math.round(r.sell) : '—'}</b> · ЦБ: <b>${r.cbu ? Math.round(r.cbu) : '—'}</b></div><div class="sub">Источник: ${r.source === 'ipakyuli' ? 'Ipak Yuli' : r.source === 'cbu' ? 'cbu.uz (запасной)' : '—'}${r.fetched_at ? ' · ' + dd(r.fetched_at) + ' ' + hm(r.fetched_at) : ''}</div><div style="margin-top:10px">Используется: <b>${Math.round(curRate())}</b></div><button class="btn sec" style="margin-top:12px" data-act="raterefresh">Обновить</button></div>`;
}
function pgSettings() {
  const th = tryLS(() => localStorage.getItem('theme')) || 'auto'; const me = S.me || {};
  return `<div class="top"><h1>Настройки</h1></div>
  <div class="card"><div class="lbl">Тема</div><div class="seg" style="margin-top:8px;width:max-content">${[['auto', 'Авто'], ['light', 'Светлая'], ['dark', 'Тёмная']].map(([k, n]) => `<button class="${th === k ? 'on' : ''}" data-act="theme" data-id="${k}">${n}</button>`).join('')}</div></div>
  <div class="card"><b>Telegram-бот</b><div class="sub" style="margin:4px 0 10px">${me.tg_ready ? (me.tg_linked ? `Привязано чатов: ${me.tg_linked}` : 'Ещё не привязан') : 'Токен бота не настроен на сервере'}</div>
  <button class="btn sec" data-act="tgsetup">1. Подключить вебхук</button> <button class="btn" data-act="tgcode">2. Получить код</button><div id="tgout" class="sub" style="margin-top:10px"></div></div>
  <div class="card"><b>Адрес для «Быстрых команд» (СМС и Wallet)</b><div class="sub" style="margin:4px 0 8px">Секретный. Никому не показывай.</div>${me.hook_url ? `<code id="hook">${esc(me.hook_url)}</code><div style="margin-top:10px"><button class="btn sec" data-act="copyhook">Скопировать</button></div>` : '<div class="sub">Не задан (секрет WEBHOOK_SECRET)</div>'}</div>
  <div class="card"><b>Данные</b><div class="sub" id="sbadge" style="margin:4px 0 10px">${syncText()}</div><button class="btn sec" data-act="syncnow">Синхронизировать</button> <button class="btn sec" data-act="csv">Экспорт CSV</button></div>
  <button class="btn red full" data-act="logout">Выйти</button><div class="stat">${esc(me.login || '')}</div>`;
}
function renderLogin() {
  $app.innerHTML = `<div class="center pg"><h1 style="margin:0 0 4px">Бюджет</h1><div class="sub" style="margin-bottom:20px">Вход</div><input class="f" style="background:var(--card)" id="lg" placeholder="Логин" autocapitalize="none" autocomplete="username"><input class="f" style="background:var(--card)" id="pw" type="password" placeholder="Пароль" autocomplete="current-password"><div class="err" id="lgerr"></div><button class="btn full" data-act="login">Войти</button></div>`;
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
  const catOpts = cats(kind).filter(c => !c.parent_id && !c.archived).map(p => `<optgroup label="${esc((p.icon || '') + ' ' + p.name)}"><option value="${p.id}" ${F.category === p.id ? 'selected' : ''}>${esc(p.name)}</option>${cats(kind).filter(c => c.parent_id === p.id && !c.archived).map(c => `<option value="${c.id}" ${F.category === c.id ? 'selected' : ''}>${esc(p.name)} › ${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  const fa = isT ? byId('accounts', F.from) : byId('accounts', F.account), ta = isT ? byId('accounts', F.to) : null;
  const cross = isT && fa && ta && fa.currency !== ta.currency;
  openSheet(`<h2>${F.id ? 'Изменить' : 'Новая операция'}</h2>
  <div class="seg" style="margin-bottom:10px">${[['expense', 'Расход'], ['income', 'Доход'], ['transfer', 'Перевод']].map(([k, n]) => `<button style="flex:1" class="${F.type === k ? 'on' : ''}" data-act="ftype" data-id="${k}" ${F.id && F.type !== k && (F.type === 'transfer' || k === 'transfer') ? 'disabled' : ''}>${n}</button>`).join('')}</div>
  <input class="f amtin" id="f-amount" inputmode="decimal" placeholder="0" value="${esc(F.amount)}" data-f="amount" ${''}>
  ${isT ? `<div class="lbl">Откуда</div><select class="f" data-f="from">${opts(F.from)}</select><div class="lbl">Куда</div><select class="f" data-f="to"><option value="">—</option>${opts(F.to)}</select>${cross ? `<div class="lbl">Сумма на счёт зачисления (${ta.currency})</div><input class="f" inputmode="decimal" data-f="amount2" value="${esc(F.amount2)}" placeholder="сколько пришло">` : ''}`
      : `<div class="lbl">Счёт</div><select class="f" data-f="account">${opts(F.account)}</select><div class="lbl">Категория</div><select class="f" data-f="category"><option value="">Без категории</option>${catOpts}</select>`}
  <div class="lbl">Заметка</div><input class="f" data-f="note" value="${esc(F.note)}" placeholder="Что это было">
  <div class="lbl">Дата и время</div><input class="f" type="datetime-local" data-f="date" value="${F.date}">
  ${!isT && fa && fa.currency === 'USD' ? `<div class="sub" style="margin-bottom:10px">Курс: ${Math.round(curRate())} (из настроек)</div>` : ''}
  <div style="display:flex;gap:10px">${F.id ? '<button class="btn red" data-act="txdel">Удалить</button>' : ''}<button class="btn full" data-act="txsave">Сохранить</button></div>`);
  const am = document.getElementById('f-amount'); if (am && !F.id && !F.amount) setTimeout(() => am.focus(), 320);
}
function saveTx() {
  const amt = num(F.amount); if (!(amt > 0)) return toast('Введи сумму');
  const minor = Math.round(amt * 100); const ts = fromLocal(F.date);
  if (F.type === 'transfer') {
    const fa = byId('accounts', F.from), ta = byId('accounts', F.to); if (!fa || !ta || fa.id === ta.id) return toast('Выбери два разных счёта');
    let minor2 = minor; if (fa.currency !== ta.currency) { const a2 = num(F.amount2); if (!(a2 > 0)) return toast('Введи сумму зачисления'); minor2 = Math.round(a2 * 100); }
    const g = F.group || rid(); const old = F.legs || [];
    const base = fa.currency === 'UZS' ? minor : minor2; const usd = fa.currency === 'USD' ? minor : ta.currency === 'USD' ? minor2 : 0; const fx = usd ? base / usd : 1;
    const mk = (prev, acc, amount) => ({ ...(prev || {}), id: prev ? prev.id : rid(), space_id: S.space, type: 'transfer', account_id: acc.id, amount, currency: acc.currency, fx_rate: fx, amount_base: acc.currency === 'USD' ? Math.round(amount * fx) : amount, category_id: null, note: F.note, merchant: '', occurred_at: ts, transfer_group_id: g, source: (prev && prev.source) || 'app' });
    const o = old.find(x => x.amount < 0), i = old.find(x => x.amount > 0);
    put('transactions', mk(o, fa, -minor)); put('transactions', mk(i, ta, minor2));
  } else {
    const acc = byId('accounts', F.account); if (!acc) return toast('Выбери счёт');
    const prev = F.id ? byId('transactions', F.id) : null;
    const tx = prev ? { ...prev } : makeTx({ type: F.type, account: acc, amount: minor });
    const usd = acc.currency === 'USD'; const fx = prev && prev.account_id === acc.id && prev.fx_rate ? prev.fx_rate : (usd ? curRate() : 1);
    Object.assign(tx, { type: F.type, account_id: acc.id, amount: minor, currency: acc.currency, fx_rate: fx, amount_base: usd ? Math.round(minor * fx) : minor, category_id: F.category || null, note: F.note, occurred_at: ts });
    put('transactions', tx);
    if (tx.merchant && tx.category_id) { /* память мерчант→категория ведёт бот; здесь не трогаем */ }
  }
  closeSheet(); toast('Сохранено');
}
function deleteTx() {
  if (F.type === 'transfer') (F.legs || []).forEach(l => del('transactions', l.id)); else del('transactions', F.id);
  closeSheet(); toast('Удалено');
}
function openAcc(id) {
  const a = id ? byId('accounts', id) : { type: 'card_uzs', currency: 'UZS', name: '', card_last4: '', opening_balance: 0, hidden: 0, exclude_from_total: 0 };
  F = { acc: id, ...a, opening: String((a.opening_balance || 0) / 100) };
  openSheet(`<h2>${id ? 'Счёт' : 'Новый счёт'}</h2><div class="lbl">Название</div><input class="f" data-f="name" value="${esc(a.name)}">
  <div class="lbl">Тип</div><select class="f" data-f="type" ${id ? 'disabled' : ''}><option value="cash" ${a.type === 'cash' ? 'selected' : ''}>Наличные</option><option value="card_uzs" ${a.type === 'card_uzs' ? 'selected' : ''}>Карта UZS</option><option value="card_visa" ${a.type === 'card_visa' ? 'selected' : ''}>Visa / USD</option></select>
  <div class="lbl">Последние 4 цифры карты (для авто-импорта)</div><input class="f" data-f="card_last4" maxlength="4" inputmode="numeric" value="${esc(a.card_last4)}">
  <div class="lbl">Начальный остаток</div><input class="f" data-f="opening" inputmode="decimal" value="${esc(F.opening)}">
  <div class="row" style="cursor:default"><div class="grow">Скрыть</div><div class="sw ${a.hidden ? 'on' : ''}" data-act="fflag" data-id="hidden"></div></div>
  <div class="row" style="cursor:default"><div class="grow">Не учитывать в итоге</div><div class="sw ${a.exclude_from_total ? 'on' : ''}" data-act="fflag" data-id="exclude_from_total"></div></div>
  <div style="display:flex;gap:10px;margin-top:14px">${id ? '<button class="btn red" data-act="accdel">Удалить</button>' : ''}<button class="btn full" data-act="accsave">Сохранить</button></div>`);
}
function saveAcc() {
  if (!F.name.trim()) return toast('Введи название');
  const cur = F.type === 'card_visa' ? 'USD' : 'UZS'; const prev = F.acc ? byId('accounts', F.acc) : null;
  put('accounts', { ...(prev || {}), id: prev ? prev.id : rid(), space_id: S.space, name: F.name.trim(), type: F.type, currency: prev ? prev.currency : cur, opening_balance: Math.round((num(F.opening) || 0) * 100), card_last4: F.card_last4 || '', sort: prev ? prev.sort : accounts().length, hidden: F.hidden ? 1 : 0, exclude_from_total: F.exclude_from_total ? 1 : 0 });
  closeSheet();
}
function openCat(id, parent) {
  const c = id ? byId('categories', id) : { name: '', icon: '', parent_id: parent || null, kind: parent ? (byId('categories', parent) || {}).kind : 'expense' };
  F = { cat: id, ...c };
  openSheet(`<h2>${id ? 'Категория' : 'Новая категория'}</h2><div class="lbl">Название</div><input class="f" data-f="name" value="${esc(c.name)}">
  ${c.parent_id ? '' : `<div class="lbl">Значок (эмодзи)</div><input class="f" data-f="icon" value="${esc(c.icon)}"><div class="lbl">Тип</div><select class="f" data-f="kind" ${id ? 'disabled' : ''}><option value="expense" ${c.kind === 'expense' ? 'selected' : ''}>Расход</option><option value="income" ${c.kind === 'income' ? 'selected' : ''}>Доход</option></select>`}
  <div style="display:flex;gap:8px;margin:6px 0 14px">${id ? '<button class="btn sec" data-act="catup">↑</button><button class="btn sec" data-act="catdown">↓</button><button class="btn sec" data-act="catarch">В архив</button>' : ''}</div>
  <button class="btn full" data-act="catsave">Сохранить</button>`);
}
function saveCat() {
  if (!F.name.trim()) return toast('Введи название');
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
      if (!r) return er.textContent = 'Нет связи с сервером';
      if (!r.ok) return er.textContent = r.data.error === 'locked' ? 'Слишком много попыток, подожди 15 минут' : 'Неверный логин или пароль';
      S.user = document.getElementById('lg').value.trim(); S.route = '/'; history.replaceState({}, '', '/'); await boot(true); break; }
    case 'logout': await api('/api/logout', { method: 'POST' }).catch(() => 0); await logoutLocal(); break;
    case 'add': openTx(null); break;
    case 'qa': { const i = document.getElementById('qa'); if (i.value.trim()) { quickAdd(i.value); i.value = ''; } break; }
    case 'space': S.space = id; persist(); render(); break;
    case 'mprev': S.month = shiftMonth(curMonth(), -1); render(); break;
    case 'mnext': S.month = shiftMonth(curMonth(), 1); render(); break;
    case 'accf': S.accF = id; render(); break;
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
    case 'raterefresh': { const r = await api('/api/rate?force=1').catch(() => null); if (r && r.ok) { S.rates = r.data; persist(); render(true); toast('Курс обновлён'); } else toast('Не удалось обновить'); break; }
    case 'theme': tryLS(() => localStorage.setItem('theme', id)); applyTheme(); render(true); break;
    case 'syncnow': await sync(); toast('Готово'); break;
    case 'copyhook': tryLS(() => navigator.clipboard.writeText(S.me.hook_url)); toast('Скопировано'); break;
    case 'tgsetup': { const r = await api('/api/tg/setup', { method: 'POST' }).catch(() => null); document.getElementById('tgout').textContent = r && r.data.ok ? 'Вебхук подключён: @' + r.data.bot : 'Ошибка: ' + (r ? (r.data.desc || r.data.error) : 'нет связи'); break; }
    case 'tgcode': { const r = await api('/api/tg/code', { method: 'POST' }).catch(() => null); document.getElementById('tgout').innerHTML = r && r.ok ? `Отправь боту этот код (10 минут): <b style="font-size:22px">${r.data.code}</b>` : 'Ошибка'; break; }
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
  const L = ['Дата;Тип;Счёт;Сумма;Валюта;Категория;Заметка;Источник'];
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
