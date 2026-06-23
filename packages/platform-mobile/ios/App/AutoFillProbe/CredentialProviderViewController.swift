import AuthenticationServices
import Security
import UIKit

// AutoFill Credential Provider. Lists the vault's logins from the shared App Group,
// then on a tap obtains the VEK and decrypts the chosen password natively via the
// shared Rust core (VaultCryptoFFI). Two ways to get the VEK, in order:
//   1. a biometric/passcode-cached VEK (the in-app "biometric unlock" item, gated by
//      Face ID OR device passcode) — the fast path, no typing.
//   2. the master password: the app shares the (non-secret) password slot, so the
//      extension runs Argon2id itself and unwraps the VEK. The Bitwarden-style flow,
//      works with no biometrics set up.
// Passwords are never stored in cleartext; the slot's wrappedVek stays AES-encrypted.
// docs/mobile-port.md "OS-level autofill".

private struct Cred {
	let recordId: String
	let name: String
	let username: String
	let iv: String
	let ciphertext: String
	let services: [String]
}

private struct Slot {
	let salt: String
	let slotId: String
	let verifier: String
	let wrapIv: String
	let wrappedVek: String
	let magicVersion: Data
}

private func initials(_ s: String) -> String {
	let words = s.split(whereSeparator: { $0 == " " || $0 == "." })
	let chars: [Character] =
		words.count >= 2 ? [words[0].first, words[1].first].compactMap { $0 } : Array(s.prefix(2))
	return String(chars).uppercased()
}

// Row styled to resemble the in-app vault list: initials chip + name + username.
private final class CredCell: UITableViewCell {
	private let chip = UILabel()
	private let titleLabel = UILabel()
	private let subtitleLabel = UILabel()

	override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
		super.init(style: style, reuseIdentifier: reuseIdentifier)
		chip.textAlignment = .center
		chip.font = .systemFont(ofSize: 15, weight: .semibold)
		chip.textColor = .label
		chip.backgroundColor = UIColor(white: 0.26, alpha: 1)
		chip.layer.cornerRadius = 10
		chip.layer.masksToBounds = true
		titleLabel.font = .systemFont(ofSize: 16, weight: .semibold)
		titleLabel.textColor = .label
		subtitleLabel.font = .systemFont(ofSize: 14)
		subtitleLabel.textColor = .secondaryLabel
		let text = UIStackView(arrangedSubviews: [titleLabel, subtitleLabel])
		text.axis = .vertical
		text.spacing = 2
		[chip, text].forEach {
			$0.translatesAutoresizingMaskIntoConstraints = false
			contentView.addSubview($0)
		}
		NSLayoutConstraint.activate([
			chip.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 12),
			chip.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
			chip.widthAnchor.constraint(equalToConstant: 40),
			chip.heightAnchor.constraint(equalToConstant: 40),
			text.leadingAnchor.constraint(equalTo: chip.trailingAnchor, constant: 12),
			text.trailingAnchor.constraint(lessThanOrEqualTo: contentView.trailingAnchor, constant: -12),
			text.centerYAnchor.constraint(equalTo: contentView.centerYAnchor),
			contentView.heightAnchor.constraint(greaterThanOrEqualToConstant: 64),
		])
	}
	required init?(coder: NSCoder) { fatalError() }

	func configure(_ c: Cred) {
		titleLabel.text = c.name
		subtitleLabel.text = c.username
		chip.text = initials(c.name)
	}
}

// Master-password unlock sheet. Collects the password and reports it via onUnlock; the
// presenter runs Argon2id and either dismisses (success) or calls showError to retry.
private final class MasterPasswordViewController: UIViewController, UITextFieldDelegate {
	var onUnlock: ((String) -> Void)?
	var onCancel: (() -> Void)?
	private let field = UITextField()
	private let unlockButton = UIButton(type: .system)
	private let spinner = UIActivityIndicatorView(style: .medium)
	private let errorLabel = UILabel()
	private let prompt: String

	init(prompt: String) {
		self.prompt = prompt
		super.init(nibName: nil, bundle: nil)
	}
	required init?(coder: NSCoder) { fatalError() }

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground

		let cancel = UIButton(type: .system)
		cancel.setTitle("Cancel", for: .normal)
		cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

