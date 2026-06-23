import AuthenticationServices
import LocalAuthentication
import Security
import UIKit

// AutoFill Credential Provider: lists the vault's logins, and on a tap reads the
// biometric-gated VEK the main app cached in the shared Keychain (Face ID) and
// decrypts the chosen password natively via the shared Rust core (VaultCryptoFFI) —
// no Argon2id, which would not fit the extension's ~120 MB cap. The main app writes
// each login's encrypted password + (service, username) to the shared App Group and
// populates ASCredentialIdentityStore (AutofillBridge.swift). docs/mobile-port.md.
class CredentialProviderViewController: ASCredentialProviderViewController, UITableViewDataSource,
	UITableViewDelegate
{
	private let appGroup = "group.app.bramble.mobile"
	private let secretsKey = "autofill.secrets"
	private let keychainService = "app.bramble.mobile.biometric-vault"
	private let keychainAccount = "vek"
	private let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	private struct Cred {
		let recordId: String
		let username: String
		let iv: String
		let ciphertext: String
		let services: [String]
	}

	private var creds: [Cred] = []
	private let table = UITableView()
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
				recordId: recordId, username: username, iv: iv, ciphertext: ct,
				services: (d["services"] as? [String]) ?? [])
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
		table.register(UITableViewCell.self, forCellReuseIdentifier: "cred")

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
			emptyLabel.centerXAnchor.constraint(equalTo: table.centerXAnchor),
			emptyLabel.centerYAnchor.constraint(equalTo: table.centerYAnchor),
			emptyLabel.leadingAnchor.constraint(equalTo: table.leadingAnchor, constant: 24),
			emptyLabel.trailingAnchor.constraint(equalTo: table.trailingAnchor, constant: -24),
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
				+ "If 0 bytes: open Bramble and unlock the vault once (that syncs autofill), "
				+ "and make sure Bramble is enabled under Settings > Passwords."
			NSLog("[AutoFill] empty list. appGroupReachable=%@ blobBytes=%d",
				String(ud != nil), bytes)
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
		let c = creds[indexPath.row]
		var config = cell.defaultContentConfiguration()
		config.text = c.services.first ?? c.username
		config.secondaryText = c.username
		cell.contentConfiguration = config
		return cell
	}

	func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
		tableView.deselectRow(at: indexPath, animated: true)
		fill(creds[indexPath.row])
	}

	// --- decrypt + complete (Face ID runs here: user-initiated, so foregrounded) ---

	private func fill(_ cred: Cred) {
		readVek(reason: "Unlock to fill \(cred.username)") { [weak self] vek in
			DispatchQueue.main.async {
				guard let self = self else { return }
				guard let vek = vek else {
					self.cancel(.userCanceled)
					return
				}
				do {
					try unlockWithVek(vekB64: vek)
					let password = try decryptWithVek(ivB64: cred.iv, ciphertextB64: cred.ciphertext)
					self.extensionContext.completeRequest(
						withSelectedCredential: ASPasswordCredential(user: cred.username, password: password),
						completionHandler: nil)
				} catch {
					NSLog("[AutoFill] decrypt failed: %@", error.localizedDescription)
					self.cancel(.failed)
				}
			}
		}
	}

	private func readVek(reason: String, completion: @escaping (String?) -> Void) {
		let context = LAContext()
		context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) {
			success, evalError in
			guard success else {
				NSLog("[AutoFill] biometric failed: %@", evalError?.localizedDescription ?? "?")
				completion(nil)
				return
			}
			let query: [String: Any] = [
				kSecClass as String: kSecClassGenericPassword,
				kSecAttrService as String: self.keychainService,
				kSecAttrAccount as String: self.keychainAccount,
				kSecAttrAccessGroup as String: self.accessGroup,
				kSecReturnData as String: true,
				kSecMatchLimit as String: kSecMatchLimitOne,
				kSecUseAuthenticationContext as String: context,
				kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
			]
			var item: CFTypeRef?
			let status = SecItemCopyMatching(query as CFDictionary, &item)
			if status == errSecSuccess, let data = item as? Data,
				let secret = String(data: data, encoding: .utf8)
			{
				completion(secret)
			} else {
				NSLog("[AutoFill] keychain read failed: status=%d", status)
				completion(nil)
			}
		}
	}

	@objc private func cancelTapped() { cancel(.userCanceled) }

	private func cancel(_ code: ASExtensionError.Code) {
		extensionContext.cancelRequest(
			withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
	}
}
