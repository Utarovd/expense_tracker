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
// у каждого пользователя своя метка изменений: открытое приложение видит, что пора синхронизироваться
const touch = (env) => setMeta(env, 'stamp:' + needUid(env), now());
// ---------- пользователи ----------
// Данные (счета, операции, категории, лимиты, настройки, правила) принадлежат пользователю: у каждой строки user_id.
// Запрос работает с «окружением пользователя» forUser(env, uid): все функции ниже берут env.uid и видят только его строки.
const forUser = (env, uid) => Object.assign(Object.create(env), { uid });
const needUid = (env) => { if (!env.uid) throw new Error('no user context'); return env.uid; };
const ownerUid = async (env) => getMeta(env, 'owner_uid');
// метка для /api/stamp: своя + общая (общую ставят разовые SQL-правки в schema.sql)
const stampOf = async (env) => `${(await getMeta(env, 'stamp:' + needUid(env))) || 0}.${(await getMeta(env, 'stamp')) || 0}`;

// ---------- сессии ----------
function cookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? m[1] : null;
}
// нативное приложение (iPhone) шлёт токен в заголовке Authorization: Bearer
const bearer = (req) => { const m = (req.headers.get('authorization') || '').match(/^Bearer\s+([0-9a-f]{64})$/i); return m ? m[1] : null; };
const NATIVE_ORIGINS = ['capacitor://localhost'];
// приложение iPhone закрыто Face ID: вход держится 30 дней (сайт и PWA: 12 часов). Решение 20.11.
const NATIVE_SESSION = 30 * 86400000;
const cors = (origin) => ({ 'access-control-allow-origin': origin, 'access-control-allow-headers': 'content-type, authorization, x-client', 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-max-age': '86400', vary: 'origin' });
async function authed(req, env) {
  const tok = bearer(req) || cookie(req, 'sid');
  if (!tok) return null;
  const s = await env.DB.prepare('SELECT user_id, exp FROM sessions WHERE id=?').bind(await sha(tok)).first();
  if (!s || s.exp < now()) return null;
  return s.user_id;
}


// ---------- passkey (Face ID) ----------
const b64u = (buf) => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => unb64(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
async function pkChallenge(env) {
  const c = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT OR REPLACE INTO meta(k,v) VALUES(?,?)').bind('chal:' + c, String(now() + 5 * 60000)).run();
  return c;
}
async function pkCheckClient(env, url, cdj, type) {
  const cd = JSON.parse(new TextDecoder().decode(unb64u(cdj)));
  if (cd.type !== type || cd.origin !== (env.PK_ORIGIN || url.origin)) return false;
  const row = await env.DB.prepare('SELECT v FROM meta WHERE k=?').bind('chal:' + cd.challenge).first();
  if (!row) return false;
  await env.DB.prepare('DELETE FROM meta WHERE k=?').bind('chal:' + cd.challenge).run();
  return +row.v > now();
}
function derToRaw(der) {
  let i = 2; const out = new Uint8Array(64);
  for (let k = 0; k < 2; k++) {
    i++; let len = der[i++]; let r = der.slice(i, i + len); i += len;
    while (r.length > 32 && r[0] === 0) r = r.slice(1);
    out.set(r, k * 32 + 32 - r.length);
  }
  return out;
}
async function pkVerifySig(pubB64, authData, cdj, sig) {
  const key = await crypto.subtle.importKey('spki', unb64u(pubB64), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', unb64u(cdj)));
  const data = new Uint8Array(authData.length + 32); data.set(authData); data.set(h, authData.length);
  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), data);
}
async function pkAuthDataOk(env, url, authData) {
  const rp = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(env.PK_HOST || url.hostname)));
  for (let i = 0; i < 32; i++) if (authData[i] !== rp[i]) return false;
  return (authData[32] & 0x05) === 0x05; // user present + verified
}