		let title = UILabel()
		title.text = prompt
		title.font = .preferredFont(forTextStyle: .headline)
		title.textAlignment = .center

		field.placeholder = "Master password"
		field.isSecureTextEntry = true
		field.borderStyle = .roundedRect
		field.autocapitalizationType = .none
		field.autocorrectionType = .no
		field.returnKeyType = .go
		field.delegate = self

		unlockButton.setTitle("Unlock", for: .normal)
		unlockButton.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
		unlockButton.addTarget(self, action: #selector(unlockTapped), for: .touchUpInside)

		errorLabel.textColor = .systemRed
		errorLabel.font = .preferredFont(forTextStyle: .footnote)
		errorLabel.numberOfLines = 0
		errorLabel.textAlignment = .center

		let stack = UIStackView(arrangedSubviews: [title, field, unlockButton, errorLabel, spinner])
		stack.axis = .vertical
		stack.spacing = 16
		[cancel, stack].forEach {
			$0.translatesAutoresizingMaskIntoConstraints = false
			view.addSubview($0)
		}
		let g = view.safeAreaLayoutGuide
		NSLayoutConstraint.activate([
			cancel.topAnchor.constraint(equalTo: g.topAnchor, constant: 8),
			cancel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
			stack.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 24),
			stack.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -24),
			stack.topAnchor.constraint(equalTo: g.topAnchor, constant: 64),
		])
	}

	override func viewDidAppear(_ animated: Bool) {
		super.viewDidAppear(animated)
		field.becomeFirstResponder()
	}

	func textFieldShouldReturn(_ textField: UITextField) -> Bool {
		unlockTapped()
		return true
	}

	@objc private func unlockTapped() {
		errorLabel.text = nil
		setBusy(true)
		onUnlock?(field.text ?? "")
	}

	@objc private func cancelTapped() { onCancel?() }

	func showError(_ message: String) {
		setBusy(false)
		errorLabel.text = message
		field.becomeFirstResponder()
	}

	private func setBusy(_ busy: Bool) {
		busy ? spinner.startAnimating() : spinner.stopAnimating()
		field.isEnabled = !busy
		unlockButton.isEnabled = !busy
	}
}

