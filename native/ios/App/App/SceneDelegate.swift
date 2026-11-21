import UIKit
import Capacitor
import LocalAuthentication
import WidgetKit

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
    }

    func sceneWillResignActive(_ scene: UIScene) {
        AppLock.shared.cover()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
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
    override func capacitorDidLoad() {
        super.capacitorDidLoad()
        webView?.isOpaque = false
        webView?.backgroundColor = Brand.background
        webView?.scrollView.backgroundColor = Brand.background
        // резинка iOS у краёв страницы, как в Safari (Capacitor по умолчанию выключает bounces; Doniyor 21.11)
        webView?.scrollView.bounces = true
        webView?.scrollView.alwaysBounceVertical = true
        webView?.scrollView.alwaysBounceHorizontal = false
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
            s.layer.removeAllAnimations()
            s.alpha = 1
            window.bringSubviewToFront(s)
            return
        }
        let s = UIView(frame: window.bounds)
        s.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        s.backgroundColor = .clear

        // два слоя размытия: раскладка и цвета видны, цифры и текст не читаются
        for style in [UIBlurEffect.Style.systemMaterial, .systemThinMaterial] {
            let blur = UIVisualEffectView(effect: UIBlurEffect(style: style))
            blur.frame = s.bounds
            blur.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            s.addSubview(blur)
        }

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
        CAPPluginMethod(name: "shareFile", returnType: CAPPluginReturnPromise)
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

    @objc func setLock(_ call: CAPPluginCall) {
        AppLock.enabled = call.getBool("on") ?? true
        call.resolve(["on": AppLock.enabled])
    }
}
