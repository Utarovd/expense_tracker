// Бюджетное приложение: один Worker = API + вебхук банка/Wallet + Telegram-бот.
// Деньги: целые числа в минимальных единицах (сум ×100, центы USD).

const TZ_OFFSET = 5 * 3600 * 1000; // Asia/Tashkent
const T = {
  spaces: ['id', 'name', 'kind', 'sort'],
  accounts: ['id', 'space_id', 'name', 'type', 'currency', 'opening_balance', 'card_last4', 'sort', 'hidden', 'exclude_from_total'],
  categories: ['id', 'space_id', 'parent_id', 'name', 'kind', 'sort', 'icon', 'archived'],
  transactions: ['id', 'space_id', 'type', 'account_id', 'amount', 'currency', 'fx_rate', 'amount_base', 'category_id', 'note', 'merchant', 'occurred_at', 'transfer_group_id', 'source', 'external_id'],
  budgets: ['id', 'space_id', 'month', 'category_id', 'limit_amount', 'currency'],
  settings: ['id', 'value'],
};

const J = (o, s = 200, h = {}) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...h } });
const rid = () => { const a = crypto.getRandomValues(new Uint8Array(9)); return [...a].map(x => (x % 36).toString(36)).join('') + Date.now().toString(36).slice(-3); };
const now = () => Date.now();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

async function pbkdf2(pw, salt) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, k, 256));
}
const getMeta = async (env, k) => (await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind(k).first())?.v ?? null;
const setMeta = (env, k, v) => env.DB.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, String(v)).run();
const touch = (env) => setMeta(env, 'stamp', now());

// ---------- сессии ----------
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
async function authed(req, env) {
  const tok = cookie(req, 'sid');
  if (!tok) return null;
  const s = await env.DB.prepare('SELECT user_id, exp FROM sessions WHERE id=?').bind(await sha(tok)).first();
  if (!s || s.exp < now()) return null;
  return s.user_id;
}

