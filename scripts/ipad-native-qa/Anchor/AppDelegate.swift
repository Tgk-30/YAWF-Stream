import UIKit

@main
@MainActor
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let configuration = UISceneConfiguration(name: "Native QA", sessionRole: session.role)
        configuration.delegateClass = SceneDelegate.self
        return configuration
    }
}

@MainActor
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        let window = UIWindow(windowScene: scene)
        window.rootViewController = CounterViewController()
        self.window = window
        window.makeKeyAndVisible()
    }
}

@MainActor
final class CounterViewController: UIViewController {
    private var count = 0
    private let valueLabel = UILabel()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground
        let title = UILabel()
        title.text = "Disposable iPad native input control"
        title.font = .preferredFont(forTextStyle: .headline)
        valueLabel.accessibilityIdentifier = "qa.counter.value"
        valueLabel.font = .preferredFont(forTextStyle: .title1)
        let button = UIButton(type: .system)
        button.setTitle("Tap counter", for: .normal)
        button.accessibilityIdentifier = "qa.counter.increment"
        button.addTarget(self, action: #selector(increment), for: .primaryActionTriggered)
        button.heightAnchor.constraint(greaterThanOrEqualToConstant: 48).isActive = true
        let stack = UIStackView(arrangedSubviews: [title, valueLabel, button])
        stack.axis = .vertical
        stack.spacing = 24
        stack.alignment = .center
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerXAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -24)
        ])
        updateLabel()
    }

    @objc private func increment() { count += 1; updateLabel() }

    private func updateLabel() {
        valueLabel.text = "Counter: \(count)"
        valueLabel.accessibilityValue = String(count)
    }
}
