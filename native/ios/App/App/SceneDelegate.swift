import UIKit
import Capacitor
import LocalAuthentication
import WidgetKit
import CryptoKit
import CoreImage

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.backgroundColor = Brand.background
        window?.rootViewController = MainViewController()
        window?.makeKeyAndVisible()
        if let window = window { AppLock.shared.attach(to: window) }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        AppLock.shared.becameActive()
        OTA.applyIfReady((scene as? UIWindowScene)?.windows.first?.rootViewController as? CAPBridgeViewController)
        OTA.check()
    }

    func sceneWillResignActive(_ scene: UIScene) {
        AppLock.shared.cover()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        OTA.backgroundAt = Date()
        AppLock.shared.lock()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}


/// Цвета фона как у веб-приложения: без белой/чёрной вспышки до загрузки страницы.
enum Brand {
    static let background = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x12 / 255, green: 0x13 / 255, blue: 0x16 / 255, alpha: 1)
            : UIColor(red: 0xF5 / 255, green: 0xF1 / 255, blue: 0xE8 / 255, alpha: 1)
    }
    static let accent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0xF5 / 255, green: 0xC5 / 255, blue: 0x18 / 255, alpha: 1)
            : UIColor(red: 0x1B / 255, green: 0x2F / 255, blue: 0x5E / 255, alpha: 1)
    }
    static let onAccent = UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0x1A / 255, green: 0x1B / 255, blue: 0x1E / 255, alpha: 1)
            : .white
    }
}

class MainViewController: CAPBridgeViewController {
    // веб-часть: скачанная обновлённая версия (OTA), если она есть и рабочая, иначе встроенная
    override func instanceDescriptor() -> InstanceDescriptor {
        let desc = super.instanceDescriptor()
        if let u = OTA.launchLocation() { desc.appLocation = u }
        return desc
    }

    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.isOpaque = false
        webView?.backgroundColor = Brand.background
        webView?.scrollView.backgroundColor = Brand.background
        // резинка iOS у краёв страницы, как в Safari (Capacitor по умолчанию выключает bounces; Doniyor 21.11)
        webView?.scrollView.bounces = true
        webView?.scrollView.alwaysBounceVertical = true
        webView?.scrollView.alwaysBounceHorizontal = false
        // приложение не масштабируется: ни двойным тапом, ни щипком (Doniyor 21.11)
        webView?.scrollView.minimumZoomScale = 1
        webView?.scrollView.maximumZoomScale = 1
        webView?.scrollView.bouncesZoom = false
        webView?.scrollView.pinchGestureRecognizer?.isEnabled = false
        bridge?.registerPluginInstance(BudgetNativePlugin())
    }
}


/// Замок приложения: Face ID (или код iPhone) при каждом запуске и возврате из фона.
/// Пока приложение в переключателе приложений, содержимое закрыто заставкой.
final class AppLock {
    static let shared = AppLock()

    private weak var window: UIWindow?
    private var shield: UIView?
    private var locked = false
    private var authenticating = false
    private var autoPrompt = false

