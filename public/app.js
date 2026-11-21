'use strict';
// Бюджет: SPA на чистом JS. Данные в IndexedDB, очередь изменений уходит в /api/sync.
const TABLES = ['spaces', 'accounts', 'categories', 'transactions', 'budgets', 'settings'];
const TZ = 5 * 3600000;
const $app = document.getElementById('app');
const tryLS = (f) => { try { return f(); } catch (e) { return null; } };
// нативное приложение iPhone: код и данные на устройстве, сервер только для синхронизации (вход по токену)
const NATIVE = location.protocol === 'capacitor:';
const API_BASE = NATIVE ? 'https://budget.in-manager.uz' : '';
const ntok = () => NATIVE ? tryLS(() => localStorage.getItem('ntok')) : null;
// вызов нативной части (BudgetNative в SceneDelegate.swift); в браузере ничего не делает
const nat = (method, opts = {}) => { try { return NATIVE && window.Capacitor && Capacitor.nativePromise ? Capacitor.nativePromise('BudgetNative', method, opts).catch(() => null) : Promise.resolve(null); } catch (e) { return Promise.resolve(null); } };
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
const persist = () => { clearTimeout(persistT); persistT = setTimeout(() => { idb.set('state', { db: S.db, queue: S.queue, cursor: S.cursor, user: S.user, space: S.space, rates: S.rates, me: S.me }); pushWidget(); }, 200); };
const rows = (t) => Object.values(S.db[t]).filter(r => !r.deleted_at);
const byId = (t, id) => S.db[t][id];
function put(t, row) { row.updated_at = now(); S.db[t][row.id] = row; S.queue[t][row.id] = row; persist(); scheduleSync(); }
function del(t, id) { const r = S.db[t][id]; if (r) put(t, { ...r, deleted_at: now() }); }

// ---------- сеть ----------
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (x) => Uint8Array.from(atob(x.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((x.length + 3) % 4)), c => c.charCodeAt(0));
async function api(path, opt = {}, ms = 15000) {
  const ac = new AbortController(); const to = setTimeout(() => ac.abort(), ms);
  try {
    const tk = ntok(); const nh = NATIVE ? { 'x-client': 'native', ...(tk ? { authorization: 'Bearer ' + tk } : {}) } : {};
    const r = await fetch(API_BASE + path, { ...opt, signal: ac.signal, headers: { 'content-type': 'application/json', ...nh, ...(opt.headers || {}) }, credentials: NATIVE ? 'omit' : 'same-origin' });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 && path !== '/api/login') {
      // в приложении данные и несинхронизированные изменения остаются на устройстве: только снова войти
      if (NATIVE) { tryLS(() => localStorage.removeItem('ntok')); S.user = null; closeSheet(); render(); throw new Error('auth'); }
      await logoutLocal(); throw new Error('auth');
    }
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
  seedRules();
}
// ---------- правила «слово → категория»: «компы» → Leisure › Gaming сразу ----------
// Хранятся в синхронизируемых настройках (cat_rules), их же читает сервер для бота и СМС/Wallet.
// Слово сравнивается по основе: «компы», «компах», «компов» — одно и то же; правило из нескольких слов требует все слова.
const stemOf = (w) => { w = String(w).toLowerCase().replace(/ё/g, 'е'); const m = w.replace(/(ами|ями|ов|ев|ах|ях|ам|ям|ой|ей|ий|ый|ая|ое|ые|ы|и|а|я|е|у|ю|о)$/, ''); return m.length >= 3 ? m : w; };
const wordsOf = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}'ʻ’]+/gu) || [];
const rules = () => { try { const r = JSON.parse(setting('cat_rules', '[]')); return Array.isArray(r) ? r : []; } catch (_) { return []; } };
const saveRules = (r) => setSetting('cat_rules', JSON.stringify(r));
function ruleCat(text, kind) {
  // совпало несколько правил с разными категориями — не угадываем, категорию спросим (Doniyor 19.11)
  const ws = wordsOf(text); if (!ws.length) return null; const hit = new Set();
  rules().forEach(r => { const c = byId('categories', r.c); if (!c || c.deleted_at || (kind && c.kind !== kind)) return; const sts = wordsOf(r.w).map(stemOf); if (!sts.length) return;
    if (sts.every(st => ws.some(w => w.startsWith(st)))) hit.add(r.c); });
  return hit.size === 1 ? [...hit][0] : null;
}
// стартовые правила для набора по умолчанию (новые пользователи): компы → Gaming; снеки → Coffee & snacks; блюда и фастфуд → Cafes; продукты → Food › Groceries; машина → Transport.
// Добавляются один раз (метка cat_rules_seed), уже существующие слова не трогаем
const SEED = [['Leisure', 'Gaming', ['компы']],
  ['Food', 'Coffee & snacks', ['снеки', 'чипсы', 'сникерс', 'шоколад', 'печенье', 'snacks', 'кофе', 'coffee']],
  ['Food', 'Cafes', ['плов', 'шаурма', 'бургер', 'пицца', 'суши', 'лагман', 'самса', 'шашлык', 'манты', 'кебаб', 'донер', 'лаваш', 'хотдог', 'кафе', 'ресторан', 'burger', 'pizza', 'kfc', 'evos', 'oqtepa']],
  ['Food', 'Groceries', ['продукты', 'корзинка', 'korzinka', 'базар', 'bozor', 'макро', 'makro', 'havas', 'супермаркет']],
  ['Transport', 'Fuel', ['бензин', 'заправка', 'топливо', 'метан', 'пропан', 'benzin', 'yoqilg\'i', 'gas']],
  ['Transport', 'Parking & fines', ['штраф', 'jarima', 'парковка', 'стоянка']],
  ['Transport', 'Car service', ['мойка', 'автомойка', 'шиномонтаж', 'запчасти', 'автосервис', 'техосмотр', 'страховка', 'машина', 'avto', 'moyka']]];
function seedRules() {
  if (setting('cat_rules_seed', '') === '3') return; const ex = cats('expense'); if (!ex.length) return;
  const r = rules(); const have = new Set(r.map(x => x.w)); let n = 0;
  SEED.forEach(([pn, cn, ws]) => { const p = ex.find(c => !c.parent_id && c.name.toLowerCase() === pn.toLowerCase()); const c = p && (cn ? ex.find(x => x.parent_id === p.id && x.name.toLowerCase() === cn.toLowerCase()) : p); if (!c) return; ws.forEach(w => { if (!have.has(w)) { r.push({ w, c: c.id }); n++; } }); });
  if (n) saveRules(r); setSetting('cat_rules_seed', '3');
}
const catLabel = (id) => { const c = byId('categories', id); if (!c) return '—'; const p = c.parent_id && byId('categories', c.parent_id); return (p ? p.name + ' › ' : '') + c.name; };
// ---------- выбор категории: своя шторка поверх окна (в стандартном списке iOS заголовки разделов не настроить) ----------
// Разделы — раскрывающиеся списки (заголовок 20 px, стрелка поворачивается, список плавно раскрывается и сворачивается).
// Заголовок раздела только раскрывает список: раздел без подкатегории не выбирается (Doniyor 19.11); раздел совсем без подкатегорий выбирается тапом.
// В поле показывается «Раздел › Подкатегория». Шторка закрывается свайпом вниз, когда список не прокручен.
function catField(key, val, kind) { return `<button type="button" class="f catf${val ? '' : ' none'}" data-act="catpick" data-cf="${key}" data-kind="${kind}">${val ? esc(catLabel(val)) : 'No category'}</button>`; }
function setCatField(btn, id) { btn.textContent = id ? catLabel(id) : 'No category'; btn.classList.toggle('none', !id); }
function openCatPicker(btn) {
  const key = btn.dataset.cf, kinds = btn.dataset.kind ? [btn.dataset.kind] : ['expense', 'income'], cur = F[key] || '';
  const ck = (id) => id === cur ? '<span class="cpk">✓</span>' : '';
  const sec = (p, k) => {
    const subs = cats(k).filter(c => c.parent_id === p.id && !c.archived); const open = p.id === cur || subs.some(c => c.id === cur);
    if (!subs.length) return `<div class="cps"><div class="cph${p.id === cur ? ' sel' : ''}" data-cid="${p.id}"><span class="ico sm">${rootIcon(p, 18)}</span><span class="grow">${esc(p.name)}</span>${ck(p.id)}</div></div>`;
    return `<div class="cps${open ? ' open' : ''}"><div class="cph${open ? ' sel' : ''}" data-tog><span class="ico sm">${rootIcon(p, 18)}</span><span class="grow">${esc(p.name)}</span><svg class="cpa" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>`
      + `<div class="cpb"><div class="cpbi">${subs.map(c => `<div class="cpi${c.id === cur ? ' sel' : ''}" data-cid="${c.id}"><span class="grow">${esc(c.name)}</span>${ck(c.id)}</div>`).join('')}</div></div></div>`;
  };
  const body = kinds.map(k => cats(k).filter(c => !c.parent_id && !c.archived).map(p => sec(p, k)).join('')).join('');
  const el = document.createElement('div'); el.className = 'cp';
  el.innerHTML = `<div class="cpp"><i class="grab"></i><h2>Category</h2><div class="cpl">${key === 'category' ? `<div class="cpi cp0${cur ? '' : ' sel'}" data-cid="">No category${cur ? '' : '<span class="cpk">✓</span>'}</div>` : ''}${body}</div></div>`;
  document.body.appendChild(el); void el.offsetWidth; el.classList.add('on');
  const pp = el.querySelector('.cpp'), list = el.querySelector('.cpl');
  let gone = false;
  const close = (curve) => {
    if (gone) return; gone = true;
    if (curve) { pp.style.transition = 'transform ' + curve; pp.style.transform = `translate3d(0,${pp.offsetHeight + 40}px,0)`; }
    el.classList.remove('on'); setTimeout(() => el.remove(), 320);
  };
  el.addEventListener('click', (e) => {
    const tg = e.target.closest('[data-tog]');
    if (tg) { // раскрыть раздел (открытые остальные сворачиваются одновременно)
      const s = tg.parentNode, was = s.classList.contains('open'), others = [...el.querySelectorAll('.cps.open')].filter(x => x !== s);
      const apply = (on) => { others.forEach(x => x.classList.toggle('open', !on)); s.classList.toggle('open', on ? !was : was); };
      // раскрытый раздел у нижнего края: список докручивается ОДНОВРЕМЕННО с раскрытием (без паузы и второго рывка).
      // Конечное положение меряем заранее: на миг ставим итоговое состояние без анимации, меряем и возвращаем — на экране не видно.
      let tgt = null;
      if (!was) { list.classList.add('cpnt'); apply(true); const top = s.offsetTop, h = s.offsetHeight; apply(false); void list.offsetHeight; list.classList.remove('cpnt'); void list.offsetHeight;
        const cur = list.scrollTop, ch = list.clientHeight; let t = cur; if (top + h + 8 > cur + ch) t = top + h + 8 - ch; if (t > top - 4) t = top - 4; if (top - 4 < cur) t = top - 4; if (Math.abs(t - cur) > 1) tgt = { from: cur, to: Math.max(0, t) }; }
      apply(true); haptic('select');
      if (tgt) { const t0 = performance.now(), D = 300, ease = (x) => x < .5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
        const step = (now) => { const k = Math.min(1, (now - t0) / D); list.scrollTop = tgt.from + (tgt.to - tgt.from) * ease(k); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }
      return;
    }
    const r = e.target.closest('[data-cid]'); if (!r) { if (e.target === el) close(); return; }
    F[key] = r.dataset.cid; if (key === 'category') F.autoCat = false; setCatField(btn, F[key]); haptic('select'); close();
    // новая операция: после выбора категории сразу открывается клавиатура в Note (фокус в том же тапе, иначе iOS не покажет клавиатуру)
    if (key === 'category' && !F.id) { const n = sheetEl() && sheetEl().querySelector('[data-f=note]'); if (n) { n.dataset.center = '1'; n.focus({ preventScroll: true }); } }
  });
  // свайп вниз: шторка едет за пальцем, когда список вверху; отпускание — пружина со скоростью пальца
  let st = null;
  pp.addEventListener('touchstart', (e) => { if (e.touches.length !== 1) { st = null; return; } const t = e.touches[0]; st = { x: t.clientX, y: t.clientY, on: false, dy: 0, t0: Date.now() }; pp.style.willChange = 'transform'; }, { passive: true });
  pp.addEventListener('touchmove', (e) => {
    if (!st) return; const t = e.touches[0], dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (!st.on) {
      const inList = list.contains(e.target);
      if (dy > 8 && dy > Math.abs(dx) * 1.2 && (!inList || list.scrollTop <= 0)) { st.on = true; st.y = t.clientY; pp.style.transition = 'none'; }
      else if (Math.abs(dx) > 10 || dy < -8 || (dy > 8 && inList && list.scrollTop > 0)) { st = null; return; }
      else { if (dy > 0 && dy >= Math.abs(dx) && (!inList || list.scrollTop <= 0) && e.cancelable) e.preventDefault(); return; }
    }
    const d = Math.max(0, t.clientY - st.y); st.dy = d; trackV(st, d); if (e.cancelable) e.preventDefault();
    pp.style.transform = `translate3d(0,${d}px,0)`; el.style.setProperty('--dim', String(Math.max(0.2, 1 - d / 500))); // фон светлеет за пальцем, как у других шторок
  }, { passive: false });
  const end = () => {
    if (!st) return; const s2 = st; st = null; if (!s2.on) { pp.style.willChange = ''; return; }
    if (s2.lt && performance.now() - s2.lt > 80) s2.v = 0; const v = s2.v || 0, H = pp.offsetHeight + 40; el.style.setProperty('--dimt', '.3s'); el.style.setProperty('--dim', '1');
    if (flingDone(s2.dy, v, 110)) return close(springCurve(H - s2.dy, v));
    pp.style.transition = 'transform ' + springCurve(-s2.dy, v); pp.style.transform = 'translate3d(0,0,0)';
    setTimeout(() => { if (!gone) { pp.style.transition = ''; pp.style.transform = ''; pp.style.willChange = ''; el.style.removeProperty('--dimt'); } }, 320);
  };
  pp.addEventListener('touchend', end); pp.addEventListener('touchcancel', end);
  // список открывается на разделе выбранной категории (заголовок раздела виден целиком)
  const os = el.querySelector('.cps.open'); if (os && os.offsetTop + os.offsetHeight > list.clientHeight) list.scrollTop = os.offsetTop - 4;
}
function ruleWord(note) { const w = wordsOf(note).find(x => x.length >= 3 && !/^\d/.test(x)); return w || ''; }
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
  invite: 'M9.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3 20a6.5 6.5 0 0 1 13 0M19 8v6M16 11h6',
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
  med: 'M9.5 3.5h5v6h6v5h-6v6h-5v-6h-6v-5h6z',
  ring: 'M12 21a6 6 0 1 0 0-12 6 6 0 0 0 0 12zM9.6 9.5 7.5 6l2-2.5h5l2 2.5-2.1 3.5M7.5 6h9',
  gift: 'M3.5 8.5h17v4h-17zM5 12.5V20h14v-7.5M12 8.5V20M12 8.5S10.6 4 8.3 4.6C6.6 5 7 8.5 12 8.5zM12 8.5s1.4-4.5 3.7-3.9C17.4 5 17 8.5 12 8.5z',
  tag: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8 8a1 1 0 0 1 0 1.4l-7.6 7.6a1 1 0 0 1-1.4 0zM8 8h.01',
  ok: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.3l2.7 2.7L16 9.5',
  bad: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9 9l6 6M15 9l-6 6',
  coffee: 'M4 8h13v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8zM17 9h1.5a2.5 2.5 0 0 1 0 5H17M7.5 3v2.5M10.5 3v2.5M13.5 3v2.5M5 21h11',
  cart: 'M3 4h2l2.2 10.3a1.5 1.5 0 0 0 1.5 1.2h8.5a1.5 1.5 0 0 0 1.4-1.1L20.5 8H6M8.4 20a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0M15.6 20a1.2 1.2 0 1 0 2.4 0a1.2 1.2 0 1 0-2.4 0',
  burger: 'M4 10a8 6 0 0 1 16 0H4zM3 13.5h18M4 17h16a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3z',
  wine: 'M8 2.5h8l-.5 6a3.5 3.5 0 0 1-7 0L8 2.5zM12 12v9M8.5 21h7',
  bus: 'M6 3h12a2 2 0 0 1 2 2v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a2 2 0 0 1 2-2zM4 11h16M7 17v3M17 17v3M8 14h.01M16 14h.01',
  fuel: 'M4 21V5a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M3 21h12M7 8h4M14 10h2a2 2 0 0 1 2 2v4a1.5 1.5 0 0 0 3 0V8l-3-3',
  wrench: 'M14.5 3.5a5 5 0 0 0-5.8 6.6L3 15.8V21h5.2l5.7-5.7a5 5 0 0 0 6.6-5.8l-3 3-3.5-1-1-3.5 3-3z',
  plane: 'M21 3L3 10.5l7 3 3 7.5L21 3zM10 13.5L21 3',
  bed: 'M3 19V6M3 14h18v5M21 14v-2a3 3 0 0 0-3-3h-7v5M7 11.5h.01',
  sun: 'M12 16.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  film: 'M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4',
  music: 'M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  ball: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7.5l4 2.9-1.5 4.6h-5L8 10.4l4-2.9zM12 3v4.5M16 10.4l4.6-1.4M14.5 15l2.8 4M9.5 15l-2.8 4M8 10.4L3.4 9',
  gym: 'M6.5 7v10M3.5 9.5v5M17.5 7v10M20.5 9.5v5M6.5 12h11',
  pill: 'M10.5 3.5a5 5 0 0 1 7 7l-7 7a5 5 0 0 1-7-7l7-7zM7 10l7 7',
  baby: 'M12 3a9 9 0 0 1 9 9h-9V3zM3 12h9M5 12a7 7 0 0 0 14 0M6.5 20.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M14.5 20.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
  grad: 'M2 9l10-5 10 5-10 5L2 9zM6 11v5c3 2.5 9 2.5 12 0v-5M22 9v6',
  book: 'M4 4.5A1.5 1.5 0 0 1 5.5 3H20v15H5.5A1.5 1.5 0 0 0 4 19.5v-15zM4 19.5A1.5 1.5 0 0 0 5.5 21H20M8 7h8',
  shirt: 'M8 3L3 6l2 4 2-1v12h10V9l2 1 2-4-5-3a4 4 0 0 1-8 0z',
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.1 7.9L20 20M8.1 16.1L20 4',
  paw: 'M12 13c-3 0-5.5 3.5-5.5 5.5 0 1.5 1.2 2.5 2.7 2.5 1 0 1.8-.5 2.8-.5s1.8.5 2.8.5c1.5 0 2.7-1 2.7-2.5 0-2-2.5-5.5-5.5-5.5zM4.5 10.5a1.8 2.2 0 1 0 3.6 0a1.8 2.2 0 1 0-3.6 0M15.9 10.5a1.8 2.2 0 1 0 3.6 0a1.8 2.2 0 1 0-3.6 0M7.8 5.5a1.8 2.2 0 1 0 3.6 0a1.8 2.2 0 1 0-3.6 0M12.6 5.5a1.8 2.2 0 1 0 3.6 0a1.8 2.2 0 1 0-3.6 0',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM11 18h2',
  wifi: 'M2 9a15 15 0 0 1 20 0M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7l1-8z',
  drop: 'M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z',
  work: 'M3 8h18v12H3V8zM8 8V5a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v3M3 13h18',
  piggy: 'M5 11.5a7 6 0 0 1 12.5-3.5H20v4l-2 1a7 6 0 0 1-2 3V19h-3v-2h-3v2H7v-3.2a6 6 0 0 1-2-4.3zM15 10.5h.01M2.5 10c0 1.5 1 2 2.5 2',
  leaf: 'M5 19C5 10 11 4 20 4c0 9-6 15-15 15zM5 19l8-8',
};
const svg = (n, sz = 22) => `<svg class="i i-${n}" width="${sz}" height="${sz}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${IC[n]}"/></svg>`;
const CATIC = { food: 'food', home: 'home', leisure: 'game', transport: 'car', expenses: 'receipt', nilufar: 'heart', family: 'family', 'family & kids': 'family', shopping: 'bag', health: 'med',
  'gifts & events': 'gift', finance: 'card', other: 'tag', salary: 'wallet', business: 'bag', gifts: 'gift', cashback: 'rate', 'other income': 'plus' };
