import AuthenticationServices
import UIKit

// Phase 3 autofill go/no-go probe: a minimal AutoFill Credential Provider Extension.
// It holds no real credentials. It exists only to retire three unknowns before the real
// provider is built:
//   1. does a hand-added app-extension target survive `cap sync`,
//   2. can the extension read data the main app wrote to a shared App Group (the channel
//      the real provider uses to reach the vault), and
//   3. does iOS list it under Settings > Passwords > AutoFill and launch it.
// See docs/mobile-port.md "OS-level autofill".
class CredentialProviderViewController: ASCredentialProviderViewController {
	private let appGroup = "group.app.bramble.mobile"
	private let probeKey = "probe.sharedValue"

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground

		let shared =
			UserDefaults(suiteName: appGroup)?.string(forKey: probeKey) ?? "<nothing read from App Group>"
		NSLog("[AutoFillProbe] App Group %@ -> %@", appGroup, shared)

		let label = UILabel()
		label.numberOfLines = 0
		label.textAlignment = .center
		label.font = .preferredFont(forTextStyle: .body)
		label.text = "Bramble AutoFill probe\n\nRead from the shared App Group:\n\n\(shared)"
		label.translatesAutoresizingMaskIntoConstraints = false
		view.addSubview(label)
		NSLayoutConstraint.activate([
			label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
			label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
			label.leadingAnchor.constraint(greaterThanOrEqualTo: view.leadingAnchor, constant: 24),
			label.trailingAnchor.constraint(lessThanOrEqualTo: view.trailingAnchor, constant: -24),
		])

		navigationItem.leftBarButtonItem = UIBarButtonItem(
			barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
	}

	@objc private func cancelTapped() {
		let err = NSError(
			domain: ASExtensionErrorDomain, code: ASExtensionError.Code.userCanceled.rawValue)
		extensionContext.cancelRequest(withError: err)
	}

	// We hold no credentials, so the silent fast-path always defers to the UI.
	override func provideCredentialWithoutUserInteraction(
		for credentialIdentity: ASPasswordCredentialIdentity
	) {
		let err = NSError(
			domain: ASExtensionErrorDomain,
			code: ASExtensionError.Code.userInteractionRequired.rawValue)
		extensionContext.cancelRequest(withError: err)
	}
}
