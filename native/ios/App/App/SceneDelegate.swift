import UIKit
import Capacitor
import LocalAuthentication

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
    private var available: Bool {
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

    /// Пункт управления, переключатель приложений: только закрыть содержимое.
    func cover() {
        showShield()
    }

    func becameActive() {
        if locked {
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
        let ctx = LAContext()
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "Unlock Budget") { ok, _ in
            DispatchQueue.main.async {
                self.authenticating = false
                if ok {
                    self.locked = false
                    self.hideShield()
                }
            }
        }
    }

    @objc private func unlockTapped() {
        if locked && !authenticating { authenticate() }
    }

    // MARK: - Заставка

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
        s.backgroundColor = Brand.background

        let icon = UIImageView(image: UIImage(named: "LockIcon"))
        icon.translatesAutoresizingMaskIntoConstraints = false
        icon.layer.cornerRadius = 22
        icon.layer.cornerCurve = .continuous
        icon.clipsToBounds = true
        s.addSubview(icon)

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
        s.addSubview(button)

        NSLayoutConstraint.activate([
            icon.centerXAnchor.constraint(equalTo: s.centerXAnchor),
            icon.centerYAnchor.constraint(equalTo: s.centerYAnchor, constant: -40),
            icon.widthAnchor.constraint(equalToConstant: 96),
            icon.heightAnchor.constraint(equalToConstant: 96),
            button.centerXAnchor.constraint(equalTo: s.centerXAnchor),
            button.topAnchor.constraint(equalTo: icon.bottomAnchor, constant: 32),
            button.heightAnchor.constraint(equalToConstant: 48)
        ])

        window.addSubview(s)
        shield = s
    }

    private func hideShield() {
        guard let s = shield else { return }
        UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
            s.alpha = 0
        }, completion: { finished in
            if finished && self.shield === s && s.alpha == 0 {
                s.removeFromSuperview()
                self.shield = nil
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
