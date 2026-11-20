# Нативное iOS-приложение (native/)

- Capacitor 8 (SPM, без CocoaPods), bundle id `uz.inmanager.budget`, iOS 15+. Оболочка грузит живой `https://budget.in-manager.uz` (server.url), поэтому выкладка сайта = обновление приложения. Нет сети при первом запуске: `www/offline.html`.
- Service worker работает за счёт App-Bound Domains (`WKAppBoundDomains` в Info.plist + `ios.limitsNavigationsToAppBoundDomains`). Чужие ссылки (t.me) открываются в Safari.
- User-Agent приложения содержит `BudgetApp/1.0` (можно отличить на сервере).
- Face ID-замок: `ios/App/App/SceneDelegate.swift` (класс AppLock): при запуске и каждом возврате из фона, код iPhone как запасной вариант, заставка в переключателе приложений. Passkey внутри приложения не работает (нужен Associated Domains, его нет у бесплатного Apple ID).
- Статус-бар: белый текст (UIStatusBarStyleLightContent), веб-контент под ним (contentInset never, env(safe-area-inset-*)). Только портрет на iPhone.
- Иконка: `public/icon-512.png`, увеличенная до 1024. Заставка: иконка на #f5f1e8 / #121316.
- Сборка: `.github/workflows/ios.yml` на macOS-раннере GitHub. Push в main с изменениями в native/: проверка сборки + скриншоты из симулятора (артефакт sim-screenshots). Ручной запуск (только по «сделай сборку»): неподписанный `Budget.ipa` в релиз `ios-latest`; AltStore/AltServer подписывает бесплатным Apple ID, продлевает каждые 7 дней.
- Изменил `native/capacitor.config.json` → `cd native && npx cap sync ios` и закоммитить `ios/App/App/capacitor.config.json`.
