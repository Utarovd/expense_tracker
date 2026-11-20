CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT UNIQUE, pass_hash TEXT, pass_salt TEXT, fails INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT, exp INTEGER);
CREATE TABLE IF NOT EXISTS login_log(id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT, ok INTEGER, ip TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS passkeys(id TEXT PRIMARY KEY, user_id TEXT, pub TEXT, created_at INTEGER);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS telegram_links(chat_id TEXT PRIMARY KEY, user_id TEXT, username TEXT, linked_at INTEGER);
CREATE TABLE IF NOT EXISTS merchant_map(merchant TEXT PRIMARY KEY, category_id TEXT, updated_at INTEGER);
CREATE TABLE IF NOT EXISTS import_log(id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, raw TEXT, result TEXT, at INTEGER);

CREATE TABLE IF NOT EXISTS spaces(id TEXT PRIMARY KEY, name TEXT, kind TEXT, sort INTEGER, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);
CREATE TABLE IF NOT EXISTS accounts(id TEXT PRIMARY KEY, space_id TEXT, name TEXT, type TEXT, currency TEXT, opening_balance INTEGER, card_last4 TEXT, sort INTEGER, hidden INTEGER, exclude_from_total INTEGER, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);
CREATE TABLE IF NOT EXISTS categories(id TEXT PRIMARY KEY, space_id TEXT, parent_id TEXT, name TEXT, kind TEXT, sort INTEGER, icon TEXT, archived INTEGER, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);
CREATE TABLE IF NOT EXISTS transactions(id TEXT PRIMARY KEY, space_id TEXT, type TEXT, account_id TEXT, amount INTEGER, currency TEXT, fx_rate REAL, amount_base INTEGER, category_id TEXT, note TEXT, merchant TEXT, occurred_at INTEGER, transfer_group_id TEXT, source TEXT, external_id TEXT, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);
CREATE TABLE IF NOT EXISTS budgets(id TEXT PRIMARY KEY, space_id TEXT, month TEXT, category_id TEXT, limit_amount INTEGER, currency TEXT, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(id TEXT PRIMARY KEY, value TEXT, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);

CREATE INDEX IF NOT EXISTS i_tx_sync ON transactions(synced_at);
CREATE INDEX IF NOT EXISTS i_tx_acc ON transactions(account_id, occurred_at);
CREATE UNIQUE INDEX IF NOT EXISTS u_tx_ext ON transactions(source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS i_acc_sync ON accounts(synced_at);
CREATE INDEX IF NOT EXISTS i_cat_sync ON categories(synced_at);
CREATE INDEX IF NOT EXISTS i_bud_sync ON budgets(synced_at);
CREATE INDEX IF NOT EXISTS i_set_sync ON settings(synced_at);
CREATE INDEX IF NOT EXISTS i_sp_sync ON spaces(synced_at);

-- карта ***2660 (Doniyor, 20.11): счёт и две прошлые операции (идемпотентно). Visa остаётся последней.
UPDATE accounts SET sort=sort+1, updated_at=CAST(strftime('%s','now') AS INTEGER)*1000, synced_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE type='card_visa' AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM spaces WHERE id=accounts.space_id AND kind='personal') AND NOT EXISTS (SELECT 1 FROM accounts WHERE card_last4='2660');
INSERT OR IGNORE INTO accounts(id,space_id,name,type,currency,opening_balance,card_last4,sort,hidden,exclude_from_total,updated_at,deleted_at,synced_at)
  SELECT 'acc-card-2660', s.id, 'Card ···2660', 'card_uzs', 'UZS', 0, '2660', COALESCE((SELECT MIN(sort) FROM accounts WHERE space_id=s.id AND type='card_visa' AND deleted_at IS NULL),9)-1, 0, 0, CAST(strftime('%s','now') AS INTEGER)*1000, NULL, CAST(strftime('%s','now') AS INTEGER)*1000
  FROM spaces s WHERE s.kind='personal' AND s.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM accounts WHERE card_last4='2660') LIMIT 1;
INSERT OR IGNORE INTO transactions(id,space_id,type,account_id,amount,currency,fx_rate,amount_base,category_id,note,merchant,occurred_at,transfer_group_id,source,external_id,updated_at,deleted_at,synced_at)
  SELECT 'tx-2660-a', a.space_id, 'income', a.id, 1013920000, 'UZS', 1, 1013920000, NULL, '', 'ATIB IPOTEKA BANK SHAHAR FILIALI EPOS', CAST(strftime('%s','2026-11-20 12:47:00') AS INTEGER)*1000, NULL, 'sms', 'sms:2660:2011261747:10139200.00:10139200.00', CAST(strftime('%s','now') AS INTEGER)*1000, NULL, CAST(strftime('%s','now') AS INTEGER)*1000
  FROM accounts a WHERE a.id='acc-card-2660';
INSERT OR IGNORE INTO transactions(id,space_id,type,account_id,amount,currency,fx_rate,amount_base,category_id,note,merchant,occurred_at,transfer_group_id,source,external_id,updated_at,deleted_at,synced_at)
  SELECT 'tx-2660-b', a.space_id, 'expense', a.id, 10000000, 'UZS', 1, 10000000, NULL, '', 'PAYME P2P UZCARD NA MC OSMON 0', CAST(strftime('%s','2026-11-20 14:13:00') AS INTEGER)*1000, NULL, 'sms', 'sms:2660:2011261913:100000.00:10039200.00', CAST(strftime('%s','now') AS INTEGER)*1000, NULL, CAST(strftime('%s','now') AS INTEGER)*1000
  FROM accounts a WHERE a.id='acc-card-2660';
INSERT OR REPLACE INTO meta(k,v) VALUES('stamp', CAST(strftime('%s','now') AS INTEGER)*1000);