// ---------- синхронизация ----------
function upsertStmt(env, table, row, ts) {
  const cols = [...T[table], 'updated_at', 'deleted_at'];
  const vals = cols.map(c => { const v = row[c]; return v === undefined || v === '' ? null : (typeof v === 'object' ? null : v); });
  const sets = cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',');
  const sql = `INSERT INTO ${table}(${cols.join(',')},synced_at) VALUES(${cols.map(() => '?').join(',')},?) ON CONFLICT(id) DO UPDATE SET ${sets},synced_at=excluded.synced_at WHERE excluded.updated_at > ${table}.updated_at`;
  return env.DB.prepare(sql).bind(...vals, ts);
}
async function sync(env, body) {
  const ts = now();
  const stmts = [];
  for (const t of Object.keys(T)) {
    for (const r of (body.changes?.[t] || [])) {
      if (!r || typeof r.id !== 'string' || typeof r.updated_at !== 'number') continue;
      stmts.push(upsertStmt(env, t, r, ts));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  if (stmts.length) await touch(env);
  const since = Number(body.cursor) || 0;
  const out = {}; let cursor = since;
  for (const t of Object.keys(T)) {
    const { results } = await env.DB.prepare(`SELECT * FROM ${t} WHERE synced_at >= ? ORDER BY synced_at LIMIT 5000`).bind(since).all();
    out[t] = results;
    for (const r of results) if (r.synced_at > cursor) cursor = r.synced_at;
  }
  return { cursor, changes: out, server_time: ts };
}
function insertRow(env, table, row) { // серверная запись (вебхук, бот)
  const ts = now();
  row.updated_at = row.updated_at || ts;
  return upsertStmt(env, table, row, ts);
}

// ---------- курс ----------
function resolveNuxt(arr) {
  const memo = new Map();
  const rv = (i) => {
    if (memo.has(i)) return memo.get(i);
    const v = arr[i];
    if (Array.isArray(v)) {
      if (typeof v[0] === 'string' && v.length === 2 && /Reactive|Ref|Set|Map/.test(v[0])) { const r = rv(v[1]); memo.set(i, r); return r; }
      const o = []; memo.set(i, o); v.forEach(x => o.push(typeof x === 'number' ? rv(x) : x)); return o;
    }
    if (v && typeof v === 'object') {
      const o = {}; memo.set(i, o);
      for (const k of Object.keys(v)) o[k] = typeof v[k] === 'number' ? rv(v[k]) : v[k];
      return o;
    }
    memo.set(i, v); return v;
  };
  return rv(0);
}
function findRates(tree) {
  // ищем объекты, где есть buy/sell-подобные поля; возвращаем кандидатов
  const found = [];
  const walk = (o, path, depth) => {
    if (depth > 12 || !o || typeof o !== 'object') return;
    if (!Array.isArray(o)) {
      const keys = Object.keys(o);
      const buy = keys.find(k => /buy|purchase|bid|pokup|xarid/i.test(k));
      const sell = keys.find(k => /sell|sale|ask|prodaj|sotish/i.test(k));
      if (buy && sell && Number(o[buy]) > 0 && Number(o[sell]) > 0) found.push({ path, buy: Number(o[buy]), sell: Number(o[sell]), cbu: Number(o[keys.find(k => /cbu|central|mark/i.test(k))] || 0) || null, obj: o });
    }
    for (const k of Object.keys(o)) walk(o[k], path + '.' + k, depth + 1);
  };
  walk(tree, '', 0);
  return found;
}
const normRate = (n) => (n > 100000 ? n / 100 : n); // в тийинах -> сум
async function fetchRates() {
  const res = { buy: null, sell: null, cbu: null, source: 'cbu', debug: null };
  try {
    const r = await fetch('https://ru.ipakyulibank.uz/physical', { headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'ru' } });
    const html = await r.text();
    const m = html.match(/<script[^>]*id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (m) {
      const tree = resolveNuxt(JSON.parse(m[1]));
      const cands = findRates(tree);
      res.debug = cands.slice(0, 8).map(c => ({ path: c.path, buy: c.buy, sell: c.sell, cbu: c.cbu }));
      // нужен USD; берём первого кандидата, чьи значения похожи на курс доллара (10000..20000 сум)
      const usd = cands.map(c => ({ ...c, b: normRate(c.buy), s: normRate(c.sell) })).find(c => c.b > 8000 && c.b < 25000 && c.s > 8000 && c.s < 25000);
      if (usd) { res.buy = usd.b; res.sell = usd.s; res.cbu = usd.cbu ? normRate(usd.cbu) : null; res.source = 'ipakyuli'; }
    }
  } catch (e) { res.debug = String(e); }
  if (!res.cbu) {
    try {
      const r = await fetch('https://cbu.uz/ru/arkhiv-kursov-valyut/json/USD/');
      const j = await r.json();
      res.cbu = parseFloat(j[0].Rate);
    } catch (e) { /* ignore */ }
  }
  return res;
}
async function getRates(env, force) {
  const cached = JSON.parse((await getMeta(env, 'rates')) || 'null');
  if (!force && cached && now() - cached.fetched_at < 30 * 60 * 1000) return cached;
  const r = await fetchRates();
  if (r.buy || r.cbu) { r.fetched_at = now(); await setMeta(env, 'rates', JSON.stringify(r)); return r; }
  return cached || { buy: null, sell: null, cbu: null, fetched_at: 0 };
}
async function setting(env, k, d) {
  const r = await env.DB.prepare('SELECT value FROM settings WHERE id=? AND deleted_at IS NULL').bind(k).first();
  return r?.value ?? d;
}
async function effRate(env, kind) {
  const rates = await getRates(env);
  const mode = await setting(env, 'rate_mode', 'auto');
  if (mode === 'manual') { const m = parseFloat(await setting(env, 'rate_manual', '')); if (m > 0) return m; }
  const k = kind || await setting(env, 'rate_kind', 'buy');
  return rates[k] || rates.cbu || 12700;
}

// ---------- сид ----------
const SEED_CATS = [
  ['Food', '🍽', ['Lunch', 'Dine out', 'Nutrition', 'Snacks']],
  ['Leisure', '🎮', ['Friends', 'Date', 'Gaming']],
  ['Transport', '🚗', ['Gas', 'Fines', 'Public']],
  ['Expenses', '🧾', ['Bills', 'Community', 'Savings', 'Education', 'Other']],
  ['Family', '👨‍👩‍👧', ['Groceries', 'Food', 'Nilufar', 'Leisure', 'Expenses', 'Other']],
  ['Shopping', '🛍', ['Clothes', 'Household', 'Nilufar', 'Technology', 'Other']],
  ['Health', '💊', ['Sports', 'Hygiene', 'Pharmacy', 'Cosmetic', 'Other']],
];
async function seed(env) {
  const ts = now(); const st = [];
  const sp = { personal: rid(), family: rid() };
  st.push(insertRow(env, 'spaces', { id: sp.personal, name: 'Personal', kind: 'personal', sort: 0, updated_at: ts }));
  st.push(insertRow(env, 'spaces', { id: sp.family, name: 'Family', kind: 'family', sort: 1, updated_at: ts }));
  const acc = (space, name, type, cur, last4, sort) => st.push(insertRow(env, 'accounts', { id: rid(), space_id: space, name, type, currency: cur, opening_balance: 0, card_last4: last4, sort, hidden: 0, exclude_from_total: 0, updated_at: ts }));
  acc(sp.personal, 'Cash', 'cash', 'UZS', '', 0);
  acc(sp.personal, 'UZS card', 'card_uzs', 'UZS', '3153', 1);
  acc(sp.personal, 'Visa', 'card_visa', 'USD', '', 2);
  acc(sp.family, 'Cash', 'cash', 'UZS', '', 0);
  acc(sp.family, 'Card', 'card_uzs', 'UZS', '', 1);
  for (const space of [sp.personal, sp.family]) {
    SEED_CATS.forEach(([name, icon, subs], i) => {
      const pid = rid();
      st.push(insertRow(env, 'categories', { id: pid, space_id: space, parent_id: null, name, kind: 'expense', sort: i, icon, archived: 0, updated_at: ts }));
      subs.forEach((s, j) => st.push(insertRow(env, 'categories', { id: rid(), space_id: space, parent_id: pid, name: s, kind: 'expense', sort: j, icon: '', archived: 0, updated_at: ts })));
    });
    [['Salary', '💰'], ['Other income', '➕']].forEach(([name, icon], i) =>
      st.push(insertRow(env, 'categories', { id: rid(), space_id: space, parent_id: null, name, kind: 'income', sort: 100 + i, icon, archived: 0, updated_at: ts })));
  }
  st.push(insertRow(env, 'settings', { id: 'rate_mode', value: 'auto', updated_at: ts }));
  st.push(insertRow(env, 'settings', { id: 'rate_kind', value: 'buy', updated_at: ts }));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
}

// ---------- вспомогательное для импорта ----------
async function personalSpace(env) {
  return (await env.DB.prepare("SELECT id FROM spaces WHERE kind='personal' AND deleted_at IS NULL ORDER BY sort LIMIT 1").first())?.id;
}
async function balances(env, space) {
  const { results } = await env.DB.prepare(`SELECT a.id,a.name,a.currency,a.hidden,a.opening_balance + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount WHEN 'expense' THEN -t.amount ELSE t.amount END),0) AS bal
    FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND t.deleted_at IS NULL
    WHERE a.space_id=? AND a.deleted_at IS NULL GROUP BY a.id ORDER BY a.sort`).bind(space).all();
  return results;
}
const norm = (s) => (s || '').toUpperCase().replace(/\s+/g, ' ').trim();
const fmtMoney = (minor, cur) => {
  const v = minor / 100;
  if (cur === 'USD') return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ') + ' UZS';
};
const fmtTs = (ts) => { const d = new Date(ts + TZ_OFFSET); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`; };
function parseNum(s) {
  s = String(s ?? '').replace(/[^\d.,\-]/g, '');
  if (!s) return NaN;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) { s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, ''); }
  else if (lc > -1) { s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, ''); }
  return parseFloat(s);
}
const toMinor = (n) => Math.round(n * 100);

async function pickAccount(env, space, { last4, card, currency }) {
  const { results } = await env.DB.prepare('SELECT * FROM accounts WHERE space_id=? AND deleted_at IS NULL ORDER BY sort').bind(space).all();
  let l4 = last4 || ((card || '').match(/(\d{4})\s*$/) || [])[1] || ((card || '').match(/\*+\s*(\d{4})/) || [])[1];
  if (l4) { const a = results.find(x => x.card_last4 === l4); if (a) return a; }
  if (currency === 'USD' || /visa/i.test(card || '')) { const a = results.find(x => x.type === 'card_visa'); if (a) return a; }
  return results.find(x => x.type === 'card_uzs') || results[0];
}
function money(account, amountMinor, rate) {
  const usd = account.currency === 'USD';
  return { currency: account.currency, fx_rate: usd ? rate : 1, amount_base: usd ? Math.round(amountMinor * rate) : amountMinor };
}
async function findDup(env, accId, type, amount, ts, source) {
  const any = source === 'payme'; // скрин Payme может относиться к любой карте: ищем по всем счетам
  const { results } = await env.DB.prepare(`SELECT id,source,occurred_at,merchant FROM transactions WHERE (account_id=? OR ?) AND type=? AND amount=? AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ?`)
    .bind(accId, any ? 1 : 0, type, amount, ts - 15 * 60000, ts + 15 * 60000).all();
  return results.find(r => r.source !== source || Math.abs(r.occurred_at - ts) < 60000) || null;
}

// ---------- СМС банка ----------
function parseHumoSms(t) {
  // HUMOCARD *7052: oplata 14000.00 UZS; OCTOBANK YANDEX DELI; 26-11-09 20:33; Dostupno: 414301.00 UZS
  const m = t.match(/^(?:HUMOCARD|UZCARD|HUMO|UZCARD-?\w*)\s*\*+(\d{4}):\s*([a-z]+(?:\s+[a-z]+)*?)\s+([\d.,]+)\s*([A-Z]{3});\s*(.+?);\s*(\d\d)-(\d\d)-(\d\d)\s+(\d\d):(\d\d);?\s*(?:Dostupno:\s*([\d.,]+))?/i);
  if (!m) return null;
  const [, last4, verb, amt, cur, merchant, yy, mm, dd, HH, MM, bal] = m;
  const v = verb.toLowerCase(); let type = null, kind;
  if (/^(snjatie|snyatie|vydacha)|nalichn/.test(v)) { type = 'expense'; kind = 'cashout'; }
  else if (/^(oplata|pokupka|spisanie)/.test(v)) type = 'expense';
  else if (/popoln|zachisl|postupl|vozvrat|kirim/.test(v)) { type = 'income'; if (/\bATM\b/i.test(merchant) && !/UZCARD|HUMO/i.test(merchant)) kind = 'cashin'; }
  if (!type) return null;
  const ts = Date.UTC(2000 + +yy, +mm - 1, +dd, +HH, +MM) - TZ_OFFSET;
  return { type, kind, merchant: merchant.trim(), ts, last4, amount: toMinor(parseNum(amt)), currency: cur.toUpperCase(), balance: bal ? toMinor(parseNum(bal)) : null, ext: `sms:${last4}:${yy}${mm}${dd}${HH}${MM}:${amt}:${bal || ''}` };
}
function parseSms(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  if (/^(HUMO|UZCARD)/i.test(t)) return parseHumoSms(t);
  const m = t.match(/^(.+?):\s*(.+?),\s*[A-Z]{2},\s*(\d\d)\.(\d\d)\.(\d\d)\s+(\d\d):(\d\d)\s*,\s*karta\s*\*+(\d{4})\.\s*Miqdor:\s*([\d.,]+)\s*([A-Z]{3})(?:\s*Qoldiq:\s*([\d.,]+))?/i);
  if (!m) return null;
  const [, kind, merchant, dd, mm, yy, HH, MM, last4, amt, cur, bal] = m;
  const k = kind.toLowerCase();
  let type = null;
  let kindX;
  if (/chiqim|to'?lov|xarid|yechish|payment|purchase/.test(k)) type = 'expense';
  else if (/kartaga|kirim|tushum|o'tkazma|refund|qaytarish/.test(k)) type = 'income';
  if (!type) return null;
  const ts = Date.UTC(2000 + +yy, +mm - 1, +dd, +HH, +MM) - TZ_OFFSET;
  return { type, kind: kindX, merchant: merchant.trim(), ts, last4, amount: toMinor(parseNum(amt)), currency: cur.toUpperCase(), balance: bal ? toMinor(parseNum(bal)) : null, ext: `sms:${last4}:${dd}${mm}${yy}${HH}${MM}:${amt}:${bal || ''}` };
}

// ---------- запись операции из источника ----------
async function ingest(env, ev) {
  // ev: {src:'sms'|'wallet'|'telegram', type, merchant, ts, amount(minor), currency, last4, card, balance, ext}
  const space = await personalSpace(env);
  if (!space) return { text: 'Create the user first (setup).' };
  const acc = await pickAccount(env, space, ev);
  if (!acc) return { text: 'No accounts.' };
  const ts = ev.ts || now();
  if (ev.ext) {
    const ex = await env.DB.prepare('SELECT id FROM transactions WHERE source=? AND external_id=?').bind(ev.src, ev.ext).first();
    if (ex) return { dup: true, text: 'duplicate' };
  }
  const dup = await findDup(env, acc.id, ev.type, ev.amount, ts, ev.src);
  if (dup) {
    if (!dup.merchant && ev.merchant) await env.DB.prepare('UPDATE transactions SET merchant=?, updated_at=?, synced_at=? WHERE id=?').bind(ev.merchant, now(), now(), dup.id).run();
    await touch(env);
    return { dup: true, text: 'merged' };
  }
  const rate = await effRate(env);
  let converted = '';
  if (acc.currency === 'USD' && (ev.currency === 'UZS' || (ev.currency == null && ev.amount / 100 >= 20000))) {
    // оплата в сумах по долларовой карте: пересчитываем в USD по текущему курсу
    converted = ` (${fmtMoney(ev.amount, 'UZS')} → at rate ${Math.round(rate)})`;
    ev.amount = Math.round(ev.amount / rate); ev.currency = 'USD';
  }
  const m = (ev.merchant || '').toUpperCase();
  const sms = ev.src === 'sms';
  const stmts = []; let txId = rid(); let notice;
  // переводы между своими счетами: Humo ···7052, Ipak Yuli ···3153, Cash
  if (sms && ev.type !== 'transfer') {
    const { results: all } = await env.DB.prepare('SELECT * FROM accounts WHERE space_id=? AND deleted_at IS NULL').bind(space).all();
    const humo = all.find(a => a.card_last4 === '7052'), ipak = all.find(a => a.card_last4 === '3153'), cash = all.find(a => a.type === 'cash');
    const own = acc === undefined ? null : (humo && acc.id === humo.id) ? ipak : (ipak && acc.id === ipak.id) ? humo : null;
    const pair = async (from, to, note) => {
      const ex = await env.DB.prepare("SELECT id FROM transactions WHERE type='transfer' AND account_id=? AND amount=? AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ?").bind(from.id, -ev.amount, ts - 15 * 60000, ts + 15 * 60000).first();
      if (ex) { await touch(env); return { dup: true, text: 'merged' }; }
      const g = rid(); const mine = acc.id === from.id; const id2 = rid();
      const leg = (id, a, amount, own) => insertRow(env, 'transactions', { id, space_id: space, type: 'transfer', account_id: a.id, amount, currency: 'UZS', fx_rate: 1, amount_base: amount, note, merchant: ev.merchant, occurred_at: ts, transfer_group_id: g, source: own ? ev.src : 'sms_leg', external_id: own ? (ev.ext || null) : null });
      await env.DB.batch([leg(mine ? txId : id2, from, -ev.amount, mine), leg(mine ? id2 : txId, to, ev.amount, !mine)]); await touch(env);
      return { text: `🔁 Transfer: ${fmtMoney(ev.amount, 'UZS')} ${from.name} → ${to.name}` + await qoldiq(env, space, acc, ev), txId, noCat: true };
    };
    if (own && (ev.currency || 'UZS') === 'UZS') {
      const out = ev.type === 'expense';
      const from = out ? acc : own, to = out ? own : acc;
      if (/IPAK YULI M ULUGBEK|HUMO\s*2\s*UZCARD|UZCARD\s*2\s*HUMO/.test(m)) return pair(from, to, 'Between own cards');
      const tl = await env.DB.prepare("SELECT id FROM transactions WHERE account_id=? AND type='transfer' AND amount=? AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ?").bind(own.id, out ? ev.amount : -ev.amount, ts - 10 * 60000, ts + 10 * 60000).first();
      if (tl) { await touch(env); return { dup: true, text: 'merged' }; }
      // встречная операция на другой своей карте (та же сумма, ±10 мин): превращаем обе в перевод
      const opp = await env.DB.prepare("SELECT * FROM transactions WHERE account_id=? AND type=? AND amount=? AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ?").bind(own.id, out ? 'income' : 'expense', ev.amount, ts - 10 * 60000, ts + 10 * 60000).first();
      if (opp) {
        const g = rid(), t2 = now();
        await env.DB.prepare('UPDATE transactions SET type=?, amount=?, amount_base=?, category_id=NULL, transfer_group_id=?, note=?, updated_at=?, synced_at=? WHERE id=?').bind('transfer', out ? opp.amount : -opp.amount, out ? opp.amount : -opp.amount, g, 'Between own cards', t2, t2, opp.id).run();
        await env.DB.batch([insertRow(env, 'transactions', { id: txId, space_id: space, type: 'transfer', account_id: acc.id, amount: out ? -ev.amount : ev.amount, currency: 'UZS', fx_rate: 1, amount_base: out ? -ev.amount : ev.amount, note: 'Between own cards', merchant: ev.merchant, occurred_at: ts, transfer_group_id: g, source: ev.src, external_id: ev.ext || null })]); await touch(env);
        return { text: `🔁 Transfer: ${fmtMoney(ev.amount, 'UZS')} ${from.name} → ${to.name} (matched two SMS)` + await qoldiq(env, space, acc, ev), txId, noCat: true };
      }
    }
    if (cash && (ev.kind === 'cashout' || ev.kind === 'cashin') && (ev.currency || 'UZS') === 'UZS' && acc.id !== cash.id) {
      return ev.kind === 'cashout' ? pair(acc, cash, 'Cash withdrawal') : pair(cash, acc, 'Cash deposit');
    }
  }
  if (sms && /IYB MOBILE EXCHANGE|IPAK YULI BANK KONV/.test(m) && ev.type === 'expense' && acc.currency === 'UZS') {
    // обмен сум -> USD на Visa: перевод между счетами
    const visa = (await env.DB.prepare("SELECT * FROM accounts WHERE space_id=? AND type='card_visa' AND deleted_at IS NULL LIMIT 1").bind(space).first());
    const g = rid(); const sell = await effRate(env, 'sell');
    const usdMinor = Math.round(ev.amount / sell);
    stmts.push(insertRow(env, 'transactions', { id: txId, space_id: space, type: 'transfer', account_id: acc.id, amount: -ev.amount, currency: 'UZS', fx_rate: 1, amount_base: -ev.amount, note: 'Exchange in IYB Mobile', merchant: ev.merchant, occurred_at: ts, transfer_group_id: g, source: ev.src, external_id: ev.ext || null }));
    if (visa) stmts.push(insertRow(env, 'transactions', { id: rid(), space_id: space, type: 'transfer', account_id: visa.id, amount: usdMinor, currency: 'USD', fx_rate: sell, amount_base: ev.amount, note: 'Exchange in IYB Mobile (≈ at rate)', merchant: ev.merchant, occurred_at: ts, transfer_group_id: g, source: 'sms_leg', external_id: null }));
    notice = `🔁 Exchange: −${fmtMoney(ev.amount, 'UZS')} from “${acc.name}”` + (visa ? `\n≈ +${fmtMoney(usdMinor, 'USD')} to “${visa.name}” at ${Math.round(sell)} (estimate, fix it in the app if needed)` : '');
    await env.DB.batch(stmts); await touch(env);
    return { text: notice + await qoldiq(env, space, acc, ev), txId, noCat: true };
  }
  const mm = money(acc, ev.amount, rate);
  const mapped = ev.merchant ? (await env.DB.prepare('SELECT category_id FROM merchant_map WHERE merchant=?').bind(norm(ev.merchant)).first())?.category_id : null;
  stmts.push(insertRow(env, 'transactions', { id: txId, space_id: space, type: ev.type, account_id: acc.id, amount: ev.amount, ...mm, category_id: mapped || null, note: ev.note || '', merchant: ev.merchant || '', occurred_at: ts, source: ev.src === 'sms' ? 'sms' : ev.src, external_id: ev.ext || null }));
  await env.DB.batch(stmts); await touch(env);
  let catName = '';
  if (mapped) { const c = await env.DB.prepare('SELECT c.name, p.name AS pn FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=?').bind(mapped).first(); if (c) catName = (c.pn ? c.pn + ' › ' : '') + c.name; }
  const sign = ev.type === 'income' ? '+' : '−';
  const text = `${ev.type === 'income' ? '📥' : '💳'} ${sign}${fmtMoney(ev.amount, acc.currency)} · ${ev.merchant || '—'}${converted}\n${acc.name} · ${fmtTs(ts)}${catName ? '\n📂 ' + catName : ''}` + await qoldiq(env, space, acc, ev);
  return { text, txId, kind: ev.type === 'income' ? 'income' : 'expense', mapped: !!mapped, space };
}
async function qoldiq(env, space, acc, ev) {
  if (ev.balance == null) return '';
  const b = (await balances(env, space)).find(x => x.id === acc.id);
  if (!b || b.bal === ev.balance) return '';
  return `\n⚠ Balance in the app ${fmtMoney(b.bal, acc.currency)}, in the bank ${fmtMoney(ev.balance, acc.currency)}`;
}

// ---------- Telegram ----------
const tg = async (env, method, body) => {
  if (!env.TG_TOKEN) return null;
  const r = await fetch(`https://api.telegram.org/bot${env.TG_TOKEN}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => null);
};
async function chats(env) { return (await env.DB.prepare('SELECT chat_id FROM telegram_links').all()).results.map(r => r.chat_id); }
async function catKeyboard(env, space, kind, txId, parentId) {
  const { results } = await env.DB.prepare('SELECT id,name,icon,parent_id FROM categories WHERE space_id=? AND kind=? AND deleted_at IS NULL AND archived=0 ORDER BY sort').bind(space, kind).all();
  const rows = [];
  if (!parentId) {
    const parents = results.filter(c => !c.parent_id);
    for (let i = 0; i < parents.length; i += 2) rows.push(parents.slice(i, i + 2).map(c => ({ text: `${c.icon || ''} ${c.name}`.trim(), callback_data: (results.some(x => x.parent_id === c.id) ? 'p:' : 'c:') + txId + ':' + c.id })));
  } else {
    const p = results.find(c => c.id === parentId);
    const subs = results.filter(c => c.parent_id === parentId);
    for (let i = 0; i < subs.length; i += 2) rows.push(subs.slice(i, i + 2).map(c => ({ text: c.name, callback_data: 'c:' + txId + ':' + c.id })));
    rows.push([{ text: `Just “${p?.name}”`, callback_data: 'c:' + txId + ':' + parentId }, { text: '← Back', callback_data: 'b:' + txId + ':' + (p?.kind || kind) }]);
  }
  return { inline_keyboard: rows };
}
async function notify(env, res) {
  if (!res?.text || res.dup) return;
  let markup;
  if (res.txId && !res.noCat) {
    const space = res.space;
    markup = res.mapped ? { inline_keyboard: [[{ text: '✏ Change category', callback_data: 'b:' + res.txId + ':' + res.kind }]] } : await catKeyboard(env, space, res.kind, res.txId, null);
  }
  const text = res.txId && !res.noCat && !res.mapped ? res.text + '\n\nWhich category?' : res.text;
  for (const c of await chats(env)) await tg(env, 'sendMessage', { chat_id: c, text, reply_markup: markup });
}
async function tgSend(env, chat, text, extra) { return tg(env, 'sendMessage', { chat_id: chat, text, ...extra }); }

function parseQuick(text) {
  let t = text.trim(); let income = false;
  if (t.startsWith('+')) { income = true; t = t.slice(1).trim(); }
  const cur = /\$|usd|доллар/i.test(t) ? 'USD' : 'UZS';
  const m = t.match(/(\d[\d ]*(?:[.,]\d+)?)\s*(к|k|тыс\w*|млн|mln)?/i);
  if (!m) return null;
  let n = parseNum(m[1].replace(/ /g, ''));
  if (isNaN(n) || n <= 0) return null;
  if (m[2]) n *= /млн|mln/i.test(m[2]) ? 1e6 : 1e3;
  const kind = /нал|cash/i.test(t) ? 'cash' : /visa|виз/i.test(t) ? 'visa' : /карт|card/i.test(t) ? 'card' : null;
  let note = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\$|usd|доллар\w*|сум\w*|uzs|нал\w*|cash|visa|виза|карт\w*|card/ig, ' ').replace(/\s+/g, ' ').trim();
  return { income, cur, amount: toMinor(n), note, kind };
}
async function aiReadScreenshot(env, bytes, mime) {
  const prompt = 'This is a screenshot of a Payme (Uzbekistan payment app) receipt or payment history item, amounts in UZS (сум). Find the paid amount, the merchant or service/recipient name, and the date and time. Reply ONLY with JSON: {"amount": number, "currency": "UZS", "merchant": string, "datetime": "YYYY-MM-DD HH:MM" or null}. Amount is positive, without spaces or currency text. Ignore fees lines, use the total paid.';
  const model = '@cf/meta/llama-3.2-11b-vision-instruct';
  const dataUri = `data:${mime};base64,${b64(bytes)}`;
  const run = () => env.AI.run(model, { messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUri } }] }], max_tokens: 300 });
  let out;
  try { out = await run(); }
  catch (e) {
    if (/agree/i.test(String(e))) { await env.AI.run(model, { prompt: 'agree' }); out = await run(); }
    else out = await env.AI.run(model, { image: [...bytes], prompt, max_tokens: 300 });
  }
  const s = typeof out === 'string' ? out : (out.response || out.description || JSON.stringify(out));
  const j = s.match(/\{[\s\S]*\}/);
  return j ? JSON.parse(j[0]) : null;
}
async function tgHandle(env, update) {
  if (update.callback_query) return tgCallback(env, update.callback_query);
  const msg = update.message; if (!msg) return;
  const chat = String(msg.chat.id); const text = (msg.text || '').trim();
  const linked = await env.DB.prepare('SELECT * FROM telegram_links WHERE chat_id=?').bind(chat).first();
  if (!linked) {
    const code = (text.match(/^\/start\s+(\d{6})$/) || text.match(/^(\d{6})$/) || [])[1];
    const saved = JSON.parse((await getMeta(env, 'tglink')) || 'null');
    if (code && saved && saved.code === code && saved.exp > now()) {
      await env.DB.prepare('INSERT OR REPLACE INTO telegram_links(chat_id,user_id,username,linked_at) VALUES(?,?,?,?)').bind(chat, saved.user_id, msg.from?.username || '', now()).run();
      await setMeta(env, 'tglink', 'null');
      return tgSend(env, chat, '✅ Linked. Send expenses like “netflix 15$” or “lunch 58000”. For a Payme payment, just send the screenshot. /balance, /budget, /help');
    }
    return tgSend(env, chat, 'Link the bot: in the app go to Profile → Settings → Telegram, get a one-time code and send it here.');
  }
  const space = await personalSpace(env);
  if (/^\/(help|start)/.test(text)) return tgSend(env, chat, 'Text: “taxi 25000”, “netflix 15$”, “+500000 salary” (plus = income), you can add “cash” / “card” / “visa”.\nPayme payment screenshot: I’ll read it and record it.\n/balance: balances. /budget: monthly budget.');
  if (/^\/balance/.test(text)) {
    const b = await balances(env, space);
    return tgSend(env, chat, b.filter(x => !x.hidden).map(x => `${x.name}: ${fmtMoney(x.bal, x.currency)}`).join('\n') || 'No accounts');
  }
  if (/^\/budget/.test(text)) return tgSend(env, chat, await budgetText(env, space));
  if (msg.photo?.length) {
    if (!env.AI) return tgSend(env, chat, 'Recognition is not set up (no AI).');
    try {
      const p = msg.photo[msg.photo.length - 1];
      const f = await tg(env, 'getFile', { file_id: p.file_id });
      const img = await fetch(`https://api.telegram.org/file/bot${env.TG_TOKEN}/${f.result.file_path}`);
      const bytes = new Uint8Array(await img.arrayBuffer());
      const r = await aiReadScreenshot(env, bytes, 'image/jpeg');
      const amt = parseNum(r?.amount);
      if (!r || !(amt > 0)) return tgSend(env, chat, 'Couldn’t read the amount on the screenshot. Type it instead, e.g. “shop 15$”.');
      const dt = String(r.datetime || '').match(/(\d{4})-(\d\d)-(\d\d)[ T](\d\d):(\d\d)/);
      const ts = dt ? Date.UTC(+dt[1], +dt[2] - 1, +dt[3], +dt[4], +dt[5]) - TZ_OFFSET : now();
      const res = await ingest(env, { src: 'payme', type: 'expense', merchant: r.merchant || '', ts, amount: toMinor(amt), currency: 'UZS', card: '', last4: '7052', ext: 'tgphoto:' + p.file_unique_id });
      if (res.dup) return tgSend(env, chat, 'This transaction is already recorded.');
      res.text = '🖼 Read from the Payme screenshot (check the amount):\n' + res.text;
      return notify(env, res);
    } catch (e) { return tgSend(env, chat, 'Recognition error: ' + String(e).slice(0, 200)); }
  }
  const q = parseQuick(text);
  if (!q) return tgSend(env, chat, 'Didn’t get that. Example: “taxi 25000” or “netflix 15$”. /help');
  const accounts = (await env.DB.prepare('SELECT * FROM accounts WHERE space_id=? AND deleted_at IS NULL ORDER BY sort').bind(space).all()).results;
  let acc = q.kind === 'cash' ? accounts.find(a => a.type === 'cash') : q.kind === 'visa' ? accounts.find(a => a.type === 'card_visa') : q.kind === 'card' ? accounts.find(a => a.type === 'card_uzs') : null;
  if (!acc) acc = q.cur === 'USD' ? accounts.find(a => a.type === 'card_visa') : accounts.find(a => a.type === 'cash');
  if (!acc) acc = accounts[0];
  const res = await ingest(env, { src: 'telegram', type: q.income ? 'income' : 'expense', merchant: q.note, ts: now(), amount: q.amount, currency: acc.currency, last4: acc.card_last4 || undefined, card: acc.type === 'card_visa' ? 'visa' : '', ext: 'tgmsg:' + msg.message_id });
  if (res.dup) return;
  return notify(env, res);
}
async function tgCallback(env, cq) {
  const [act, txId, id] = (cq.data || '').split(':');
  const chat = cq.message.chat.id; const mid = cq.message.message_id;
  const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id=?').bind(txId).first();
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!tx) return;
  if (act === 'p' || act === 'b') {
    const kind = act === 'b' ? id : tx.type === 'income' ? 'income' : 'expense';
    const kb = await catKeyboard(env, tx.space_id, kind, txId, act === 'p' ? id : null);
    return tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: kb });
  }
  if (act === 'c') {
    const c = await env.DB.prepare('SELECT c.name, p.name AS pn FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=?').bind(id).first();
    if (!c) return;
    const t = now();
    await env.DB.prepare('UPDATE transactions SET category_id=?, updated_at=?, synced_at=? WHERE id=?').bind(id, t, t, txId).run();
    if (tx.merchant) await env.DB.prepare('INSERT INTO merchant_map(merchant,category_id,updated_at) VALUES(?,?,?) ON CONFLICT(merchant) DO UPDATE SET category_id=excluded.category_id, updated_at=excluded.updated_at').bind(norm(tx.merchant), id, t).run();
    await touch(env);
    const base = (cq.message.text || '').replace(/\n\n(Куда отнести|Which category)\?$/, '').replace(/\n📂 .*/, '');
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: base + `\n📂 ${(c.pn ? c.pn + ' › ' : '') + c.name} ✓`, reply_markup: { inline_keyboard: [[{ text: '✏ Change category', callback_data: 'b:' + txId + ':' + (tx.type === 'income' ? 'income' : 'expense') }]] } });
  }
}
async function budgetText(env, space) {
  const d = new Date(now() + TZ_OFFSET); const month = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0');
  const b = await env.DB.prepare("SELECT limit_amount FROM budgets WHERE space_id=? AND category_id IS NULL AND month<=? AND deleted_at IS NULL ORDER BY month DESC LIMIT 1").bind(space, month).first();
  const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) - TZ_OFFSET;
  const s = await env.DB.prepare("SELECT COALESCE(SUM(amount_base),0) AS s FROM transactions WHERE space_id=? AND type='expense' AND deleted_at IS NULL AND occurred_at>=?").bind(space, from).first();
  if (!b) return `Spent this month: ${fmtMoney(s.s, 'UZS')}. No limit set (app → Budget).`;
  return `Budget: ${fmtMoney(s.s, 'UZS')} of ${fmtMoney(b.limit_amount, 'UZS')}\nLeft: ${fmtMoney(b.limit_amount - s.s, 'UZS')}`;
}

