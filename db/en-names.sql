-- One-off 18.11: rename seeded spaces/accounts to English; bumps updated_at/synced_at so clients pull it.
UPDATE spaces SET name='Personal', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000, synced_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE name='Личный';
UPDATE spaces SET name='Family', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000, synced_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE name='Семейный';
UPDATE accounts SET name='Cash', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000, synced_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE name='Наличные';
UPDATE accounts SET name='UZS card', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000, synced_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE name='Карта UZS';
UPDATE accounts SET name='Card', updated_at=CAST(strftime('%s','now') AS INTEGER)*1000, synced_at=CAST(strftime('%s','now') AS INTEGER)*1000 WHERE name='Карта';