    /// Face ID / Touch ID / код настроены на iPhone. Без кода замок не включается.
    /// Переключатель в Settings приложения (по умолчанию включён).
    static var enabled: Bool {
        get { UserDefaults.standard.object(forKey: "lockEnabled") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "lockEnabled") }
    }

    private var available: Bool {
        guard AppLock.enabled else { return false }
        var err: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: &err)
    }

    func attach(to window: UIWindow) {
        self.window = window
        lock()
    }

    /// Ушли в фон: при возврате спросим Face ID.
    func lock() {
        guard available else { return }
        locked = true
        autoPrompt = true
        showShield()
    }

    /// Пункт управления, переключатель приложений: экран размывается (дизайн виден, данные нет).
    /// Этот же размытый вид попадает в снимок для списка недавних приложений.
    func cover() {
        showShield()
    }

    func becameActive() {
        if locked {
            // Face ID сразу, поверх размытого экрана; кнопка Unlock появляется, только если отменили или не узнало
            if autoPrompt && !authenticating {
                autoPrompt = false
                authenticate()
            }
        } else {
            hideShield()
        }
    }

    private func authenticate() {
        authenticating = true
        setButton(visible: false)
        let ctx = LAContext()
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Budget") { ok, _ in
            DispatchQueue.main.async {
                self.authenticating = false
                if ok {
                    self.locked = false
                    self.hideShield()
                } else {
                    self.setButton(visible: true)
                }
            }
        }
    }

    @objc private func unlockTapped() {
        if locked && !authenticating { authenticate() }
    }

    // MARK: - Заставка: размытый текущий экран, кнопка Unlock только при необходимости

    private var buttonBox: UIView?

    private func setButton(visible: Bool) {
        guard let b = buttonBox else { return }
        UIView.animate(withDuration: visible ? 0.25 : 0.12, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
            b.alpha = visible ? 1 : 0
            b.transform = visible ? .identity : CGAffineTransform(scaleX: 0.96, y: 0.96)
        }
    }

    private func showShield() {
        guard let window = window else { return }
        if let s = shield {
            // заставка ещё гасла после разблокировки: обновить размытый снимок (экран мог измениться)
            if s.alpha < 1, let iv = s.subviews.first(where: { $0 is UIImageView }) as? UIImageView { iv.image = AppLock.blurredSnapshot(of: window) }
            s.layer.removeAllAnimations()
            s.alpha = 1
            window.bringSubviewToFront(s)
            return
        }
        let s = UIView(frame: window.bounds)
        s.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        s.backgroundColor = .clear

        // снимок текущего экрана, размытый по Гауссу: дизайн и цвета видны, цифры и текст не читаются.
        // (системное размытие UIVisualEffectView в списке недавних приложений превращалось в серый экран)
        s.backgroundColor = Brand.background
        let img = UIImageView(frame: s.bounds)
        img.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        img.contentMode = .scaleAspectFill
        img.image = AppLock.blurredSnapshot(of: window)
        s.addSubview(img)

        let box = UIView()
        box.translatesAutoresizingMaskIntoConstraints = false
        box.alpha = 0
        box.transform = CGAffineTransform(scaleX: 0.96, y: 0.96)
        s.addSubview(box)

        let icon = UIImageView(image: UIImage(named: "LockIcon"))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.layer.cornerRadius = 22
        icon.layer.cornerCurve = .continuous
        icon.clipsToBounds = true
        box.addSubview(icon)

        let button = UIButton(type: .custom)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setTitle("Unlock", for: .normal)
        button.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
        button.setTitleColor(Brand.onAccent, for: .normal)
        button.backgroundColor = Brand.accent
        button.layer.cornerRadius = 24
        button.contentEdgeInsets = UIEdgeInsets(top: 0, left: 32, bottom: 0, right: 32)
        button.addTarget(self, action: #selector(unlockTapped), for: .touchUpInside)
        button.addTarget(self, action: #selector(pressDown(_:)), for: [.touchDown, .touchDragEnter])
        button.addTarget(self, action: #selector(pressUp(_:)), for: [.touchUpInside, .touchUpOutside, .touchCancel, .touchDragExit])
        box.addSubview(button)

        NSLayoutConstraint.activate([
            box.centerXAnchor.constraint(equalTo: s.centerXAnchor),
            box.centerYAnchor.constraint(equalTo: s.centerYAnchor),
            box.widthAnchor.constraint(equalTo: s.widthAnchor),
            icon.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            icon.topAnchor.constraint(equalTo: box.topAnchor),
            icon.widthAnchor.constraint(equalToConstant: 96),
            icon.heightAnchor.constraint(equalToConstant: 96),
            button.centerXAnchor.constraint(equalTo: box.centerXAnchor),
            button.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 32),
            button.heightAnchor.constraint(equalToConstant: 48),
            button.bottomAnchor.constraint(equalTo: box.bottomAnchor)
        ])

        window.addSubview(s)
        shield = s
        buttonBox = box
    }

    private static let ciContext = CIContext(options: nil)

    /// Снимок окна в 1/4 размера и сильное размытие: быстро и надёжно попадает в снимок переключателя приложений.
    static func blurredSnapshot(of window: UIWindow) -> UIImage? {
        guard let root = window.rootViewController?.view, root.bounds.width > 0 else { return nil }
        let scale: CGFloat = 0.25
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = scale
        let shot = UIGraphicsImageRenderer(bounds: root.bounds, format: fmt).image { _ in
            root.drawHierarchy(in: root.bounds, afterScreenUpdates: false)
        }
        guard let cg = shot.cgImage else { return nil }
        let input = CIImage(cgImage: cg)
        let extent = input.extent
        // радиус ~6 px на снимке 1/4 = ~24 pt на экране: крупные блоки и цвета видны, текст нет
        guard let blur = CIFilter(name: "CIGaussianBlur", parameters: [kCIInputImageKey: input.clampedToExtent(), kCIInputRadiusKey: 6.0])?.outputImage?.cropped(to: extent),
              let out = ciContext.createCGImage(blur, from: extent) else { return nil }
        return UIImage(cgImage: out, scale: shot.scale, orientation: .up)
    }

    private func hideShield() {
        guard let s = shield else { return }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
            s.alpha = 0
        }, completion: { finished in
            if finished && self.shield === s && s.alpha == 0 {
                s.removeFromSuperview()
                self.shield = nil
                self.buttonBox = nil
            }
        })
    }

    @objc private func pressDown(_ b: UIButton) {
        UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
            b.transform = CGAffineTransform(scaleX: 0.97, y: 0.97)
            b.alpha = 0.7
        }
    }

    @objc private func pressUp(_ b: UIButton) {
        UIView.animate(withDuration: 0.12, delay: 0, options: [.curveEaseOut, .beginFromCurrentState, .allowUserInteraction]) {
            b.transform = .identity
            b.alpha = 1
        }
    }
}