// ---------- синхронизация ----------
function upsertStmt(env, table, row, ts) {
  const cols = [...T[table], 'updated_at', 'deleted_at'];
  const vals = cols.map(c => { const v = row[c]; return v === undefined || v === '' ? null : (typeof v === 'object' ? null : v); });
  const sets = cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',');
  // user_id ставит только сервер; чужую строку с тем же id перезаписать нельзя
  const key = table === 'settings' ? 'user_id,id' : 'id';
  const sql = `INSERT INTO ${table}(${cols.join(',')},user_id,synced_at) VALUES(${cols.map(() => '?').join(',')},?,?) ON CONFLICT(${key}) DO UPDATE SET ${sets},synced_at=excluded.synced_at WHERE excluded.updated_at > ${table}.updated_at AND ${table}.user_id IS excluded.user_id`;
  return env.DB.prepare(sql).bind(...vals, needUid(env), ts);
}
async function sync(env, body) {
  if (env.uid === await ownerUid(env)) { await migrateCatsV2(env); await migrateCatsV3(env); } // разовые личные переносы Doniyor
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
    const { results } = await env.DB.prepare(`SELECT * FROM ${t} WHERE user_id=? AND synced_at >= ? ORDER BY synced_at LIMIT 5000`).bind(needUid(env), since).all();
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
  const r = await env.DB.prepare('SELECT value FROM settings WHERE user_id=? AND id=? AND deleted_at IS NULL').bind(needUid(env), k).first();
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
// набор по умолчанию для новых пользователей (Doniyor 19.11, для App Store)
const SEED_CATS = [
  ['Food', '🍽', ['Groceries', 'Cafes', 'Delivery', 'Coffee & snacks']],
  ['Home', '🏠', ['Rent', 'Utilities', 'Internet & phone', 'Household', 'Repairs']],
  ['Transport', '🚗', ['Fuel', 'Taxi', 'Public', 'Car service', 'Parking & fines']],
  ['Shopping', '🛍', ['Clothes', 'Electronics', 'Home goods']],
  ['Health', '💊', ['Pharmacy', 'Doctors', 'Sports', 'Beauty']],
  ['Family & kids', '👨‍👩‍👧', ['Kids', 'Education', 'Pets']],
  ['Leisure', '🎮', ['Entertainment', 'Travel', 'Hobbies', 'Subscriptions']],
  ['Gifts & events', '🎁', ['Gifts', 'Weddings & events', 'Charity']],
  ['Finance', '💳', ['Loans', 'Fees', 'Savings']],
  ['Other', '🏷', []],
];
const SEED_INCOME = [['Salary', '💰'], ['Business', '💼'], ['Gifts', '🎁'], ['Cashback', '💸'], ['Other income', '➕']];

// ---------- перенос личных категорий после свадьбы (Doniyor 19.11), один раз, только пространство Personal ----------
// Подкатегории переезжают с тем же id: операции, лимиты, правила слов и «магазин → категория» идут за ними.
// Ничего не удаляется: убранные подкатегории без операций уходят в архив, с операциями остаются видимыми (о них пишем в бот).
// Doniyor 20.11: убрать Nilufar из раздела Family (Nilufar теперь свой раздел). Один раз, только Personal.
// Пустая подкатегория (без операций, лимитов, правил и магазинов) уходит в архив; иначе остаётся, бот пишет, что в ней есть
async function migrateCatsV3(env) {
  const lock = await env.DB.prepare("INSERT INTO meta(k,v) VALUES('cats_v3','run') ON CONFLICT(k) DO NOTHING").run();
  if (!lock.meta?.changes) return;
  try {
    const c = await env.DB.prepare("SELECT c.* FROM categories c JOIN categories p ON p.id=c.parent_id JOIN spaces s ON s.id=c.space_id WHERE s.user_id='"+needUid(env).replace(/'/g,'')+"' AND s.kind='personal' AND s.deleted_at IS NULL AND lower(p.name)='family' AND lower(c.name)='nilufar' AND c.deleted_at IS NULL AND c.archived=0 LIMIT 1").first();
    if (!c) return setMeta(env, 'cats_v3', 'not found');
    const n = async (sql) => (await env.DB.prepare(sql).bind(c.id).first()).n;
    const tx = await n('SELECT COUNT(*) n FROM transactions WHERE category_id=? AND deleted_at IS NULL');
    const bud = await n('SELECT COUNT(*) n FROM budgets WHERE category_id=? AND deleted_at IS NULL');
    const shops = await n('SELECT COUNT(*) n FROM merchant_map WHERE category_id=?'); // id категории уникален, значит и пользователь тот же
    const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND id='cat_rules' AND deleted_at IS NULL").bind(needUid(env)).first();
    let rules = []; try { rules = JSON.parse(row?.value || '[]') || []; } catch (_) {}
    const words = rules.filter(r => r.c === c.id).length;
    const summary = { tx, bud, shops, words };
    if (!tx && !bud && !shops && !words) {
      const ts = now(); c.archived = 1; c.updated_at = ts;
      await upsertStmt(env, 'categories', c, ts).run(); await touch(env);
      return setMeta(env, 'cats_v3', JSON.stringify({ archived: true, ...summary }));
    }
    await setMeta(env, 'cats_v3', JSON.stringify({ archived: false, ...summary }));
    const parts = [tx && `${tx} operations`, bud && `${bud} limits`, words && `${words} word rules`, shops && `${shops} shops`].filter(Boolean).join(', ');
    try { for (const ch of await chats(env)) await tgSend(env, ch, `🗂 Family › Nilufar has ${parts}, so it is not removed yet. Tell where to move them.`); } catch (_) {}
  } catch (e) { console.log('cats_v3 failed', e); await env.DB.prepare("DELETE FROM meta WHERE k='cats_v3'").run(); }
}
async function migrateCatsV2(env) {
  const lock = await env.DB.prepare("INSERT INTO meta(k,v) VALUES('cats_v2','run') ON CONFLICT(k) DO NOTHING").run();
  if (!lock.meta?.changes) return;
  try { await doMigrateCatsV2(env); } catch (e) { console.log('cats_v2 failed', e); await env.DB.prepare("DELETE FROM meta WHERE k='cats_v2'").run(); }
}
async function doMigrateCatsV2(env) {
  const sp = { id: await personalSpace(env) }; if (!sp.id) return setMeta(env, 'cats_v2', 'no personal space');
  if (!sp) return setMeta(env, 'cats_v2', 'no personal space');
  const all = (await env.DB.prepare("SELECT * FROM categories WHERE space_id=? AND kind='expense' AND deleted_at IS NULL").bind(sp.id).all()).results;
  const lc = (x) => String(x || '').trim().toLowerCase();
  const root = (n) => all.find(c => !c.parent_id && lc(c.name) === lc(n));
  const sub = (p, n) => p ? all.find(c => c.parent_id === p.id && lc(c.name) === lc(n)) : null;
  const txCount = async (c) => (await env.DB.prepare('SELECT COUNT(*) n FROM transactions WHERE category_id=? AND deleted_at IS NULL').bind(c.id).first()).n;
  const ts = now(); const dirty = new Set(); const kept = []; const st = [];
  const set = (c, ch) => { Object.assign(c, ch); dirty.add(c); return c; };
  const mk = (parent, name, sort) => { const c = { id: rid(), space_id: sp.id, parent_id: parent ? parent.id : null, name, kind: 'expense', sort, icon: '', archived: 0 }; all.push(c); dirty.add(c); return c; };
  const old = { food: root('Food'), leisure: root('Leisure'), transport: root('Transport'), expenses: root('Expenses'), family: root('Family'), shopping: root('Shopping'), health: root('Health') };
  const from = (p, n) => sub(old[p], n);
  const src = { lunch: from('food', 'Lunch'), dine: from('food', 'Dine out'), snacks: from('food', 'Snacks'), nutr: from('food', 'Nutrition'), bills: from('expenses', 'Bills'),
    date: from('leisure', 'Date'), pub: from('transport', 'Public'), shopNil: from('shopping', 'Nilufar'), hyg: from('health', 'Hygiene'), cosm: from('health', 'Cosmetic'),
    household: from('shopping', 'Household'), healthOther: from('health', 'Other'), famGroc: from('family', 'Groceries') };
  // порядок разделов — ровно как сказал Doniyor
  const ORDER = ['Home', 'Leisure', 'Transport', 'Expenses', 'Nilufar', 'Family', 'Shopping', 'Health'];
  const R = {}; ORDER.forEach((n, i) => { const r = root(n); R[n] = r ? set(r, { sort: i, archived: 0 }) : mk(null, n, i); });
  const LAYOUT = {
    Home: [['Groceries'], ['Utilities', src.bills], ['Rent'], ['Internet & phone'], ['Lunch', src.lunch], ['Snacks', src.snacks]],
    Leisure: [['Friends'], ['Gaming'], ['Together', src.date], ['Trips']],
    Transport: [['Gas'], ['Fines'], ['Car service'], ['Taxi & public', src.pub]],
    Expenses: [['Community'], ['Savings'], ['Education'], ['Other']],
    Nilufar: [['Gifts'], ['Shopping', src.shopNil], ['Beauty'], ['Dine out', src.dine]],
    Shopping: [['Clothes'], ['Technology'], ['Other']],
    Health: [['Sports'], ['Nutrition', src.nutr], ['Pharmacy'], ['Doctors'], ['Care', src.hyg]],
  };
  const placed = new Set();
  for (const [pn, items] of Object.entries(LAYOUT)) items.forEach(([name, s], j) => {
    const c = s || sub(R[pn], name);
    placed.add(c ? set(c, { parent_id: R[pn].id, name, sort: j, archived: 0 }) : mk(R[pn], name, j));
  });
  // Cosmetic сливается с Care (Hygiene + Cosmetic, согласовано 19.11)
  const care = sub(R.Health, 'Care'); let merged = 0;
  if (src.cosm && care) { merged = await txCount(src.cosm); if (merged) st.push(env.DB.prepare('UPDATE transactions SET category_id=?, updated_at=?, synced_at=? WHERE category_id=? AND deleted_at IS NULL').bind(care.id, ts, ts, src.cosm.id)); set(src.cosm, { archived: 1 }); }
  // убранные: в архив, если пусто; иначе оставляем в конце раздела и сообщаем
  for (const [c, label] of [[src.household, 'Shopping › Household'], [src.healthOther, 'Health › Other']]) {
    if (!c) continue; const n = await txCount(c);
    if (n) { set(c, { sort: 50 }); kept.push(`${label}: ${n}`); } else set(c, { archived: 1 });
  }
  // Food уходит целиком; свои подкатегории, которых нет в списке, не трогаем
  if (old.food) {
    const left = all.filter(c => c.parent_id === old.food.id && !placed.has(c));
    const n = await txCount(old.food);
    if (!left.length && !n) set(old.food, { archived: 1 }); else { set(old.food, { sort: 8 }); kept.push(`Food: ${n + left.length}`); }
  }
  let k = 9; all.filter(c => !c.parent_id && !ORDER.includes(c.name) && c !== old.food && !c.archived).forEach(c => set(c, { sort: k++ }));
  for (const c of dirty) { c.updated_at = ts; st.push(upsertStmt(env, 'categories', c, ts)); }
  // правила слов: продукты → Home › Groceries (раньше Family › Groceries); машина вообще → Transport › Car service
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND id='cat_rules' AND deleted_at IS NULL").bind(needUid(env)).first();
  let rules = []; try { rules = JSON.parse(row?.value || '[]') || []; } catch (_) {}
  const groc = sub(R.Home, 'Groceries'), car = sub(R.Transport, 'Car service'); let moved = 0;
  rules.forEach(r => { if (src.famGroc && r.c === src.famGroc.id) { r.c = groc.id; moved++; } else if (r.c === R.Transport.id) { r.c = car.id; moved++; } else if (src.cosm && r.c === src.cosm.id) { r.c = care.id; moved++; } });
  if (moved) st.push(upsertStmt(env, 'settings', { id: 'cat_rules', value: JSON.stringify(rules), updated_at: ts }, ts));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
  await touch(env);
  const summary = { at: ts, changed: dirty.size, cosmetic_to_care: merged, rules_moved: moved, kept };
  await setMeta(env, 'cats_v2', JSON.stringify(summary));
  const text = `🗂 Categories updated: Home, Leisure, Transport, Expenses, Nilufar, Family, Shopping, Health.` + (merged ? `\n${merged} from Cosmetic moved to Health › Care.` : '') + (kept.length ? `\nStill have operations (left in place, tell where to move): ${kept.join(', ')}.` : '');
  try { for (const c of await chats(env)) await tgSend(env, c, text); } catch (_) {}
}
async function seed(env) {
  const ts = now(); const st = [];
  const sp = { personal: rid(), family: rid() };
  st.push(insertRow(env, 'spaces', { id: sp.personal, name: 'Personal', kind: 'personal', sort: 0, updated_at: ts }));
  st.push(insertRow(env, 'spaces', { id: sp.family, name: 'Family', kind: 'family', sort: 1, updated_at: ts }));
  const acc = (space, name, type, cur, last4, sort) => st.push(insertRow(env, 'accounts', { id: rid(), space_id: space, name, type, currency: cur, opening_balance: 0, card_last4: last4, sort, hidden: 0, exclude_from_total: 0, updated_at: ts }));
  acc(sp.personal, 'Cash', 'cash', 'UZS', '', 0);
  acc(sp.personal, 'Card', 'card_uzs', 'UZS', '', 1);
  acc(sp.personal, 'Visa', 'card_visa', 'USD', '', 2);
  acc(sp.family, 'Cash', 'cash', 'UZS', '', 0);
  acc(sp.family, 'Card', 'card_uzs', 'UZS', '', 1);
  for (const space of [sp.personal, sp.family]) {
    SEED_CATS.forEach(([name, icon, subs], i) => {
      const pid = rid();
      st.push(insertRow(env, 'categories', { id: pid, space_id: space, parent_id: null, name, kind: 'expense', sort: i, icon, archived: 0, updated_at: ts }));
      subs.forEach((s, j) => st.push(insertRow(env, 'categories', { id: rid(), space_id: space, parent_id: pid, name: s, kind: 'expense', sort: j, icon: '', archived: 0, updated_at: ts })));
    });
    SEED_INCOME.forEach(([name, icon], i) =>
      st.push(insertRow(env, 'categories', { id: rid(), space_id: space, parent_id: null, name, kind: 'income', sort: 100 + i, icon, archived: 0, updated_at: ts })));
  }
  st.push(insertRow(env, 'settings', { id: 'rate_mode', value: 'auto', updated_at: ts }));
  st.push(insertRow(env, 'settings', { id: 'rate_kind', value: 'buy', updated_at: ts }));
  for (let i = 0; i < st.length; i += 50) await env.DB.batch(st.slice(i, i + 50));
}

// ---------- вспомогательное для импорта ----------
async function personalSpace(env) {
  return (await env.DB.prepare("SELECT id FROM spaces WHERE user_id=? AND kind='personal' AND deleted_at IS NULL ORDER BY sort LIMIT 1").bind(needUid(env)).first())?.id;
}
async function balances(env, space) {
  const { results } = await env.DB.prepare(`SELECT a.id,a.name,a.currency,a.hidden,a.opening_balance + COALESCE(SUM(CASE t.type WHEN 'income' THEN t.amount WHEN 'expense' THEN -t.amount ELSE t.amount END),0) AS bal
    FROM accounts a LEFT JOIN transactions t ON t.account_id=a.id AND t.user_id=a.user_id AND t.deleted_at IS NULL
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
// правила «слово → категория» из настроек приложения (cat_rules), та же логика, что в приложении
const stemOf = (w) => { w = String(w).toLowerCase().replace(/ё/g, 'е'); const m = w.replace(/(ами|ями|ов|ев|ах|ях|ам|ям|ой|ей|ий|ый|ая|ое|ые|ы|и|а|я|е|у|ю|о)$/, ''); return m.length >= 3 ? m : w; };
const wordsOf = (t) => String(t || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}'ʻ’]+/gu) || [];
async function ruleCat(env, space, text, kind) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE user_id=? AND id='cat_rules' AND deleted_at IS NULL").bind(needUid(env)).first(); if (!row) return null;
  let rules = []; try { rules = JSON.parse(row.value) || []; } catch (_) { return null; }
  const ws = wordsOf(text); if (!ws.length || !rules.length) return null;
  const { results } = await env.DB.prepare('SELECT id, kind FROM categories WHERE space_id=? AND deleted_at IS NULL').bind(space).all(); const ok = new Map(results.map(c => [c.id, c.kind]));
  const hit = new Set(); // несколько разных категорий — не угадываем, бот спросит
  for (const r of rules) { if (ok.get(r.c) !== kind) continue; const sts = wordsOf(r.w).map(stemOf); if (sts.length && sts.every(st => ws.some(w => w.startsWith(st)))) hit.add(r.c); }
  return hit.size === 1 ? [...hit][0] : null;
}
async function findDup(env, accId, type, amount, ts, source) {
  const any = source === 'payme'; // скрин Payme может относиться к любой карте: ищем по всем счетам
  const { results } = await env.DB.prepare(`SELECT id,source,occurred_at,merchant FROM transactions WHERE user_id=? AND (account_id=? OR ?) AND type=? AND amount=? AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ?`)
    .bind(needUid(env), accId, any ? 1 : 0, type, amount, ts - 15 * 60000, ts + 15 * 60000).all();
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
  const t = String(text).replace(/[\u2018\u2019\u02bb\u02bc\u02b9`´]/g, "'").replace(/\s+/g, ' ').trim();
  if (/^(HUMO|UZCARD)/i.test(t)) return parseHumoSms(t);
  const m = t.match(/^(.+?):\s*(.+?)(?:,\s*[A-Z]{2},)?\s*(\d\d)\.(\d\d)\.(\d\d)\s+(\d\d):(\d\d)\s*,?\s*karta\s*\*+(\d{4})\.?\s*(?:Miqdor|summa):\s*([\d.,]+)\s*([A-Z]{3})[.,]?\s*(?:(?:Qoldiq|balans):\s*([\d.,]+))?/i);
  if (!m) return null;
  const [, kind, merchant, dd, mm, yy, HH, MM, last4, amt, cur, bal] = m;
  const k = kind.toLowerCase();
  let type = null;
  let kindX;
  if (/naqd pul kirim/.test(k)) kindX = 'cashin';
  if (/chiqim|to'?lov|xarid|yechish|payment|purchase|platezh|oplata|spisanie|perevod\s+s\s+kart/.test(k)) type = 'expense';
  else if (/kartaga|kirim|tushum|o'tkazma|refund|qaytarish|popoln|zachisl|postupl|vozvrat|perevod\s+na\s+kart/.test(k)) type = 'income';
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
    const ex = await env.DB.prepare('SELECT id FROM transactions WHERE user_id=? AND source=? AND external_id=?').bind(needUid(env), ev.src, ev.ext).first();
    if (ex) return { dup: true, text: 'duplicate' };
  }
  const dup = ev.noDup ? null : await findDup(env, acc.id, ev.type, ev.amount, ts, ev.src);
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
    const ownOld = acc === undefined ? null : (humo && acc.id === humo.id) ? ipak : (ipak && acc.id === ipak.id) ? humo : null;
    // все свои карты в сумах (в т.ч. новые): встречная СМС на другой своей карте превращает обе операции в один перевод
    const owns = [ownOld, ...all.filter(a => a.id !== acc.id && a !== ownOld && a.card_last4 && a.type !== 'cash' && a.currency === 'UZS' && !a.hidden)].filter(Boolean);
    const pair = async (from, to, note) => {
      const ex = await env.DB.prepare("SELECT id FROM transactions WHERE type='transfer' AND account_id=? AND amount=? AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ?").bind(from.id, -ev.amount, ts - 15 * 60000, ts + 15 * 60000).first();
      if (ex) { await touch(env); return { dup: true, text: 'merged' }; }
      const g = rid(); const mine = acc.id === from.id; const id2 = rid();
      const leg = (id, a, amount, own) => insertRow(env, 'transactions', { id, space_id: space, type: 'transfer', account_id: a.id, amount, currency: 'UZS', fx_rate: 1, amount_base: amount, note, merchant: ev.merchant, occurred_at: ts, transfer_group_id: g, source: own ? ev.src : 'sms_leg', external_id: own ? (ev.ext || null) : null });
      await env.DB.batch([leg(mine ? txId : id2, from, -ev.amount, mine), leg(mine ? id2 : txId, to, ev.amount, !mine)]); await touch(env);
      return { text: `🔁 Transfer: ${fmtMoney(ev.amount, 'UZS')} ${from.name} → ${to.name}` + await qoldiq(env, space, acc, ev), txId, noCat: true };
    };
    for (const own of owns) if ((ev.currency || 'UZS') === 'UZS') {
      const out = ev.type === 'expense';
      const from = out ? acc : own, to = out ? own : acc;
      if (own === ownOld && /IPAK YULI M ULUGBEK|HUMO\s*2\s*UZCARD|UZCARD\s*2\s*HUMO/.test(m)) return pair(from, to, 'Between own cards');
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
  const mapped = ev.merchant ? ((await env.DB.prepare('SELECT category_id FROM merchant_map WHERE user_id=? AND merchant=?').bind(needUid(env), norm(ev.merchant)).first())?.category_id || await ruleCat(env, space, ev.merchant, ev.type === 'income' ? 'income' : 'expense')) : null;
  stmts.push(insertRow(env, 'transactions', { id: txId, space_id: space, type: ev.type, account_id: acc.id, amount: ev.amount, ...mm, category_id: mapped || null, note: ev.note || '', merchant: ev.merchant || '', occurred_at: ts, source: ev.src === 'sms' ? 'sms' : ev.src, external_id: ev.ext || null }));
  await env.DB.batch(stmts); await touch(env);
  const gapR = sms && ev.balance != null && acc.currency === 'UZS' ? await reconcileGap(env, space, acc, ev) : {};
  const gapNote = gapR.note || '';
  let catName = '';
  if (mapped) { const c = await env.DB.prepare('SELECT c.name, p.name AS pn FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=?').bind(mapped).first(); if (c) catName = (c.pn ? c.pn + ' › ' : '') + c.name; }
  const sign = ev.type === 'income' ? '+' : '−';
  const text = (gapNote ? gapNote + '\n' : '') + `${ev.type === 'income' ? '📥' : '💳'} ${sign}${fmtMoney(ev.amount, acc.currency)} · ${ev.merchant || '—'}${converted}\n${acc.name} · ${fmtTs(ts)}${catName ? '\n📂 ' + catName : ''}` + await qoldiq(env, space, acc, ev);
  return { text, txId, kind: ev.type === 'income' ? 'income' : 'expense', mapped: !!mapped, space, gapAsk: gapR.ask };
}
// сверка по остатку из СМС: если в банке на карте не хватает/лишняя сумма ровно как у недавней операции на другой своей карте,
// значит вторая СМС перевода потерялась (Shortcuts обрабатывает одну за раз): достраиваем вторую ногу и склеиваем в перевод
async function reconcileGap(env, space, acc, ev) {
  try {
    const b = (await balances(env, space)).find(x => x.id === acc.id); if (!b) return {};
    const gap = ev.balance - b.bal; if (!gap) return {};
    const { results: others } = await env.DB.prepare("SELECT id,name FROM accounts WHERE space_id=? AND deleted_at IS NULL AND id<>? AND card_last4 IS NOT NULL AND card_last4<>'' AND type<>'cash' AND currency='UZS'").bind(space, acc.id).all();
    if (!others.length) return {};
    const want = gap > 0 ? 'expense' : 'income'; const amt = Math.abs(gap);
    const ph = others.map(() => '?').join(','); const TOL = 100000; // 1 000 UZS в минимальных единицах
    const find = (lo, hi) => env.DB.prepare(`SELECT * FROM transactions WHERE account_id IN (${ph}) AND type=? AND amount BETWEEN ? AND ? AND currency='UZS' AND deleted_at IS NULL AND occurred_at BETWEEN ? AND ? ORDER BY ABS(amount-?) ASC, occurred_at DESC LIMIT 1`).bind(...others.map(o => o.id), want, lo, hi, ev.ts - 12 * 3600000, ev.ts + 12 * 3600000, amt).first();
    const cand = await find(amt, amt);
    if (cand) {
      const g = rid(), t = now(); const from = want === 'expense' ? others.find(o => o.id === cand.account_id) : acc, to = want === 'expense' ? acc : others.find(o => o.id === cand.account_id);
      await env.DB.prepare("UPDATE transactions SET type='transfer', amount=?, amount_base=?, category_id=NULL, transfer_group_id=?, note='Between own cards', updated_at=?, synced_at=? WHERE id=?").bind(want === 'expense' ? -amt : amt, want === 'expense' ? -amt : amt, g, t, t, cand.id).run();
      await env.DB.batch([insertRow(env, 'transactions', { id: rid(), space_id: space, type: 'transfer', account_id: acc.id, amount: want === 'expense' ? amt : -amt, currency: 'UZS', fx_rate: 1, amount_base: want === 'expense' ? amt : -amt, note: 'Between own cards', merchant: cand.merchant, occurred_at: cand.occurred_at, transfer_group_id: g, source: 'sms_leg', external_id: null })]);
      await touch(env);
      return { note: `🔁 The balance showed a missed SMS: ${fmtMoney(amt, 'UZS')} ${from?.name || ''} → ${to?.name || ''} is now one transfer.` };
    }
    // почти совпало (разница до 1 000 UZS: комиссия): не угадываем, спрашиваем; комиссия бывает только со стороны списания (списано больше, чем пришло)
    const near = want === 'expense' ? await find(amt + 1, amt + TOL) : await find(amt - TOL, amt - 1);
    if (!near) return {};
    const other = others.find(o => o.id === near.account_id); const fee = want === 'expense' ? near.amount - amt : amt - near.amount;
    const q = want === 'expense'
      ? `The balance of ${acc.name} grew by ${fmtMoney(amt, 'UZS')}. Close to the ${fmtMoney(near.amount, 'UZS')} spent from ${other?.name || ''} at ${fmtTs(near.occurred_at)} (difference ${fmtMoney(fee, 'UZS')}, a fee?). Is it a transfer?`
      : `The balance of ${acc.name} dropped by ${fmtMoney(amt, 'UZS')}. Close to the ${fmtMoney(near.amount, 'UZS')} received on ${other?.name || ''} at ${fmtTs(near.occurred_at)} (difference ${fmtMoney(fee, 'UZS')}, a fee?). Is it a transfer?`;
    return { ask: { q, rows: [[{ text: `🔁 Transfer + fee ${fmtMoney(fee, 'UZS')}`, callback_data: `f:${near.id}:${acc.id}:${gap}` }], [{ text: 'Keep as expense', callback_data: `k:${near.id}` }]] } };
  } catch (e) { return {}; }
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
async function chats(env) { return (await env.DB.prepare('SELECT chat_id FROM telegram_links WHERE user_id=?').bind(needUid(env)).all()).results.map(r => r.chat_id); }
async function catKeyboard(env, space, kind, txId, parentId) {
  const { results } = await env.DB.prepare('SELECT id,name,icon,parent_id FROM categories WHERE space_id=? AND kind=? AND deleted_at IS NULL AND archived=0 ORDER BY sort').bind(space, kind).all();
  const rows = [];
  if (!parentId) {
    const parents = results.filter(c => !c.parent_id);
    for (let i = 0; i < parents.length; i += 2) rows.push(parents.slice(i, i + 2).map(c => ({ text: `${c.icon && c.icon[0] !== '@' ? c.icon : ''} ${c.name}`.trim(), callback_data: (results.some(x => x.parent_id === c.id) ? 'p:' : 'c:') + txId + ':' + c.id })));
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
  if (res.gapAsk && markup?.inline_keyboard) markup.inline_keyboard = [...res.gapAsk.rows, ...markup.inline_keyboard];
  let text = res.txId && !res.noCat && !res.mapped ? res.text + '\n\nWhich category?' : res.text;
  if (res.gapAsk) text += '\n\n❓ ' + res.gapAsk.q;
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
// иконка для новой категории: ИИ выбирает одну из списка (запасной путь, когда словарь в приложении не нашёл)
const ICON_KEYS = { food: 'food, meals', coffee: 'coffee, cafe, tea', burger: 'fast food, snacks', cart: 'groceries, supermarket', wine: 'alcohol, bars, drinks', home: 'home, rent, household', bolt: 'electricity, utilities', drop: 'water', wifi: 'internet', phone: 'mobile phone', car: 'car, taxi', fuel: 'fuel, gas station', wrench: 'repair, service, tools', bus: 'public transport', plane: 'travel, flights', bed: 'hotel', sun: 'rest, vacation', game: 'games, hobby, entertainment', film: 'movies, streaming', music: 'music, concerts', ball: 'sport', gym: 'gym, fitness', med: 'health, doctor', pill: 'pharmacy, medicine', heart: 'love, partner, dates, charity', family: 'family', baby: 'kids, baby', user: 'friends, personal', paw: 'pets', grad: 'education, courses', book: 'books', bag: 'shopping', shirt: 'clothes, shoes', cut: 'beauty, haircut', gift: 'gifts, holidays', ring: 'wedding, jewelry', receipt: 'bills, taxes, fees, subscriptions', card: 'bank, loans, credit', cash: 'cash', wallet: 'salary, income', piggy: 'savings', rate: 'cashback, interest', work: 'work, business', leaf: 'garden, plants, nature', globe: 'online, foreign', tag: 'other, anything else' };
async function aiIcon(env, name) {
  if (!env.AI || !name.trim()) return null;
  const list = Object.entries(ICON_KEYS).map(([k, d]) => `${k}: ${d}`).join('\n');
  try {
    const out = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', { messages: [{ role: 'system', content: 'You pick an icon for a personal budget category. The name may be in Russian, Uzbek or English. Reply with ONE key from the list and nothing else.\n' + list }, { role: 'user', content: name }], max_tokens: 8, temperature: 0 });
    const k = String(out && out.response || '').toLowerCase().match(/[a-z]+/g) || [];
    return k.find(x => ICON_KEYS[x] && x !== 'tag') || null;
  } catch (_) { return null; }
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
async function tgHandle(env0, update) {
  const cq = update.callback_query;
  const msg = update.message; if (!msg && !cq) return;
  const chat = String(cq ? cq.message.chat.id : msg.chat.id); const text = ((msg && msg.text) || '').trim();
  const linked = await env0.DB.prepare('SELECT * FROM telegram_links WHERE chat_id=?').bind(chat).first();
  if (cq) return linked ? tgCallback(forUser(env0, linked.user_id), cq) : tg(env0, 'answerCallbackQuery', { callback_query_id: cq.id });
  let env = env0;
  if (!linked) {
    const code = (text.match(/^\/start\s+(\d{6})$/) || text.match(/^(\d{6})$/) || [])[1];
    const saved = code ? JSON.parse((await getMeta(env, 'tglink:' + code)) || 'null') : null;
    if (saved && saved.exp > now()) {
      await env.DB.prepare('INSERT OR REPLACE INTO telegram_links(chat_id,user_id,username,linked_at) VALUES(?,?,?,?)').bind(chat, saved.user_id, msg.from?.username || '', now()).run();
      await env.DB.prepare('DELETE FROM meta WHERE k=?').bind('tglink:' + code).run();
      return tgSend(env, chat, '✅ Linked. Send expenses like “netflix 15$” or “lunch 58000”. For a Payme payment, just send the screenshot. /balance, /budget, /help');
    }
    return tgSend(env, chat, 'Link the bot: in the app go to Profile → Settings → Telegram, get a one-time code and send it here.');
  }
  env = forUser(env0, linked.user_id);
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
  // вставленный текст банковской СМС (запасной путь, если Shortcuts не сработал)
  { const ps = text.split(/\n\s*\n/).map(x => x.trim()).filter(Boolean); const pp = ps.map(x => parseSms(x)); if (ps.length && pp.every(Boolean)) { for (const p of pp) { const res = await ingest(env, { src: 'sms', ...p }); if (res.dup) { await tgSend(env, chat, 'Already recorded: ' + (p.merchant || '').slice(0, 40)); continue; } await notify(env, res); } return; } }
  // несколько трат одним сообщением: «Компы 50к, снеки 20к» → две операции (как в Quick в приложении)
  const parts = []; String(text).split(/[;\n]+|,(?!\d)/).map(x => x.trim()).filter(Boolean).forEach(x => { if (/\d/.test(x) || !parts.length) parts.push(x); else parts[parts.length - 1] += ' ' + x; });
  const qs = parts.map(parseQuick);
  if (!qs.length || qs.some(q => !q)) return tgSend(env, chat, 'Didn’t get that. Example: “taxi 25000” or “lunch 58k, taxi 25k”. /help');
  const accounts = (await env.DB.prepare('SELECT * FROM accounts WHERE space_id=? AND deleted_at IS NULL ORDER BY sort').bind(space).all()).results;
  for (let i = 0; i < qs.length; i++) { const q = qs[i];
  let acc = q.kind === 'cash' ? accounts.find(a => a.type === 'cash') : q.kind === 'visa' ? accounts.find(a => a.type === 'card_visa') : q.kind === 'card' ? accounts.find(a => a.type === 'card_uzs') : null;
  if (!acc) acc = q.cur === 'USD' ? accounts.find(a => a.type === 'card_visa') : accounts.find(a => a.type === 'cash');
  if (!acc) acc = accounts[0];
  const res = await ingest(env, { src: 'telegram', type: q.income ? 'income' : 'expense', merchant: q.note, ts: now() + i, amount: q.amount, currency: acc.currency, last4: acc.card_last4 || undefined, card: acc.type === 'card_visa' ? 'visa' : '', ext: 'tgmsg:' + msg.message_id + (i ? ':' + i : ''), noDup: qs.slice(0, i).some(o => o.amount === q.amount) }); // одинаковые суммы в одном сообщении — это разные траты
  if (res.dup) continue;
  await notify(env, res);
  }
}
async function sameMerchantUncategorized(env, tx) {
  if (!tx.merchant) return [];
  const { results } = await env.DB.prepare("SELECT id, merchant FROM transactions WHERE space_id=? AND type=? AND category_id IS NULL AND deleted_at IS NULL AND id<>?").bind(tx.space_id, tx.type, tx.id).all();
  const key = norm(tx.merchant);
  return results.filter(r => norm(r.merchant) === key);
}
async function tgCallback(env, cq) {
  const [act, txId, id, gapArg] = (cq.data || '').split(':');
  const chat = cq.message.chat.id; const mid = cq.message.message_id;
  const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id=? AND user_id=?').bind(txId, needUid(env)).first(); // только свои операции
  await tg(env, 'answerCallbackQuery', { callback_query_id: cq.id });
  if (!tx) return;
  if (act === 'p' || act === 'b') {
    const kind = act === 'b' ? id : tx.type === 'income' ? 'income' : 'expense';
    const kb = await catKeyboard(env, tx.space_id, kind, txId, act === 'p' ? id : null);
    return tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: kb });
  }
  if (act === 'k') return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: (cq.message.text || '').split('\n\n❓')[0] + '\n— kept as an expense' });
  if (act === 'f') {
    const acc = await env.DB.prepare('SELECT * FROM accounts WHERE id=? AND user_id=? AND deleted_at IS NULL').bind(id, needUid(env)).first();
    const gap = parseInt(gapArg, 10);
    const okType = gap > 0 ? 'expense' : 'income';
    if (!acc || !gap || tx.type !== okType) return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: (cq.message.text || '').split('\n\n❓')[0] + '\n— already handled' });
    const amt = Math.abs(gap); const g = rid(), t = now();
    const other = await env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(tx.account_id).first();
    const fee = gap > 0 ? tx.amount - amt : amt - tx.amount; if (!(fee > 0)) return;
    const base = (aid, type, amount, note, src, extra = {}) => insertRow(env, 'transactions', { id: rid(), space_id: tx.space_id, type, account_id: aid, amount, currency: 'UZS', fx_rate: 1, amount_base: amount, note, merchant: tx.merchant, occurred_at: tx.occurred_at, source: src, external_id: null, ...extra });
    if (gap > 0) {
      // acc получил amt, с другой карты списано tx.amount: перевод amt + комиссия
      await env.DB.prepare("UPDATE transactions SET type='transfer', amount=?, amount_base=?, category_id=NULL, transfer_group_id=?, note='Between own cards', updated_at=?, synced_at=? WHERE id=?").bind(-amt, -amt, g, t, t, txId).run();
      await env.DB.batch([base(acc.id, 'transfer', amt, 'Between own cards', 'sms_leg', { transfer_group_id: g }), base(tx.account_id, 'expense', fee, 'Transfer fee', 'sms_leg', { merchant: 'Transfer fee' })]);
    } else {
      // acc потерял amt, на другой карте пришло tx.amount: перевод tx.amount и комиссия на acc
      await env.DB.prepare("UPDATE transactions SET type='transfer', category_id=NULL, transfer_group_id=?, note='Between own cards', updated_at=?, synced_at=? WHERE id=?").bind(g, t, t, txId).run();
      await env.DB.batch([base(acc.id, 'transfer', -tx.amount, 'Between own cards', 'sms_leg', { transfer_group_id: g }), base(acc.id, 'expense', fee, 'Transfer fee', 'sms_leg', { merchant: 'Transfer fee' })]);
    }
    await touch(env);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: (cq.message.text || '').split('\n\n❓')[0] + `\n🔁 Transfer recorded, fee ${fmtMoney(fee, 'UZS')} saved as an expense` });
  }
  if (act === 'x') {
    const to = await env.DB.prepare('SELECT * FROM accounts WHERE id=? AND user_id=? AND deleted_at IS NULL').bind(id, needUid(env)).first();
    if (!to || tx.type !== 'expense') return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: (cq.message.text || '').split('\n\n')[0] + '\n— already a transfer or changed' });
    const from = await env.DB.prepare('SELECT * FROM accounts WHERE id=?').bind(tx.account_id).first();
    const g = rid(), t = now();
    await env.DB.prepare("UPDATE transactions SET type='transfer', amount=?, amount_base=?, category_id=NULL, transfer_group_id=?, note='Between own cards', updated_at=?, synced_at=? WHERE id=?").bind(-tx.amount, -tx.amount, g, t, t, txId).run();
    await env.DB.batch([insertRow(env, 'transactions', { id: rid(), space_id: tx.space_id, type: 'transfer', account_id: to.id, amount: tx.amount, currency: 'UZS', fx_rate: 1, amount_base: tx.amount, note: 'Between own cards', merchant: tx.merchant, occurred_at: tx.occurred_at, transfer_group_id: g, source: 'sms_leg', external_id: null })]);
    await touch(env);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: `🔁 Transfer: ${fmtMoney(tx.amount, 'UZS')} ${from?.name || ''} → ${to.name}` });
  }
  if (act === 'n') return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: (cq.message.text || '') + '\n— left as is' });
  if (act === 'y') {
    const others = await sameMerchantUncategorized(env, tx);
    const t = now();
    const okCat = await env.DB.prepare('SELECT id FROM categories WHERE id=? AND user_id=?').bind(id, needUid(env)).first(); if (!okCat) return;
    for (const o of others) await env.DB.prepare('UPDATE transactions SET category_id=?, updated_at=?, synced_at=? WHERE id=? AND category_id IS NULL').bind(id, t, t, o.id).run();
    if (others.length) await touch(env);
    return tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: `✓ Category set for ${others.length} other from ${tx.merchant}` });
  }
  if (act === 'c') {
    const c = await env.DB.prepare('SELECT c.name, p.name AS pn FROM categories c LEFT JOIN categories p ON p.id=c.parent_id WHERE c.id=? AND c.user_id=?').bind(id, needUid(env)).first();
    if (!c) return;
    const t = now();
    await env.DB.prepare('UPDATE transactions SET category_id=?, updated_at=?, synced_at=? WHERE id=?').bind(id, t, t, txId).run();
    if (tx.merchant) await env.DB.prepare('INSERT INTO merchant_map(user_id,merchant,category_id,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id,merchant) DO UPDATE SET category_id=excluded.category_id, updated_at=excluded.updated_at').bind(needUid(env), norm(tx.merchant), id, t).run();
    await touch(env);
    const base = (cq.message.text || '').replace(/\n\n(Куда отнести|Which category)\?$/, '').replace(/\n📂 .*/, '');
    const done = await tg(env, 'editMessageText', { chat_id: chat, message_id: mid, text: base + `\n📂 ${(c.pn ? c.pn + ' › ' : '') + c.name} ✓`, reply_markup: { inline_keyboard: [[{ text: '✏ Change category', callback_data: 'b:' + txId + ':' + (tx.type === 'income' ? 'income' : 'expense') }]] } });
    const others = await sameMerchantUncategorized(env, tx);
    if (others.length) await tgSend(env, chat, `Also set ${(c.pn ? c.pn + ' › ' : '') + c.name} for ${others.length} other uncategorized from ${tx.merchant}?`, { reply_markup: { inline_keyboard: [[{ text: `Yes (${others.length})`, callback_data: 'y:' + txId + ':' + id }, { text: 'No', callback_data: 'n:' + txId + ':x' }]] } });
    return done;
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
  await setMeta(env, 'last_in:' + needUid(env), now());
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
    const p = /^\s*Xato\b/i.test(sms) ? 'ignore' : /^\s*budgettest/i.test(sms) ? 'test' : parseSms(sms);
    if (p === 'test') res = { text: '✅ Shortcuts reached the server. The SMS automation works.' }; else
    if (p === 'ignore') res = { dup: true, text: 'ignored' }; else
    if (p) res = await ingest(env, { src: 'sms', ...p });
    else { res = { text: '⚠ Couldn’t parse the SMS:\n' + String(sms).slice(0, 300) }; }
  } else res = { text: '' };
  await env.DB.prepare('INSERT INTO import_log(source,raw,result,at,user_id) VALUES(?,?,?,?,?)').bind(obj?.amount !== undefined ? 'wallet' : 'sms', raw.slice(0, 1000), ((res.dup ? res.text : res.text || '') + (res.gapAsk ? ' ❓ ' + res.gapAsk.q : '')).slice(0, 600), now(), needUid(env)).run();
  if (res.text && !res.dup) await notify(env, res);
  return J({ ok: true, result: res.dup ? res.text : 'recorded' });
}

