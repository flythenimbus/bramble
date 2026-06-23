import AuthenticationServices
import LocalAuthentication
import Security
import UIKit

// AutoFill Credential Provider: lists the vault's logins, reads the biometric-gated
// VEK the main app cached in the shared Keychain (Face ID), and decrypts the chosen
// password natively via the shared Rust core (VaultCryptoFFI) — no Argon2id, which
// would not fit the extension's ~120 MB cap. The main app writes each login's
// encrypted password + (service, username) to the shared App Group and populates
// ASCredentialIdentityStore (see AutofillBridge.swift). docs/mobile-port.md "the crux".
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

	private func loadCreds() -> [Cred] {
		let raw = UserDefaults(suiteName: appGroup)?.array(forKey: secretsKey) as? [[String: Any]] ?? []
		return raw.compactMap { d in
			guard let recordId = d["recordId"] as? String, let username = d["username"] as? String,
				let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String
			else { return nil }
			return Cred(
				recordId: recordId, username: username, iv: iv, ciphertext: ct,
				services: (d["services"] as? [String]) ?? [])
		}
	}

	// --- credential list UI ---

	override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		let wanted = serviceIdentifiers.map { $0.identifier.lowercased() }
		let all = loadCreds()
		// Matches (a wanted domain is a suffix of one of the login's services) first.
		func matches(_ c: Cred) -> Bool {
			c.services.contains { svc in
				wanted.contains { w in svc.lowercased() == w || svc.lowercased().hasSuffix("." + w) || w.hasSuffix("." + svc.lowercased()) }
			}
		}
		creds = all.sorted { a, b in (matches(a) ? 0 : 1) < (matches(b) ? 0 : 1) }
		setupTable()
	}

	private func setupTable() {
		view.backgroundColor = .systemBackground
		title = "Bramble"
		navigationItem.leftBarButtonItem = UIBarButtonItem(
			barButtonSystemItem: .cancel, target: self, action: #selector(cancelTapped))
		table.frame = view.bounds
		table.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		table.dataSource = self
		table.delegate = self
		table.register(UITableViewCell.self, forCellReuseIdentifier: "cred")
		if table.superview == nil { view.addSubview(table) }
		table.reloadData()
	}

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

	// --- fast paths ---

	// No silent fill: every fill requires the biometric VEK read, so defer to UI.
	override func provideCredentialWithoutUserInteraction(
		for credentialIdentity: ASPasswordCredentialIdentity
	) {
		cancel(.userInteractionRequired)
	}

	// QuickType pick (a specific identity): decrypt just that record behind Face ID.
	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		view.backgroundColor = .systemBackground
		let record = credentialIdentity.recordIdentifier
		guard let c = loadCreds().first(where: { $0.recordId == record }) else {
			cancel(.credentialIdentityNotFound)
			return
		}
		fill(c)
	}

	// --- decrypt + complete ---

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
					let credential = ASPasswordCredential(user: cred.username, password: password)
					self.extensionContext.completeRequest(
						withSelectedCredential: credential, completionHandler: nil)
				} catch {
					self.cancel(.failed)
				}
			}
		}
	}

	// Face ID, then read the shared-Keychain VEK reusing that authenticated context.
	private func readVek(reason: String, completion: @escaping (String?) -> Void) {
		let context = LAContext()
		context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) {
			success, _ in
			guard success else {
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
