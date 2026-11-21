-- Несколько пользователей (21.11.2026). Применяется один раз: npx wrangler d1 migrations apply expense-tracker --remote
-- 1) Бэкап всех таблиц внутри той же базы (bak1121_*). Плюс D1 Time Travel (откат на любую минуту за 30 дней).
-- 2) У каждой строки появляется user_id. Все существующие данные отдаются первому пользователю (Doniyor, владелец).
-- 3) settings и merchant_map: ключ теперь (user_id, id/merchant), чтобы у каждого были свои настройки.

CREATE TABLE IF NOT EXISTS bak1121_users AS SELECT * FROM users;
CREATE TABLE IF NOT EXISTS bak1121_spaces AS SELECT * FROM spaces;
CREATE TABLE IF NOT EXISTS bak1121_accounts AS SELECT * FROM accounts;
CREATE TABLE IF NOT EXISTS bak1121_categories AS SELECT * FROM categories;
CREATE TABLE IF NOT EXISTS bak1121_transactions AS SELECT * FROM transactions;
CREATE TABLE IF NOT EXISTS bak1121_budgets AS SELECT * FROM budgets;
CREATE TABLE IF NOT EXISTS bak1121_settings AS SELECT * FROM settings;
CREATE TABLE IF NOT EXISTS bak1121_merchant_map AS SELECT * FROM merchant_map;
CREATE TABLE IF NOT EXISTS bak1121_telegram_links AS SELECT * FROM telegram_links;
CREATE TABLE IF NOT EXISTS bak1121_meta AS SELECT * FROM meta;

-- владелец = самый первый пользователь
INSERT OR REPLACE INTO meta(k,v) SELECT 'owner_uid', id FROM users ORDER BY created_at, rowid LIMIT 1;

ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'user';
ALTER TABLE users ADD COLUMN hook_key TEXT;
ALTER TABLE users ADD COLUMN invited_by TEXT;
UPDATE users SET role='owner' WHERE id=(SELECT v FROM meta WHERE k='owner_uid');
CREATE UNIQUE INDEX IF NOT EXISTS u_users_hook ON users(hook_key) WHERE hook_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS u_users_login ON users(lower(login));

CREATE TABLE IF NOT EXISTS invites(code_hash TEXT PRIMARY KEY, created_by TEXT, created_at INTEGER, exp INTEGER, used_by TEXT, used_at INTEGER);

ALTER TABLE spaces ADD COLUMN user_id TEXT;
ALTER TABLE accounts ADD COLUMN user_id TEXT;
ALTER TABLE categories ADD COLUMN user_id TEXT;
ALTER TABLE transactions ADD COLUMN user_id TEXT;
ALTER TABLE budgets ADD COLUMN user_id TEXT;
ALTER TABLE import_log ADD COLUMN user_id TEXT;
UPDATE spaces SET user_id=(SELECT v FROM meta WHERE k='owner_uid');
UPDATE accounts SET user_id=(SELECT v FROM meta WHERE k='owner_uid');
UPDATE categories SET user_id=(SELECT v FROM meta WHERE k='owner_uid');
UPDATE transactions SET user_id=(SELECT v FROM meta WHERE k='owner_uid');
UPDATE budgets SET user_id=(SELECT v FROM meta WHERE k='owner_uid');
UPDATE import_log SET user_id=(SELECT v FROM meta WHERE k='owner_uid');

-- settings: ключ (user_id, id)
CREATE TABLE settings_mu(user_id TEXT, id TEXT, value TEXT, updated_at INTEGER, deleted_at INTEGER, synced_at INTEGER);
INSERT INTO settings_mu(user_id,id,value,updated_at,deleted_at,synced_at) SELECT (SELECT v FROM meta WHERE k='owner_uid'), id, value, updated_at, deleted_at, synced_at FROM settings;
DROP TABLE settings;
ALTER TABLE settings_mu RENAME TO settings;
CREATE UNIQUE INDEX IF NOT EXISTS u_set_user ON settings(user_id, id);

-- магазин → категория: свой у каждого
CREATE TABLE merchant_map_mu(user_id TEXT, merchant TEXT, category_id TEXT, updated_at INTEGER);
INSERT INTO merchant_map_mu(user_id,merchant,category_id,updated_at) SELECT (SELECT v FROM meta WHERE k='owner_uid'), merchant, category_id, updated_at FROM merchant_map;
DROP TABLE merchant_map;
ALTER TABLE merchant_map_mu RENAME TO merchant_map;
CREATE UNIQUE INDEX IF NOT EXISTS u_mm_user ON merchant_map(user_id, merchant);

-- дубли СМС ищутся внутри одного пользователя
DROP INDEX IF EXISTS u_tx_ext;
CREATE UNIQUE INDEX IF NOT EXISTS u_tx_ext2 ON transactions(user_id, source, external_id) WHERE external_id IS NOT NULL;

-- синхронизация читает «мои строки новее курсора»
DROP INDEX IF EXISTS i_tx_sync; DROP INDEX IF EXISTS i_acc_sync; DROP INDEX IF EXISTS i_cat_sync; DROP INDEX IF EXISTS i_bud_sync; DROP INDEX IF EXISTS i_set_sync; DROP INDEX IF EXISTS i_sp_sync;
CREATE INDEX IF NOT EXISTS i_tx_usync ON transactions(user_id, synced_at);
CREATE INDEX IF NOT EXISTS i_acc_usync ON accounts(user_id, synced_at);
CREATE INDEX IF NOT EXISTS i_cat_usync ON categories(user_id, synced_at);
CREATE INDEX IF NOT EXISTS i_bud_usync ON budgets(user_id, synced_at);
CREATE INDEX IF NOT EXISTS i_set_usync ON settings(user_id, synced_at);
CREATE INDEX IF NOT EXISTS i_sp_usync ON spaces(user_id, synced_at);
CREATE INDEX IF NOT EXISTS i_sp_user ON spaces(user_id, kind);
CREATE INDEX IF NOT EXISTS i_tg_user ON telegram_links(user_id);

-- служебные метки по пользователю
INSERT OR REPLACE INTO meta(k,v) SELECT 'stamp:' || (SELECT v FROM meta WHERE k='owner_uid'), v FROM meta WHERE k='stamp' AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
INSERT OR REPLACE INTO meta(k,v) SELECT 'last_in:' || (SELECT v FROM meta WHERE k='owner_uid'), v FROM meta WHERE k='last_in' AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
DELETE FROM meta WHERE k='tglink';