// ---------- роутер ----------
async function remindAll(env) {
  const { results } = await env.DB.prepare('SELECT DISTINCT user_id FROM telegram_links WHERE user_id IS NOT NULL').all();
  for (const r of results) { try { await uncategorizedReminder(forUser(env, r.user_id)); } catch (e) { console.log('remind failed', r.user_id, String(e)); } }
}
async function uncategorizedReminder(env) {
  const space = await personalSpace(env); if (!space) return;
  const { results } = await env.DB.prepare("SELECT t.*, a.name AS acc FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id WHERE t.space_id=? AND t.type IN ('expense','income') AND t.category_id IS NULL AND t.deleted_at IS NULL ORDER BY t.occurred_at DESC LIMIT 200").bind(space).all();
  if (!results.length) return;
  const lines = results.slice(0, 15).map(t => `${fmtTs(t.occurred_at)} · ${t.type === 'income' ? '+' : '−'}${fmtMoney(t.amount, t.currency)} · ${t.merchant || t.note || '—'} · ${t.acc || ''}`);
  const more = results.length > 15 ? `\n…and ${results.length - 15} more` : '';
  const text = `🗂 ${results.length} without category:\n${lines.join('\n')}${more}\n\nPick a category with the buttons under the original messages, or in the app: Home → “without category”.`;
  for (const c of await chats(env)) await tgSend(env, c, text);
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(remindAll(env)); },
  async fetch(req, env, ctx) {
    const origin = req.headers.get('origin') || '';
    if (!NATIVE_ORIGINS.includes(origin) || !new URL(req.url).pathname.startsWith('/api/')) return handle(req, env, ctx);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(origin) });
    const res = await handle(req, env, ctx);
    const out = new Response(res.body, res);
    Object.entries(cors(origin)).forEach(([k, v]) => out.headers.set(k, v));
    return out;
  },
};

