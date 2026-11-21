# Нативное iOS-приложение (native/)

- Capacitor 8 (SPM, без CocoaPods), bundle id `uz.inmanager.budget`, iOS 15+.
- Код приложения ВНУТРИ .ipa: `webDir = ../public` (тот же SPA, что и PWA). Работает без сети: данные в IndexedDB на устройстве, изменения копятся в очереди и уходят в `/api/sync` при появлении сети (побеждает более новый updated_at).
- Изменения интерфейса попадают в приложение только с новой сборкой («сделай сборку»). Doniyor согласен (20.11). Сайт/PWA обновляются как раньше.
- В app.js: `NATIVE = location.protocol === 'capacitor:'`, запросы на `https://budget.in-manager.uz/api/...` с заголовками `x-client: native` и `Authorization: Bearer <token>` (токен из ответа /api/login, хранится в localStorage `ntok`). При 401 в приложении данные НЕ стираются, только экран входа. Service worker, passkey и выбор иконки в приложении отключены.
- В worker.js: CORS для Origin `capacitor://localhost` (preflight OPTIONS), `authed()` принимает Bearer или cookie.
- Face ID-замок: `ios/App/App/SceneDelegate.swift` (AppLock): при запуске и каждом возврате из фона, код iPhone как запасной вариант, заставка в переключателе приложений. Passkey внутри приложения не работает (нужен Associated Domains, его нет у бесплатного Apple ID).
- Статус-бар: белый текст, контент под ним (contentInset never). Только портрет. Иконка: `public/icon-512.png` → 1024. Заставка: иконка на #f5f1e8 / #121316.
- Сборка: `.github/workflows/ios.yml` на macOS-раннере. Push в main с изменениями в native/ или public/: проверка сборки + скриншоты симулятора. Ручной запуск (только по «сделай сборку»): неподписанный `Budget.ipa` в релиз `ios-latest`; AltServer/AltStore подписывает бесплатным Apple ID и продлевает каждые 7 дней.
- Нативный мост `BudgetNative` (в SceneDelegate.swift): `haptic` (Taptic Engine), `setWidget` (JSON в App Group + перерисовка виджета), `getLock`/`setLock` (переключатель Face ID в Settings), `takeUrl` (ссылки `budget://add` из виджета открывают новую операцию). В JS: `nat(method, opts)`.
- Виджет `BudgetWidget/` (iOS 17+): маленький и средний, данные Personal, строки готовит app.js (`pushWidget`, скрытые суммы = *****). App Group `group.uz.inmanager.budget`; AltStore переименовывает группу и пишет её в `ALTAppGroups` в Info.plist, код читает оттуда. В CI .ipa подписан ad-hoc только чтобы вложить entitlements.
- Вход в приложении: сессия 30 дней (`NATIVE_SESSION` в worker.js), сайт 12 часов.