// MARK: - Общие данные с виджетом (App Group)

enum SharedStore {
    /// AltStore подписывает App Group своим ID и пишет его в Info.plist (ALTAppGroups).
    static var groups: [String] {
        var out = (Bundle.main.object(forInfoDictionaryKey: "ALTAppGroups") as? [String]) ?? []
        out.append("group.uz.inmanager.budget")
        return out
    }
    static func write(_ json: String) {
        for g in groups { UserDefaults(suiteName: g)?.set(json, forKey: "widget") }
        UserDefaults.standard.set(json, forKey: "widget")
    }
}

// MARK: - Мост для веб-части: вибрация, виджет, Face ID, ссылки budget://

@objc(BudgetNativePlugin)
public class BudgetNativePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BudgetNativePlugin"
    public let jsName = "BudgetNative"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "haptic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setWidget", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "takeUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "otaOk", returnType: CAPPluginReturnPromise)
    ]

    private var pendingURL: String?
    private let light = UIImpactFeedbackGenerator(style: .light)
    private let medium = UIImpactFeedbackGenerator(style: .medium)
    private let notify = UINotificationFeedbackGenerator()
    private let select = UISelectionFeedbackGenerator()

    @objc override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(openURL(_:)), name: .capacitorOpenURL, object: nil)
        light.prepare()
    }

    @objc private func openURL(_ n: Notification) {
        guard let obj = n.object as? [String: Any], let url = obj["url"] as? URL, url.scheme == "budget" else { return }
        pendingURL = url.absoluteString
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
            guard let self = self, let u = self.pendingURL else { return }
            self.bridge?.triggerWindowJSEvent(eventName: "budgetopenurl", data: "{\"url\":\"\(u)\"}")
        }
    }

    @objc func takeUrl(_ call: CAPPluginCall) {
        let u = pendingURL
        pendingURL = nil
        call.resolve(["url": u ?? ""])
    }

    @objc func haptic(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            switch call.getString("style") ?? "light" {
            case "medium": self.medium.impactOccurred()
            case "success": self.notify.notificationOccurred(.success)
            case "warning": self.notify.notificationOccurred(.warning)
            case "error": self.notify.notificationOccurred(.error)
            case "select": self.select.selectionChanged()
            default: self.light.impactOccurred()
            }
            call.resolve()
        }
    }

    @objc func setWidget(_ call: CAPPluginCall) {
        guard let json = call.getString("json") else { return call.reject("json required") }
        SharedStore.write(json)
        WidgetCenter.shared.reloadAllTimelines()
        call.resolve()
    }

    @objc func getLock(_ call: CAPPluginCall) {
        call.resolve(["on": AppLock.enabled])
    }

    // экспорт файла (CSV): во встроенном браузере скачивание по ссылке не работает, поэтому файл
    // пишется во временную папку и открывается системное меню «Поделиться» (Сохранить в Файлы, Telegram и т.д.)
    @objc func shareFile(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else { return call.reject("text required") }
        let raw = call.getString("name") ?? "export.txt"
        let name = raw.replacingOccurrences(of: "/", with: "-")
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(name)
        do { try text.write(to: url, atomically: true, encoding: .utf8) } catch { return call.reject("write failed") }
        DispatchQueue.main.async {
            guard let vc = self.bridge?.viewController else { return call.reject("no view") }
            let av = UIActivityViewController(activityItems: [url], applicationActivities: nil)
            if let pop = av.popoverPresentationController {
                pop.sourceView = vc.view
                pop.sourceRect = CGRect(x: vc.view.bounds.midX, y: vc.view.bounds.midY, width: 1, height: 1)
                pop.permittedArrowDirections = []
            }
            av.completionWithItemsHandler = { _, done, _, _ in call.resolve(["done": done]) }
            vc.present(av, animated: true)
        }
    }

    /// Веб-часть загрузилась: текущая версия рабочая. Отвечает, какая версия открыта.
    @objc func otaOk(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            OTA.confirm()
            call.resolve(["v": OTA.current ?? (OTA.version(at: OTA.bundled) ?? "bundled")])
        }
    }

    @objc func setLock(_ call: CAPPluginCall) {
        AppLock.enabled = call.getBool("on") ?? true
        call.resolve(["on": AppLock.enabled])
    }
}