// своя иконка категории: icon = '@ключ.цвет' (выбирается в окне категории); иначе старая логика (по названию / emoji)
const ICCOL = { def: ['', '', '', ''], orange: ['#fff0e3', '#f97316', '#3a2414', '#ff9a4d'], amber: ['#fcf2dc', '#d97706', '#3a2c12', '#f5b544'],
  green: ['#e1f6e8', '#16a34a', '#133222', '#4ade80'], teal: ['#dff6f3', '#0d9488', '#12322f', '#3fd0c8'], sky: ['#e0f3fd', '#0ea5e9', '#11303e', '#38bdf8'], blue: ['#e7f0ff', '#3b82f6', '#1c2a45', '#6aa1ff'],
  indigo: ['#ebebff', '#6366f1', '#24234a', '#8b8cf8'], violet: ['#f1ebff', '#8b5cf6', '#2b2245', '#a78bfa'], pink: ['#fde7f3', '#ec4899', '#3a1a2c', '#f472b6'], red: ['#fde7e7', '#ef4444', '#3a1a1c', '#ff7a7a'], slate: ['#eef1f5', '#64748b', '#262c36', '#a3adbd'] };
const CICONS = ['food', 'coffee', 'burger', 'cart', 'wine', 'home', 'bolt', 'drop', 'wifi', 'phone', 'car', 'fuel', 'wrench', 'bus', 'plane', 'bed', 'sun', 'game', 'film', 'music', 'ball', 'gym', 'med', 'pill', 'heart', 'family', 'baby', 'user', 'paw', 'grad', 'book', 'bag', 'shirt', 'cut', 'gift', 'ring', 'receipt', 'card', 'cash', 'wallet', 'piggy', 'rate', 'work', 'leaf', 'globe', 'tag'];
const ICDEF = { food: 'orange', coffee: 'amber', burger: 'orange', cart: 'green', wine: 'violet', home: 'def', bolt: 'def', drop: 'sky', wifi: 'blue', phone: 'indigo', car: 'blue', fuel: 'amber', wrench: 'slate', bus: 'blue', plane: 'sky', bed: 'indigo', sun: 'def', game: 'violet', film: 'red', music: 'pink', ball: 'green', gym: 'red', med: 'red', pill: 'teal', heart: 'red', family: 'pink', baby: 'pink', user: 'blue', paw: 'amber', grad: 'indigo', book: 'teal', bag: 'amber', shirt: 'violet', cut: 'pink', gift: 'red', ring: 'violet', receipt: 'teal', card: 'indigo', cash: 'green', wallet: 'green', piggy: 'pink', rate: 'green', work: 'slate', leaf: 'green', globe: 'sky', tag: 'slate' };
const parseIc = (v) => { const m = /^@([a-z]+)\.([a-z]+)$/.exec(v || ''); return m && IC[m[1]] ? { k: m[1], c: ICCOL[m[2]] ? m[2] : 'def' } : null; };
const icSvg = (k, c, sz) => svg(k, sz).replace('class="i ', `class="i ${c && c !== 'def' ? 'col-' + c + ' ' : ''}`);
const rootIcon = (r, sz) => r && parseIc(r.icon) ? icSvg(parseIc(r.icon).k, parseIc(r.icon).c, sz) : !r ? svg('tag', sz) : CATIC[String(r.name).toLowerCase()] ? svg(CATIC[String(r.name).toLowerCase()], sz) : r.icon ? `<span class="emo">${esc(r.icon)}</span>` : svg('tag', sz);
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
// несколько трат за раз: «Компы 50к, снеки 20к» → две операции. Делим по запятой (не перед цифрой: «12,5$» — это число), «;» и новой строке;
// кусок без суммы дописывается к заметке предыдущего
function splitQuick(text) {
  const out = []; String(text).split(/[;\n]+|,(?!\d)/).map(x => x.trim()).filter(Boolean).forEach(x => { if (/\d/.test(x) || !out.length) out.push(x); else out[out.length - 1] += ' ' + x; });
  return out;
}
function quickAdd(text) {
  const items = splitQuick(text).map(parseQuick); if (!items.length || items.some(q => !q)) return toast('Didn’t get that. Example: “lunch 58000, taxi 25k”');
  if (items.length === 1) return quickOne(items[0]);
  const done = items.map(q => quickOne(q, true)).filter(Boolean); haptic('success');
  toast(`Added ${done.length}: ` + done.map(d => `${d.q.income ? '+' : '−'}${fmt(d.q.amount, d.acc.currency)}${d.q.note ? ' ' + d.q.note : ''}`).join(' · '));
}
function quickOne(q, quiet) {
  const accs = accounts();
  let acc = accs.find(a => a.type === q.kind) || (q.usd ? accs.find(a => a.type === 'card_visa') : accs.find(a => a.type === 'cash')) || accs[0];
  if (!acc) return;
  // категория по прошлым операциям с той же заметкой
  let cat = q.note ? ruleCat(q.note, q.income ? 'income' : 'expense') : null;
  if (!cat && q.note) { const same = rows('transactions').filter(t => (t.note || t.merchant || '').toLowerCase() === q.note.toLowerCase() && t.category_id).sort((a, b) => b.occurred_at - a.occurred_at)[0]; if (same) cat = same.category_id; }
  const tx = makeTx({ type: q.income ? 'income' : 'expense', account: acc, amount: q.amount, category: cat, note: q.note });
  put('transactions', tx);
  if (quiet) return { q, acc };
  toast(`${q.income ? '+' : '−'}${fmt(q.amount, acc.currency)} · ${acc.name}` + (cat ? '' : ' · tap to pick a category'), cat ? null : () => openTx(tx.id));
}

// ---------- UI-утилиты ----------
let toastT;
// отклик вибрацией: Android через vibrate, iPhone (Safari 18+) через системный переключатель
let hapEl;
function haptic(style) {
  if (NATIVE) { nat('haptic', { style: style || 'light' }); return; }
  try {
    if (navigator.vibrate) { navigator.vibrate(12); return; }
    if (!hapEl) { hapEl = document.createElement('label'); hapEl.style.cssText = 'position:fixed;left:-99px;top:0;opacity:0;pointer-events:none'; hapEl.innerHTML = '<input type="checkbox" switch>'; document.body.appendChild(hapEl); }
    hapEl.click();
  } catch (e) { /* нет поддержки */ }
}
// уведомление: карточка сверху под статус-баром, иконка по смыслу (успех / ошибка / инфо / «тапни»), въезжает сверху пружиной.
// Длинный текст растягивает карточку вширь (до 16 px от краёв), а не в узкий высокий столбик. Ошибка — с вибрацией «ошибка».
const TOAST_ERR = /^(Enter|Pick|Couldn|Didn|Error|Wrong|Failed|No |Export needs)/i;
const TOAST_INFO = /^(Rate updated|Icon selected|Face ID is|Sync)/i;
const TOAST_IC = { ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>', err: '<path d="M12 7v6"/><path d="M12 17h.01"/>', del: '<path d="M5 7h14"/><path d="M9 7V5h6v2"/><path d="M7 7l1 12h8l1-12"/>', info: '<path d="M12 11v6"/><path d="M12 7h.01"/>' };
// уведомление: цветная карточка с градиентом сверху под часами (успех — зелёная, ошибка — красная, удаление — фиолетовая,
// Info — тёмно-синяя с жёлтым заголовком, «тапни» — жёлтая со стрелкой). У каждого типа своя вибрация при появлении.
function toast(msg, onTap, kind) {
  let el = document.getElementById('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.innerHTML = '<i class="tic"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"></svg></i><span class="ttx"><b class="tth">Info</b><span class="ttm"></span></span>'; document.body.appendChild(el); }
  const k = onTap ? 'act' : kind || (TOAST_ERR.test(msg) ? 'err' : /^Deleted|^Archived/.test(msg) ? 'del' : TOAST_INFO.test(msg) ? 'info' : 'ok');
  el.dataset.k = k; el.querySelector('svg').innerHTML = TOAST_IC[k] || TOAST_IC.ok; el.querySelector('.ttm').textContent = msg;
  el.onclick = onTap ? () => { el.classList.remove('on'); onTap(); } : k === 'info' ? () => el.classList.remove('on') : null; el.style.pointerEvents = el.onclick ? 'auto' : 'none';
  haptic(/^Saved/.test(msg) ? 'success' : { ok: 'success', err: 'error', del: 'warning' }[k] || 'light');
  el.classList.remove('on'); void el.offsetWidth; requestAnimationFrame(() => el.classList.add('on'));
  clearTimeout(toastT); toastT = setTimeout(() => el.classList.remove('on'), onTap || k === 'info' ? 5000 : k === 'err' ? 3200 : 2600);
}
let ovEl = null;
let lockY = null;
function lockScroll() { if (lockY !== null) return; lockY = window.scrollY || 0; const b = document.body; b.style.position = 'fixed'; b.style.top = -lockY + 'px'; b.style.left = '0'; b.style.right = '0'; b.style.width = '100%'; }
function unlockScroll() { if (lockY === null) return; const y = lockY; lockY = null; const b = document.body; b.style.position = b.style.top = b.style.left = b.style.right = b.style.width = ''; window.scrollTo({ top: y, behavior: 'instant' }); }
function openSheet(html) {
  if (!ovEl) { lockScroll(); ovEl = document.createElement('div'); ovEl.className = 'ov'; ovEl.innerHTML = '<div class="sheet"></div>'; ovEl.addEventListener('mousedown', e => { if (e.target === ovEl) closeSheet(); }); document.body.appendChild(ovEl); requestAnimationFrame(() => requestAnimationFrame(() => ovEl && ovEl.classList.add('open'))); }
  ovEl.firstChild.innerHTML = '<i class="grab"></i><button type="button" class="shx" aria-label="Close" data-act="shclose">×</button>' + html;
}
// закрытие: шторка уезжает вниз до конца (по её собственной анимации, в т.ч. пружине после свайпа), и только потом окно убирается;
// прокрутка страницы возвращается после этого — на экране ничего не мелькает
function closeSheet() { const el = ovEl; if (!el) return; ovEl = null; el.classList.remove('open'); el.style.pointerEvents = 'none';
  const sh = el.firstChild; let done = false; const fin = () => { if (done) return; done = true; el.remove(); if (!ovEl) unlockScroll(); };
  if (sh) sh.addEventListener('transitionend', (e) => { if (e.target === sh && e.propertyName === 'transform') fin(); }); setTimeout(fin, 700); }
const sheetEl = () => ovEl && ovEl.firstChild;
// подтверждение (как alert в iOS): Promise<boolean>
function ask(title, msg, okLabel = 'Delete') {
  return new Promise(res => {
    const el = document.createElement('div'); el.className = 'cf';
    el.innerHTML = `<div class="cfb" role="alertdialog"><b>${esc(title)}</b>${msg ? `<p>${esc(msg)}</p>` : ''}<div class="cfa"><button data-r="0">Cancel</button><button data-r="1" class="dng">${esc(okLabel)}</button></div></div>`;
    const done = (v) => { document.removeEventListener('keydown', key, true); el.classList.remove('open'); setTimeout(() => el.remove(), 250); res(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); } if (e.key === 'Enter') { e.preventDefault(); done(true); } };
    el.addEventListener('click', e => { e.stopPropagation(); const b = e.target.closest('button'); if (b) { b.classList.add('prs'); done(b.dataset.r === '1'); } else if (e.target === el) done(false); });
    document.addEventListener('keydown', key, true);
    document.body.appendChild(el); requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
  });
}

// ---------- роутинг ----------
const MAIN = ['/', '/history', '/stats', '/profile'];
let slideDir = '';
const PAGES = () => ({ '/': pgHome, '/history': pgTrans, '/stats': pgStats, '/profile/accounts': pgAccounts, '/profile': pgMore, '/profile/budget': pgBudget, '/profile/categories': pgCats, '/profile/rules': pgRules, '/profile/rate': pgRate, '/profile/settings': pgSettings, '/profile/invite': pgInvite });
// порядок страниц для направления сдвига: вложенные страницы Profile стоят «правее» самого Profile
// старые адреса (до 20.11: /more, /accounts …) ведут на новые /profile/… — закладки и PWA продолжают работать
const OLDP = { '/transactions': '/history', '/more': '/profile', '/accounts': '/profile/accounts', '/budget': '/profile/budget', '/categories': '/profile/categories', '/rate': '/profile/rate', '/settings': '/profile/settings' };
const curPath = () => { const p = location.pathname.replace(/\/+$/, '') || '/'; const n = OLDP[p]; if (n) { history.replaceState({}, '', n + location.search); return n; } return p; };
const pgIdx = (p) => MAIN.includes(p) ? MAIN.indexOf(p) : PAGES()[p] ? MAIN.length - 0.5 : -1;
const dirTo = (a, b) => { const x = pgIdx(a), y = pgIdx(b); return x > -1 && y > -1 && x !== y ? (y > x ? 'pg-next' : 'pg-prev') : ''; };
function go(path, replace) { slideDir = dirTo(S.route, path); if (location.pathname !== path) history[replace ? 'replaceState' : 'pushState']({}, '', path); S.route = path; render(); window.scrollTo(0, 0); }
window.addEventListener('popstate', () => { const np = curPath(); slideDir = dirTo(S.route, np); closeSheet(); S.route = curPath(); render(); });
// превью иконок в Settings не пересоздаются при перерисовке: те же загруженные картинки переносятся в новую разметку, без мигания
const ICN = {};
function keepIcons() { document.querySelectorAll('#app .icpick img').forEach(im => { const k = im.getAttribute('src'); const c = ICN[k]; if (c && c !== im) im.replaceWith(c); else if (!c) ICN[k] = im; }); }
let lastRoute = null;
// переход тапом по вкладке: как при свайпе, старая страница уезжает в сторону, новая въезжает рядом (300 мс, мягкое торможение)
let pgAnim = null;
function slidePages(oldPg, box, sign) {
  const W = Math.min(window.innerWidth, 560) + 16, cv = 'transform ' + springCurve(W, 0);
  // на широком экране (Mac) переход виден только внутри колонки приложения: старая страница уезжает в «окно» шириной колонки и обрезается по нему
  const col = $app.getBoundingClientRect(); const clip = document.createElement('div'); clip.style.cssText = `position:fixed;left:${col.left}px;top:0;width:${col.width}px;height:100%;overflow:hidden;z-index:15;pointer-events:none`;
  const gh = document.createElement('div'); gh.style.cssText = `position:absolute;left:${box.left - col.left}px;top:${box.top}px;width:${box.width}px;will-change:transform`;
  oldPg.style.transition = ''; oldPg.style.transform = ''; gh.appendChild(oldPg); clip.appendChild(gh); document.body.appendChild(clip);
  const nw = $app.firstElementChild; nw.style.transition = 'none'; nw.style.willChange = 'transform'; nw.style.transform = `translate3d(${-sign * W}px,0,0)`;
  void nw.offsetWidth; gh.style.transition = cv; gh.style.transform = `translate3d(${sign * W}px,0,0)`; nw.style.transition = cv; nw.style.transform = 'translate3d(0,0,0)';
  const fin = () => { clearTimeout(tm); clip.remove(); if (nw.isConnected) { nw.style.transition = ''; nw.style.transform = ''; nw.style.willChange = ''; } if (pgAnim === fin) pgAnim = null; };
  const tm = setTimeout(fin, 320); pgAnim = fin;
}
// тап не теряется: фоновая перерисовка (синхронизация и т.п.) не меняет страницу под пальцем — ждёт, пока касание закончится
let touchBusy = false, touchT = 0;
document.addEventListener('touchstart', () => { touchBusy = true; clearTimeout(touchT); }, { passive: true, capture: true });
const touchOff = () => { clearTimeout(touchT); touchT = setTimeout(() => { touchBusy = false; if (render._q) { render._q = false; render(true); } }, 450); };
document.addEventListener('touchend', touchOff, { passive: true, capture: true }); document.addEventListener('touchcancel', touchOff, { passive: true, capture: true });
function render(soft) {
  if (soft && touchBusy) { render._q = true; return; }
  if (S.route.startsWith('/join/')) return renderJoin(); // приглашение друга: страница регистрации
  if (!S.user) { if (S.route !== '/login') { S.route = '/login'; history.replaceState({}, '', '/login'); } return renderLogin(); }
  if (S.route === '/login') { S.route = '/'; history.replaceState({}, '', '/'); }
  const r = S.route;
  const fn = PAGES()[r] || pgHome;
  const main = MAIN.includes(r) ? r : '/profile';
  const scroll = soft ? window.scrollY : 0;
  const focus = document.activeElement && document.activeElement.id;
  const keep = soft && document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.closest('#app');
  if (keep) return; // не перерисовываем поверх вводимого текста
  { const op = document.querySelector('.navpill'), nv = op && op.offsetParent; if (op && nv && S.pill) { const r1 = op.getBoundingClientRect(), r0 = nv.getBoundingClientRect(); S.pill = { x: r1.left - r0.left - nv.clientLeft, y: S.pill.y, w: r1.width, h: S.pill.h }; } }
  if (pgAnim) pgAnim(); // быстрые тапы: предыдущий переход сразу завершаем, ничего не копится
  const slide = lastRoute !== null && lastRoute !== r && !soft && slideDir && pgIdx(lastRoute) > -1 && pgIdx(r) > -1;
  const oldPg = slide ? $app.firstElementChild : null, oldBox = oldPg && oldPg.getBoundingClientRect();
  $app.innerHTML = `<div class="${lastRoute !== null && lastRoute !== r && !soft && !slide ? 'pg ' + slideDir : ''}">${fn()}</div>` + nav(main) ;
  lastRoute = r; render.seq = (render.seq || 0) + 1; if (window.swPrebuild) window.swPrebuild();
  if (oldPg) slidePages(oldPg, oldBox, slideDir === 'pg-next' ? -1 : 1);
  keepIcons();
  placePill();
  animateBalance();
  if (soft) window.scrollTo(0, scroll);
  if (focus) { const e = document.getElementById(focus); if (e) e.focus(); }
}
// плавные сегменты: одна плашка едет от прошлого выбора к новому
// белый текст внутри плашки сегмента: копия кнопок внутри плашки, сдвинутая обратно
function segClone(sg, pl) {
  const bs = [...sg.querySelectorAll(':scope > button')]; const sig = bs.map(b => b.textContent + (b.dataset.id || '')).join('|');
  let hi = pl.firstElementChild;
  if (!hi || pl._sig !== sig) {
    pl._sig = sig; if (!hi) { hi = document.createElement('div'); hi.className = 'seghi'; pl.appendChild(hi); }
    hi.innerHTML = ''; bs.forEach(b => { const c = b.cloneNode(true); c.className = ''; c.removeAttribute('data-act'); c.removeAttribute('disabled'); c.tabIndex = -1; c.setAttribute('aria-hidden', 'true'); hi.appendChild(c); });
  }
  hi.style.width = sg.clientWidth + 'px'; hi.style.height = sg.clientHeight + 'px';
  [...hi.children].forEach((c, n) => { const o = bs[n]; if (!o) return; c.style.left = o.offsetLeft + 'px'; c.style.top = o.offsetTop + 'px'; c.style.width = o.offsetWidth + 'px'; c.style.height = o.offsetHeight + 'px'; });
  return hi;
}
function segMove(pl, x, w, dur) {
  const sg = pl.parentElement, hi = pl.firstElementChild || segClone(sg, pl);
  pl.style.transition = dur ? `transform ${dur},width ${dur},background .22s ease` : 'none'; pl.style.width = w + 'px'; pl.style.transform = `translateX(${x}px)`;
  if (hi) { hi.style.transition = dur ? `transform ${dur}` : 'none'; if (pl._ot == null || dur) pl._ot = pl.offsetTop; hi.style.transform = `translate(${-x}px,${-pl._ot}px)`; }
  if (sg && sg.classList.contains('tt')) { ttPaint(pl, dur ? undefined : x); if (dur) { const t0 = performance.now(); cancelAnimationFrame(pl._raf); const f = () => { ttPaint(pl); if (performance.now() - t0 < 340) pl._raf = requestAnimationFrame(f); }; pl._raf = requestAnimationFrame(f); } }
}
// цвет плашки Expense / Income / Transfer плавно смешивается по положению (в OKLab, как реальный переход цвета)
const TT = { expense: ['#ff6b6b', '#d1213b', [209, 33, 59]], income: ['#34d399', '#05875f', [5, 135, 95]], transfer: ['#60a5fa', '#1d4ed8', [29, 78, 216]] };
const hex2 = (h) => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
const gam = (c) => { c = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; return Math.max(0, Math.min(255, Math.round(c * 255))); };
function toLab([r, g, b]) { r = lin(r); g = lin(g); b = lin(b); const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b), m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b), s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b); return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]; }
function fromLab([L, A, B]) { const l = Math.pow(L + 0.3963377774 * A + 0.2158037573 * B, 3), m = Math.pow(L - 0.1055613458 * A - 0.0638541728 * B, 3), s = Math.pow(L - 0.0894841775 * A - 1.291485548 * B, 3); return [gam(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), gam(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), gam(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)]; }
const mixLab = (c1, c2, f) => { // OKLCH: по цветовому кругу (красный → оранжевый → жёлтый → зелёный → бирюзовый → синий)
  const [L1, a1, b1] = toLab(c1), [L2, a2, b2] = toLab(c2); const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2); let h1 = Math.atan2(b1, a1), h2 = Math.atan2(b2, a2);
  let dh = h2 - h1; if (dh > Math.PI) dh -= 2 * Math.PI; if (dh < -Math.PI) dh += 2 * Math.PI;
  const L = L1 + (L2 - L1) * f, C = C1 + (C2 - C1) * f, h = h1 + dh * f; return fromLab([L, C * Math.cos(h), C * Math.sin(h)]); };