// ---------- вебхук банка / Wallet ----------
async function readBody(req) {
  const ct = req.headers.get('content-type') || ''; const raw = await req.text();
  if (/json/.test(ct) || raw.trim().startsWith('{')) { try { return { raw, obj: JSON.parse(raw) }; } catch (e) { /* падаем в текст */ } }
  if (/urlencoded/.test(ct)) return { raw, obj: Object.fromEntries(new URLSearchParams(raw)) };
  return { raw, obj: null };
}
async function webhook(req, env) {
  const { raw, obj } = await readBody(req);
  let res;
  const sms = (obj && (obj.sms || obj.text || obj.message || obj.body)) || (obj && obj.amount !== undefined ? null : raw);
  if (obj && obj.amount !== undefined && !obj.sms) {
    // Apple Wallet: {amount, merchant, card, currency?}
    const amtStr = String(obj.amount);
    let n = parseNum(amtStr); if (!(n > 0)) { res = { text: '' }; }
    else {
      const ct = amtStr + ' ' + (obj.currency || ''); const cur = /\$|usd/i.test(ct) ? 'USD' : /uzs|sum|сум|so'm|soum/i.test(ct) ? 'UZS' : null;
      res = await ingest(env, { src: 'wallet', type: /refund|return|возврат/i.test(String(obj.type || '')) ? 'income' : 'expense', merchant: String(obj.merchant || obj.name || '').trim(), ts: now(), amount: toMinor(n), currency: cur, card: String(obj.card || ''), last4: undefined });
    }
  } else if (sms) {
    const p = parseSms(sms);
    if (p) res = await ingest(env, { src: 'sms', ...p });
    else { res = { text: '⚠ Couldn’t parse the SMS:\n' + String(sms).slice(0, 300) }; }
  } else res = { text: '' };
  await env.DB.prepare('INSERT INTO import_log(source,raw,result,at) VALUES(?,?,?,?)').bind(obj?.amount !== undefined ? 'wallet' : 'sms', raw.slice(0, 1000), (res.dup ? res.text : res.text || '').slice(0, 300), now()).run();
  if (res.text && !res.dup) await notify(env, res);
  return J({ ok: true, result: res.dup ? res.text : 'recorded' });
}

