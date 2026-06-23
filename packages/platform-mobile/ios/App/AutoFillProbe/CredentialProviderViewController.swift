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
// in-app vault + auth screen. Passwords are never stored in cleartext. docs/mobile-port.md.

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
	static let background = Color(rgb: 0x17_17_17)
	static let card = Color(rgb: 0x21_21_21)
	static let input = Color(rgb: 0x2A_2A_2A)
	static let chip = Color(rgb: 0x2E_2E_2E)
	static let border = Color(rgb: 0x36_36_36)
	static let foreground = Color(rgb: 0xF5_F5_F5)
	static let muted = Color(rgb: 0xA1_A1_A1)
	static let destructive = Color(rgb: 0xF8_71_71)
}

// The Bramble glyph (the app's bramble-glyph.png), embedded so the extension needs no
// asset-catalog wiring. Rendered as a template tinted with the foreground color.
private func brambleGlyphImage() -> UIImage? {
	Data(base64Encoded: brambleGlyphBase64).flatMap { UIImage(data: $0) }
}

private struct Glyph: View {
	let size: CGFloat
	var body: some View {
		if let img = brambleGlyphImage() {
			Image(uiImage: img).renderingMode(.template).resizable().scaledToFit()
				.frame(width: size, height: size).foregroundColor(Theme.foreground)
		} else {
			Color.clear.frame(width: size, height: size)
		}
	}
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
			HStack(spacing: 10) {
				Glyph(size: 26)
				Text("Bramble").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).foregroundColor(Theme.muted)
			}
			.padding(.horizontal, 20)
			.padding(.top, 16)
			.padding(.bottom, 12)
			Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6)

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
							.padding(.top, 16)
						ForEach(creds) { cred in
							Button { onSelect(cred) } label: { RowView(cred: cred) }.buttonStyle(.plain)
						}
					}
					.padding(.horizontal, 20)
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
	let onSubmit: (String) -> Void
	let onCancel: () -> Void
	init(onSubmit: @escaping (String) -> Void, onCancel: @escaping () -> Void) {
		self.onSubmit = onSubmit
		self.onCancel = onCancel
	}
}

// Mirrors the app's auth screen: glyph, heading, then a card holding the password
// field and the primary Unlock button (recovery code and below are intentionally
// omitted for the autofill context).
private struct MasterPasswordView: View {
	@ObservedObject var model: UnlockModel
	@State private var password = ""
	@State private var showPassword = false
	@FocusState private var focused: Bool

	var body: some View {
		VStack(spacing: 0) {
			HStack {
				Button("Cancel", action: model.onCancel).foregroundColor(Theme.muted)
				Spacer()
			}
			.padding(.horizontal, 20)
			.padding(.top, 16)

			ScrollView {
				VStack(alignment: .leading, spacing: 20) {
					HStack { Spacer(); Glyph(size: 64); Spacer() }.padding(.top, 24)
					Text("Enter your master password to unlock your vault")
						.font(.system(size: 21, weight: .regular))
						.foregroundColor(Theme.foreground)
						.fixedSize(horizontal: false, vertical: true)

					VStack(spacing: 18) {
						HStack(spacing: 8) {
							Group {
								if showPassword {
									TextField("Master password", text: $password)
								} else {
									SecureField("Master password", text: $password)
								}
							}
							.textContentType(.password)
							.autocorrectionDisabled()
							.textInputAutocapitalization(.never)
							.focused($focused)
							.foregroundColor(Theme.foreground)
							.onSubmit(submit)
							Button { showPassword.toggle() } label: {
								Image(systemName: showPassword ? "eye.slash" : "eye")
									.font(.system(size: 15)).foregroundColor(Theme.muted)
							}
						}
						.padding(12)
						.background(Theme.input)
						.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
						.overlay(
							RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1)
						)

						if let error = model.error {
							Text(error).font(.footnote).foregroundColor(Theme.destructive)
								.frame(maxWidth: .infinity, alignment: .leading)
						}

						Button(action: submit) {
							HStack(spacing: 8) {
								if model.busy {
									ProgressView().tint(.black)
								} else {
									Image(systemName: "asterisk").font(.system(size: 14, weight: .bold))
								}
								Text("Unlock Vault").font(.system(size: 15, weight: .semibold))
							}
							.frame(maxWidth: .infinity).padding(.vertical, 12)
							.background(Theme.foreground).foregroundColor(.black)
							.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
						}
						.disabled(model.busy || password.isEmpty)
					}
					.padding(20)
					.background(Theme.card)
					.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
					.overlay(
						RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
				}
				.padding(.horizontal, 24)
				.padding(.bottom, 24)
			}
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

// bramble-glyph.png (128x128), base64-embedded so the extension needs no asset catalog.
private let brambleGlyphBase64 = "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"