function ttPaint(pl, x0) {
  const sg = pl.parentElement; const bs = [...sg.querySelectorAll(':scope > button')]; if (bs.length < 2) return;
  let x = x0; if (x === undefined) { const tf = getComputedStyle(pl).transform; try { x = new DOMMatrixReadOnly(tf === 'none' ? undefined : tf).m41; } catch (_) { x = 0; } }
  // центры кнопок не меняются во время жеста: считаем один раз, без лишних замеров вёрстки на каждом кадре
  const key = pillText.k; if (pl._csk !== key || !pl._cs) { pl._csk = key; pl._cs = bs.map(b => b.offsetLeft + b.offsetWidth / 2); }
  const cx = x + parseFloat(pl.style.width || pl.offsetWidth) / 2; const cs = pl._cs; const ty = bs.map(b => b.dataset.id);
  let i = 0; while (i < cs.length - 2 && cx > cs[i + 1]) i++; const f = Math.max(0, Math.min(1, (cx - cs[i]) / ((cs[i + 1] - cs[i]) || 1)));
  const A = TT[ty[i]], B = TT[ty[i + 1]]; if (!A || !B) return;
  const c1 = mixLab(hex2(A[0]), hex2(B[0]), f), c2 = mixLab(hex2(A[1]), hex2(B[1]), f), sh = mixLab(A[2], B[2], f);
  pl.style.background = `linear-gradient(135deg,rgb(${c1}),rgb(${c2}))`; pl.style.boxShadow = `0 4px 12px rgba(${sh},.3)`;
}
const segPos = {};
function initSegs() {
  document.querySelectorAll('.seg').forEach((sg) => {
    const on = sg.querySelector(':scope > button.on'); const first = sg.querySelector(':scope > button'); if (!first) return;
    const key = (first.dataset.act || '') + ':' + (sg.closest('.ov') ? 'ov' : S.route);
    let pl = sg.querySelector(':scope > .segpill'); const fresh = !pl;
    if (!pl) { pl = document.createElement('i'); pl.className = 'segpill'; sg.prepend(pl); }
    segClone(sg, pl);
    if (!on) { pl.style.opacity = 0; return; }
    const b = { x: on.offsetLeft, w: on.offsetWidth, t: on.dataset.id || '' };
    if (pl._t === b.t + b.x + ':' + b.w) return; pl._t = b.t + b.x + ':' + b.w;
    pl.dataset.t = b.t; const prev = segPos[key];
    const put = (x, w, anim) => { segMove(pl, x, w, anim ? '.22s cubic-bezier(.4,0,.2,1)' : ''); pl.style.opacity = 1; };
    if (fresh && prev && (prev.x !== b.x || prev.w !== b.w)) { put(prev.x, prev.w, false); requestAnimationFrame(() => requestAnimationFrame(() => put(b.x, b.w, true))); } else put(b.x, b.w, !fresh);
    segPos[key] = b;
  });
}
new MutationObserver(() => { cancelAnimationFrame(initSegs._r); initSegs._r = requestAnimationFrame(initSegs); }).observe(document.documentElement, { childList: true, subtree: true });
// плашка выбранной вкладки: одна на всё меню, плавно едет между вкладками и за свайпом
const tabBox = (path) => { const a = document.querySelector(`.nav a[data-go="${path}"]`); return a ? { x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight } : null; };
// белый текст внутри плашки: копия меню внутри плашки, сдвинутая обратно, поэтому текст делится ровно по краю плашки
function pillText(el, x, y, tr) {
  const hi = el.firstElementChild, box = el.parentElement; if (!hi || !box) return;
  if (hi._k !== pillText.k) { hi._k = pillText.k; const cs = getComputedStyle(box); hi.style.width = box.clientWidth + 'px'; hi.style.height = box.clientHeight + 'px'; hi.style.padding = cs.padding; } // размеры меню меряем один раз, не на каждом кадре
  hi.style.transition = tr; hi.style.transform = `translate(${-x}px,${-y}px)`;
}
pillText.k = 1; window.addEventListener('resize', () => { pillText.k++; });
function setPill(b, anim) {
  const el = document.querySelector('.navpill'); if (!el || !b) return;
  const cv = typeof anim === 'string' ? anim : '.22s cubic-bezier(.4,0,.2,1)';
  const tr = anim ? `transform ${cv},width ${cv},height ${cv}` : 'none';
  el.style.transition = tr; el.style.width = b.w + 'px'; el.style.height = b.h + 'px'; el.style.transform = `translate(${b.x}px,${b.y}px)`; el.style.opacity = 1;
  pillText(el, b.x, b.y, anim ? `transform ${cv}` : 'none');
}
const onTab = (path) => { const hs = document.querySelectorAll('.navhi a'); document.querySelectorAll('.nav a[data-go]').forEach((a, n) => { const on = a.dataset.go === path; a.classList.toggle('on', on); if (hs[n]) hs[n].classList.toggle('on', on); }); };
function placePill() {
  const main = MAIN.includes(S.route) ? S.route : '/profile'; const b = tabBox(main); if (!b) return;
  if (S.pill && Math.abs(S.pill.x - b.x) > 1) { setPill(S.pill, false); requestAnimationFrame(() => requestAnimationFrame(() => setPill(b, true))); } else setPill(b, false);
  S.pill = b;
}
function nav(on) {
  const it = [['/', 'home', 'Home'], ['/history', 'list', 'History'], ['/stats', 'chart', 'Stats'], ['/profile', 'user', 'Profile']];
  const a = ([p, i, n]) => `<a href="${p}" data-go="${p}" class="${p === on ? 'on' : ''}"><span>${svg(i, 24)}</span>${n}</a>`;
  const h = ([p, i, n]) => `<a class="${p === on ? 'on' : ''}" tabindex="-1" aria-hidden="true"><span>${svg(i, 24)}</span>${n}</a>`;
  return `<div class="nav"><div><i class="navpill"><div class="navhi">${it.slice(0, 2).map(h).join('')}<div></div>${it.slice(2).map(h).join('')}</div></i>${it.slice(0, 2).map(a).join('')}<div class="navadd"><button data-act="add" aria-label="Add">${svg('add', 28)}</button></div>${it.slice(2).map(a).join('')}</div></div>`;
}
const spaceSwitch = () => `<div class="seg">${rows('spaces').sort((a, b) => a.sort - b.sort).map(s => `<button class="${s.id === S.space ? 'on' : ''}" data-act="space" data-id="${s.id}">${esc(s.name)}</button>`).join('')}</div>`;
const mnav = () => `<div class="mnav"><button data-act="mprev">‹</button><b>${monthName(curMonth())}</b><button data-act="mnext">›</button></div>`;
const srcIco = { sms: '📱', wallet: '', payme: '🧾', telegram: '✈️' };
// перевод = одна строка (одна операция — одна карточка): оставляем расходную ногу, вторая показывается в подписи «откуда → куда»
const oneTransfer = (list) => { const seen = new Set(); return list.filter(t => { if (t.type !== 'transfer' || !t.transfer_group_id) return true; if (seen.has(t.transfer_group_id)) return false;
  const legs = rows('transactions').filter(x => x.transfer_group_id === t.transfer_group_id && !x.deleted_at); const out = legs.find(x => x.amount < 0) || t; if (out !== t && list.includes(out)) return false; seen.add(t.transfer_group_id); return true; }); };
function txRow(t, merged) {
  let acc = byId('accounts', t.account_id); const isT = t.type === 'transfer';
  const leg2 = isT && merged && t.transfer_group_id ? rows('transactions').find(x => x.transfer_group_id === t.transfer_group_id && x.id !== t.id && !x.deleted_at) : null;
  if (leg2) { const out = t.amount < 0 ? t : leg2, inn = t.amount < 0 ? leg2 : t; const fa = byId('accounts', out.account_id), ta = byId('accounts', inn.account_id); acc = { name: (fa ? fa.name : '?') + ' → ' + (ta ? ta.name : '?') }; t = out; }
  const title = isT ? 'Transfer' : (t.note || t.merchant || catPath(t.category_id) || 'Untitled');
  const sub = isT ? (t.note || '') : (catPath(t.category_id) || 'no category');
  const sign = leg2 ? '' : t.type === 'income' || (isT && t.amount > 0) ? '+' : '−'; const cls = isT ? 'trf' : sign === '+' ? 'pos' : 'neg';
  const src = t.source === 'wallet' ? ' · Wallet' : t.source === 'sms' ? ' · SMS' : t.source === 'payme' ? ' · Payme' : t.source === 'telegram' ? ' · bot' : '';
  return `<div class="row" data-act="tx" data-id="${t.id}"><div class="ico">${isT ? svg('transfer') : catIcon(t.category_id)}</div><div class="grow"><b>${esc(title)}</b><span class="sub">${[sub, acc ? acc.name : '?', hm(t.occurred_at)].filter(Boolean).map(esc).join(' · ')}${src}</span></div><div class="amt ${cls}">${sign}${fmt(Math.abs(t.amount), t.currency)}</div></div>`;
}

// ---------- страницы ----------
const uncatList = () => rows('transactions').filter(t => t.space_id === S.space && (t.type === 'expense' || t.type === 'income') && !t.category_id);