// ---------- роутер ----------
export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url); const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      // публичные: вебхуки
      if (path === '/api/in/' + env.WEBHOOK_SECRET && env.WEBHOOK_SECRET && req.method === 'POST') return await webhook(req, env);
      if (path === '/api/tg' && req.method === 'POST') {
        if (!env.TG_SECRET || req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_SECRET) return J({ error: 'forbidden' }, 403);
        const upd = await req.json();
        ctx.waitUntil(tgHandle(env, upd).catch(e => console.log('tg error', String(e))));
        return J({ ok: true });
      }
      if (path === '/api/setup' && req.method === 'POST') {
        const b = await req.json();
        const has = await env.DB.prepare('SELECT COUNT(*) c FROM users').first();
        if (has.c > 0) return J({ error: 'already' }, 400);
        if (!env.SETUP_KEY || b.key !== env.SETUP_KEY || !b.login || String(b.password || '').length < 8) return J({ error: 'bad' }, 400);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        await env.DB.prepare('INSERT INTO users(id,login,pass_hash,pass_salt,created_at) VALUES(?,?,?,?,?)').bind(rid(), b.login, await pbkdf2(b.password, salt), b64(salt), now()).run();
        await seed(env); await touch(env);
        return J({ ok: true });
      }
      if (path === '/api/login' && req.method === 'POST') {
        const b = await req.json(); const ip = req.headers.get('cf-connecting-ip') || '';
        const u = await env.DB.prepare('SELECT * FROM users WHERE login=?').bind(String(b.login || '')).first();
        if (u && u.locked_until > now()) return J({ error: 'locked', until: u.locked_until }, 429);
        const ok = u && (await pbkdf2(String(b.password || ''), unb64(u.pass_salt))) === u.pass_hash;
        await env.DB.prepare('INSERT INTO login_log(login,ok,ip,at) VALUES(?,?,?,?)').bind(String(b.login || ''), ok ? 1 : 0, ip, now()).run();
        if (!ok) {
          if (u) { const f = u.fails + 1; await env.DB.prepare('UPDATE users SET fails=?, locked_until=? WHERE id=?').bind(f >= 5 ? 0 : f, f >= 5 ? now() + 15 * 60000 : 0, u.id).run(); }
          return J({ error: 'bad_credentials' }, 400);
        }
        await env.DB.prepare('UPDATE users SET fails=0, locked_until=0 WHERE id=?').bind(u.id).run();
        const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare('INSERT INTO sessions(id,user_id,exp) VALUES(?,?,?)').bind(await sha(tok), u.id, now() + 12 * 3600000).run();
        return J({ ok: true }, 200, { 'set-cookie': `sid=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` });
      }
      const uid = await authed(req, env);
      if (!uid) return J({ error: 'auth' }, 401);
      if (path === '/api/logout') {
        await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(await sha(cookie(req, 'sid'))).run();
        return J({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
      }
      if (path === '/api/me') {
        const u = await env.DB.prepare('SELECT login FROM users WHERE id=?').bind(uid).first();
        const links = await env.DB.prepare('SELECT COUNT(*) c FROM telegram_links').first();
        return J({ login: u.login, hook_url: env.WEBHOOK_SECRET ? url.origin + '/api/in/' + env.WEBHOOK_SECRET : null, tg_ready: !!env.TG_TOKEN, tg_linked: links.c, stamp: await getMeta(env, 'stamp') });
      }
      if (path === '/api/stamp') return J({ stamp: await getMeta(env, 'stamp') });
      if (path === '/api/sync' && req.method === 'POST') return J(await sync(env, await req.json()));
      if (path === '/api/rate') return J({ ...(await getRates(env, url.searchParams.get('force') === '1')) });
      if (path === '/api/tg/code' && req.method === 'POST') {
        const code = String(Math.floor(100000 + Math.random() * 900000));
        await setMeta(env, 'tglink', JSON.stringify({ code, exp: now() + 10 * 60000, user_id: uid }));
        return J({ code });
      }
      if (path === '/api/tg/setup' && req.method === 'POST') {
        if (!env.TG_TOKEN || !env.TG_SECRET) return J({ error: 'no_token' }, 400);
        const r = await tg(env, 'setWebhook', { url: url.origin + '/api/tg', secret_token: env.TG_SECRET, allowed_updates: ['message', 'callback_query'] });
        const me = await tg(env, 'getMe', {});
        return J({ ok: r?.ok, bot: me?.result?.username, desc: r?.description });
      }
      if (path === '/api/import-log') return J((await env.DB.prepare('SELECT * FROM import_log ORDER BY id DESC LIMIT 30').all()).results);
      return J({ error: 'not_found' }, 404);
    } catch (e) {
      console.log('error', path, String(e && e.stack || e));
      return J({ error: 'server', message: String(e).slice(0, 200) }, 500);
    }
  },
};
