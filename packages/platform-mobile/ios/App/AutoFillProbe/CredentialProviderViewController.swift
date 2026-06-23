import AuthenticationServices
import Security
import SwiftUI
import UIKit

// AutoFill Credential Provider. Lists the vault's logins from the shared App Group,
// then on a tap obtains the VEK and decrypts the chosen password natively via the
// shared Rust core (VaultCryptoFFI). Two ways to get the VEK, in order:
//   1. a biometric/passcode-cached VEK (Face ID OR device passcode) - the fast path.
//   2. the master password: the app shares the (non-secret) password slot, so the
//      extension runs Argon2id itself and unwraps the VEK (Bitwarden-style; no
//      biometrics needed).
// The UI is SwiftUI styled from the app's design tokens for visual parity with the
// in-app vault. Passwords are never stored in cleartext. docs/mobile-port.md.

private struct Cred: Identifiable {
	var id: String { recordId }
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

// --- design tokens (app dark theme; oklch grayscale converted to sRGB) ---

extension Color {
	fileprivate init(rgb: UInt32) {
		self.init(
			.sRGB, red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255,
			blue: Double(rgb & 0xff) / 255)
	}
}
private enum Theme {
	static let background = Color(rgb: 0x171717)
	static let card = Color(rgb: 0x21_21_21)
	static let chip = Color(rgb: 0x2E_2E_2E)
	static let border = Color(rgb: 0x33_33_33)
	static let foreground = Color(rgb: 0xF5_F5_F5)
	static let muted = Color(rgb: 0xA1_A1_A1)
	static let destructive = Color(rgb: 0xF8_71_71)
}

// --- SwiftUI views ---

private struct RowView: View {
	let cred: Cred
	var body: some View {
		HStack(spacing: 12) {
			Text(initials(cred.name))
				.font(.system(size: 15, weight: .semibold))
				.foregroundColor(Theme.foreground)
				.frame(width: 40, height: 40)
				.background(Theme.chip)
				.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
			VStack(alignment: .leading, spacing: 2) {
				Text(cred.name).font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.foreground)
				Text(cred.username).font(.system(size: 14)).foregroundColor(Theme.muted).lineLimit(1)
			}
			Spacer(minLength: 0)
		}
		.padding(12)
		.background(Theme.card)
		.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
		.overlay(
			RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
	}
}

private struct CredentialListView: View {
	let creds: [Cred]
	let diagnostic: String?
	let onSelect: (Cred) -> Void
	let onCancel: () -> Void

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				Text("Bramble").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).foregroundColor(Theme.muted)
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)

			if creds.isEmpty {
				Spacer()
				Text(diagnostic ?? "No logins to fill.")
					.font(.footnote).foregroundColor(Theme.muted).multilineTextAlignment(.center)
					.padding(24)
				Spacer()
			} else {
				ScrollView {
					VStack(alignment: .leading, spacing: 10) {
						Text("Items (\(creds.count))")
							.font(.system(size: 13, weight: .medium)).foregroundColor(Theme.muted)
							.padding(.top, 4)
						ForEach(creds) { cred in
							Button { onSelect(cred) } label: { RowView(cred: cred) }.buttonStyle(.plain)
						}
					}
					.padding(.horizontal, 16)
					.padding(.bottom, 24)
				}
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
	}
}

private final class UnlockModel: ObservableObject {
	@Published var busy = false
	@Published var error: String?
	let name: String
	let onSubmit: (String) -> Void
	let onCancel: () -> Void
	init(name: String, onSubmit: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
		self.name = name
		self.onSubmit = onSubmit
		self.onCancel = onCancel
	}
}

private struct MasterPasswordView: View {
	@ObservedObject var model: UnlockModel
	@State private var password = ""
	@FocusState private var focused: Bool

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				Button("Cancel", action: model.onCancel).foregroundColor(Theme.muted)
				Spacer()
			}
			.padding(.horizontal, 16)
			.padding(.vertical, 12)

			Spacer()
			VStack(spacing: 16) {
				Text("Unlock \(model.name)")
					.font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.foreground)
				SecureField("Master password", text: $password)
					.textContentType(.password)
					.autocorrectionDisabled()
					.textInputAutocapitalization(.never)
					.focused($focused)
					.padding(12)
					.background(Theme.card)
					.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
					.overlay(
						RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1)
					)
					.foregroundColor(Theme.foreground)
					.onSubmit(submit)
				if let error = model.error {
					Text(error).font(.footnote).foregroundColor(Theme.destructive).multilineTextAlignment(.center)
				}
				Button(action: submit) {
					HStack {
						if model.busy { ProgressView().tint(.black) }
						Text("Unlock").font(.system(size: 17, weight: .semibold))
					}
					.frame(maxWidth: .infinity).padding(.vertical, 12)
					.background(Theme.foreground).foregroundColor(.black)
					.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
				}
				.disabled(model.busy || password.isEmpty)
			}
			.padding(.horizontal, 24)
			Spacer()
			Spacer()
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
		.onAppear { focused = true }
	}

	private func submit() {
		guard !model.busy, !password.isEmpty else { return }
		model.error = nil
		model.busy = true
		model.onSubmit(password)
	}
}