// MARK: - Обновление веб-части без переустановки (OTA)
// Только HTML/JS/CSS/картинки из public/ (по правилам Apple можно; новые нативные возможности так не приходят).
// Сервер отдаёт /ota.json: {"v": версия, "files": {путь: sha256}}. Приложение скачивает новую версию в фоне
// в Library/ota/<v>, проверяет каждый файл по sha256 и включает её при следующем запуске
// (или при возврате, если приложение было в фоне 10+ минут). Если новая версия не дошла до рабочего
// состояния (веб-часть не сообщила otaOk), при следующем запуске открывается прошлая рабочая или встроенная.



enum OTA {
    static let server = URL(string: "https://budget.in-manager.uz")!
    static let fallback = URL(string: "https://expense-tracker.in-manager.workers.dev")!
    static let d = UserDefaults.standard
    static var root: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].appendingPathComponent("ota", isDirectory: true)
    }
    static var bundled: URL? { Bundle.main.url(forResource: "public", withExtension: nil) }
    static private(set) var current: String? = nil   // версия OTA, которая сейчас открыта (nil = встроенная)
    static var busy = false
    static var backgroundAt: Date?

    static func version(at dir: URL?) -> String? {
        guard let dir = dir, let data = try? Data(contentsOf: dir.appendingPathComponent("ota.json")),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return j["v"] as? String
    }
    static func files(at dir: URL?) -> [String: String] {
        guard let dir = dir, let data = try? Data(contentsOf: dir.appendingPathComponent("ota.json")),
              let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return (j["files"] as? [String: String]) ?? [:]
    }
    static var bad: [String] { d.stringArray(forKey: "otaBad") ?? [] }
    static func markBad(_ v: String) { d.set(Array((bad + [v]).suffix(20)), forKey: "otaBad") }
    static func dir(_ v: String) -> URL { root.appendingPathComponent(v, isDirectory: true) }
    static func usable(_ v: String?) -> Bool {
        guard let v = v, !bad.contains(v) else { return false }
        return FileManager.default.fileExists(atPath: dir(v).appendingPathComponent("index.html").path)
    }

    /// Какую папку открыть при запуске. nil = встроенная в приложение.
    static func launchLocation() -> URL? {
        // новая установка из Mac со своей встроенной версией: прошлые OTA-версии больше не нужны
        let bv = version(at: bundled) ?? "none"
        let binKey = bv + "|" + (Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "")
        if d.string(forKey: "otaBinary") != binKey {
            d.set(binKey, forKey: "otaBinary")
            for k in ["otaGood", "otaReady", "otaTrying", "otaBad"] { d.removeObject(forKey: k) }
            try? FileManager.default.removeItem(at: root)
            return nil
        }
        // прошлый запуск новой версии не подтвердился (веб-часть не загрузилась) — эта версия плохая
        if let t = d.string(forKey: "otaTrying") {
            d.removeObject(forKey: "otaTrying")
            markBad(t)
            if d.string(forKey: "otaReady") == t { d.removeObject(forKey: "otaReady") }
            if d.string(forKey: "otaGood") == t { d.removeObject(forKey: "otaGood") }
        }
        if let r = d.string(forKey: "otaReady"), usable(r) { return start(r) }
        if let g = d.string(forKey: "otaGood"), usable(g) { current = g; return dir(g) }
        return nil
    }
    private static func start(_ v: String) -> URL {
        d.set(v, forKey: "otaTrying"); current = v; return dir(v)
    }

    /// Веб-часть загрузилась и работает: эта версия становится рабочей.
    static func confirm() {
        guard let v = current else { return }
        d.removeObject(forKey: "otaTrying")
        d.set(v, forKey: "otaGood")
        if d.string(forKey: "otaReady") == v { d.removeObject(forKey: "otaReady") }
        cleanup()
    }
    private static func cleanup() {
        let keep = Set([d.string(forKey: "otaGood"), d.string(forKey: "otaReady"), current].compactMap { $0 })
        let items = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
        for n in items where !keep.contains(n) { try? FileManager.default.removeItem(at: root.appendingPathComponent(n)) }
    }

    /// Возврат из фона: если готова новая версия и приложение долго было в фоне — включить её сразу.
    static func applyIfReady(_ vc: CAPBridgeViewController?) {
        defer { backgroundAt = nil }
        guard let since = backgroundAt, Date().timeIntervalSince(since) >= 600,
              let r = d.string(forKey: "otaReady"), r != current, usable(r), let vc = vc else { return }
        let u = start(r)
        vc.setServerBasePath(path: u.path)
        vc.webView?.reload()
    }

    /// Проверить сервер и скачать новую версию в фоне.
    static func check() {
        guard !busy else { return }
        busy = true
        Task.detached(priority: .utility) {
            defer { OTA.busy = false }
            for base in [OTA.server, OTA.fallback] {
                if await OTA.fetch(base) { return }
            }
        }
    }

    private static func get(_ url: URL) async -> Data? {
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 20)
        req.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
        guard let r = try? await URLSession.shared.data(for: req),
              (r.1 as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return r.0
    }
    private static func sha(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    /// true = сервер ответил (обновление скачано или не нужно), false = сервер недоступен.
    static func fetch(_ base: URL) async -> Bool {
        let stamp = String(Int(Date().timeIntervalSince1970))
        guard let mdata = await get(URL(string: base.absoluteString + "/ota.json?t=" + stamp)!),
              let j = try? JSONSerialization.jsonObject(with: mdata) as? [String: Any],
              let v = j["v"] as? String, let want = j["files"] as? [String: String], !want.isEmpty,
              v.range(of: "^[a-f0-9]{8,64}$", options: .regularExpression) != nil else { return false }
        let have = current ?? version(at: bundled)
        if v == have || v == d.string(forKey: "otaReady") || bad.contains(v) { return true }

        let fm = FileManager.default
        let tmp = root.appendingPathComponent("tmp-" + v, isDirectory: true)
        try? fm.removeItem(at: tmp)
        guard (try? fm.createDirectory(at: tmp, withIntermediateDirectories: true)) != nil else { return true }
        // файлы, которые не изменились, берём из открытой сейчас версии (меньше трафика)
        let srcDir = current.map { dir($0) } ?? bundled
        let srcFiles = files(at: srcDir)
        for (path, hash) in want {
            guard !path.contains(".."), !path.hasPrefix("/") else { try? fm.removeItem(at: tmp); return true }
            let dst = tmp.appendingPathComponent(path)
            try? fm.createDirectory(at: dst.deletingLastPathComponent(), withIntermediateDirectories: true)
            var data: Data? = nil
            if srcFiles[path] == hash, let s = srcDir, let local = try? Data(contentsOf: s.appendingPathComponent(path)), sha(local) == hash {
                data = local
            } else {
                let enc = path.split(separator: "/").map { String($0).addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? String($0) }.joined(separator: "/")
                data = await get(URL(string: base.absoluteString + "/" + enc + "?v=" + v)!)
            }
            // любой файл не скачался или не совпал по sha256 — версия не включается
            guard let ok = data, sha(ok) == hash, (try? ok.write(to: dst)) != nil else {
                try? fm.removeItem(at: tmp); return true
            }
        }
        guard (try? mdata.write(to: tmp.appendingPathComponent("ota.json"))) != nil else { try? fm.removeItem(at: tmp); return true }
        let final = dir(v)
        try? fm.removeItem(at: final)
        guard (try? fm.moveItem(at: tmp, to: final)) != nil else { try? fm.removeItem(at: tmp); return true }
        d.set(v, forKey: "otaReady")
        return true
    }
}