const INVITE_TTL = 7 * 86400000;
async function inviteRow(env, code) {
  code = String(code || ''); if (!/^[A-Za-z0-9_-]{10,40}$/.test(code)) return null;
  return env.DB.prepare('SELECT * FROM invites WHERE code_hash=? AND used_at IS NULL AND exp>?').bind(await sha(code), now()).first();
}
async function newSession(env, req, uid) {
  const native = req.headers.get('x-client') === 'native';
  const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare('INSERT INTO sessions(id,user_id,exp) VALUES(?,?,?)').bind(await sha(tok), uid, now() + (native ? NATIVE_SESSION : 12 * 3600000)).run();
  return J({ ok: true, ...(native ? { token: tok } : {}) }, 200, { 'set-cookie': `sid=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` });
}
async function handle(req, env, ctx) {
    const url = new URL(req.url); const path = url.pathname;
    if (!path.startsWith('/api/')) return env.ASSETS.fetch(req);
    try {
      // публичные: вебхуки. Адрес Doniyor (WEBHOOK_SECRET) не меняется; у остальных свой ключ users.hook_key
      if (path.startsWith('/api/in/')) {
        const key = path.slice(8);
        const hu = key && env.WEBHOOK_SECRET && key === env.WEBHOOK_SECRET ? await ownerUid(env) : (key.length >= 24 ? (await env.DB.prepare('SELECT id FROM users WHERE hook_key=?').bind(key).first())?.id : null);
        if (!hu) { await setMeta(env, 'bad_in', JSON.stringify({ at: now(), host: url.hostname, head: path.slice(8, 12) })); return J({ error: 'bad_url' }, 404); }
        const ue = forUser(env, hu);
        if (req.method === 'GET') return J({ ok: true, last_received: Number(await getMeta(env, 'last_in:' + hu)) || null });
        if (req.method === 'POST') return await webhook(req, ue);
        return J({ error: 'method' }, 405);
      }
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
        const salt = crypto.getRandomValues(new Uint8Array(16)); const id = rid();
        await env.DB.prepare("INSERT INTO users(id,login,pass_hash,pass_salt,created_at,role) VALUES(?,?,?,?,?,'owner')").bind(id, b.login, await pbkdf2(b.password, salt), b64(salt), now()).run();
        await setMeta(env, 'owner_uid', id);
        await seed(forUser(env, id)); await touch(forUser(env, id));
        return J({ ok: true });
      }
      // приглашение: проверить ссылку (страница /join/<код>)
      if (path === '/api/invite/check' && req.method === 'POST') {
        const inv = await inviteRow(env, (await req.json()).code);
        if (!inv) return J({ ok: false });
        const by = await env.DB.prepare('SELECT login FROM users WHERE id=?').bind(inv.created_by).first();
        return J({ ok: true, by: by?.login || '', exp: inv.exp });
      }
      // регистрация по приглашению: свой логин и пароль, свои данные с нуля
      if (path === '/api/signup' && req.method === 'POST') {
        const b = await req.json();
        const inv = await inviteRow(env, b.code);
        if (!inv) return J({ error: 'bad_invite' }, 400);
        const login = String(b.login || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(login)) return J({ error: 'bad_login' }, 400);
        if (String(b.password || '').length < 8) return J({ error: 'too_short' }, 400);
        if (await env.DB.prepare('SELECT id FROM users WHERE lower(login)=?').bind(login).first()) return J({ error: 'taken' }, 400);
        const t = now();
        const used = await env.DB.prepare('UPDATE invites SET used_at=? WHERE code_hash=? AND used_at IS NULL AND exp>?').bind(t, inv.code_hash, t).run();
        if (!used.meta?.changes) return J({ error: 'bad_invite' }, 400);
        const salt = crypto.getRandomValues(new Uint8Array(16)); const id = rid();
        try {
          await env.DB.prepare("INSERT INTO users(id,login,pass_hash,pass_salt,created_at,role,hook_key,invited_by) VALUES(?,?,?,?,?,'user',?,?)").bind(id, login, await pbkdf2(String(b.password), salt), b64(salt), t, hex(crypto.getRandomValues(new Uint8Array(16))), inv.created_by).run();
        } catch (e) { await env.DB.prepare('UPDATE invites SET used_at=NULL WHERE code_hash=?').bind(inv.code_hash).run(); return J({ error: 'taken' }, 400); }
        await env.DB.prepare('UPDATE invites SET used_by=? WHERE code_hash=?').bind(id, inv.code_hash).run();
        const ue = forUser(env, id); await seed(ue); await touch(ue);
        await env.DB.prepare('INSERT INTO login_log(login,ok,ip,at) VALUES(?,?,?,?)').bind('signup:' + login, 1, req.headers.get('cf-connecting-ip') || '', t).run();
        return newSession(env, req, id);
      }
      if (path === '/api/login' && req.method === 'POST') {
        const b = await req.json(); const ip = req.headers.get('cf-connecting-ip') || '';
        const u = await env.DB.prepare('SELECT * FROM users WHERE lower(login)=lower(?)').bind(String(b.login || '').trim()).first();
        if (u && u.locked_until > now()) return J({ error: 'locked', until: u.locked_until }, 429);
        const ok = u && (await pbkdf2(String(b.password || ''), unb64(u.pass_salt))) === u.pass_hash;
        await env.DB.prepare('INSERT INTO login_log(login,ok,ip,at) VALUES(?,?,?,?)').bind(String(b.login || ''), ok ? 1 : 0, ip, now()).run();
        if (!ok) {
          if (u) { const f = u.fails + 1; await env.DB.prepare('UPDATE users SET fails=?, locked_until=? WHERE id=?').bind(f >= 5 ? 0 : f, f >= 5 ? now() + 15 * 60000 : 0, u.id).run(); }
          return J({ error: 'bad_credentials' }, 400);
        }
        await env.DB.prepare('UPDATE users SET fails=0, locked_until=0 WHERE id=?').bind(u.id).run();
        const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare('INSERT INTO sessions(id,user_id,exp) VALUES(?,?,?)').bind(await sha(tok), u.id, now() + (req.headers.get('x-client') === 'native' ? NATIVE_SESSION : 12 * 3600000)).run();
        return J({ ok: true, ...(req.headers.get('x-client') === 'native' ? { token: tok } : {}) }, 200, { 'set-cookie': `sid=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` });
      }
      if (path === '/api/pk/auth-options' && req.method === 'POST') {
        const ks = (await env.DB.prepare('SELECT id FROM passkeys').all()).results;
        if (!ks.length) return J({ none: true });
        return J({ challenge: await pkChallenge(env), rpId: env.PK_HOST || url.hostname, allow: ks.map(k => k.id) });
      }
      if (path === '/api/pk/auth-finish' && req.method === 'POST') {
        const b = await req.json();
        const k = await env.DB.prepare('SELECT * FROM passkeys WHERE id=?').bind(String(b.id || '')).first();
        try {
          const ad = unb64u(b.authenticatorData);
          if (!k || !(await pkCheckClient(env, url, b.clientDataJSON, 'webauthn.get')) || !(await pkAuthDataOk(env, url, ad)) || !(await pkVerifySig(k.pub, ad, b.clientDataJSON, unb64u(b.signature)))) return J({ error: 'bad_passkey' }, 400);
        } catch (e) { return J({ error: 'bad_passkey' }, 400); }
        const tok = hex(crypto.getRandomValues(new Uint8Array(32)));
        await env.DB.prepare('INSERT INTO sessions(id,user_id,exp) VALUES(?,?,?)').bind(await sha(tok), k.user_id, now() + 12 * 3600000).run();
        await env.DB.prepare('INSERT INTO login_log(login,ok,ip,at) VALUES(?,?,?,?)').bind('passkey', 1, req.headers.get('cf-connecting-ip') || '', now()).run();
        return J({ ok: true, ...(req.headers.get('x-client') === 'native' ? { token: tok } : {}) }, 200, { 'set-cookie': `sid=${tok}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=43200` });
      }
      const uid = await authed(req, env);
      if (!uid) return J({ error: 'auth' }, 401);
      env = forUser(env, uid); // дальше всё только в данных этого пользователя
      const isOwner = uid === await ownerUid(env);
      if (path === '/api/logout') {
        await env.DB.prepare('DELETE FROM sessions WHERE id=?').bind(await sha(bearer(req) || cookie(req, 'sid'))).run();
        return J({ ok: true }, 200, { 'set-cookie': 'sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0' });
      }
      if (path === '/api/username' && req.method === 'POST') { // смена юзернейма (= логина) со страницы личных данных
        const login = String((await req.json()).login || '').trim().toLowerCase();
        if (!/^[a-z0-9._-]{3,32}$/.test(login)) return J({ error: 'bad_login' }, 400);
        const ex = await env.DB.prepare('SELECT id FROM users WHERE lower(login)=?').bind(login).first();
        if (ex && ex.id !== uid) return J({ error: 'taken' }, 400);
        try { await env.DB.prepare('UPDATE users SET login=? WHERE id=?').bind(login, uid).run(); } catch (e) { return J({ error: 'taken' }, 400); }
        return J({ ok: true, login });
      }
      if (path === '/api/password' && req.method === 'POST') {
        const b = await req.json(); const u = await env.DB.prepare('SELECT * FROM users WHERE id=?').bind(uid).first();
        if (!u || (await pbkdf2(String(b.current || ''), unb64(u.pass_salt))) !== u.pass_hash) return J({ error: 'wrong_current' }, 400);
        if (String(b.next || '').length < 8) return J({ error: 'too_short' }, 400);
        const salt = crypto.getRandomValues(new Uint8Array(16));
        await env.DB.prepare('UPDATE users SET pass_hash=?, pass_salt=? WHERE id=?').bind(await pbkdf2(String(b.next), salt), b64(salt), uid).run();
        await env.DB.prepare('DELETE FROM sessions WHERE user_id=? AND id<>?').bind(uid, await sha(bearer(req) || cookie(req, 'sid'))).run();
        return J({ ok: true });
      }
      if (path === '/api/pk/reg-options' && req.method === 'POST') {
        const u = await env.DB.prepare('SELECT login FROM users WHERE id=?').bind(uid).first();
        return J({ challenge: await pkChallenge(env), rp: { id: env.PK_HOST || url.hostname, name: 'Budget' }, user: { id: b64u(new TextEncoder().encode(uid)), name: u.login, displayName: u.login } });
      }
      if (path === '/api/pk/reg-finish' && req.method === 'POST') {
        const b = await req.json();
        try { if (!(await pkCheckClient(env, url, b.clientDataJSON, 'webauthn.create')) || !b.id || !b.publicKey) return J({ error: 'bad_passkey' }, 400);
          await crypto.subtle.importKey('spki', unb64u(b.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        } catch (e) { return J({ error: 'bad_passkey' }, 400); }
        await env.DB.prepare('INSERT OR REPLACE INTO passkeys(id,user_id,pub,created_at) VALUES(?,?,?,?)').bind(String(b.id), uid, String(b.publicKey), now()).run();
        return J({ ok: true });
      }
      if (path === '/api/pk/remove' && req.method === 'POST') {
        await env.DB.prepare('DELETE FROM passkeys WHERE user_id=?').bind(uid).run();
        return J({ ok: true });
      }
      if (path === '/api/me') {
        const u = await env.DB.prepare('SELECT login FROM users WHERE id=?').bind(uid).first();
        const links = await env.DB.prepare('SELECT COUNT(*) c FROM telegram_links WHERE user_id=?').bind(uid).first();
        const pk = await env.DB.prepare('SELECT COUNT(*) c FROM passkeys WHERE user_id=?').bind(uid).first();
        const hk = isOwner ? env.WEBHOOK_SECRET : (await env.DB.prepare('SELECT hook_key FROM users WHERE id=?').bind(uid).first())?.hook_key;
        return J({ login: u.login, owner: isOwner, pk: pk.c, last_in: Number(await getMeta(env, 'last_in:' + uid)) || null, bad_in: isOwner ? JSON.parse((await getMeta(env, 'bad_in')) || 'null') : null, hook_url: hk ? url.origin + '/api/in/' + hk : null, tg_ready: !!env.TG_TOKEN, tg_linked: links.c, stamp: await stampOf(env) });
      }
      if (path === '/api/stamp') return J({ stamp: await stampOf(env) });
      if (path === '/api/sync' && req.method === 'POST') return J(await sync(env, await req.json()));
      if (path === '/api/icon' && req.method === 'POST') return J({ icon: await aiIcon(env, String((await req.json()).name || '').slice(0, 60)) });
      if (path === '/api/rate') return J({ ...(await getRates(env, url.searchParams.get('force') === '1')) });
      if (path === '/api/tg/code' && req.method === 'POST') {
        const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
        await env.DB.prepare("DELETE FROM meta WHERE k LIKE 'tglink:%' AND CAST(json_extract(v,'$.exp') AS INTEGER) < ?").bind(now()).run();
        await setMeta(env, 'tglink:' + code, JSON.stringify({ exp: now() + 10 * 60000, user_id: uid }));
        return J({ code });
      }
      if (path === '/api/tg/status') {
        if (!env.TG_TOKEN) return J({ ok: false, reason: 'no_token' });
        const w = await tg(env, 'getWebhookInfo', {}).catch(() => null); const i = w?.result || {};
        const links = await env.DB.prepare('SELECT COUNT(*) c FROM telegram_links WHERE user_id=?').bind(uid).first();
        const hook = !!i.url && /\/api\/tg$/.test(i.url);
        const recentErr = i.last_error_date && (now() / 1000 - i.last_error_date) < 3600;
        const ok = hook && !recentErr && links.c > 0;
        return J({ ok, reason: !w?.ok ? 'tg_unreachable' : !hook ? 'no_webhook' : recentErr ? 'error' : !links.c ? 'not_linked' : '', error: recentErr ? i.last_error_message : '' });
      }
      if (path === '/api/tg/setup' && req.method === 'POST') {
        if (!isOwner) return J({ error: 'owner_only' }, 403); // вебхук бота общий, его ставит только владелец
        if (!env.TG_TOKEN || !env.TG_SECRET) return J({ error: 'no_token' }, 400);
        const r = await tg(env, 'setWebhook', { url: url.origin + '/api/tg', secret_token: env.TG_SECRET, allowed_updates: ['message', 'callback_query'] });
        const me = await tg(env, 'getMe', {});
        return J({ ok: r?.ok, bot: me?.result?.username, desc: r?.description });
      }
      if (path === '/api/tg/remind' && req.method === 'POST') { await uncategorizedReminder(env); return J({ ok: true }); }
      if (path === '/api/import-log') return J((await env.DB.prepare('SELECT * FROM import_log WHERE user_id=? ORDER BY id DESC LIMIT 30').bind(uid).all()).results);
      // приглашения друзей (пока только владелец): одноразовая ссылка на 7 дней
      if (path === '/api/invites' && req.method === 'POST') {
        if (!isOwner) return J({ error: 'owner_only' }, 403);
        const code = b64u(crypto.getRandomValues(new Uint8Array(12))); const t = now();
        await env.DB.prepare('INSERT INTO invites(code_hash,created_by,created_at,exp) VALUES(?,?,?,?)').bind(await sha(code), uid, t, t + INVITE_TTL).run();
        return J({ code, url: url.origin + '/join/' + code, exp: t + INVITE_TTL });
      }
      if (path === '/api/invites') {
        if (!isOwner) return J({ error: 'owner_only' }, 403);
        const { results } = await env.DB.prepare('SELECT i.created_at, i.exp, i.used_at, u.login FROM invites i LEFT JOIN users u ON u.id=i.used_by WHERE i.created_by=? ORDER BY i.created_at DESC LIMIT 50').bind(uid).all();
        return J({ invites: results.map(r => ({ created_at: r.created_at, exp: r.exp, used_at: r.used_at, login: r.login || null })) });
      }
      return J({ error: 'not_found' }, 404);
    } catch (e) {
      console.log('error', path, String(e && e.stack || e));
      return J({ error: 'server', message: String(e).slice(0, 200) }, 500);
    }
}