// ---------- Home: лимиты, пустые состояния, анимация баланса ----------
function limitsCard(m, sp) {
  const rs = cats('expense').filter(c => !c.parent_id && !c.archived).map(c => { const b = budgetFor(c.id, m); return b && b.limit_amount > 0 ? { c, b, v: sp.out[c.id] || 0 } : null; }).filter(Boolean)
    .map(x => ({ ...x, p: Math.round(x.v / x.b.limit_amount * 100) })).sort((a, b) => b.p - a.p).slice(0, 3);
  if (!rs.length) return '';
  return `<div class="card" data-go="/profile/budget" style="cursor:pointer"><div class="lbl">Category limits</div>${rs.map(x => `<div class="lim"><div class="limh"><div class="ico sm">${rootIcon(x.c, 18)}</div><b class="grow">${esc(x.c.name)}</b><span class="sub">${fmt(x.v, 'UZS', 1)} / ${fmt(x.b.limit_amount, 'UZS')}</span></div><div class="bar"><i class="${x.p >= 90 ? 'gr-red' : x.p >= 50 ? 'gr-ylw' : 'gr-grn'}" style="width:${Math.min(100, x.p)}%"></i></div><div class="sub limp">${x.p}%${x.p >= 100 ? ' · over the limit' : x.p >= 90 ? ' · almost at the limit' : ''}</div></div>`).join('')}</div>`;
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
  const t0 = performance.now(), dur = 300;
  const step = (t) => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); const v = Math.round((from + (to - from) * e) / 100) * 100; const n = document.getElementById('bal'); if (!n) return; n.textContent = fmt(v, 'UZS'); if (k < 1) balAnim = requestAnimationFrame(step); };
  balAnim = requestAnimationFrame(step);
}
function pgHome() {
  const m = monthKey(now()); const bud = budgetFor(null, m); const sp = spentByRoot(m);
  const accs = accounts().filter(a => !a.hidden); const tot = totalBase(); const rate = curRate();
  // Recent: только сегодня (Asia/Tashkent), последние 3 операции; перевод — одной строкой
  const d0 = Math.floor((now() + TZ) / 86400000) * 86400000 - TZ;
  const recent = oneTransfer(rows('transactions').filter(t => t.space_id === S.space && t.occurred_at >= d0 && t.occurred_at < d0 + 86400000).sort((a, b) => b.occurred_at - a.occurred_at)).slice(0, 3);
  const [, e] = monthRange(m); const daysLeft = Math.max(1, Math.ceil((e - now()) / 86400000));
  const pct = bud ? Math.min(100, Math.round(sp.total / bud.limit_amount * 100)) : 0;
  return `<div class="top"><h1>Home</h1>${spaceSwitch()}</div>
  <div class="quick"><input id="qa" placeholder="Quick: “lunch 58000” or “taxi 25k”" enterkeyhint="done" autocomplete="off"><button data-act="qa">＋</button></div>
  <div class="card hero"><button class="eyeb" data-act="hide" aria-label="${S.hide ? 'Show amounts' : 'Hide amounts'}">${svg(S.hide ? 'eye' : 'eyeoff', 22)}</button><div class="lbl">Balance</div><div class="big" id="bal" data-v="${tot}">${fmt(S.balShown ?? tot, 'UZS')}</div><div class="sub">≈ $${S.hide ? '*****' : (tot / rate / 100).toLocaleString('en-US', { maximumFractionDigits: 0 })} at ${fmtRate(rate)}${S.rates && S.rates.fetched_at ? ' · updated ' + dd(S.rates.fetched_at) + ' ' + hm(S.rates.fetched_at) : ''}</div></div>
  ${uncatList().length ? `<div class="card" data-act="uncat" style="cursor:pointer;display:flex;justify-content:space-between;align-items:center"><div><b>${uncatList().length} without category</b><div class="sub">Tap to sort them</div></div><span class="sub">›</span></div>` : ''}
  <div class="card" data-go="/profile/budget" style="cursor:pointer"><div class="lbl">Monthly budget</div>${bud ? `<div style="display:flex;justify-content:space-between;font-weight:600;margin-top:4px"><span>${fmt(sp.total, 'UZS', 1)} / ${fmt(bud.limit_amount, 'UZS')}</span><span class="lbl">${pct}%</span></div><div class="bar"><i class="${sp.total > bud.limit_amount ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">Left ${fmt(bud.limit_amount - sp.total, 'UZS')} · ${daysLeft} d</div>` : `<div class="sub" style="margin-top:6px">No limit set. Spent: ${fmt(sp.total, 'UZS')}. Tap to set.</div>`}</div>
  ${limitsCard(m, sp)}
  <div class="card">${accs.map(a => `<div class="row" data-act="acc" data-id="${a.id}"><div class="ico">${accIcon(a)}</div><div class="grow"><b>${esc(a.name)}</b>${a.currency === 'USD' ? '<span class="sub">USD</span>' : ''}</div><div class="amt">${a.currency === 'USD' ? fmt(balance(a), 'USD') : fmt(balance(a), 'UZS')}</div></div>`).join('') || '<div class="sub">No accounts</div>'}</div>
  <div class="card"><div class="lbl">Recent</div>${recent.map(t => txRow(t, true)).join('') || '<div class="sub" style="padding:6px 0 2px">No payments today</div>'}</div>`;
}
function pgTrans() {
  const [a, b] = monthRange(curMonth()); const q = S.q.toLowerCase();
  const list = rows('transactions').filter(t => t.space_id === S.space && (S.uncat ? (t.type !== 'transfer' && !t.category_id) : (t.occurred_at >= a && t.occurred_at < b)) && (!S.accF || t.account_id === S.accF) &&
    (!q || (t.note + ' ' + t.merchant + ' ' + catPath(t.category_id)).toLowerCase().includes(q))).sort((x, y) => y.occurred_at - x.occurred_at);
  const days = {}; (S.accF ? list : oneTransfer(list)).forEach(t => { const k = dayLabel(t.occurred_at); (days[k] = days[k] || []).push(t); });
  const exp = list.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount_base, 0), inc = list.filter(t => t.type === 'income').reduce((s, t) => s + t.amount_base, 0);
  return `<div class="top"><h1>History</h1>${spaceSwitch()}</div>${mnav()}
  <div class="card" style="display:flex;justify-content:space-around;text-align:center"><div><div class="lbl">Expenses</div><b class="neg">${fmt(exp, 'UZS')}</b></div><div><div class="lbl">Income</div><b class="pos">${fmt(inc, 'UZS')}</b></div></div>
  <input id="srch" class="f" style="background:var(--card)" placeholder="Search" value="${esc(S.q)}">
  <div class="chips"><button class="chip ${S.uncat ? 'on' : ''}" data-act="uncatf">No category (${uncatList().length})</button><button class="chip ${!S.accF ? 'on' : ''}" data-act="accf" data-id="">All</button>${accounts().map(x => `<button class="chip ${S.accF === x.id ? 'on' : ''}" data-act="accf" data-id="${x.id}">${esc(x.name)}</button>`).join('')}</div>
  ${Object.keys(days).map(k => `<div class="day"><span>${k}</span>${dayNet(days[k])}</div><div class="card" style="padding:4px 16px">${days[k].map(t => txRow(t, !S.accF)).join('')}</div>`).join('') || `<div class="card">${emptyState()}</div>`}`;
}
const PAL = ['#3b6ef6', '#22a06b', '#f5a623', '#e5484d', '#9b6cf0', '#18b4c9', '#e26ba5', '#8b92a3'];
const CATCOL = { food: '#f97316', leisure: '#8b5cf6', transport: '#3b82f6', expenses: '#0d9488', family: '#ec4899', shopping: '#d97706', health: '#ef4444', salary: '#16a34a', 'other income': '#16a34a' };
const colOf = (it, i) => { const p = it.c && parseIc(it.c.icon); if (p && p.c !== 'def') return ICCOL[p.c][document.documentElement.dataset.theme === 'dark' ? 3 : 1]; return (it.c && CATCOL[String(it.c.name).toLowerCase()]) || PAL[i % PAL.length]; };
function selSlice(id) {
  const box = document.querySelector('.dwrap'); if (!box) return;
  const cur = box.dataset.sel || ''; const nx = cur === id ? '' : id; box.dataset.sel = nx; box.classList.toggle('has', !!nx);
  box.querySelectorAll('.sl').forEach(c => c.classList.toggle('on', c.dataset.id === nx));
  box.querySelectorAll('.dc').forEach(c => c.classList.toggle('on', c.dataset.for === nx));
  document.querySelectorAll('.sdet').forEach(c => c.classList.toggle('on', c.dataset.for === nx));
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
  return `<div class="card"><div class="lbl">Expenses · last 6 months</div><svg class="trend" viewBox="0 0 300 ${top + H + 24}" width="100%"><defs><linearGradient id="gexp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ff6b6b"/><stop offset="1" stop-color="#c81e3a"/></linearGradient></defs>${bars}</svg><div class="tleg">Average ${shortAmt(avg, disp, rate)} / month · tap a month to open it</div></div>`;
}
function pgStats() {
  const m = curMonth(); const per = S.per || '1M'; const rng = perRange(m, per); const sp = spentByRoot(m, S.space, rng); const disp = S.dispCur || 'UZS'; const rate = curRate();
  const conv = (v) => disp === 'USD' ? v / rate : v; const f = (v) => disp === 'USD' ? fmt(Math.round(conv(v)), 'USD') : fmt(v, 'UZS');
  const items = Object.entries(sp.out).map(([id, v]) => ({ id, v, c: byId('categories', id) })).sort((a, b) => b.v - a.v);
  let acc = 0; const R = 70, C = 2 * Math.PI * R; const [a0, b0] = rng;
  const pct = (v) => Math.round(v / sp.total * 100);
  const donut = sp.total ? `<div class="donut"><svg viewBox="0 0 200 200" width="200" height="200" style="transform:rotate(-90deg)">${items.map((it, i) => { const len = it.v / sp.total * C; const gap = items.length > 1 ? 1.5 : 0; const s = `<circle data-act="slice" data-id="${it.id}" class="sl" r="${R}" cx="100" cy="100" fill="none" stroke="${colOf(it, i)}" stroke-width="34" stroke-dasharray="${Math.max(0.1, len - gap)} ${C - len + gap}" stroke-dashoffset="${-acc}"/>`; acc += len; return s; }).join('')}</svg>
    <div class="dc" data-for="">${(() => { const t = f(sp.total), u = disp === 'USD' ? '' : ' UZS'; const n = u && t.endsWith(u) ? t.slice(0, -u.length) : t; return `<b class="dct${n.length > 9 ? ' sm' : ''}">${n}</b><span>${u ? 'UZS · total' : 'total'}</span>`; })()}</div>${items.map((it, i) => `<div class="dc" data-for="${it.id}"><b style="color:${colOf(it, i)}">${pct(it.v)}%</b><span>${it.c ? esc(it.c.name) : 'No category'}</span></div>`).join('')}</div>` : '';
  const det = {}; if (sp.total) items.forEach((it, i) => { const subs = {}; rows('transactions').forEach(t => { if (t.space_id === S.space && t.type === 'expense' && t.occurred_at >= a0 && t.occurred_at < b0 && (rootOf(t.category_id) ? rootOf(t.category_id).id : '_none') === it.id) { const k = t.category_id && t.category_id !== it.id ? byId('categories', t.category_id).name : 'General'; subs[k] = (subs[k] || 0) + t.amount_base; } });
      det[it.id] = `<div class="sdet" data-for="${it.id}"><div class="sdin">${Object.entries(subs).sort((x, y) => y[1] - x[1]).map(([k, v]) => `<div class="sdr"><span>${esc(k)}</span><span>${f(v)}</span></div>`).join('')}</div></div>`; });
  const donutOr = donut || '<div class="sub">No expenses</div>';
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
  <div class="card" style="text-align:center"><div class="lbl">${ttl}</div><div class="big neg">${f(sp.total)}</div>${bud ? `<div class="sub">budget ${f(bud.limit_amount)} · used ${Math.round(sp.total / bud.limit_amount * 100)}%</div>` : ''}<div class="dwrap">${donutOr}</div>
  ${items.map((it, i) => `<div class="legend" data-act="slice" data-id="${it.id}"><i style="background:${colOf(it, i)}"></i><span class="grow">${it.c ? esc(it.c.name) : 'No category'}</span><b>${f(it.v)}</b><span class="sub" style="width:42px;text-align:right">${Math.round(it.v / sp.total * 100)}%</span><svg class="lga" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg></div>${det[it.id] || ''}`).join('')}</div>
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
  const l = [['/profile/accounts', 'card', 'Accounts'], ['/profile/budget', 'target', 'Budget & limits'], ['/profile/categories', 'grid', 'Categories'], ['/profile/rules', 'tag', 'Rules'], ['/profile/rate', 'rate', 'USD rate'], ['/profile/settings', 'sliders', 'Settings, Telegram'], ...(S.me && S.me.owner ? [['/profile/invite', 'invite', 'Invite friends']] : [])];
  return `<div class="top"><h1>Profile</h1></div><div class="card">${l.map(([p, i, n]) => `<div class="row" data-go="${p}"><div class="ico">${svg(i)}</div><div class="grow"><b>${n}</b></div><span class="sub">›</span></div>`).join('')}</div><div class="stat" id="sbadge">${syncText()}</div>`;
}
function pgBudget() {
  const m = curMonth(); const sp = spentByRoot(m); const tot = budgetFor(null, m);
  const roots = cats('expense').filter(c => !c.parent_id && !c.archived);
  const line = (name, spent, b, cat) => { const lim = b ? b.limit_amount : 0; const pct = lim ? Math.min(100, Math.round(spent / lim * 100)) : 0; return `<div style="padding:10px 0;border-bottom:1px solid var(--line)"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><b class="grow">${name}</b><input class="f" style="width:130px;margin:0;text-align:right" inputmode="decimal" data-bud="${cat || ''}" placeholder="limit" value="${lim ? grp(Math.round(lim / 100)) : ''}"></div><div class="bar"><i class="${lim && spent > lim ? 'over' : ''}" style="width:${pct}%"></i></div><div class="sub">spent ${fmt(spent, 'UZS')}${lim ? ' · left ' + fmt(lim - spent, 'UZS') : ''}</div></div>`; };
  const pace = (() => {
    if (!tot || !(tot.limit_amount > 0)) return '';
    const [st, en] = monthRange(m); const span = en - st; const el = Math.min(1, Math.max(0, (now() - st) / span));
    const dim = Math.round(span / 86400000); const dayN = Math.min(dim, Math.max(1, Math.ceil(el * dim)));
    const planned = Math.round(tot.limit_amount * el); const left = tot.limit_amount - sp.total; const dl = Math.max(1, dim - dayN + 1);
    const st2 = sp.total > tot.limit_amount ? ['over', 'Over the budget'] : sp.total > planned * 1.1 ? ['warn', 'Ahead of plan'] : ['ok', 'On track'];
    return `<div class="card pace ${st2[0]}"><div class="lbl">Goal for ${monthName(m)}</div><div style="display:flex;justify-content:space-between;align-items:baseline;margin-top:4px"><b class="big">${fmt(sp.total, 'UZS', 1)}</b><span class="sub">of ${fmt(tot.limit_amount, 'UZS')}</span></div><div class="bar"><i class="${sp.total > tot.limit_amount ? 'over' : ''}" style="width:${Math.min(100, Math.round(sp.total / tot.limit_amount * 100))}%"></i><u style="left:${Math.round(el * 100)}%"></u></div><div class="sub"><b class="pst">${st2[1]}</b> · plan for today ${fmt(planned, 'UZS')} · ${left >= 0 ? 'you can spend ' + fmt(Math.round(left / dl), 'UZS') + ' a day' : 'over by ' + fmt(-left, 'UZS')}</div></div>`;
  })();
  return `<div class="top"><h1>Budget</h1>${spaceSwitch()}</div>${mnav()}${pace}<button class="btn full" style="margin-bottom:12px" data-act="bt">Budget template</button><div class="card"><div class="lbl">The limit applies to this and following months</div>${line('Whole month', sp.total, tot, '')}${roots.map(c => line(`<span class="lic">${rootIcon(c, 18)}</span>` + esc(c.name), sp.out[c.id] || 0, budgetFor(c.id, m), c.id)).join('')}</div>`;
}
function pgCats() {
  const roots = cats('expense').concat(cats('income')).filter(c => !c.parent_id && !c.archived);
  const hdl = `<span class="hdl" data-hdl aria-label="Drag to reorder">${svg('grip', 20)}</span>`;
  return `<div class="top"><h1>Categories</h1>${spaceSwitch()}</div><div class="dz" data-group="root">${roots.map(r => `<div class="card dr" data-id="${r.id}"><div class="row rtop" data-act="catedit" data-id="${r.id}" style="padding-top:0"><div class="ico">${rootIcon(r)}</div><div class="grow"><b>${esc(r.name)}</b><span class="sub">${r.kind === 'income' ? 'income' : 'expense'}</span></div>${hdl}</div><div class="dz" data-group="${r.id}">${cats().filter(c => c.parent_id === r.id && !c.archived).map(c => `<div class="row dr" data-act="catedit" data-id="${c.id}" style="padding-left:56px"><div class="grow">${esc(c.name)}</div>${hdl}</div>`).join('')}</div><button class="addsub" data-act="catnew" data-id="${r.id}">${svg('add', 18)}<span>Add subcategory</span></button></div>`).join('')}</div><button class="btn sec full" data-act="catnew" data-id="">+ Category</button>`;
}
// Правила на своей странице, сгруппированы по разделам: заголовок раздела раскрывает его правила (как в выборе категории)
function pgRules() {
  const all = rules().map((r, i) => ({ ...r, i })); const roots = cats('expense').concat(cats('income')).filter(c => !c.parent_id);
  const order = (id) => { const c = byId('categories', id); return c ? c.sort : 999; };
  const groups = roots.map(p => { const ids = new Set([p.id].concat(cats().filter(c => c.parent_id === p.id).map(c => c.id))); return { p, list: all.filter(r => ids.has(r.c)) }; }).filter(g => g.list.length);
  const known = new Set(groups.flatMap(g => g.list.map(r => r.i))); const lost = all.filter(r => !known.has(r.i));
  const chev = '<svg class="cpa" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  const sec = (key, ico, name, list, pid) => {
    list.sort((a, b) => (a.c === pid ? -1 : order(a.c)) - (b.c === pid ? -1 : order(b.c)) || a.w.localeCompare(b.w));
    return `<div class="card rgp cps${S.rOpen === key ? ' open' : ''}" data-id="${key}"><div class="cph" data-act="rtog" data-id="${key}">${ico}<span class="grow">${esc(name)}</span><span class="rgn">${list.length}</span>${chev}</div><div class="cpb"><div class="cpbi">${list.map(r => { const c = byId('categories', r.c); return `<div class="cpi" data-act="ruleedit" data-id="${r.i}"><span class="grow"><b>${esc(r.w)}</b><span class="sub">${c && c.parent_id ? esc(c.name) : c ? 'Whole category' : 'Category deleted'}</span></span><span class="sub">›</span></div>`; }).join('')}</div></div></div>`;
  };
  return `<div class="top"><h1>Rules</h1>${spaceSwitch()}</div><div class="sub" style="margin:-4px 0 14px">A word in the note picks the category right away: “компы” → Gaming.</div>
  ${groups.map(g => sec(g.p.id, `<span class="ico sm">${rootIcon(g.p, 18)}</span>`, g.p.name, g.list, g.p.id)).join('')}${lost.length ? sec('_lost', `<span class="ico sm">${svg('tag', 18)}</span>`, 'No category', lost, '') : ''}
  ${all.length ? '' : '<div class="card"><div class="sub">No rules yet</div></div>'}<button class="btn sec full" data-act="ruleedit" data-id="">+ Rule</button>`;
}
function openRule(i) {
  const r = i === '' ? { w: '', c: '' } : rules()[+i]; if (!r) return; F = { ri: i, rw: r.w, rc: r.c };
  const opt = (k) => cats(k).filter(c => !c.parent_id && !c.archived).map(p => `<optgroup label="${esc(p.name)}"><option value="${p.id}" ${r.c === p.id ? 'selected' : ''}>${esc(p.name)}</option>${cats(k).filter(c => c.parent_id === p.id && !c.archived).map(c => `<option value="${c.id}" ${r.c === c.id ? 'selected' : ''}>${esc(p.name)} › ${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  openSheet(`<h2>${i === '' ? 'New rule' : 'Rule'}</h2><div class="lbl">Word in the note</div><input class="f" data-f="rw" value="${esc(r.w)}" placeholder="компы" autocapitalize="none">
  <div class="lbl">Category</div>${catField('rc', r.c, '')}
  <div style="display:flex;gap:10px">${i === '' ? '' : '<button class="btn red" data-act="ruledel">Delete</button>'}<button class="btn full" data-act="rulesave">Save</button></div>`);
}
function saveRule() {
  const w = String(F.rw || '').trim().toLowerCase(); if (!w) return toast('Enter a word'); if (!F.rc) return toast('Pick a category');
  const r = rules(); if (F.ri === '') r.push({ w, c: F.rc }); else r[+F.ri] = { w, c: F.rc };
  saveRules(r); const rc = byId('categories', F.rc); S.rOpen = rc ? (rc.parent_id || rc.id) : S.rOpen; closeSheet(); haptic('success'); render(true); toast('Saved · old transactions are not changed');
}
async function deleteRule() {
  if (!(await ask('Delete this rule?', '“' + F.rw + '” → ' + catLabel(F.rc)))) return;
  const r = rules(); r.splice(+F.ri, 1); saveRules(r); closeSheet(); haptic('warning'); render(true); toast('Deleted');
}
// перетаскивание за ручку ☰, соседи сдвигаются плавно.
// Мышь: сразу. Палец: удержание 1 с (Doniyor 21.11) → строка приподнимается + вибрация, только потом двигается; обычный свайп просто листает.
let drag = null, hold = null;
const HOLD_MS = 1000;
function startDrag(h, y) {
  const el = h.closest('.dr'); if (!el) return; const box = el.parentElement;
  drag = { el, box, y0: y, top0: el.offsetTop, moved: false };
  el.classList.add('dragging'); el.style.transition = 'transform .18s cubic-bezier(.2,.8,.2,1)'; el.style.transform = 'scale(1.03)';
}
function moveDrag(y) {
  const { el, box } = drag; const vis = drag.top0 + (y - drag.y0); drag.moved = true;
  const center = vis + el.offsetHeight / 2;
  const sibs = [...box.children].filter(x => x.classList.contains('dr') && x !== el);
  for (const sb of sibs) {
    const mid = sb.offsetTop + sb.offsetHeight / 2; const after = el.compareDocumentPosition(sb) & Node.DOCUMENT_POSITION_FOLLOWING;
    if ((after && center > mid) || (!after && center < mid)) {
      const before = sibs.map(x => [x, x.offsetTop]);
      if (after) box.insertBefore(el, sb.nextSibling); else box.insertBefore(el, sb);
      before.forEach(([x, t]) => { const d = t - x.offsetTop; if (d) { x.style.transition = 'none'; x.style.transform = `translateY(${d}px)`; requestAnimationFrame(() => { x.style.transition = 'transform .2s cubic-bezier(.4,0,.2,1)'; x.style.transform = ''; }); } });
      haptic('select'); break;
    }
  }
  el.style.transition = 'none'; el.style.transform = `translateY(${vis - el.offsetTop}px) scale(1.03)`;
}
document.addEventListener('pointerdown', (e) => {
  if (e.pointerType === 'touch') return; const h = e.target.closest('[data-hdl]'); if (!h) return;
  e.preventDefault(); e.stopPropagation(); startDrag(h, e.clientY); try { h.setPointerCapture(e.pointerId); } catch (x) { /* */ }
}, true);
document.addEventListener('pointermove', (e) => { if (!drag || e.pointerType === 'touch') return; e.preventDefault(); moveDrag(e.clientY); }, { passive: false });
document.addEventListener('pointerup', (e) => { if (e.pointerType !== 'touch') endDrag(); }); document.addEventListener('pointercancel', (e) => { if (e.pointerType !== 'touch') endDrag(); });
// палец
const holdOff = () => { if (hold) { clearTimeout(hold.t); hold.h.classList.remove('hold'); hold = null; } };
document.addEventListener('touchstart', (e) => {
  const h = e.target.closest('[data-hdl]'); if (!h || e.touches.length !== 1 || drag) return; holdOff();
  const t = e.touches[0]; h.classList.add('hold');
  hold = { h, x: t.clientX, y: t.clientY, t: setTimeout(() => { const hh = hold; hold = null; hh.h.classList.remove('hold'); startDrag(hh.h, hh.y); haptic('medium'); }, HOLD_MS) };
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (hold && t && Math.hypot(t.clientX - hold.x, t.clientY - hold.y) > 8) holdOff(); // палец поехал раньше срока — это прокрутка
  if (drag && t) { e.preventDefault(); moveDrag(t.clientY); }
}, { passive: false });
const touchEnd = () => { holdOff(); if (drag) endDrag(); };
document.addEventListener('touchend', touchEnd); document.addEventListener('touchcancel', touchEnd);
function endDrag() {
  if (!drag) return; const { el, box, moved } = drag; drag = null;
  el.style.transition = 'transform .2s cubic-bezier(.4,0,.2,1)'; el.style.transform = ''; el.classList.remove('dragging');
  setTimeout(() => { el.style.transition = ''; }, 220);
  if (!moved) return;
  const ids = [...box.children].filter(x => x.classList.contains('dr')).map(x => x.dataset.id);
  const tb = box.dataset.table || 'categories';
  setTimeout(() => { ids.forEach((id, k) => { const c = byId(tb, id); if (c && c.sort !== k) put(tb, { ...c, sort: k }); }); haptic('light'); }, 220);
}
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
  ${NATIVE ? `<div class="card"><div class="row" style="cursor:default"><div class="grow"><b>Face ID lock</b><span class="sub">Ask for Face ID when the app opens</span></div><div class="sw ${S.lockOn === false ? '' : 'on'}" data-act="lock"></div></div></div>` : ''}
  <div class="card"><div class="lbl">Menu style</div><div class="seg" style="margin-top:8px;width:max-content">${[['glass', 'Liquid Glass'], ['solid', 'Solid']].map(([k, n]) => `<button class="${(tryLS(() => localStorage.getItem('navstyle')) || 'glass') === k ? 'on' : ''}" data-act="navstyle" data-id="${k}">${n}</button>`).join('')}</div></div>
  ${NATIVE ? '' : `<div class="card"><div class="lbl">App icon</div><div class="icpick">${[['a', 'Wallet'], ['b', 'Donut'], ['c', 'Growth']].map(([k, n]) => `<button class="${(tryLS(() => localStorage.getItem('appicon')) || 'a') === k ? 'on' : ''}" data-act="appicon" data-id="${k}"><img src="/icon-${k}-180.png" alt=""><span>${n}</span></button>`).join('')}</div><div class="sub" style="margin-top:10px">On iPhone the icon is saved when the app is added. To change it: delete the app from the Home Screen, open the site in Safari, then Share → Add to Home Screen.</div></div>`}
  <div class="card"><b>Telegram bot <span id="tgst" class="tgst on">${tgBadge()}</span></b><div class="sub" style="margin:4px 0 10px">${me.tg_ready ? (me.tg_linked ? `Linked chats: ${me.tg_linked}` : 'Not linked yet') : 'Bot token is not set on the server'}<span id="tgwhy">${tgWhy()}</span></div>
  ${me.owner ? '<button class="btn sec" data-act="tgsetup">1. Connect webhook</button> <button class="btn" data-act="tgcode">2. Get code</button>' : '<button class="btn" data-act="tgcode">Get code</button>'}<div id="tgout" class="sub" style="margin-top:10px"></div></div>
  <div class="card"><b>URL for Shortcuts (SMS and Wallet)</b><div class="sub" style="margin:4px 0 8px">Secret. Don’t share it.</div>${me.hook_url ? `<code id="hook">${esc(me.hook_url)}</code><div style="margin-top:10px"><button class="btn sec" data-act="copyhook">Copy</button></div><div class="sub" style="margin-top:10px">Last SMS or Wallet received: ${me.last_in ? (() => { const d = new Date(me.last_in + TZ); const p = n => String(n).padStart(2, '0'); return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + ' ' + hm(me.last_in); })() : 'never'}</div>${me.bad_in ? `<div class="sub" style="margin-top:6px;color:#d64545">A request with a wrong URL came on ${(() => { const d = new Date(me.bad_in.at + TZ); const p = n => String(n).padStart(2, '0'); return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + ' ' + hm(me.bad_in.at); })()}. The Shortcut has an old URL: paste the one above.</div>` : ''}` : '<div class="sub">Not set (WEBHOOK_SECRET)</div>'}</div>
  ${window.PublicKeyCredential && !NATIVE ? `<div class="card"><b>Face ID</b><div class="sub" style="margin:4px 0 10px">${me.pk ? 'Face ID sign-in is on. The password still works.' : 'Sign in with Face ID instead of typing the password. The password stays as a backup.'}</div><div class="err" id="pkerr"></div>${me.pk ? '<button class="btn sec" data-act="pkoff">Turn off Face ID</button>' : '<button class="btn" data-act="pkon">Turn on Face ID</button>'}</div>` : ''}
  <div class="card"><b>Password</b><div class="sub" style="margin:4px 0 10px">Other devices will be signed out, this one stays signed in.</div><input class="f" type="password" id="pw0" placeholder="Current password" autocomplete="current-password"><input class="f" type="password" id="pw1" placeholder="New password (8+ characters)" autocomplete="new-password"><input class="f" type="password" id="pw2" placeholder="Repeat new password" autocomplete="new-password"><div class="err" id="pwerr"></div><button class="btn" data-act="pwsave">Change password</button></div>
  <div class="card"><b>Data</b><div class="sub" id="sbadge" style="margin:4px 0 10px">${syncText()}</div><button class="btn sec" data-act="syncnow">Sync now</button> <button class="btn sec" data-act="csv">Export CSV</button></div>
  <button class="btn red full" data-act="logout">Log out</button><div class="stat">${esc(me.login || '')}</div>`;
}
// ---------- приглашение друга ----------
const dm = (ts) => { const d = new Date(ts + TZ); const p = n => String(n).padStart(2, '0'); return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1); };
async function loadInvites() {
  const r = await api('/api/invites').catch(() => null);
  S.inv = { ...(S.inv || {}), list: r && r.ok ? r.data.invites : [] }; if (S.route === '/profile/invite') render(true);
}
function pgInvite() {
  const iv = S.inv || {}; if (!iv.list && !iv.loading) { S.inv = { ...iv, loading: 1 }; loadInvites(); }
  const list = (iv.list || []);
  const joined = list.filter(x => x.login), open = list.filter(x => !x.login && x.exp > now());
  return `<div class="top"><h1>Invite friends</h1></div>
  <div class="card"><b>Invite link</b><div class="sub" style="margin:4px 0 10px">Each link works once and for 7 days. Your friend picks a login and password and starts with an empty budget. Your data stays private.</div>
  ${iv.link ? `<code id="invlink" style="display:block;word-break:break-all">${esc(iv.link)}</code><div style="display:flex;gap:10px;margin-top:10px"><button class="btn sec full" data-act="invcopy">Copy</button><button class="btn full" data-act="invshare">Share</button></div><button class="btn sec full" data-act="invnew" style="margin-top:10px">New link</button>` : `<button class="btn full" data-act="invnew">Create invite link</button>`}</div>
  <div class="card"><div class="lbl">Friends</div>${joined.length ? joined.map(x => `<div class="row" style="cursor:default"><div class="ico">${svg('user')}</div><div class="grow"><b>${esc(x.login)}</b><span class="sub">joined ${dm(x.used_at)}</span></div></div>`).join('') : `<div class="sub" style="margin-top:6px">${iv.list ? 'No one has joined yet' : 'Loading…'}</div>`}
  ${open.length ? `<div class="sub" style="margin-top:10px">Unused links: ${open.length} (until ${open.map(x => dm(x.exp)).join(', ')})</div>` : ''}</div>`;
}
function renderJoin() {
  const code = S.route.slice(6);
  if (!S.joinChk || S.joinChk.code !== code) { S.joinChk = { code }; api('/api/invite/check', { method: 'POST', body: JSON.stringify({ code }) }).then(r => { S.joinChk = { code, ok: !!(r.ok && r.data.ok), by: r.data.by || '' }; if (S.route.startsWith('/join/')) render(); }).catch(() => { S.joinChk = { code, ok: null }; render(); }); }
  const c = S.joinChk; const fs = 'style="background:var(--card)"';
  let body;
  if (S.user) body = `<div class="sub" style="margin-bottom:16px">You are signed in as <b>${esc(S.user)}</b>. Log out on this device to create a new account.</div><button class="btn full" data-act="joinout">Log out</button><button class="btn sec full" style="margin-top:10px" data-go="/">Back to my budget</button>`;
  else if (c.ok === undefined) body = '<div class="sub">Checking the invite…</div>';
  else if (c.ok === false) body = `<div class="sub" style="margin-bottom:16px">This invite link is used or expired. Ask for a new one.</div><button class="btn sec full" data-go="/login">Sign in</button>`;
  else body = `<div class="sub" style="margin-bottom:20px">${c.by ? esc(c.by) + ' invited you. ' : ''}Create your account</div><input class="f" ${fs} id="jl" placeholder="Login" autocapitalize="none" autocorrect="off" spellcheck="false" autocomplete="username"><input class="f" ${fs} id="jp1" type="password" placeholder="Password (8+ characters)" autocomplete="new-password"><input class="f" ${fs} id="jp2" type="password" placeholder="Repeat password" autocomplete="new-password"><div class="err" id="jerr"></div><button class="btn full" data-act="join">Create account</button><button class="btn sec full" style="margin-top:10px" data-go="/login">I have an account</button>`;
  $app.innerHTML = `<div class="center pg"><h1 style="margin:0 0 4px">Budget</h1>${body}</div>`;
}
function renderLogin() {
  $app.innerHTML = `<div class="center pg"><h1 style="margin:0 0 4px">Budget</h1><div class="sub" style="margin-bottom:20px">Sign in</div><input class="f" style="background:var(--card)" id="lg" placeholder="Login" autocapitalize="none" autocomplete="username"><input class="f" style="background:var(--card)" id="pw" type="password" placeholder="Password" autocomplete="current-password"><div class="err" id="lgerr"></div>${tryLS(() => localStorage.getItem('pk')) === '1' && window.PublicKeyCredential && !NATIVE ? '<button class="btn full" data-act="pklogin" style="margin-bottom:10px">Sign in with Face ID</button>' : ''}<button class="btn ${tryLS(() => localStorage.getItem('pk')) === '1' && window.PublicKeyCredential && !NATIVE ? 'sec ' : ''}full" data-act="login">Sign in</button></div>`;
}

// плавная смена темы: вся страница (фоны, градиенты, сияние, меню) перетекает за 300 мс без кадров чужого цвета
function smoothTheme(fn) {
  const de = document.documentElement;
  if (document.startViewTransition && !document.hidden) {
    de.classList.add('vt-theme');
    try { const t = document.startViewTransition(fn); t.finished.finally(() => de.classList.remove('vt-theme')); return; } catch (_) { de.classList.remove('vt-theme'); }
  }
  de.classList.add('theming'); clearTimeout(window._thT); window._thT = setTimeout(() => de.classList.remove('theming'), 320); fn();
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
function txHtml() {
  const accs = accounts(); const isT = F.type === 'transfer';
  const opts = (sel) => accs.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)} (${a.currency})</option>`).join('');
  const kind = F.type === 'income' ? 'income' : 'expense';
  const catOpts = cats(kind).filter(c => !c.parent_id && !c.archived).map(p => `<optgroup label="${esc(p.name)}"><option value="${p.id}" ${F.category === p.id ? 'selected' : ''}>${esc(p.name)}</option>${cats(kind).filter(c => c.parent_id === p.id && !c.archived).map(c => `<option value="${c.id}" ${F.category === c.id ? 'selected' : ''}>${esc(p.name)} › ${esc(c.name)}</option>`).join('')}</optgroup>`).join('');
  const fa = isT ? byId('accounts', F.from) : byId('accounts', F.account), ta = isT ? byId('accounts', F.to) : null;
  const cross = isT && fa && ta && fa.currency !== ta.currency;
  return `<h2>${F.id ? 'Edit' : 'New transaction'}</h2>
  <div class="seg tt" style="margin-bottom:10px">${[['expense', 'Expense'], ['income', 'Income'], ['transfer', 'Transfer']].map(([k, n]) => `<button style="flex:1" class="${F.type === k ? 'on' : ''}" data-act="ftype" data-id="${k}" ${F.id && F.type !== k && (F.type === 'transfer' || k === 'transfer') ? 'disabled' : ''}>${n}</button>`).join('')}</div>
  <div class="txpane"><input class="f amtin amt-${F.type}" id="f-amount" inputmode="decimal" placeholder="0" value="${esc(grp(F.amount))}" data-f="amount" ${''}>
  ${isT ? `<div class="lbl">From</div><select class="f" data-f="from">${opts(F.from)}</select><div class="lbl">To</div><select class="f" data-f="to"><option value="">—</option>${opts(F.to)}</select>${cross ? `<div class="lbl">Amount received (${ta.currency})</div><input class="f" inputmode="decimal" data-f="amount2" value="${esc(grp(F.amount2))}" placeholder="amount received">` : ''}`
      : `<div class="lbl">Account</div><select class="f" data-f="account">${opts(F.account)}</select><div class="lbl">Category</div>${catField('category', F.category, F.type === 'income' ? 'income' : 'expense')}`}
  <div class="lbl">Note</div><input class="f" data-f="note" value="${esc(F.note)}" placeholder="What was it">
  <div class="lbl">Date and time</div><input class="f" type="datetime-local" data-f="date" value="${F.date}">
  ${!isT && fa && fa.currency === 'USD' ? `<div class="sub" style="margin-bottom:10px">Rate: ${fmtRate(curRate())} (from settings)</div>` : ''}
  <div style="display:flex;gap:10px">${F.id ? '<button class="btn red" data-act="txdel">Delete</button>' : ''}<button class="btn full save-${F.type}" data-act="txsave">Save</button></div></div>`;
}
function drawTx() {
  openSheet(txHtml());
  const am = document.getElementById('f-amount'); if (am && !F.id && !F.amount) setTimeout(() => am.focus(), 320);
}
function setFType(id) { const was = F.type; if (was === id) return;
      if (id === 'transfer' && was !== 'transfer') { if (F.account) F.from = F.account; if (F.to === F.from) F.to = ''; }
      else if (was === 'transfer' && id !== 'transfer' && F.from) F.account = F.from;
      F.type = id; if (id === 'income' || id === 'expense') F.category = ''; drawTx();
      if (!F.id) { const am = document.getElementById('f-amount'); if (am) { am.focus({ preventScroll: true }); const n = am.value.length; try { am.setSelectionRange(n, n); } catch (_) {} } }
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
    // новая заметка с выбранной категорией: предложить запомнить правило (один раз, тапом по подсказке)
    const w = tx.category_id && !F.autoCat ? ruleWord(tx.note) : '';
    if (w && !ruleCat(tx.note) ) { closeSheet(); return toast(`Saved · tap to always put “${w}” in ${catLabel(tx.category_id)}`, () => { saveRules(rules().concat([{ w, c: tx.category_id }])); toast(`Rule added: ${w} → ${catLabel(tx.category_id)}`); }); }
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
// Иконка по названию: словарь слов (рус/англ/узб), работает сразу и без сети. Нет совпадения — спрашиваем ИИ на сервере (если онлайн).
// Порядок важен: первое совпадение по началу слова побеждает (card раньше car, business раньше bus).
const ICWORDS = [
  ['cut', 'beauty красот barber барбер парикмах salon салон haircut стриж cosmet космет маникюр nail'], ['card', 'credit кредит loan заём займ долг debt bank банк financ финанс'],
  ['work', 'work работ business бизнес office офис ish freelance фриланс'], ['med', 'health здоров doctor врач hospital больниц clinic клиник медиц salomat dentist стомат зуб'],
  ['pill', 'pharm аптек лекар medicine dori vitamin витамин'], ['gym', 'gym фитнес fitness тренаж workout'], ['ball', 'sport спорт football футбол tennis теннис swim бассейн'],
  ['game', 'game игр gaming playstation steam xbox oyin o\'yin компы leisure досуг'], ['film', 'movie кино cinema film netflix фильм'], ['music', 'music музык spotify concert концерт'],
  ['coffee', 'coffee кофе cafe кафе tea чай choy'], ['burger', 'fast burger бургер pizza пицц snack снек перекус шаурм lavash лаваш'], ['wine', 'alcohol алког bar бар beer пиво wine вин drink напит'],
  ['cart', 'grocer продукт magazin магазин market маркет супермаркет korzinka makro bozor базар oziq'], ['food', 'food еда eat обед lunch dinner ужин завтрак breakfast ovqat restaurant ресторан dine nutrition питан'],
  ['bolt', 'utilit коммун электр electric свет kommunal'], ['drop', 'water вода suv'], ['wifi', 'internet интернет wifi wi-fi'], ['phone', 'phone телефон mobile мобил связь ucell beeline uzmobile mobiuz'],
  ['home', 'home house дом квартир rent аренд uy ijara household хозяйств'], ['fuel', 'fuel бензин benzin заправ petrol gas газ metan метан propan пропан'],
  ['wrench', 'service сервис ремонт repair tools инструмент remont'], ['car', 'car авто машин mashina parking парков мойк taxi такси yandex'],
  ['bus', 'bus автобус metro метро public общест transport транспорт'], ['plane', 'travel trip путеш flight авиа перелёт перелет vacation отпуск sayohat'], ['bed', 'hotel отель гостиниц mehmonxona'],
  ['sun', 'rest отдых dam'], ['heart', 'love date свидан wife жена girlfriend девушк romance роман'], ['baby', 'kid child baby дет ребен bola bog\'cha садик'],
  ['family', 'family семь oila parents родит'], ['user', 'friend друз dost do\'st personal личн'], ['paw', 'pet питом dog собак кошк корм'],
  ['grad', 'educat образов school школ course курс universit учеб talim ta\'lim'], ['book', 'book книг kitob'], ['shirt', 'cloth одежд shirt обув shoes kiyim'],
  ['bag', 'shop покуп xarid mall шопинг'], ['gift', 'gift подар sovg holiday праздн birthday рожден event событ'], ['ring', 'wedding свадьб tuy to\'y jewel украш'],
  ['piggy', 'saving сбереж накоп deposit депозит jamg'], ['rate', 'cashback кэшбэк кешбек interest процент'], ['wallet', 'salary зарплат maosh income доход'], ['cash', 'cash налич naqd'],
  ['receipt', 'bill счет счёт tax налог fee комисс subscription подписк payment платеж платёж expense расход'], ['leaf', 'garden сад plant растен nature'],
].map(([k, w]) => [k, w.split(' ')]);
function icGuess(name) {
  const t = String(name || '').toLowerCase().replace(/ё/g, 'е'); if (!t.trim()) return null;
  for (const [k, ws] of ICWORDS) if (ws.some(w => new RegExp('(^|[^\\p{L}])' + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u').test(t))) return k;
  return null;
}
const LEGCOL = { food: 'orange', game: 'violet', car: 'blue', receipt: 'teal', family: 'pink', bag: 'amber', heart: 'red', wallet: 'green', plus: 'green', card: 'indigo', rate: 'green', tag: 'slate', cash: 'green', globe: 'sky' };
function openCat(id, parent) {
  const c = id ? byId('categories', id) : { name: '', icon: '', parent_id: parent || null, kind: parent ? (byId('categories', parent) || {}).kind : 'expense' };
  F = { cat: id, ...c };
  if (!c.parent_id) { // своя иконка: уже выбранная, иначе та, что показывается сейчас (по названию); emoji остаётся, пока не выбрана иконка
    const p = parseIc(c.icon), leg = CATIC[String(c.name).toLowerCase()];
    if (p) { F.ic = p.k; F.col = p.c; } else if (c.icon && id && !leg) { F.ic = ''; F.col = 'def'; } else { F.ic = leg || (id ? 'tag' : ''); F.col = LEGCOL[F.ic] || 'def'; }
    F.icMan = !!id; F.colMan = !!id;
  }
  const icTop = c.parent_id ? '' : `<div class="icpv"><span class="ico lg" id="icpv">${icPrev()}</span><b id="icnm">${esc(c.name) || 'Name'}</b></div>`;
  const icPick = c.parent_id ? '' : `<div class="lbl">Icon <span class="ichint" id="ichint">${id ? '' : 'picked from the name'}</span></div><div class="icg">${CICONS.map(k => `<button type="button" class="icb${F.ic === k ? ' on' : ''}" data-act="icpk" data-id="${k}">${F.ic === k ? icSvg(k, F.col, 22) : svg(k, 22)}</button>`).join('')}</div>
  <div class="lbl">Color</div><div class="clg">${Object.keys(ICCOL).map(k => `<button type="button" class="clb${F.col === k ? ' on' : ''}" data-act="clpk" data-id="${k}" aria-label="${k}"><i class="cl-${k}"></i></button>`).join('')}</div>`;
  openSheet(`<h2>${id ? 'Category' : 'New category'}</h2>${icTop}<div class="lbl">Name</div><input class="f" data-f="name" value="${esc(c.name)}" ${id ? '' : 'autocomplete="off"'}>
  ${c.parent_id ? '' : `${icPick}<div class="lbl">Type</div><select class="f" data-f="kind" ${id ? 'disabled' : ''}><option value="expense" ${c.kind === 'expense' ? 'selected' : ''}>Expense</option><option value="income" ${c.kind === 'income' ? 'selected' : ''}>Income</option></select>`}
  ${id ? '<div style="display:flex;gap:10px;margin:6px 0 14px"><button class="btn red" data-act="catdel">Delete</button><button class="btn sec" data-act="catarch">Archive</button></div>' : ''}
  <button class="btn full" data-act="catsave">Save</button>`);
}
const icPrev = () => F.ic ? icSvg(F.ic, F.col, 34) : rootIcon({ name: F.name, icon: F.icon }, 34);
function icPaint() {
  const pv = document.getElementById('icpv'); if (!pv) return; pv.innerHTML = icPrev();
  const nm = document.getElementById('icnm'); if (nm) nm.textContent = (F.name || '').trim() || 'Name';
  document.querySelectorAll('.icb').forEach(b => { const on = b.dataset.id === F.ic; if (on || b.classList.contains('on')) b.innerHTML = on ? icSvg(b.dataset.id, F.col, 22) : svg(b.dataset.id, 22); b.classList.toggle('on', on); });
  document.querySelectorAll('.clb').forEach(b => b.classList.toggle('on', b.dataset.id === F.col));
}
// ввод названия: подбираем иконку (пока её не выбрали вручную)
let icT = 0, icSeq = 0;
function icAuto() {
  if (F.icMan || F.parent_id) return icPaint();
  const nm = (F.name || '').trim(), hint = document.getElementById('ichint'), k = icGuess(nm); clearTimeout(icT); const seq = ++icSeq;
  const set = (key, how) => { if (F.icMan) return; F.ic = key; if (!F.colMan) F.col = ICDEF[key] || 'def'; if (hint) hint.textContent = how; icPaint(); };
  if (k) return set(k, 'picked from the name');
  if (nm.length < 3) return set('', nm ? '' : 'picked from the name');
  set('', ''); if (!navigator.onLine) return;
  icT = setTimeout(async () => { try { if (hint) hint.textContent = 'thinking…'; const r = await api('/api/icon', { method: 'POST', body: JSON.stringify({ name: nm }) }, 6000);
    if (seq !== icSeq || F.icMan) return; if (r && r.icon && IC[r.icon]) set(r.icon, 'suggested by AI'); else if (hint) hint.textContent = ''; } catch (_) { if (seq === icSeq && hint) hint.textContent = ''; } }, 550);
}
const icVal = () => F.parent_id ? '' : F.ic ? `@${F.ic}.${F.col || 'def'}` : (F.icon || '');
function saveCat() {
  if (!F.name.trim()) return toast('Enter a name');
  const prev = F.cat ? byId('categories', F.cat) : null;
  const sibs = cats().filter(x => (x.parent_id || null) === (F.parent_id || null));
  if (!prev) {
    haptic('success');
    const nm = F.name.trim(), kind = F.kind || 'expense', pid = F.parent_id || null;
    const old = Object.values(S.db.categories).filter(c => c.deleted_at && c.space_id === S.space && c.name === nm && c.kind === kind && (c.parent_id || null) === pid).sort((a, b) => b.updated_at - a.updated_at)[0];
    if (old) { const sibs = cats().filter(x => (x.parent_id || null) === pid); put('categories', { ...old, deleted_at: null, archived: 0, sort: sibs.length + 1, icon: pid ? '' : (F.ic ? icVal() : old.icon || '') }); closeSheet(); render(true); const n = rows('transactions').filter(t => t.category_id === old.id).length; return toast(n ? `Restored · ${n} old transaction${n > 1 ? 's' : ''} joined` : 'Saved'); }
  }
  put('categories', { ...(prev || {}), id: prev ? prev.id : rid(), space_id: S.space, parent_id: F.parent_id || null, name: F.name.trim(), kind: F.kind || 'expense', sort: prev ? prev.sort : sibs.length + 1, icon: icVal(), archived: prev ? prev.archived || 0 : 0 });
  closeSheet();
}
// Удаление категории (Doniyor 21.11): удаляется сразу, операции остаются в истории со своим названием.
// Раздел удаляется вместе с подкатегориями; правила и лимиты на них тоже уходят.
// Новая категория с ТОЧНО таким же названием (там же, того же типа) возвращает удалённую — старые операции снова с ней, как будто слиты.
const catFamily = (id) => [id].concat(cats().filter(c => c.parent_id === id).map(c => c.id));
async function deleteCat() {
  const c = byId('categories', F.cat); if (!c) return; const fam = new Set(catFamily(c.id));
  const n = rows('transactions').filter(t => fam.has(t.category_id)).length;
  const subsN = fam.size - 1, what = c.parent_id ? 'subcategory' : 'category';
  const msg = `“${c.name}”${subsN ? ` and its ${subsN} subcategor${subsN > 1 ? 'ies' : 'y'}` : ''} will be removed.` + (n ? ` ${n} transaction${n > 1 ? 's stay' : ' stays'} in History. Create a ${what} with exactly this name later and they join it again.` : '');
  if (!(await ask(`Delete this ${what}?`, msg))) return;
  dropCat(fam);
}
function dropCat(fam) {
  fam.forEach(id => del('categories', id));
  rows('budgets').filter(b => fam.has(b.category_id)).forEach(b => del('budgets', b.id));
  const r = rules(), keep = r.filter(x => !fam.has(x.c)); if (keep.length !== r.length) saveRules(keep);
  closeSheet(); haptic('warning'); render(true); toast('Deleted');
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
      if (NATIVE && r.data.token) tryLS(() => localStorage.setItem('ntok', r.data.token));
      { const was = (S.me && S.me.login) || ''; if (was && was.toLowerCase() !== document.getElementById('lg').value.trim().toLowerCase()) await clearLocal(); }
      S.user = document.getElementById('lg').value.trim(); S.route = '/'; history.replaceState({}, '', '/'); await boot(!NATIVE); break; }
    case 'pkon': {
      const er = document.getElementById('pkerr');
      try {
        const o = await api('/api/pk/reg-options', { method: 'POST' }); if (!o.ok) throw 0;
        const cr = await navigator.credentials.create({ publicKey: { challenge: unb64u(o.data.challenge), rp: o.data.rp, user: { id: unb64u(o.data.user.id), name: o.data.user.name, displayName: o.data.user.displayName }, pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' }, timeout: 60000 } });
        const r = await api('/api/pk/reg-finish', { method: 'POST', body: JSON.stringify({ id: b64u(cr.rawId), clientDataJSON: b64u(cr.response.clientDataJSON), publicKey: b64u(cr.response.getPublicKey()) }) });
        if (!r.ok) throw 0;
        tryLS(() => localStorage.setItem('pk', '1')); S.me = { ...S.me, pk: 1 }; persist(); render(); toast('Face ID is on');
      } catch (e) { if (er) er.textContent = 'Couldn’t turn on Face ID. Open the app at budget.in-manager.uz and try again.'; }
      break; }
    case 'pkoff': if (!(await ask('Turn off Face ID?', 'You will sign in with the password.', 'Turn off'))) break; await api('/api/pk/remove', { method: 'POST' }).catch(() => 0); tryLS(() => localStorage.removeItem('pk')); S.me = { ...S.me, pk: 0 }; persist(); render(); break;
    case 'pklogin': {
      const er = document.getElementById('lgerr');
      try {
        const o = await api('/api/pk/auth-options', { method: 'POST' }); if (!o.ok || o.data.none) throw 0;
        const a = await navigator.credentials.get({ publicKey: { challenge: unb64u(o.data.challenge), rpId: o.data.rpId, allowCredentials: o.data.allow.map(id => ({ type: 'public-key', id: unb64u(id) })), userVerification: 'required', timeout: 60000 } });
        const r = await api('/api/pk/auth-finish', { method: 'POST', body: JSON.stringify({ id: b64u(a.rawId), clientDataJSON: b64u(a.response.clientDataJSON), authenticatorData: b64u(a.response.authenticatorData), signature: b64u(a.response.signature) }) });
        if (!r.ok) throw 0;
        S.route = '/'; history.replaceState({}, '', '/'); await boot(true);
      } catch (e) { if (er) er.textContent = 'Face ID didn’t work. Use the password.'; }
      break; }
    case 'shclose': closeSheet(); break;
    case 'bt': openBt(); break;
    case 'btsave': {
      const sh = sheetEl(); const t = num(sh.querySelector('#bt_total').value);
      if (!(t > 0)) { sh.querySelector('#bterr').textContent = 'Enter the total first'; break; }
      saveBudget(null, String(t));
      sh.querySelectorAll('[data-bt]').forEach(i => saveBudget(i.dataset.bt, i.value));
      closeSheet(); toast('Template saved'); break; }
    case 'btfill': {
      const sh = sheetEl(); const t = num(sh.querySelector('#bt_total').value); if (!(t > 0)) break;
      const ins = [...sh.querySelectorAll('[data-bt]')]; const per = Math.floor(t / ins.length / 1000) * 1000;
      ins.forEach((i, k) => i.value = grp(k === 0 ? t - per * (ins.length - 1) : per)); btCalc(); break; }
    case 'btcur': {
      const sh = sheetEl(); const m = curMonth();
      const b = budgetFor(null, m); if (b) sh.querySelector('#bt_total').value = grp(Math.round(b.limit_amount / 100));
      sh.querySelectorAll('[data-bt]').forEach(i => { const x = budgetFor(i.dataset.bt, m); i.value = x && x.limit_amount > 0 ? grp(Math.round(x.limit_amount / 100)) : ''; }); btCalc(); break; }
    case 'logout': if (!(await ask('Log out?', 'You’ll need to sign in again on this device.', 'Log out'))) break; await api('/api/logout', { method: 'POST' }).catch(() => 0); tryLS(() => localStorage.removeItem('ntok')); await logoutLocal(); break;
    case 'add': openTx(null); break;
    case 'slice': selSlice(id); break;
    case 'qa': { const i = document.getElementById('qa'); if (i.value.trim()) { quickAdd(i.value); i.value = ''; } break; }
    case 'space': S.space = id; S.balShown = null; persist(); render(); break;
    case 'mprev': S.month = shiftMonth(curMonth(), -(+id || 1)); render(); break;
    case 'mnext': S.month = shiftMonth(curMonth(), +id || 1); render(); break;
    case 'per': S.per = id; haptic('select'); render(); break;
    case 'trendm': S.month = id; S.per = '1M'; haptic('select'); render(); break;
    case 'lock': { const r = await nat('setLock', { on: S.lockOn === false }); S.lockOn = r ? r.on : S.lockOn; haptic('select'); render(true); break; }
    case 'hide': S.hide = !S.hide; tryLS(() => localStorage.setItem('hideAmt', S.hide ? '1' : '0')); haptic('select'); render(); break;
    case 'accf': S.accF = id; render(); break;
    case 'uncat': S.uncat = true; S.accF = ''; S.q = ''; go('/history'); break;
    case 'uncatf': S.uncat = !S.uncat; render(); break;
    case 'disp': S.dispCur = id; render(); break;
    case 'tx': openTx(id); break;
    case 'acc': go('/history'); S.accF = id; render(); break;
    case 'addtransfer': openTx(null, 'transfer'); break;
    case 'ftype': setFType(id); break;
    case 'txsave': saveTx(); break;
    case 'txdel': if (await ask(F.type === 'transfer' ? 'Delete this transfer?' : 'Delete this transaction?', 'This can’t be undone.')) deleteTx(); break;
    case 'accedit': openAcc(id); break;
    case 'accnew': openAcc(null); break;
    case 'fflag': F[id] = F[id] ? 0 : 1; a.classList.toggle('on'); break;
    case 'accsave': saveAcc(); break;
    case 'accdel': if (await ask('Delete this account?', 'Its transactions stay in history.')) { del('accounts', F.acc); closeSheet(); toast('Deleted'); } break;
    case 'catedit': openCat(id); break;
    case 'catnew': openCat(null, id || null); break;
    case 'ruleedit': openRule(id || ''); break;
    case 'catpick': openCatPicker(a); break;
    case 'rulesave': saveRule(); break;
    case 'ruledel': deleteRule(); break;
    case 'catsave': saveCat(); break;
    case 'catdel': deleteCat(); break;
    case 'icpk': F.ic = id; F.icMan = true; if (!F.colMan) F.col = ICDEF[id] || 'def'; { const h = document.getElementById('ichint'); if (h) h.textContent = ''; } icPaint(); haptic('select'); break;
    case 'clpk': F.col = id; F.colMan = true; icPaint(); haptic('select'); break;
    case 'rtog': { const s = a.closest('.rgp'), was = s.classList.contains('open'); document.querySelectorAll('.rgp.open').forEach(x => { if (x !== s) x.classList.remove('open'); }); s.classList.toggle('open', !was); S.rOpen = was ? '' : id; haptic(); break; }
    case 'catarch': if (!(await ask('Archive this category?', 'It will be hidden from lists. Past transactions keep it.', 'Archive'))) break; put('categories', { ...byId('categories', F.cat), archived: 1 }); closeSheet(); toast('Archived'); break;
    case 'catup': moveCat(-1); break;
    case 'catdown': moveCat(1); break;
    case 'ratemode': setSetting('rate_mode', setting('rate_mode', 'auto') === 'auto' ? 'manual' : 'auto'); render(true); break;
    case 'ratekind': setSetting('rate_kind', id); render(true); break;
    case 'raterefresh': { const r = await api('/api/rate?force=1').catch(() => null); if (r && r.ok) { S.rates = r.data; persist(); render(true); toast('Rate updated'); } else toast('Couldn’t update'); break; }
    case 'theme': tryLS(() => localStorage.setItem('theme', id)); smoothTheme(() => { applyTheme(); render(true); }); break;
    case 'appicon': tryLS(() => localStorage.setItem('appicon', id)); applyTheme(); haptic('select'); render(true); toast('Icon selected. Re-add the app to the Home Screen to see it.'); break;
    case 'navstyle': tryLS(() => localStorage.setItem('navstyle', id)); applyTheme(); haptic('select'); render(true); break;
    case 'pwsave': {
      const v = (i) => document.getElementById(i).value; const er = document.getElementById('pwerr'); er.textContent = '';
      if (v('pw1').length < 8) { er.textContent = 'New password must be at least 8 characters'; break; }
      if (v('pw1') !== v('pw2')) { er.textContent = 'New passwords don’t match'; break; }
      const r = await api('/api/password', { method: 'POST', body: JSON.stringify({ current: v('pw0'), next: v('pw1') }) }).catch(() => null);
      if (!r) { er.textContent = 'No connection to the server'; break; }
      if (!r.ok) { er.textContent = r.data.error === 'wrong_current' ? 'Current password is wrong' : 'Couldn’t change the password'; break; }
      ['pw0', 'pw1', 'pw2'].forEach(i => { document.getElementById(i).value = ''; }); toast('Password changed'); break;
    }
    case 'syncnow': await sync(); toast('Done'); break;
    case 'join': {
      const v = (x) => (document.getElementById(x) || {}).value || ''; const er = document.getElementById('jerr');
      if (v('jp1').length < 8) return er.textContent = 'Password: 8 characters or more';
      if (v('jp1') !== v('jp2')) return er.textContent = 'Passwords don’t match';
      a.disabled = true;
      const r = await api('/api/signup', { method: 'POST', body: JSON.stringify({ code: S.route.slice(6), login: v('jl').trim(), password: v('jp1') }) }).catch(() => null);
      a.disabled = false;
      if (!r) return er.textContent = 'No connection to the server';
      if (!r.ok) return er.textContent = ({ bad_invite: 'This invite link is used or expired. Ask for a new one.', bad_login: 'Login: 3-32 Latin letters, digits, dot, dash or _', taken: 'This login is taken, try another', too_short: 'Password: 8 characters or more' })[r.data.error] || 'Something went wrong';
      if (NATIVE && r.data.token) tryLS(() => localStorage.setItem('ntok', r.data.token));
      await clearLocal(); S.user = v('jl').trim().toLowerCase(); S.route = '/'; history.replaceState({}, '', '/'); await boot(true); toast('Welcome! Your account is ready'); break; }
    case 'joinout': await api('/api/logout', { method: 'POST' }).catch(() => 0); tryLS(() => localStorage.removeItem('ntok')); { const r = S.route; await logoutLocal(); S.route = r; history.replaceState({}, '', r); render(); } break;
    case 'invnew': {
      a.disabled = true; const r = await api('/api/invites', { method: 'POST' }).catch(() => null); a.disabled = false;
      if (!r || !r.ok) { toast('Couldn’t create the link'); break; }
      S.inv = { ...(S.inv || {}), link: r.data.url, list: null }; render(true); loadInvites(); break; }
    case 'invcopy': tryLS(() => navigator.clipboard.writeText(S.inv.link)); toast('Copied'); break;
    case 'invshare': if (navigator.share) navigator.share({ title: 'Budget', text: 'Join me in the Budget app:', url: S.inv.link }).catch(() => 0); else { tryLS(() => navigator.clipboard.writeText(S.inv.link)); toast('Copied'); } break;
    case 'copyhook': tryLS(() => navigator.clipboard.writeText(S.me.hook_url)); toast('Copied'); break;
    case 'tgsetup': { const r = await api('/api/tg/setup', { method: 'POST' }).catch(() => null); document.getElementById('tgout').textContent = r && r.data.ok ? 'Webhook connected: @' + r.data.bot : 'Error: ' + (r ? (r.data.desc || r.data.error) : 'no connection'); checkTg(); break; }
    case 'tgcode': { const r = await api('/api/tg/code', { method: 'POST' }).catch(() => null); document.getElementById('tgout').innerHTML = r && r.ok ? `Send this code to the bot (10 minutes): <b style="font-size:22px">${r.data.code}</b>` : 'Error'; break; }
    case 'csv': exportCsv(); break;
  }
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'bt_total' || el.dataset.bt !== undefined) requestAnimationFrame(btCalc);
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
  if (el.dataset.f) { F[el.dataset.f] = el.value;
    if (el.dataset.f === 'category') F.autoCat = false;
    if (el.dataset.f === 'name' && document.getElementById('icpv')) icAuto();
    if (el.dataset.f === 'note' && F.type && F.type !== 'transfer' && (!F.category || F.autoCat)) { const c = ruleCat(F.note, F.type === 'income' ? 'income' : 'expense') || ''; if (c !== (F.category || '')) { F.category = c; F.autoCat = !!c; const fld = el.closest('.txpane, .sheet').querySelector('[data-cf=category]'); if (fld) setCatField(fld, c); } } if (['from', 'to', 'account'].includes(el.dataset.f) && F.type === 'transfer' || el.dataset.f === 'account') { if (F.type === 'transfer') drawTx(); } }
  if (el.id === 'srch') { S.q = el.value; const p = el.selectionStart; render(); const n = document.getElementById('srch'); if (n) { n.focus(); n.setSelectionRange(p, p); } }
  if (el.dataset.bud !== undefined) { clearTimeout(el._t); el._t = setTimeout(() => saveBudget(el.dataset.bud, el.value), 700); }
  if (el.id === 'ratem') { clearTimeout(el._t); el._t = setTimeout(() => setSetting('rate_manual', el.value.replace(/\s/g, '').replace(',', '.')), 600); }
});
document.addEventListener('change', (e) => { const el = e.target; if (el.dataset.f && F.type === 'transfer' && ['from', 'to'].includes(el.dataset.f)) drawTx(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'qa' && e.target.value.trim()) { quickAdd(e.target.value); e.target.value = ''; } if (e.key === 'Enter' && e.target.id === 'pw') document.querySelector('[data-act=login]').click(); });
function openBt() {
  const m = curMonth(); const roots = cats('expense').filter(c => !c.parent_id && !c.archived); const tot = budgetFor(null, m);
  const v = (b) => b && b.limit_amount > 0 ? grp(Math.round(b.limit_amount / 100)) : '';
  openSheet(`<h2>Budget template · ${esc((rows('spaces').find(x => x.id === S.space) || {}).name || '')}</h2>
  <div class="sub" style="margin-bottom:8px">Pick the total for the month, then split it between categories. Saved limits repeat every month until you change them.</div>
  <div class="lbl">Total for the month, UZS</div><input class="f" id="bt_total" inputmode="decimal" placeholder="10 000 000" value="${v(tot)}">
  <div class="btrows">${roots.map(c => `<div class="btr"><div class="ico sm">${rootIcon(c, 18)}</div><b class="grow">${esc(c.name)}</b><span class="btp sub"></span><input class="f" inputmode="decimal" data-bt="${c.id}" placeholder="0" value="${v(budgetFor(c.id, m))}"></div>`).join('')}</div>
  <div class="btun" id="btun"></div><div class="err" id="bterr"></div>
  <div style="display:flex;gap:8px;flex-wrap:wrap;margin:10px 0"><button class="btn sec" data-act="btfill">Split evenly</button><button class="btn sec" data-act="btcur">Current limits</button></div>
  <button class="btn full" data-act="btsave">Save template</button>`);
  btCalc();
}
function btCalc() {
  const sh = sheetEl(); if (!sh) return; const t = num(sh.querySelector('#bt_total').value) || 0; let sum = 0;
  sh.querySelectorAll('[data-bt]').forEach(i => { const a = num(i.value) || 0; sum += a; i.parentNode.querySelector('.btp').textContent = t > 0 && a > 0 ? Math.round(a / t * 100) + '%' : ''; });
  const left = t - sum; const el = sh.querySelector('#btun');
  el.className = 'btun' + (t > 0 && left < 0 ? ' neg' : t > 0 && left === 0 ? ' ok' : '');
  el.textContent = t > 0 ? (left === 0 ? 'Everything is distributed' : left > 0 ? 'Not distributed: ' + fmt(Math.round(left * 100), 'UZS') : 'Over the total by ' + fmt(Math.round(-left * 100), 'UZS')) : 'Enter the total to see the balance';
}
function saveBudget(cat, val) {
  const m = curMonth(); const key = `${S.space}:${m}:${cat || 'all'}`; const v = num(val); const prev = S.db.budgets[key];
  if (!(v > 0)) { if (prev && !prev.deleted_at) put('budgets', { ...prev, limit_amount: 0 }); else if (budgetFor(cat || null, m)) put('budgets', { id: key, space_id: S.space, month: m, category_id: cat || null, limit_amount: 0, currency: 'UZS' }); return; }
  put('budgets', { ...(prev || {}), id: key, space_id: S.space, month: m, category_id: cat || null, limit_amount: Math.round(v * 100), currency: 'UZS', deleted_at: null });
}
function exportCsv() {
  const L = ['Date;Type;Account;Amount;Currency;Category;Note;Source'];
  rows('transactions').filter(t => t.space_id === S.space).sort((a, b) => a.occurred_at - b.occurred_at).forEach(t => L.push([dd(t.occurred_at) + ' ' + hm(t.occurred_at), t.type, (byId('accounts', t.account_id) || {}).name, t.amount / 100, t.currency, catPath(t.category_id), (t.note || t.merchant || '').replace(/;/g, ','), t.source].join(';')));
  const name = 'budget-' + new Date().toISOString().slice(0, 10) + '.csv', text = '﻿' + L.join('\n');
  // в приложении ссылка-скачивание не работает: файл отдаётся через системное меню «Поделиться» (Сохранить в Файлы и т.д.)
  if (NATIVE) { nat('shareFile', { name, text }).then(r => { if (r === null) toast('Export needs the new app version', null, 'err'); }); return; }
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' })); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function applyTheme() {
  const th = tryLS(() => localStorage.getItem('theme')) || 'auto';
  const dark = th === 'dark' || (th === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.dataset.nav = tryLS(() => localStorage.getItem('navstyle')) || 'glass';
  const ic = tryLS(() => localStorage.getItem('appicon')) || 'a'; const L = (id, h) => { const el = document.getElementById(id); if (el && el.getAttribute('href') !== h) el.setAttribute('href', h); };
  L('lati', `/icon-${ic}-180.png`); L('lfav', `/icon-${ic}-192.png`); L('lman', `/manifest-${ic}.webmanifest`);
  // цвет полосы статус-бара = цвет фона у верхнего края (iOS 26 рисует полосу сама), поэтому верх сливается с фоном
  document.querySelectorAll('meta[name=theme-color]').forEach(mt => { mt.content = dark ? '#121316' : '#f5f1e8'; });
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => smoothTheme(applyTheme));
// виджет на экране «Домой» (только приложение iPhone): готовые строки, скрытые суммы остаются *****
let lastWidget = '';
function pushWidget() {
  if (!NATIVE) return;
  try {
    const sp0 = S.space; const spaces = rows('spaces');
    const personal = (spaces.find(x => /personal/i.test(x.name || '')) || spaces[0] || {}).id;
    if (personal) S.space = personal;
    const d0 = Math.floor((now() + TZ) / 86400000) * 86400000 - TZ; const m = monthKey(now());
    const today = S.user ? spentByRoot(m, S.space, [d0, d0 + 86400000]).total : 0; const month = S.user ? spentByRoot(m).total : 0;
    const bud = budgetFor(null, m);
    const w = { v: 1, signedIn: !!S.user, hidden: !!S.hide, balance: fmt(totalBase(), 'UZS'), today: fmt(today, 'UZS'), month: fmt(month, 'UZS'), zero: fmt(0, 'UZS'),
      limit: bud ? fmt(bud.limit_amount, 'UZS') : '', pct: bud ? Math.round(month / bud.limit_amount * 100) : -1, day: dd(now()), monthKey: m, updated: now() };
    S.space = sp0;
    const j = JSON.stringify(w); if (j === lastWidget) return; lastWidget = j; nat('setWidget', { json: j });
  } catch (e) { /* виджет не важнее приложения */ }
}
// ссылки из виджета: budget://add — открыть новую операцию
async function takeNativeUrl() {
  const r = await nat('takeUrl'); const u = r && r.url; if (!u || !S.user) return;
  if (/^budget:\/\/add/.test(u)) { if (typeof ovEl !== 'undefined' && ovEl) closeSheet(); openTx(null); }
}
if (NATIVE) {
  window.addEventListener('budgetopenurl', () => takeNativeUrl());
  document.addEventListener('visibilitychange', () => { if (document.hidden) pushWidget(); });
}
async function clearLocal() { TABLES.forEach(t => { S.db[t] = {}; S.queue[t] = {}; }); S.cursor = 0; S.space = null; S.me = null; await idb.clear(); }
async function logoutLocal() { S.user = null; TABLES.forEach(t => { S.db[t] = {}; S.queue[t] = {}; }); S.cursor = 0; S.space = null; S.me = null; await idb.clear(); closeSheet(); render(); }

// ---------- старт ----------
async function boot(fresh) {
  applyTheme();
  if (!fresh) {
    const st = await idb.get('state');
    if (st && st.user) { Object.assign(S, { db: { ...S.db, ...st.db }, queue: { ...S.queue, ...st.queue }, cursor: st.cursor || 0, user: st.user, space: st.space, rates: st.rates, me: st.me }); TABLES.forEach(t => { S.db[t] = S.db[t] || {}; S.queue[t] = S.queue[t] || {}; }); }
    S.route = curPath();
  }
  ensureSpace(); render(); if (NATIVE) { setTimeout(takeNativeUrl, 400); nat('getLock').then(r => { if (r) S.lockOn = r.on; }); }
  if (navigator.onLine) {
    try {
      const [me, rate] = await Promise.all([api('/api/me', {}, 10000), api('/api/rate', {}, 15000).catch(() => null)]);
      if (me.ok) { S.me = me.data; S.user = me.data.login; lastStamp = me.data.stamp; }
      if (rate && rate.ok) S.rates = rate.data;
      await sync(); ensureSpace(); persist(); render();
    } catch (e) { /* без сети остаёмся на кэше; 401 обработан в api() */ }
  }
}
window.addEventListener('scroll', () => { const sb = document.querySelector('.sbar'); if (sb) sb.classList.toggle('on', window.scrollY > 6); }, { passive: true });
if ('serviceWorker' in navigator && !NATIVE) {
  // приложение, открытое из фона, тоже получает новую версию: при возврате проверяем обновление,
  // а когда новая версия встала — тихо перезагружаем страницу (если не открыто окно и не идёт ввод)
  const had = !!navigator.serviceWorker.controller; let pendingReload = false;
  const reloadIfIdle = () => { if (ovEl || document.querySelector('.cp,.cf') || (document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) { pendingReload = true; return; } location.reload(); };
  navigator.serviceWorker.register('/sw.js').then(reg => { document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { reg.update().catch(() => 0); if (pendingReload) reloadIfIdle(); } }); }).catch(() => 0);
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (had) reloadIfIdle(); });
  setInterval(() => { if (pendingReload && document.visibilityState === 'visible') reloadIfIdle(); }, 5000);
}
boot();

// доводка после отпускания пальца: начальная скорость анимации = скорость пальца, дальше мягкое торможение (300 мс)
function flingCurve(remaining, v) { const T = 300; const sp = (Math.sign(remaining) === Math.sign(v) ? Math.abs(v) : 0) * T / Math.max(1, Math.abs(remaining)); const x1 = 0.3, y1 = Math.min(1, sp * x1); return `${T}ms cubic-bezier(${x1},${y1.toFixed(3)},.25,1)`; }
// «плавно по стандарту» (как в iOS): доводка — критически демпфированная пружина. Старт ровно со скоростью пальца,
// сразу набирает ход и долго мягко тормозит, без отскока. Кривая передаётся в CSS через linear(), едет на композиторе.
function springCurve(remaining, v) {
  const T = 0.3, N = 40; const D = Math.abs(remaining);
  if (D < 1 || !(window.CSS && CSS.supports && CSS.supports('transition-timing-function', 'linear(0, 1)'))) return flingCurve(remaining, v);
  let v0 = (Math.sign(remaining) || 1) * v * 1000 / D; // скорость пальца в долях пути за секунду
  const w = Math.max(24, v0); v0 = Math.max(v0, -w); const B = w - v0;
  const pts = []; for (let i = 0; i <= N; i++) { const t = T * i / N; const y = i === N ? 1 : 1 - (1 + B * t) * Math.exp(-w * t); pts.push(+y.toFixed(4)); }
  return `${T * 1000}ms linear(${pts.join(',')})`;
}
// решение при отпускании как в iOS: позиция + бросок по скорости пальца (160 мс вперёд); бросок назад отменяет
const flingDone = (d, v, lim) => { const p = d + v * 160; return Math.abs(p) > lim && Math.sign(p) === Math.sign(d) && !(Math.sign(d) * v < -0.15); };
const trackV = (st, x) => { const t = performance.now(); if (st.lt) { const dt = t - st.lt; if (dt > 0) st.v = 0.6 * ((x - st.lx) / dt) + 0.4 * (st.v || 0); } st.lx = x; st.lt = t; };
// свайпы между разделами: страница едет за пальцем, соседняя въезжает рядом
(() => {
  // «плавно по стандарту»: соседние страницы строятся заранее (в паузе после отрисовки) и ждут за краем экрана;
  // при касании их только показываем, во время свайпа и доводки едут одни transform, перерисовка — когда всё встало.
  let st = null, pending = null; const pre = { key: '', els: {} };
  const W = () => Math.min(window.innerWidth, 560);
  const cur = () => $app.firstElementChild;
  const off = (j, i) => (j > i ? 1 : -1) * (W() + 16);
  const nbrs = () => { const i = MAIN.indexOf(S.route); if (i < 0) return PAGES()[S.route] ? [MAIN.indexOf('/profile')] : []; return [i - 1, i + 1].filter(j => j >= 0 && j < MAIN.length); };
  const myI = () => MAIN.includes(S.route) ? MAIN.indexOf(S.route) : MAIN.length; // вложенная страница стоит правее Profile
  function dropPre() { Object.values(pre.els).forEach(n => n.remove()); pre.els = {}; pre.key = ''; }
  function prebuild() {
    if (!S.user || ovEl || pgIdx(S.route) < 0) return; const key = S.route + ':' + render.seq; if (pre.key === key) return;
    dropPre(); pre.key = key; const i = myI();
    nbrs().forEach(j => { const nb = document.createElement('div'); nb.className = 'swnb'; nb.innerHTML = PAGES()[MAIN[j]](); nb.style.visibility = 'hidden'; nb.style.transform = `translate3d(${off(j, i)}px,0,0)`; document.body.appendChild(nb); pre.els[j] = nb; });
  }
  window.swPrebuild = () => { clearTimeout(prebuild._t); prebuild._t = setTimeout(prebuild, 180); };
  const mv = (el, x, tr) => { if (!el) return; el.style.transition = tr ? 'transform ' + tr : 'none'; el.style.transform = `translate3d(${x}px,0,0)`; };
  function cleanup() { if (!st) return; const c = cur(); if (c) { c.style.transition = ''; c.style.transform = ''; c.style.willChange = ''; } Object.values(pre.els).forEach(n => { n.style.visibility = 'hidden'; }); st = null; }
  document.addEventListener('touchstart', (e) => {
    if (pending) pending(); cleanup();
    if (e.touches.length !== 1 || ovEl || !S.user || pgIdx(S.route) < 0 || e.target.closest('input,select,textarea,.chips,.ov,[data-hdl],.nav')) return;
    prebuild(); const i = myI(); Object.entries(pre.els).forEach(([j, n]) => { mv(n, off(+j, i), ''); }); // соседние страницы стоят на местах, но остаются скрытыми до начала свайпа: iOS отменяет тап, если при касании на экране что-то появилось (холостое нажатие)
    const c = cur(); if (c) c.style.willChange = 'transform';
    const t = e.touches[0]; st = { x0: t.clientX, y0: t.clientY, t0: Date.now(), lock: null, dx: 0, j: -1, nb: null };
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!st) return; const t = e.touches[0]; const dx = t.clientX - st.x0, dy = t.clientY - st.y0;
    if (st.lock === null) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; st.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'; if (st.lock === 'y') { cleanup(); return; }
      st.x0 = t.clientX - Math.sign(dx) * 0.01; st.tb = {}; Object.values(pre.els).forEach(n => { n.style.visibility = ''; }); } // страница трогается с места без скачка на «мёртвую зону» 8 px
    e.preventDefault(); return moveX(t);
  }, { passive: false });
  function moveX(t) { const dx = t.clientX - st.x0;
    // на вложенной странице Profile свайп вправо возвращает в Profile, влево некуда
    const sub = !MAIN.includes(S.route); const i = MAIN.indexOf(S.route); const j = sub ? (dx > 0 ? MAIN.indexOf('/profile') : -1) : i + (dx < 0 ? 1 : -1);
    st.j = pre.els[j] ? j : -1; st.nb = pre.els[j] || null; st.dx = st.nb ? dx : 0; trackV(st, st.dx);
    mv(cur(), st.dx, ''); if (st.nb) mv(st.nb, st.dx + (dx < 0 ? W() + 16 : -W() - 16), '');
    const o = pre.els[sub ? -1 : i + (dx < 0 ? -1 : 1)]; if (o) mv(o, off(sub ? -1 : i + (dx < 0 ? -1 : 1), sub ? MAIN.length : i), '');
    const tbx = (k) => k in st.tb ? st.tb[k] : (st.tb[k] = tabBox(k)); const pa = tbx(S.route), pb = st.nb ? tbx(MAIN[j]) : null;
    if (pa && pb) { const k = Math.min(1, Math.abs(st.dx) / W()); setPill({ x: pa.x + (pb.x - pa.x) * k, y: pa.y, w: pa.w + (pb.w - pa.w) * k, h: pa.h }, false); const ot = k > 0.5 ? MAIN[j] : S.route; if (st.ot !== ot) { st.ot = ot; onTab(ot); } }
  }
  function end() {
    if (!st || st.lock !== 'x') { cleanup(); return; }
    const s0 = st; st = null; const c = cur();
    const sign = s0.dx < 0 ? -1 : 1; if (s0.lt && performance.now() - s0.lt > 80) s0.v = 0;
    const done = !!s0.nb && flingDone(s0.dx, s0.v || 0, W() * 0.3);
    const cv = springCurve((done ? sign * (W() + 16) : 0) - s0.dx, s0.v || 0);
    mv(c, done ? sign * (W() + 16) : 0, cv); if (s0.nb) mv(s0.nb, done ? 0 : -sign * (W() + 16), cv);
    const here = MAIN.includes(S.route) ? S.route : '/profile'; const tb = tabBox(done ? MAIN[s0.j] : here); if (tb) { setPill(tb, cv); S.pill = tb; }
    onTab(done ? MAIN[s0.j] : here); if (done) haptic();
    const fin = () => { clearTimeout(tm); pending = null;
      if (done) { slideDir = ''; const back = !MAIN.includes(S.route); lastRoute = MAIN[s0.j]; history[back ? 'replaceState' : 'pushState']({}, '', MAIN[s0.j]); S.route = MAIN[s0.j]; window.scrollTo(0, 0); render(); dropPre(); }
      else { if (c) { c.style.transition = ''; c.style.transform = ''; c.style.willChange = ''; } Object.values(pre.els).forEach(n => { n.style.visibility = 'hidden'; }); }
    };
    const tm = setTimeout(fin, 310); pending = fin;
  }
  document.addEventListener('touchend', end, { passive: true }); document.addEventListener('touchcancel', end, { passive: true });
})();
// подсветка нажимаемой области на телефоне: класс .tch на время касания, плавно гаснет после отпускания
(() => {
  const SEL = '.row[data-act],.row[data-go],.legend[data-act],.seg>button,.nav a,.btn,.quick button,.addsub,.eyeb,.fab,.card[data-act],.card[data-go],.cfa button,.f,.cph,.cpi,.mnav button,.chip,.icpick button,.shx,.icb';
  let el = null, x0 = 0, y0 = 0;
  const off = () => { if (el) el.classList.remove('tch'); el = null; };
  document.addEventListener('touchstart', (e) => { off(); const t = e.target.closest && e.target.closest(SEL); if (!t || t.disabled) return; el = t; x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; el.classList.add('tch'); }, { passive: true });
  document.addEventListener('touchmove', (e) => { if (el && Math.hypot(e.touches[0].clientX - x0, e.touches[0].clientY - y0) > 8) off(); }, { passive: true });
  document.addEventListener('touchend', () => setTimeout(off, 60), { passive: true });
  document.addEventListener('touchcancel', off, { passive: true });
  window.addEventListener('scroll', off, { passive: true });
})();
// кнопка «×» очистки поля: видна всегда, когда в поле есть текст (у каждого поля своя). Стоит соседом поля и
// ставится по offsetLeft/offsetTop поля, поэтому едет вместе с формой при свайпе и никогда не «висит» отдельно.
// Тап по ней очищает поле и сразу открывает клавиатуру.
const clrOk = (el) => el && el.tagName === 'INPUT' && !el.readOnly && !el.disabled && /^(text|search|password|tel|email|url|number)?$/.test(el.getAttribute('type') || '') && !el.closest('.nav') && !['qa', 'lg', 'pw'].includes(el.id); // без «×»: Quick и вход
const bw = (el, side) => parseFloat(getComputedStyle(el)['border' + side + 'Width']) || 0; // clientLeft у input в WebKit/Chromium включает отступ, поэтому берём рамку явно
function syncClr() {
  document.querySelectorAll('.clrx').forEach(b => { const el = b.previousElementSibling; if (!clrOk(el) || !el.value || !el.offsetParent) { if (el) el.classList.remove('hasclr', 'clrl'); b.remove(); } });
  document.querySelectorAll('input').forEach(el => {
    if (!clrOk(el) || !el.value || !el.offsetParent) return;
    let b = el.nextElementSibling; if (!b || !b.classList.contains('clrx')) {
      b = document.createElement('button'); b.type = 'button'; b.className = 'clrx on'; b.setAttribute('aria-label', 'Clear'); b.tabIndex = -1;
      b.innerHTML = '<i><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7L7 17"/></svg></i>'; el.after(b);
    }
    if (!el.classList.contains('hasclr')) { el.classList.add('hasclr'); const cs = getComputedStyle(el); const al = cs.textAlign; el.classList.toggle('clrl', al === 'left' || al === 'start' || al === 'justify');
      const bg = cs.backgroundColor, m = bg.match(/rgba?\(([^)]+)\)/); const pa = m ? m[1].split(',').slice(0, 3).join(',') : '255,255,255';
      b.style.setProperty('--fb', bg); b.style.setProperty('--fb0', `rgba(${pa},0)`);
      // у полей с текстом слева (Note и т.п.) «×» справа, текст не закрывает; у суммы по центру — слева
      const r = el.classList.contains('clrl'); b.classList.toggle('r', r);
      b.style.borderRadius = r ? `0 ${cs.borderTopRightRadius} ${cs.borderBottomRightRadius} 0` : `${cs.borderTopLeftRadius} 0 0 ${cs.borderBottomLeftRadius}`; }
    // справа ставим через right: ширина поля может измениться позже (полоса прокрутки и т.п.), а «×» останется у края
    const rt = b.classList.contains('r'), op = el.offsetParent; let R = ''; if (rt && op) { const a = op.getBoundingClientRect(), c = el.getBoundingClientRect(); R = Math.round((a.left + op.clientLeft + op.clientWidth - c.right + bw(el, 'Right')) * 10) / 10 + 'px'; }
    if (b.style.right !== R) b.style.right = R; if (rt && b.style.left !== 'auto') b.style.left = 'auto';
    const L = rt ? 'auto' : el.offsetLeft + bw(el, 'Left') + 'px', T = el.offsetTop + bw(el, 'Top') + 'px', H = el.offsetHeight - bw(el, 'Top') - bw(el, 'Bottom') + 'px';
    if (b.style.left !== L) b.style.left = L; if (b.style.top !== T) b.style.top = T; if (b.style.height !== H) b.style.height = H;
  });
}
(() => {
  const clear = (e) => { const b = e.target.closest && e.target.closest('.clrx'); if (!b) return; e.preventDefault(); e.stopPropagation();
    const el = b.previousElementSibling; if (!el) return; el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.focus(); if (typeof haptic === 'function') haptic(); syncClr(); showField(el); };
  // как при обычном тапе по полю: когда клавиатура открылась, окно плавно докручивается, чтобы поле было видно над ней
  function showField(el) {
    const fit = () => { if (document.activeElement !== el) return; const vv = window.visualViewport; const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight; const top = vv ? vv.offsetTop : 0;
      const r = el.getBoundingClientRect(); const sc = el.closest('.sheet') || document.scrollingElement; let d = 0;
      if (el.dataset.center) { // после выбора категории: поле Note встаёт по центру видимой части шторки
        delete el.dataset.center; const sr = sc.getBoundingClientRect(); const vt = Math.max(top, sr.top), vb = Math.min(bottom, sr.bottom);
        d = (r.top + r.bottom) / 2 - (vt + vb) / 2; d = Math.max(-sc.scrollTop, Math.min(d, sc.scrollHeight - sc.clientHeight - sc.scrollTop));
      } else if (r.bottom > bottom - 16) d = r.bottom - (bottom - 16); else if (r.top < top + 16) d = r.top - (top + 16);
      if (Math.abs(d) > 1) sc.scrollBy({ top: d, behavior: 'smooth' }); };
    const vv = window.visualViewport; let done = false; const once = () => { if (done) return; done = true; if (vv) vv.removeEventListener('resize', once); setTimeout(fit, 60); };
    if (vv) vv.addEventListener('resize', once); setTimeout(once, 450); }
  window.showField = showField;
  document.addEventListener('focusin', (e) => { const t = e.target; if (t && t.matches && t.matches('input:not([type=checkbox]):not([type=radio]),textarea') && t.closest('.sheet')) showField(t); });
  // клавиатура iOS: окно поднимается над ней (низ шторки = верх клавиатуры, высота = видимая часть экрана), поле в фокусе видно
  const vv = window.visualViewport;
  if (vv) { const kbFit = () => { if (!ovEl) return; const sh = ovEl.firstChild; const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const ae = document.activeElement; const typing = ae && /INPUT|TEXTAREA/.test(ae.tagName) && !/checkbox|radio|button/.test(ae.type || '') && ovEl.contains(ae);
      // верх шторки не заходит под часы/статус-бар: отступ = безопасная зона сверху + 16 px (в приложении шторка иначе упиралась в часы)
      const safe = parseFloat(getComputedStyle(document.body).paddingTop) || 0, gap = Math.max(12, safe + 16 - vv.offsetTop);
      if (kb > 80 && typing) { ovEl.style.top = vv.offsetTop + 'px'; ovEl.style.bottom = kb + 'px'; ovEl.classList.add('kb'); if (sh) sh.style.maxHeight = (vv.height - gap) + 'px'; }
      else { ovEl.style.top = ''; ovEl.style.bottom = ''; ovEl.classList.remove('kb'); if (sh) sh.style.maxHeight = ''; } };
    vv.addEventListener('resize', kbFit); vv.addEventListener('scroll', kbFit); document.addEventListener('focusout', () => setTimeout(kbFit, 350)); document.addEventListener('focusin', () => setTimeout(kbFit, 350)); }
  document.addEventListener('touchstart', clear, { passive: false, capture: true }); document.addEventListener('mousedown', clear, true);
  document.addEventListener('click', (e) => { if (e.target.closest && e.target.closest('.clrx')) { e.preventDefault(); e.stopPropagation(); } }, true);
  let q = 0; const later = () => { cancelAnimationFrame(q); q = requestAnimationFrame(syncClr); };
  document.addEventListener('input', later); window.addEventListener('resize', later);
  new MutationObserver((ms) => { if (ms.some(m => [...m.addedNodes].some(n => n.nodeType === 1 && !(n.classList && n.classList.contains('clrx'))))) later(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
// окно «+»: ✓ на клавиатуре после суммы открывает выбор категории (Doniyor 21.11).
// ✓ (Done) просто снимает фокус: отличаем его от тапа по экрану — в момент потери фокуса пальца на экране не было.
(() => {
  let touching = false, lastT = 0; const t0 = () => { touching = true; lastT = Date.now(); }, t1 = () => { touching = false; lastT = Date.now(); };
  document.addEventListener('touchstart', t0, { capture: true, passive: true }); document.addEventListener('touchend', t1, { capture: true, passive: true }); document.addEventListener('touchcancel', t1, { capture: true, passive: true });
  document.addEventListener('mousedown', () => { lastT = Date.now(); }, true);
  const next = (am) => { const sh = sheetEl(); if (!sh || !sh.contains(am) || F.id || F.type === 'transfer' || !(num(F.amount) > 0) || document.querySelector('.cp')) return false;
    const b = sh.querySelector('.catf[data-cf=category]'); if (!b) return false; openCatPicker(b); return true; };
  document.addEventListener('focusout', (e) => { const am = e.target; if (!am || am.id !== 'f-amount' || e.relatedTarget || touching || Date.now() - lastT < 400) return;
    setTimeout(() => { if (document.hidden || !am.isConnected) return; const ae = document.activeElement; if (ae && ae !== document.body && sheetEl() && sheetEl().contains(ae)) return; next(am); }, 60); });
  document.addEventListener('keydown', (e) => { const am = e.target; if (e.key !== 'Enter' || !am || am.id !== 'f-amount') return; e.preventDefault(); lastT = Date.now(); if (next(am)) am.blur(); });
})();
// окно «+»: свайп влево/вправо переключает Expense / Income / Transfer; плашка и всё содержимое под ней едут за пальцем синхронно.
// Плавность: соседние формы строятся при касании (до начала движения) и заранее выносятся в свои слои;
// во время свайпа и при отпускании ничего не перерисовывается — едут только transform; готовая соседняя форма
// просто становится настоящей, когда доводка закончилась.
(() => {
  const TY = ['expense', 'income', 'transfer'];
  let st = null, settle = null;
  const parts = (root) => [...(root || sheetEl()).children].filter(e => e.tagName !== 'H2' && !e.classList.contains('seg') && !e.classList.contains('txnb') && !e.classList.contains('clrx') && !e.classList.contains('grab') && !e.classList.contains('shx'));
  const W = () => (sheetEl() ? sheetEl().clientWidth : 360) + 16;
  const typeF = (ty) => { const g = { ...F, type: ty }; if (ty === 'transfer' && F.type !== 'transfer') { if (F.account) g.from = F.account; if (g.to === g.from) g.to = ''; } else if (F.type === 'transfer' && ty !== 'transfer' && F.from) g.account = F.from; if (ty !== 'transfer') g.category = ''; return g; };
  function preview(ty, x) { // содержимое соседнего типа, стоит за краем шторки и въезжает рядом
    const keep = F; F = typeF(ty); let html; try { html = txHtml(); } finally { F = keep; }
    const tmp = document.createElement('div'); tmp.innerHTML = html; const nb = tmp.querySelector('.txpane'); nb.classList.add('txnb');
    nb.style.transform = `translate3d(${x}px,0,0)`; const sh = sheetEl(); const first = parts()[0];
    sh.appendChild(nb); alignTop(nb, first); syncClr(); return nb;
  }
  // слой с соседней формой ставим ровно на уровень текущей: меряем фактическое положение (отступы первого поля не должны сдвигать его вниз)
  function alignTop(layer, ref) {
    layer.style.top = (ref ? ref.offsetTop : 0) + 'px'; if (!ref) return;
    // сравниваем одинаковые поля (сумму), а не обёртки: у обёртки отступ первого поля может быть внутри или снаружи
    const pick = (root) => (root.matches('[data-f=amount]') ? root : root.querySelector('[data-f=amount]')) || (root.classList.contains('txpane') ? root.firstElementChild : root);
    const r0 = pick(ref), f = pick(layer); if (!r0 || !f) return;
    const d = r0.getBoundingClientRect().top - f.getBoundingClientRect().top; if (Math.abs(d) > 0.05) layer.style.top = (parseFloat(layer.style.top) + d) + 'px';
  }
  const move = (els, x, dur) => els.forEach(el => { el.style.transition = dur ? `transform ${dur}` : 'none'; el.style.transform = `translate3d(${x}px,0,0)`; });
  const layers = (els, on) => els.forEach(el => { el.style.willChange = on ? 'transform' : ''; });
  // соседние формы строятся заранее, в паузе (после открытия окна, после ввода, после смены типа), и ждут скрытыми:
  // касание только показывает их — вертикальный свайп и прокрутка окна больше не тормозят на старте
  const pre = { key: '', sh: null, nbs: {} };
  const preKey = () => JSON.stringify(F);
  const hide = (n) => { n.style.visibility = 'hidden'; n.style.transition = 'none'; };
  function prep() {
    const sh = sheetEl(); const seg = sh && sh.querySelector('.seg.tt'); if (!seg || st) return;
    if (pre.sh === sh && pre.key === preKey() && Object.values(pre.nbs).every(n => n.isConnected)) return;
    Object.values(pre.nbs).forEach(n => n.remove()); pre.nbs = {}; pre.sh = sh; pre.key = preKey();
    const i = TY.indexOf(F.type); const bs = [...seg.querySelectorAll(':scope > button')]; const w0 = W();
    [i - 1, i + 1].forEach(j => { const b = bs[j]; if (b && !b.disabled) { const n = preview(TY[j], j > i ? w0 : -w0); hide(n); pre.nbs[j] = n; } });
  }
  let prepT = 0; const prepSoon = (ms = 250) => { clearTimeout(prepT); prepT = setTimeout(() => { if (window.requestIdleCallback) requestIdleCallback(prep, { timeout: 400 }); else prep(); }, ms); };
  document.addEventListener('input', (e) => { if (e.target.closest && e.target.closest('.sheet')) prepSoon(); });
  document.addEventListener('change', (e) => { if (e.target.closest && e.target.closest('.sheet')) prepSoon(); });
  new MutationObserver(() => { const sh = sheetEl(); if (sh && sh.querySelector('.seg.tt') && pre.sh !== sh) prepSoon(350); }).observe(document.body, { childList: true });
  window.txPrepSoon = prepSoon;
  const drop = (s) => { if (!s) return; Object.values(s.nbs).forEach(n => { if (Object.values(pre.nbs).includes(n)) hide(n); else n.remove(); }); layers(s.cur, false); s.cur.forEach(el => { el.style.transition = ''; el.style.transform = ''; }); };
  document.addEventListener('touchstart', (e) => {
    if (settle) settle(); drop(st); st = null; const sh = sheetEl(); if (!sh || e.touches.length !== 1 || !sh.contains(e.target)) return;
    const seg = sh.querySelector('.seg.tt'); if (!seg || e.target.closest('input[type=datetime-local],.clrx')) return;
    const t = e.touches[0]; const i = TY.indexOf(F.type); const bs = [...seg.querySelectorAll(':scope > button')]; const w0 = W();
    st = { x0: t.clientX, y0: t.clientY, t0: Date.now(), lock: null, seg, bs, bx: bs.map(b => [b.offsetLeft, b.offsetWidth]), i, j: -1, dx: 0, k: 0, w0, cur: parts(), nbs: {} };
    layers(st.cur, true);
    const fresh = pre.sh === sh && pre.key === preKey() && Object.values(pre.nbs).every(n => n.isConnected);
    [i - 1, i + 1].forEach(j => { const b = bs[j]; if (!b || b.disabled) return;
      if (fresh && pre.nbs[j]) { const n = pre.nbs[j]; n.style.transition = 'none'; n.style.transform = `translate3d(${j > i ? w0 : -w0}px,0,0)`; n.style.visibility = ''; st.nbs[j] = n; }
      else st.nbs[j] = preview(TY[j], j > i ? w0 : -w0); });
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!st) return; const t = e.touches[0]; const dx = t.clientX - st.x0, dy = t.clientY - st.y0;
    if (st.lock === null) { if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; st.lock = Math.abs(dx) > Math.abs(dy) * 1.2 ? 'x' : 'y'; if (st.lock === 'y') { drop(st); st = null; return; }
      st.x0 = t.clientX - Math.sign(dx) * 0.01; } // без скачка на «мёртвую зону»
    e.preventDefault(); return moveX(t);
  }, { passive: false });
  function moveX(t) { const dx = t.clientX - st.x0;
    const j = st.i + (dx < 0 ? 1 : -1); const a = st.bs[st.i], b = st.bs[j]; const nb = st.nbs[j]; const okb = !!nb;
    st.j = okb ? j : -1; st.dx = okb ? dx : 0; trackV(st, st.dx); const w0 = st.w0; const k = okb ? Math.min(1, Math.abs(dx) / w0) : 0; st.k = k;
    move(st.cur, st.dx, ''); if (nb) move([nb], st.dx + (dx < 0 ? w0 : -w0), '');
    const o = st.nbs[st.i + (dx < 0 ? -1 : 1)]; if (o) move([o], dx < 0 ? -w0 : w0, ''); // вторая соседка остаётся за краем
    const pl = st.seg.querySelector(':scope > .segpill'); if (!pl || !a) return;
    const A = st.bx[st.i], B = okb ? st.bx[j] : A; const x = A[0] + (B[0] - A[0]) * k, w = A[1] + (B[1] - A[1]) * k;
    st.px = x; st.pw = w; segMove(pl, x, w, ''); const ty = TY[okb && k > 0.5 ? j : st.i]; if (pl.dataset.t !== ty) pl.dataset.t = ty;
  }
  const end = () => {
    if (!st || st.lock !== 'x') { drop(st); st = null; return; } const s0 = st; st = null; const w0 = s0.w0; const sign = s0.dx < 0 ? -1 : 1;
    if (s0.lt && performance.now() - s0.lt > 80) s0.v = 0; const done = s0.j > -1 && flingDone(s0.dx, s0.v || 0, w0 * 0.3);
    // доводка как у свайпа страниц: стартует со скоростью пальца и мягко тормозит
    const cv = springCurve((done ? sign * w0 : 0) - s0.dx, s0.v || 0);
    const pl = s0.seg.querySelector(':scope > .segpill');
    if (done) {
      const nb = s0.nbs[s0.j]; Object.keys(s0.nbs).forEach(k => { if (+k !== s0.j) s0.nbs[k].remove(); });
      const sh = sheetEl(); const ae = document.activeElement; const typing = ae && sh.contains(ae) && ae.tagName === 'INPUT';
      F = typeF(TY[s0.j]); // меняем только состояние; разметка уже готова в соседнем слое
      s0.bs.forEach((b, n) => b.classList.toggle('on', n === s0.j));
      const tb = s0.bs[s0.j]; segPos['ftype:ov'] = { x: tb.offsetLeft, w: tb.offsetWidth, t: TY[s0.j] };
      if (pl) { pl._t = TY[s0.j] + tb.offsetLeft + ':' + tb.offsetWidth; pl.dataset.t = TY[s0.j]; segMove(pl, tb.offsetLeft, tb.offsetWidth, cv); }
      move(s0.cur, sign * w0, cv); move([nb], 0, cv); haptic();
      // фокус не трогаем во время движения: iOS прокручивает окно к полю в фокусе, и формы дёргались.
      // Клавиатура остаётся как была: когда форма встала на место, фокус переходит на сумму новой формы, и только потом старая убирается
      pre.nbs = {}; pre.key = ''; // готовая соседка стала формой, остальные заготовки строятся заново после доводки
      settle = () => { clearTimeout(tm); settle = null; prepSoon(200); nb.classList.remove('txnb'); nb.style.cssText = '';
        if (typing && !F.id) { const am = nb.querySelector('[data-f=amount]'); if (am) { am.focus({ preventScroll: true }); const n = am.value.length; try { am.setSelectionRange(n, n); } catch (_) {} } }
        s0.cur.forEach(el => el.remove()); syncClr(); };
      const tm = setTimeout(settle, 320);
    } else {
      const a = s0.bs[s0.i]; if (pl && a) { pl.dataset.t = TY[s0.i]; segMove(pl, a.offsetLeft, a.offsetWidth, cv); }
      move(s0.cur, 0, cv); Object.entries(s0.nbs).forEach(([k, n]) => move([n], +k > s0.i ? w0 : -w0, cv));
      settle = () => { clearTimeout(tm); settle = null; drop(s0); };
      const tm = setTimeout(settle, 320);
    }
  };
  document.addEventListener('touchend', end, { passive: true }); document.addEventListener('touchcancel', () => { drop(st); st = null; }, { passive: true });
})();

// нижнее меню: плашку выбранной вкладки можно вести пальцем или мышью; в стиле Liquid Glass она становится линзой
(() => {
  let d = null, justDragged = false;
  const inner = () => document.querySelector('.nav>div');
  const tabs = () => [...document.querySelectorAll('.nav a[data-go]')];
  const near = (cx) => { let best = null, bd = 1e9; tabs().forEach(a => { const c = a.offsetLeft + a.offsetWidth / 2, dd = Math.abs(c - cx); if (dd < bd) { bd = dd; best = a; } }); return best; };
  const lensOn = () => document.documentElement.dataset.nav === 'glass';
  function paint(cx) {
    const ts = tabs(); if (!ts.length) return; const lo = ts[0].offsetLeft + ts[0].offsetWidth / 2, hi = ts[ts.length - 1].offsetLeft + ts[ts.length - 1].offsetWidth / 2;
    cx = Math.max(lo, Math.min(hi, cx)); d.cx = cx;
    const a = near(cx), G = 5, V = 4; const w = a.offsetWidth + G * 2, h = a.offsetHeight + V * 2, x = cx - w / 2, y = a.offsetTop - V;
    const el = document.querySelector('.navpill'); if (!el) return;
    el.style.transition = d.painted ? 'none' : 'transform .15s cubic-bezier(.2,.8,.2,1),width .15s cubic-bezier(.2,.8,.2,1),height .15s cubic-bezier(.2,.8,.2,1)';
    el.style.width = w + 'px'; el.style.height = h + 'px'; el.style.transform = `translate(${x}px,${y}px)`; el.style.opacity = 1;
    pillText(el, x, y, d.painted ? 'none' : 'transform .15s cubic-bezier(.2,.8,.2,1)'); d.painted = true;
    onTab(a.dataset.go); d.target = a.dataset.go;
  }
  document.addEventListener('pointerdown', (e) => {
    const nv = e.target.closest('.nav'); if (!nv || e.target.closest('.navadd') || !e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const box = inner(); if (!box) return;
    d = { id: e.pointerId, x0: e.clientX, left: box.getBoundingClientRect().left, started: false, cx: 0, target: null };
  });
  document.addEventListener('pointermove', (e) => {
    if (!d || e.pointerId !== d.id) return; const dx = e.clientX - d.x0;
    if (!d.started) { if (Math.abs(dx) < 6) return; d.started = true; const nv = document.querySelector('.nav'); nv.classList.add('drag'); document.querySelectorAll('.nav .tch').forEach(x => x.classList.remove('tch')); }
    const box = inner(); const r = box.getBoundingClientRect(); trackV(d, e.clientX); paint((e.clientX - r.left) * (box.offsetWidth / r.width));
  });
  function stop(e) {
    if (!d || (e && e.pointerId !== d.id)) return; const d0 = d; d = null;
    const nv = document.querySelector('.nav'); if (nv) nv.classList.remove('drag');
    if (!d0.started) return;
    justDragged = true; setTimeout(() => { justDragged = false; }, 50);
    const path = d0.target || (MAIN.includes(S.route) ? S.route : '/profile');
    const el = document.querySelector('.navpill'); if (el) { const tb = tabBox(path); if (tb) { if (d0.lt && performance.now() - d0.lt > 80) d0.v = 0; const x0 = d0.cx - tb.w / 2; setPill(tb, springCurve(tb.x - x0, d0.v || 0)); S.pill = tb; } }
    haptic();
    if (path !== (MAIN.includes(S.route) ? S.route : '/profile')) setTimeout(() => go(path), 0); else onTab(path);
  }
  document.addEventListener('pointerup', stop); document.addEventListener('pointercancel', stop);
  window.addEventListener('click', (e) => { if (justDragged && e.target.closest('.nav')) { e.preventDefault(); e.stopPropagation(); justDragged = false; } }, true);
})();
document.addEventListener('dragstart', (e) => { if (e.target.closest && e.target.closest('.nav')) e.preventDefault(); });

// шторки: свайп вниз закрывает (окно едет за пальцем), Esc, крестик, тап по фону
(() => {
  let st = null;
  // закрывать свайпом можно только когда видна верхняя черточка шторки
  const grabSeen = (sh) => { const g = sh.querySelector('.grab'); if (!g) return true; const vv = window.visualViewport; const top = vv ? vv.offsetTop : 0; return g.getBoundingClientRect().top >= top - 1; };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ovEl && !document.querySelector('.cf')) closeSheet(); });
  document.addEventListener('touchstart', (e) => {
    const sh = sheetEl(); if (!sh || !sh.contains(e.target) || e.touches.length !== 1) { st = null; return; }
    const t = e.touches[0]; st = { x: t.clientX, y: t.clientY, t0: Date.now(), on: false, dy: 0, top: sh.scrollTop <= 0 && grabSeen(sh) };
    if (!st.top) st = null; else sh.style.willChange = 'transform'; // слой готов до начала движения // шторка прокручена (или страница уехала под клавиатуру): свайп вниз просто листает вверх
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!st || !ovEl) return; const sh = sheetEl(); const t = e.touches[0]; const dx = t.clientX - st.x, dy = t.clientY - st.y;
    if (!st.on) {
      if (!st.top && sh.scrollTop > 0) { st = null; return; }
      if (dy > 8 && dy > Math.abs(dx) * 1.2 && sh.scrollTop <= 0 && grabSeen(sh)) { st.on = true; st.y = t.clientY - 0; st.dy = 0; sh.style.transition = 'none'; }
      else if (Math.abs(dx) > 10 || dy < -8) { sh.style.willChange = ''; st = null; return; }
      else { if (dy > 0 && dy >= Math.abs(dx) && e.cancelable) e.preventDefault(); return; } // вниз от верха: iOS не начинает свою прокрутку-резинку, шторка трогается ровно
    }
    const d = Math.max(0, t.clientY - st.y); st.dy = d; trackV(st, d); if (e.cancelable) e.preventDefault();
    sh.style.transform = `translate3d(0,${d}px,0)`; ovEl.style.setProperty('--dimt', '0s'); ovEl.style.setProperty('--dim', String(Math.max(0.2, 1 - d / 500))); // светлеет только фон, шторка остаётся непрозрачной
  }, { passive: false });
  const end = () => {
    if (!st) return; const s2 = st; st = null; { const s = sheetEl(); if (s && !s2.on) s.style.willChange = ''; } if (!s2.on || !ovEl) return;
    const sh = sheetEl(), ov = ovEl;
    // доводка пружиной со скоростью пальца: закрытие — вниз до конца, иначе мягко обратно
    if (s2.lt && performance.now() - s2.lt > 80) s2.v = 0; const H = sh.offsetHeight + 40; const close = flingDone(s2.dy, s2.v || 0, 110);
    const cv = springCurve((close ? H : 0) - s2.dy, s2.v || 0); sh.style.transition = 'transform ' + cv; ov.style.setProperty('--dimt', '.3s'); ov.style.removeProperty('--dim');
    if (close) { sh.style.transform = `translate3d(0,${H}px,0)`; closeSheet(); }
    else { sh.style.transform = 'translate3d(0,0,0)'; setTimeout(() => { if (sheetEl() === sh) { sh.style.transition = ''; sh.style.transform = ''; sh.style.willChange = ''; } }, 320); }
  };
  document.addEventListener('touchend', end); document.addEventListener('touchcancel', end);
})();
