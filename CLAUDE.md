# Бюджетное приложение (Doniyor)

Личный бюджет: PWA для Mac и iPhone + Telegram-бот + авто-импорт из СМС банка и Apple Wallet. Один Cloudflare Worker + D1.

## Правила для чатов
- Отвечать по-русски, коротко. Имена людей латиницей. Даты ДД.ММ, время ЧЧ:ММ 24ч, часовой пояс Asia/Tashkent (UTC+5).
- Не выдумывать правила: если неизвестно, спросить. Решения, принятые самим, перечислять, чтобы Doniyor мог поправить.
- Изменения: коммит и push в main, сразу выкладка (`npx wrangler deploy`). Сборки (если появятся приложения для установки) только по команде «сделай сборку».
- Токены (Cloudflare, Telegram) даёт Doniyor только в чате. В файлы, репозиторий, документы и логи НЕ писать. Секреты Worker ставятся через `wrangler secret put`.
- Ведётся список «Сделаем в будущем» (см. docs/future.md); напоминать, когда работа закончена.
- Анимации плавные в обе стороны. Проверка результата скриншотами (Playwright) перед выкладкой.

## Устройство
- `src/worker.js`: весь бэкенд (вход, /api/sync, курс Ipak Yuli, вебхук /api/in/<WEBHOOK_SECRET>, Telegram /api/tg).
- `public/`: SPA (app.js, app.css), service worker sw.js, manifest. Без внешних CDN и шрифтов, без color-mix().
- D1: структура в `migrations/` (`wrangler d1 migrations apply`), `schema.sql` = разовые правки данных (после миграций), `db/after.sql` = страховка user_id. Синхронизируемые таблицы: spaces, accounts, categories, transactions, budgets, settings (поля updated_at, deleted_at, synced_at; побеждает более новый updated_at).
- Несколько пользователей (с 21.11): у каждой строки данных есть user_id, сервер работает через forUser(env, uid) и видит только строки этого пользователя. Владелец = Doniyor (meta owner_uid, users.role='owner'). Друзья приходят по одноразовой ссылке /join/<код> (Profile › Invite friends, 7 дней). Вебхук: адрес Doniyor = WEBHOOK_SECRET, у остальных users.hook_key. Бот общий, привязка по коду у каждого своя. Разовые SQL-правки для Doniyor: user_id=(SELECT v FROM meta WHERE k='owner_uid').
- Деньги: целые числа в минимальных единицах (сум ×100, центы). Перевод = две операции с общим transfer_group_id, суммы со знаком.
- Секреты Worker: SETUP_KEY (разовое создание пользователя), WEBHOOK_SECRET, TG_TOKEN, TG_SECRET.
- Локально: `.dev.vars` (в .gitignore), `npx wrangler d1 migrations apply expense-tracker --local`, затем `--file=schema.sql`, `npx wrangler dev --local --port 8787`.
- Оставлять запасной адрес *.workers.dev для .uz-доменов.

## Грабли
Смотри стартовый набор: на iPhone внешние CDN дают чёрный экран; D1: индексы на часто читаемые таблицы; CORS-заголовки для своих хедеров.
