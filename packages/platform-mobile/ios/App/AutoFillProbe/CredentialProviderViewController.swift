import AuthenticationServices
import Security
import UIKit

// AutoFill Credential Provider: lists the vault's logins, and on a tap reads the
// biometric-gated VEK the main app cached in the shared Keychain (Face ID) and
// decrypts the chosen password natively via the shared Rust core (VaultCryptoFFI) —
// no Argon2id, which would not fit the extension's ~120 MB cap. The main app writes
// each login's encrypted password + (name, service, username) to the shared App Group
// and populates ASCredentialIdentityStore (AutofillBridge.swift). docs/mobile-port.md.

private struct Cred {
	let recordId: String
	let name: String
	let username: String
	let iv: String
	let ciphertext: String
	let services: [String]
}

private func initials(_ s: String) -> String {
	let words = s.split(whereSeparator: { $0 == " " || $0 == "." })
	let chars: [Character]
	if words.count >= 2 {
		chars = [words[0].first, words[1].first].compactMap { $0 }
	} else {
		chars = Array(s.prefix(2))
	}
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

class CredentialProviderViewController: ASCredentialProviderViewController, UITableViewDataSource,
	UITableViewDelegate
{
	private let appGroup = "group.app.bramble.mobile"
	private let secretsKey = "autofill.secrets"
	private let keychainService = "app.bramble.mobile.biometric-vault"
	private let keychainAccount = "vek"
	private let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	private enum VekOutcome { case ok(String), missing, denied(String) }

	private var creds: [Cred] = []
	private let table = UITableView(frame: .zero, style: .insetGrouped)
	private let emptyLabel = UILabel()

	// JSON blob written by AutofillBridge (App-side). JSON avoids the plist
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

	// QuickType pick of a specific identity: show that record (tap confirms with Face ID).
	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		let all = loadCreds()
		let match = all.filter { $0.recordId == credentialIdentity.recordIdentifier }
		creds = match.isEmpty ? all : match
		NSLog("[AutoFill] prepareInterface record=%@ loaded=%d shown=%d",
			credentialIdentity.recordIdentifier ?? "nil", all.count, creds.count)
		render()
	}

	// No silent fill: a fill needs the biometric VEK read, so defer to UI.
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

	// --- decrypt + complete (Face ID runs here: user-initiated, so foregrounded) ---

	private func fill(_ cred: Cred) {
		readVek(reason: "Unlock to fill \(cred.username)") { [weak self] outcome in
			DispatchQueue.main.async {
				guard let self = self else { return }
				switch outcome {
				case .missing:
					self.showNeedsBiometric()
				case .denied(let msg):
					// Surface the failure instead of dismissing silently, so the cause is
					// visible on-device (cancel, lockout, no enrolled biometrics, ...).
					self.showError("Couldn't unlock", msg)
				case .ok(let vek):
					do {
						try unlockWithVek(vekB64: vek)
						let password = try decryptWithVek(ivB64: cred.iv, ciphertextB64: cred.ciphertext)
						self.extensionContext.completeRequest(
							withSelectedCredential: ASPasswordCredential(user: cred.username, password: password),
							completionHandler: nil)
					} catch {
						self.showError("Couldn't decrypt", error.localizedDescription)
					}
				}
			}
		}
	}

	// Read the biometric-gated VEK from the shared Keychain. The item's
	// `.biometryCurrentSet` access control makes SecItemCopyMatching itself present
	// Face ID (no separate LAContext, which can fail to present inside an extension);
	// `kSecUseOperationPrompt` sets the reason. Runs off the main thread since the
	// call blocks while the prompt is up.
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
			NSLog("[AutoFill] keychain read status=%d group=%@", status, self.accessGroup)
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

	// No cached VEK: the user has not turned on biometric unlock in Bramble, which is
	// what caches the key the extension decrypts with.
	private func showNeedsBiometric() {
		showError(
			"Turn on biometric unlock",
			"Open Bramble, go to Settings, and enable Biometric unlock, then try again. That caches "
				+ "the key this needs to fill your passwords.")
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