class CredentialProviderViewController: ASCredentialProviderViewController, UITableViewDataSource,
	UITableViewDelegate
{
	private let appGroup = "group.app.bramble.mobile"
	private let secretsKey = "autofill.secrets"
	private let slotKey = "autofill.slot"
	private let keychainService = "app.bramble.mobile.biometric-vault"
	private let keychainAccount = "vek"
	private let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	private enum VekOutcome { case ok(String), missing, denied(String) }

	private var creds: [Cred] = []
	private let table = UITableView(frame: .zero, style: .insetGrouped)
	private let emptyLabel = UILabel()

	// JSON blobs written by AutofillBridge (App-side). JSON avoids the plist
	// array-of-dicts cast that can silently fail across the process boundary.
	private func loadCreds() -> [Cred] {
		guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: secretsKey),
			let raw = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]]
		else { return [] }
		return raw.compactMap { d in
			guard let recordId = d["recordId"] as? String, let username = d["username"] as? String,
				let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String
			else { return nil }
			return Cred(
				recordId: recordId, name: (d["name"] as? String) ?? username, username: username,
				iv: iv, ciphertext: ct, services: (d["services"] as? [String]) ?? [])
		}
	}

	private func loadSlot() -> Slot? {
		guard let data = UserDefaults(suiteName: appGroup)?.data(forKey: slotKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let salt = d["saltB64"] as? String, let slotId = d["slotIdB64"] as? String,
			let verifier = d["verifierB64"] as? String, let wrapIv = d["wrapIvB64"] as? String,
			let wrapped = d["wrappedVekB64"] as? String, let mvB64 = d["magicVersionB64"] as? String,
			let mv = Data(base64Encoded: mvB64)
		else { return nil }
		return Slot(
			salt: salt, slotId: slotId, verifier: verifier, wrapIv: wrapIv, wrappedVek: wrapped,
			magicVersion: mv)
	}

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .systemBackground

		let header = UIView()
		let titleLabel = UILabel()
		titleLabel.text = "Bramble"
		titleLabel.font = .preferredFont(forTextStyle: .headline)
		let cancel = UIButton(type: .system)
		cancel.setTitle("Cancel", for: .normal)
		cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
		[header, titleLabel, cancel, table, emptyLabel].forEach {
			$0.translatesAutoresizingMaskIntoConstraints = false
		}
		header.addSubview(titleLabel)
		header.addSubview(cancel)
		view.addSubview(header)
		view.addSubview(table)
		view.addSubview(emptyLabel)

		table.dataSource = self
		table.delegate = self
		table.backgroundColor = .clear
		table.rowHeight = UITableView.automaticDimension
		table.estimatedRowHeight = 64
		table.register(CredCell.self, forCellReuseIdentifier: "cred")

		emptyLabel.numberOfLines = 0
		emptyLabel.textAlignment = .center
		emptyLabel.textColor = .secondaryLabel
		emptyLabel.font = .preferredFont(forTextStyle: .footnote)

		let g = view.safeAreaLayoutGuide
		NSLayoutConstraint.activate([
			header.topAnchor.constraint(equalTo: g.topAnchor),
			header.leadingAnchor.constraint(equalTo: g.leadingAnchor),
			header.trailingAnchor.constraint(equalTo: g.trailingAnchor),
			header.heightAnchor.constraint(equalToConstant: 44),
			titleLabel.leadingAnchor.constraint(equalTo: header.leadingAnchor, constant: 16),
			titleLabel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
			cancel.trailingAnchor.constraint(equalTo: header.trailingAnchor, constant: -16),
			cancel.centerYAnchor.constraint(equalTo: header.centerYAnchor),
			table.topAnchor.constraint(equalTo: header.bottomAnchor),
			table.leadingAnchor.constraint(equalTo: g.leadingAnchor),
			table.trailingAnchor.constraint(equalTo: g.trailingAnchor),
			table.bottomAnchor.constraint(equalTo: g.bottomAnchor),
			emptyLabel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
			emptyLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
			emptyLabel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 24),
			emptyLabel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -24),
		])
	}

	private func render() {
		table.reloadData()
		emptyLabel.isHidden = !creds.isEmpty
		if creds.isEmpty {
			let ud = UserDefaults(suiteName: appGroup)
			let bytes = ud?.data(forKey: secretsKey)?.count ?? 0
			emptyLabel.text =
				"No logins to fill.\n\nApp Group reachable: \(ud != nil)\nStored blob: \(bytes) bytes\n\n"
				+ "Open Bramble and unlock the vault once so it can sync your logins for autofill."
			NSLog("[AutoFill] empty list. appGroupReachable=%@ blobBytes=%d", String(ud != nil), bytes)
		}
	}

	// --- credential list UI ---

	override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		let wanted = serviceIdentifiers.map { $0.identifier.lowercased() }
		let all = loadCreds()
		NSLog("[AutoFill] prepareCredentialList wanted=%@ loaded=%d", wanted.description, all.count)
		func matches(_ c: Cred) -> Bool {
			c.services.contains { svc in
				let s = svc.lowercased()
				return wanted.contains { w in s == w || s.hasSuffix("." + w) || w.hasSuffix("." + s) }
			}
		}
		creds = all.sorted { (matches($0) ? 0 : 1) < (matches($1) ? 0 : 1) }
		render()
	}

	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		let all = loadCreds()
		let match = all.filter { $0.recordId == credentialIdentity.recordIdentifier }
		creds = match.isEmpty ? all : match
		render()
	}

	override func provideCredentialWithoutUserInteraction(
		for credentialIdentity: ASPasswordCredentialIdentity
	) {
		cancel(.userInteractionRequired)
	}

	// --- table ---

	func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { creds.count }

	func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
		let cell = tableView.dequeueReusableCell(withIdentifier: "cred", for: indexPath)
		(cell as? CredCell)?.configure(creds[indexPath.row])
		return cell
	}

	func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
		tableView.deselectRow(at: indexPath, animated: true)
		fill(creds[indexPath.row])
	}

	// --- unlock + decrypt + complete ---

	private func fill(_ cred: Cred) {
		// Fast path: a cached VEK (Face ID / passcode). Falls back to the master password.
		if vekExists() {
			readVek(reason: "Unlock to fill \(cred.username)") { [weak self] outcome in
				DispatchQueue.main.async {
					guard let self = self else { return }
					switch outcome {
					case .ok(let vek):
						do {
							try unlockWithVek(vekB64: vek)
							self.decryptAndComplete(cred)
						} catch { self.showError("Couldn't unlock", error.localizedDescription) }
					case .missing:
						self.promptPassword(for: cred)
					case .denied(let msg):
						self.showError("Couldn't unlock", msg)
					}
				}
			}
		} else {
			promptPassword(for: cred)
		}
	}

	// Master-password unlock: run Argon2id off the main thread, unwrap the VEK, fill.
	private func promptPassword(for cred: Cred) {
		guard let slot = loadSlot() else {
			showError(
				"Can't unlock here",
				"This vault has no master password set, or it hasn't been synced yet. Open Bramble and "
					+ "unlock it once, then try again.")
			return
		}
		let vc = MasterPasswordViewController(prompt: cred.name)
		vc.onCancel = { [weak vc, weak self] in vc?.dismiss(animated: true); self?.cancel(.userCanceled) }
		vc.onUnlock = { [weak self, weak vc] password in
			DispatchQueue.global(qos: .userInitiated).async {
				do {
					let ok = try unwrapVekPassword(
						password: password, saltB64: slot.salt, slotIdB64: slot.slotId,
						verifierB64: slot.verifier, wrapIvB64: slot.wrapIv, wrappedVekB64: slot.wrappedVek,
						magicVersion: slot.magicVersion)
					DispatchQueue.main.async {
						guard let self = self else { return }
						if ok {
							vc?.dismiss(animated: true) { self.decryptAndComplete(cred) }
						} else {
							vc?.showError("Incorrect master password")
						}
					}
				} catch {
					DispatchQueue.main.async { vc?.showError(error.localizedDescription) }
				}
			}
		}
		vc.modalPresentationStyle = .fullScreen
		present(vc, animated: true)
	}

	// The VEK is loaded in the native core by this point; decrypt the chosen secret.
	private func decryptAndComplete(_ cred: Cred) {
		do {
			let password = try decryptWithVek(ivB64: cred.iv, ciphertextB64: cred.ciphertext)
			extensionContext.completeRequest(
				withSelectedCredential: ASPasswordCredential(user: cred.username, password: password),
				completionHandler: nil)
		} catch { showError("Couldn't decrypt", error.localizedDescription) }
	}

	// Presence check that never prompts: is a cached VEK available at all?
	private func vekExists() -> Bool {
		let q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: keychainService,
			kSecAttrAccount as String: keychainAccount,
			kSecAttrAccessGroup as String: accessGroup,
			kSecReturnData as String: false,
			kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		let status = SecItemCopyMatching(q as CFDictionary, nil)
		return status == errSecSuccess || status == errSecInteractionNotAllowed
	}

	// Read the cached VEK. Its `.userPresence` access control makes SecItemCopyMatching
	// present Face ID or the device passcode; run off the main thread since it blocks.
	private func readVek(reason: String, completion: @escaping (VekOutcome) -> Void) {
		DispatchQueue.global(qos: .userInitiated).async {
			let query: [String: Any] = [
				kSecClass as String: kSecClassGenericPassword,
				kSecAttrService as String: self.keychainService,
				kSecAttrAccount as String: self.keychainAccount,
				kSecAttrAccessGroup as String: self.accessGroup,
				kSecReturnData as String: true,
				kSecMatchLimit as String: kSecMatchLimitOne,
				kSecUseOperationPrompt as String: reason,
			]
			var item: CFTypeRef?
			let status = SecItemCopyMatching(query as CFDictionary, &item)
			NSLog("[AutoFill] keychain read status=%d", status)
			if status == errSecSuccess, let data = item as? Data,
				let secret = String(data: data, encoding: .utf8)
			{
				completion(.ok(secret))
			} else if status == errSecItemNotFound {
				completion(.missing)
			} else {
				completion(.denied("Keychain status \(status)"))
			}
		}
	}

	private func showError(_ title: String, _ message: String) {
		let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
			self?.cancel(.userCanceled)
		})
		present(alert, animated: true)
	}

	@objc private func cancelTapped() { cancel(.userCanceled) }

	private func cancel(_ code: ASExtensionError.Code) {
		extensionContext.cancelRequest(
			withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
	}
}
