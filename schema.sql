CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, login TEXT UNIQUE, pass_hash TEXT, pass_salt TEXT, fails INTEGER DEFAULT 0, locked_until INTEGER DEFAULT 0, created_at INTEGER);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT, exp INTEGER);
CREATE TABLE IF NOT EXISTS login_log(id INTEGER PRIMARY KEY AUTOINCREMENT, login TEXT, ok INTEGER, ip TEXT, at INTEGER);
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
