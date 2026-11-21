-- Выполняется при каждой выкладке после schema.sql. Страховка: строки без user_id (из разовых правок) принадлежат владельцу.
UPDATE spaces SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE accounts SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE categories SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
-- старые правки в schema.sql (INSERT OR IGNORE) раньше молча пропускались из-за общего уникального индекса СМС;
-- теперь такие повторы (та же СМС уже есть у пользователя) просто убираем
DELETE FROM transactions WHERE user_id IS NULL AND external_id IS NOT NULL AND EXISTS (SELECT 1 FROM transactions t2 WHERE t2.user_id IS NOT NULL AND t2.source=transactions.source AND t2.external_id=transactions.external_id);
UPDATE transactions SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE budgets SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE import_log SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE OR REPLACE settings SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE OR REPLACE merchant_map SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