// --- provider controller (UIKit shell hosting the SwiftUI views) ---

class CredentialProviderViewController: ASCredentialProviderViewController {
	private let appGroup = "group.app.bramble.mobile"
	private let secretsKey = "autofill.secrets"
	private let slotKey = "autofill.slot"
	private let keychainService = "app.bramble.mobile.biometric-vault"
	private let keychainAccount = "vek"
	private let accessGroup = "BHGR3PP64J.app.bramble.mobile.shared"

	private enum VekOutcome { case ok(String), missing, denied(String) }

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

	// Swap the hosted SwiftUI root.
	private func host(_ view: some View) {
		children.forEach {
			$0.willMove(toParent: nil)
			$0.view.removeFromSuperview()
			$0.removeFromParent()
		}
		let h = UIHostingController(rootView: view)
		addChild(h)
		h.view.frame = self.view.bounds
		h.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
		self.view.addSubview(h.view)
		h.didMove(toParent: self)
	}

	private func showList(_ creds: [Cred]) {
		let diag: String?
		if creds.isEmpty {
			let ud = UserDefaults(suiteName: appGroup)
			let bytes = ud?.data(forKey: secretsKey)?.count ?? 0
			diag =
				"No logins to fill.\n\nApp Group reachable: \(ud != nil)\nStored blob: \(bytes) bytes\n\n"
				+ "Open Bramble and unlock the vault once so it can sync your logins for autofill."
			NSLog("[AutoFill] empty list. reachable=%@ bytes=%d", String(ud != nil), bytes)
		} else {
			diag = nil
		}
		host(
			CredentialListView(
				creds: creds, diagnostic: diag,
				onSelect: { [weak self] in self?.fill($0) },
				onCancel: { [weak self] in self?.cancel(.userCanceled) }))
	}

	// --- credential list entry points ---

	override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		let wanted = serviceIdentifiers.map { $0.identifier.lowercased() }
		let all = loadCreds()
		func matches(_ c: Cred) -> Bool {
			c.services.contains { svc in
				let s = svc.lowercased()
				return wanted.contains { w in s == w || s.hasSuffix("." + w) || w.hasSuffix("." + s) }
			}
		}
		showList(all.sorted { (matches($0) ? 0 : 1) < (matches($1) ? 0 : 1) })
	}

	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		let all = loadCreds()
		let match = all.filter { $0.recordId == credentialIdentity.recordIdentifier }
		showList(match.isEmpty ? all : match)
	}

	override func provideCredentialWithoutUserInteraction(
		for credentialIdentity: ASPasswordCredentialIdentity
	) {
		cancel(.userInteractionRequired)
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
				"This vault has no master password set, or it hasn't synced yet. Open Bramble, unlock it "
					+ "once, then try again.")
			return
		}
		let model = UnlockModel(
			name: cred.name,
			onSubmit: { [weak self] password in self?.tryPassword(password, slot: slot, cred: cred) },
			onCancel: { [weak self] in self?.cancel(.userCanceled) })
		currentUnlock = model
		host(MasterPasswordView(model: model))
	}

	private var currentUnlock: UnlockModel?

	private func tryPassword(_ password: String, slot: Slot, cred: Cred) {
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			guard let self = self else { return }
			do {
				let ok = try unwrapVekPassword(
					password: password, saltB64: slot.salt, slotIdB64: slot.slotId,
					verifierB64: slot.verifier, wrapIvB64: slot.wrapIv, wrappedVekB64: slot.wrappedVek,
					magicVersion: slot.magicVersion)
				DispatchQueue.main.async {
					if ok {
						self.decryptAndComplete(cred)
					} else {
						self.currentUnlock?.busy = false
						self.currentUnlock?.error = "Incorrect master password"
					}
				}
			} catch {
				DispatchQueue.main.async {
					self.currentUnlock?.busy = false
					self.currentUnlock?.error = error.localizedDescription
				}
			}
		}
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

	private func cancel(_ code: ASExtensionError.Code) {
		extensionContext.cancelRequest(
			withError: NSError(domain: ASExtensionErrorDomain, code: code.rawValue))
	}
}
