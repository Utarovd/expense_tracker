-- Выполняется при каждой выкладке после schema.sql. Страховка: строки без user_id (из разовых правок) принадлежат владельцу.
UPDATE spaces SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE accounts SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE categories SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE transactions SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE budgets SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE import_log SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE OR REPLACE settings SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
UPDATE OR REPLACE merchant_map SET user_id=(SELECT v FROM meta WHERE k='owner_uid') WHERE user_id IS NULL AND EXISTS (SELECT 1 FROM meta WHERE k='owner_uid');
