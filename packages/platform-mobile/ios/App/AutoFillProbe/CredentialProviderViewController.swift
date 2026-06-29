import AuthenticationServices
import LocalAuthentication
import Security
import SwiftUI
import UIKit

// AutoFill Credential Provider. Authenticate FIRST, then reveal entries: on launch it
// shows an unlock screen (Face ID / passcode, or the master password). Only once it has
// the VEK does it decrypt the login list (stored encrypted under the VEK in the shared
// App Group) and show it. Nothing about the vault - names, usernames, passwords - is
// readable before the user authenticates. The crypto is the shared Rust core
// (VaultCryptoFFI); the master-password path runs Argon2id natively (no biometrics
// needed). UI is SwiftUI styled from the app's design tokens. docs/mobile-port.md.

private struct Cred: Identifiable, Decodable {
	var id: String { recordId }
	let recordId: String
	let name: String
	let username: String
	let password: String
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

// One stored passkey from the (VEK-encrypted) passkey bundle. All base64 fields are
// STANDARD base64 (as written by the main app), which is what Data(base64Encoded:) and the
// Rust core both consume directly. The private key is the only secret. See AutofillBridge.
private struct Passkey: Decodable {
	let credentialId: String
	let rpId: String
	let userName: String
	let userHandle: String
	let privateKey: String
}

// A passkey sign-in (get) the OS asked us to satisfy, captured so the post-unlock path can
// finish it. Plain types only (no iOS-17 SDK types) so it can be a stored property on a
// controller whose deployment target is older. `chosen` is set when the OS already picked a
// specific credential (from its sheet); otherwise we match by rpId + allow-list.
private struct PasskeyGet {
	let rpId: String
	let clientDataHash: Data
	let allowed: [String]  // STANDARD-b64 credentialIds; empty = any discoverable
	let chosen: String?  // STANDARD-b64 credentialId already selected by the OS
}

// Localized lookup from the extension's String Catalog (Localizable.xcstrings).
// Interpolations become format keys (%@, %lld) that the catalog translates.
private func loc(_ key: String.LocalizationValue) -> String { String(localized: key) }

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

// --- list (shown only after auth) ---

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
	let matches: [Cred]
	let all: [Cred]
	let requestedHost: String?
	let onSelect: (Cred) -> Void
	let onCancel: () -> Void
	@State private var showAll = false

	// Everything that isn't already a domain match (shown under "Show all items").
	private var others: [Cred] {
		let ids = Set(matches.map { $0.recordId })
		return all.filter { !ids.contains($0.recordId) }
	}

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

			if all.isEmpty {
				Spacer()
				Text("No logins saved yet.\nAdd one in Bramble.")
					.font(.footnote).foregroundColor(Theme.muted).multilineTextAlignment(.center).padding(24)
				Spacer()
			} else {
				ScrollView {
					VStack(alignment: .leading, spacing: 10) {
						if matches.isEmpty {
							// No domain match for this page: show the whole vault.
							sectionLabel(requestedHost.map { loc("No matches for \($0)") } ?? loc("Items (\(all.count))"))
							ForEach(all) { row($0) }
						} else {
							// Filter to the page's logins; the rest are one tap away.
							sectionLabel(requestedHost.map { loc("For \($0)") } ?? loc("Matches"))
							ForEach(matches) { row($0) }
							if !others.isEmpty {
								if showAll {
									sectionLabel(loc("All items"))
									ForEach(others) { row($0) }
								} else {
									Button { showAll = true } label: {
										Text("Show all items (\(others.count) more)")
											.font(.system(size: 14, weight: .medium))
											.foregroundColor(Theme.muted)
											.frame(maxWidth: .infinity, alignment: .leading)
											.padding(.vertical, 10)
									}
									.buttonStyle(.plain)
								}
							}
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

	private func sectionLabel(_ text: String) -> some View {
		Text(text)
			.font(.system(size: 13, weight: .medium)).foregroundColor(Theme.muted).padding(.top, 16)
	}

	private func row(_ cred: Cred) -> some View {
		Button { onSelect(cred) } label: { RowView(cred: cred) }.buttonStyle(.plain)
	}
}

// --- passkey picker (only when several stored passkeys match one get() request) ---

private struct PasskeyPickerView: View {
	let choices: [Passkey]
	let onSelect: (Passkey) -> Void
	let onCancel: () -> Void

	var body: some View {
		VStack(spacing: 0) {
			HStack(spacing: 10) {
				Glyph(size: 26)
				Text("Choose a passkey").font(.system(size: 20, weight: .semibold))
					.foregroundColor(Theme.foreground)
				Spacer()
				Button("Cancel", action: onCancel).foregroundColor(Theme.muted)
			}
			.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 12)
			Rectangle().fill(Theme.border).frame(height: 1).opacity(0.6)
			ScrollView {
				VStack(alignment: .leading, spacing: 10) {
					ForEach(choices, id: \.credentialId) { pk in
						Button { onSelect(pk) } label: {
							HStack(spacing: 12) {
								Image(systemName: "person.badge.key.fill").font(.system(size: 18))
									.foregroundColor(Theme.foreground)
									.frame(width: 40, height: 40).background(Theme.chip)
									.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
								VStack(alignment: .leading, spacing: 2) {
									Text(pk.userName.isEmpty ? pk.rpId : pk.userName)
										.font(.system(size: 16, weight: .semibold)).foregroundColor(Theme.foreground)
									Text(pk.rpId).font(.system(size: 14)).foregroundColor(Theme.muted).lineLimit(1)
								}
								Spacer(minLength: 0)
							}
							.padding(12).background(Theme.card)
							.clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
							.overlay(
								RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.border, lineWidth: 1))
						}
						.buttonStyle(.plain)
					}
				}
				.padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 24)
			}
		}
		.frame(maxWidth: .infinity, maxHeight: .infinity)
		.background(Theme.background.ignoresSafeArea())
	}
}

// --- unlock screen (shown first) ---

private final class UnlockModel: ObservableObject {
	@Published var busy = false
	@Published var error: String?
	let hasBiometric: Bool
	let biometricLabel: String
	let biometricSymbol: String
	let onBiometric: () -> Void
	let onPassword: (String) -> Void
	let onCancel: () -> Void
	init(
		hasBiometric: Bool, biometricLabel: String, biometricSymbol: String,
		onBiometric: @escaping () -> Void,
		onPassword: @escaping (String) -> Void, onCancel: @escaping () -> Void
	) {
		self.hasBiometric = hasBiometric
		self.biometricLabel = biometricLabel
		self.biometricSymbol = biometricSymbol
		self.onBiometric = onBiometric
		self.onPassword = onPassword
		self.onCancel = onCancel
	}
}

// Mirrors the app's auth screen: glyph, heading, then a card with (when a cached key
// exists) a Face ID / passcode button and the master-password field + Unlock button.
private struct UnlockView: View {
	@ObservedObject var model: UnlockModel
	@State private var password = ""
	@State private var showPassword = false
	@State private var triggered = false
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
						if model.hasBiometric {
							Button {
								model.error = nil
								model.busy = true
								model.onBiometric()
							} label: {
								HStack(spacing: 8) {
									Image(systemName: model.biometricSymbol).font(.system(size: 15))
									Text("Unlock with \(model.biometricLabel)").font(.system(size: 15, weight: .semibold))
								}
								.frame(maxWidth: .infinity).padding(.vertical, 12)
								.background(Theme.foreground).foregroundColor(.black)
								.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
							}
							.disabled(model.busy)
						}

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
							RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(Theme.border, lineWidth: 1))

						if let error = model.error {
							Text(error).font(.footnote).foregroundColor(Theme.destructive)
								.frame(maxWidth: .infinity, alignment: .leading)
						}

						Button(action: submit) {
							HStack(spacing: 8) {
								if model.busy {
									ProgressView().tint(model.hasBiometric ? Theme.foreground : .black)
								} else {
									Image(systemName: "asterisk").font(.system(size: 14, weight: .bold))
								}
								Text("Unlock Vault").font(.system(size: 15, weight: .semibold))
							}
							.frame(maxWidth: .infinity).padding(.vertical, 12)
							.foregroundColor(model.hasBiometric ? Theme.foreground : .black)
							.background(model.hasBiometric ? Color.clear : Theme.foreground)
							.clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
							.overlay(
								model.hasBiometric
									? RoundedRectangle(cornerRadius: 10, style: .continuous).stroke(
										Theme.border, lineWidth: 1) : nil)
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
		.onAppear {
			// Cached key present: pop Face ID / passcode right away (password is the fallback).
			if model.hasBiometric, !triggered {
				triggered = true
				model.busy = true
				model.onBiometric()
			} else if !model.hasBiometric {
				focused = true
			}
		}
	}

	private func submit() {
		guard !model.busy, !password.isEmpty else { return }
		model.error = nil
		model.busy = true
		model.onPassword(password)
	}
}

// --- provider controller ---

class CredentialProviderViewController: ASCredentialProviderViewController {
	// All shared identifiers (App Group, Keychain group/service/account, keys) live in
	// BrambleVault, compiled into both the app and this extension so they cannot drift.
	// Keep-unlocked session (BrambleVault.sessionService): the VEK cached behind device-
	// unlock only for the configured window, so fills within it need no re-auth.

	private enum VekOutcome { case ok(String), missing, denied(String) }

	private var pendingHosts: [String] = []
	private var pendingRecordId: String?
	// Set while satisfying a passkey get(); onUnlocked() branches to the assertion path.
	private var pendingPasskey: PasskeyGet?
	private var model: UnlockModel?

	// --- entry points: authenticate first ---

	override func prepareCredentialList(for serviceIdentifiers: [ASCredentialServiceIdentifier]) {
		// Safari passes the full page URL here (e.g. https://github.com/login), while the
		// stored services are bare hostnames; normalize both to a host so they compare.
		pendingHosts = serviceIdentifiers.map { normalizeHost($0.identifier) }.filter { !$0.isEmpty }
		pendingRecordId = nil
		resume()
	}

	override func prepareInterfaceToProvideCredential(for credentialIdentity: ASPasswordCredentialIdentity) {
		pendingHosts = []
		pendingRecordId = credentialIdentity.recordIdentifier
		resume()
	}

	// Try the keep-unlocked session (no auth) before showing the unlock screen.
	private func resume() {
		if let vek = loadSession() {
			do {
				try unlockWithVek(vekB64: vek)
				onUnlocked()
				return
			} catch { clearSession() }
		}
		showUnlock()
	}

	// Tapped a QuickType suggestion. If a keep-unlocked session is live, decrypt and fill
	// silently (no unlock screen). Otherwise tell the OS we need UI: it relaunches into
	// prepareInterfaceToProvideCredential, which shows the unlock screen and then fills
	// this exact record via pendingRecordId. (Previously this always required interaction,
	// so the unlock screen appeared even when the vault was meant to stay unlocked.)
	override func provideCredentialWithoutUserInteraction(
		for credentialIdentity: ASPasswordCredentialIdentity
	) {
		guard let vek = loadSession(), (try? unlockWithVek(vekB64: vek)) != nil else {
			cancel(.userInteractionRequired)
			return
		}
		saveSession(vek)  // slide the keep-unlocked window, as the interactive path does
		guard let bundle = loadBundle(),
			let json = try? decryptWithVek(ivB64: bundle.iv, ciphertextB64: bundle.ct),
			let creds = try? JSONDecoder().decode([Cred].self, from: Data(json.utf8)),
			let cred = creds.first(where: { $0.recordId == credentialIdentity.recordIdentifier })
		else {
			cancel(.userInteractionRequired)
			return
		}
		complete(cred)
	}

	// --- passkey provider (iOS 17+, provider/authenticator role) ---
	// The OS owns clientDataJSON and hands us only its hash, so there is no origin to resolve
	// (unlike the Chromium proxy). We sign authData || clientDataHash with the stored key.
	// The unified ASCredentialRequest methods below also receive password requests on iOS 17;
	// non-passkey ones are delegated to the existing password handlers so that path is intact.

	// No-UI fast path. Assert silently only when a keep-unlocked session is live AND the RP
	// did not demand user verification (a fresh biometric); otherwise ask the OS for UI, which
	// relaunches into prepareInterfaceToProvideCredential below.
	@available(iOS 17.0, *)
	override func provideCredentialWithoutUserInteraction(for credentialRequest: ASCredentialRequest) {
		guard let req = credentialRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			if let pwd = credentialRequest.credentialIdentity as? ASPasswordCredentialIdentity {
				provideCredentialWithoutUserInteraction(for: pwd)
			} else {
				cancel(.userInteractionRequired)
			}
			return
		}
		guard req.userVerificationPreference != .required,
			let vek = loadSession(), (try? unlockWithVek(vekB64: vek)) != nil
		else {
			cancel(.userInteractionRequired)
			return
		}
		saveSession(vek)
		guard let pk = loadPasskeyBundle().first(where: { $0.credentialId == identity.credentialID.base64EncodedString() })
		else {
			cancel(.userInteractionRequired)
			return
		}
		assertPasskey(pk, clientDataHash: req.clientDataHash, userVerified: false)
	}

	// A specific passkey was chosen from the OS sheet but UI is needed (unlock). Force a fresh
	// unlock so the assertion is genuinely user-verified, then assert that credential.
	@available(iOS 17.0, *)
	override func prepareInterfaceToProvideCredential(for credentialRequest: ASCredentialRequest) {
		guard let req = credentialRequest as? ASPasskeyCredentialRequest,
			let identity = req.credentialIdentity as? ASPasskeyCredentialIdentity
		else {
			if let pwd = credentialRequest.credentialIdentity as? ASPasswordCredentialIdentity {
				prepareInterfaceToProvideCredential(for: pwd)
			} else {
				cancel(.userInteractionRequired)
			}
			return
		}
		pendingHosts = []
		pendingRecordId = nil
		pendingPasskey = PasskeyGet(
			rpId: identity.relyingPartyIdentifier, clientDataHash: req.clientDataHash,
			allowed: [], chosen: identity.credentialID.base64EncodedString())
		showUnlock()
	}

	// The user opened Bramble for a passkey sign-in (no specific credential pre-chosen): unlock,
	// then match by rpId + allow-list and assert (picking when several match).
	@available(iOS 17.0, *)
	override func prepareCredentialList(
		for serviceIdentifiers: [ASCredentialServiceIdentifier],
		requestParameters: ASPasskeyCredentialRequestParameters
	) {
		pendingHosts = []
		pendingRecordId = nil
		pendingPasskey = PasskeyGet(
			rpId: requestParameters.relyingPartyIdentifier,
			clientDataHash: requestParameters.clientDataHash,
			allowed: requestParameters.allowedCredentials.map { $0.base64EncodedString() },
			chosen: nil)
		showUnlock()
	}

	// Reached only after a fresh unlock (the passkey UI paths never use the cached session),
	// so the assertion is always user-verified here.
	@available(iOS 17.0, *)
	private func handlePasskeyUnlocked() {
		guard let req = pendingPasskey else { return }
		let all = loadPasskeyBundle()
		let matches =
			req.chosen.map { id in all.filter { $0.credentialId == id } }
			?? all.filter { $0.rpId == req.rpId && (req.allowed.isEmpty || req.allowed.contains($0.credentialId)) }
		if matches.count == 1 {
			assertPasskey(matches[0], clientDataHash: req.clientDataHash, userVerified: true)
		} else if matches.isEmpty {
			showError(
				String(localized: "No passkey found"),
				String(localized: "Bramble has no passkey for this site."))
		} else {
			host(
				PasskeyPickerView(
					choices: matches,
					onSelect: { [weak self] in self?.assertPasskey($0, clientDataHash: req.clientDataHash, userVerified: true) },
					onCancel: { [weak self] in self?.cancel(.userCanceled) }))
		}
	}

	// Sign authData || clientDataHash with the stored key (native Rust core) and hand the OS a
	// passkey assertion. The OS-provided clientDataHash is fed back verbatim.
	@available(iOS 17.0, *)
	private func assertPasskey(_ pk: Passkey, clientDataHash: Data, userVerified: Bool) {
		guard let credID = Data(base64Encoded: pk.credentialId),
			let userHandle = Data(base64Encoded: pk.userHandle),
			let assertion = try? passkeyGetAssertion(
				rpId: pk.rpId, privateKeyB64: pk.privateKey,
				clientDataHashB64: clientDataHash.base64EncodedString(), userVerified: userVerified),
			let authData = Data(base64Encoded: assertion.authenticatorData),
			let sig = Data(base64Encoded: assertion.signature)
		else {
			cancel(.failed)
			return
		}
		let credential = ASPasskeyAssertionCredential(
			userHandle: userHandle, relyingParty: pk.rpId, signature: sig,
			clientDataHash: clientDataHash, authenticatorData: authData, credentialID: credID)
		extensionContext.completeAssertionRequest(using: credential, completionHandler: nil)
	}

	// Decrypt the passkey bundle (empty if none / not unlocked). VEK must already be loaded.
	private func loadPasskeyBundle() -> [Passkey] {
		guard
			let data = UserDefaults(suiteName: BrambleVault.appGroup)?.data(
				forKey: BrambleVault.passkeyBundleKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String,
			let json = try? decryptWithVek(ivB64: iv, ciphertextB64: ct),
			let creds = try? JSONDecoder().decode([Passkey].self, from: Data(json.utf8))
		else { return [] }
		return creds
	}

	private func showUnlock() {
		let biometry = biometryInfo()
		let m = UnlockModel(
			hasBiometric: vekExists(),
			biometricLabel: biometry.label,
			biometricSymbol: biometry.symbol,
			onBiometric: { [weak self] in self?.unlockWithBiometric() },
			onPassword: { [weak self] in self?.unlockWithPassword($0) },
			onCancel: { [weak self] in self?.cancel(.userCanceled) })
		model = m
		host(UnlockView(model: m))
	}

	// The device's biometry name + the passcode fallback (the cached VEK is gated by
	// `.userPresence`, so the device passcode always works too). The SF Symbol is derived
	// here from the biometry type, not from the (localized) label text. Touch ID devices and
	// devices with no enrolled biometric are covered.
	private func biometryInfo() -> (label: String, symbol: String) {
		let ctx = LAContext()
		_ = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
		switch ctx.biometryType {
		case .faceID: return (String(localized: "Face ID or passcode"), "faceid")
		case .touchID: return (String(localized: "Touch ID or passcode"), "touchid")
		default: return (String(localized: "biometrics or passcode"), "lock")
		}
	}

	// --- unlock paths (each loads the VEK into the native core, then onUnlocked) ---

	private func unlockWithBiometric() {
		readVek(reason: String(localized: "Unlock Bramble")) { [weak self] outcome in
			DispatchQueue.main.async {
				guard let self = self else { return }
				switch outcome {
				case .ok(let vek):
					do {
						try unlockWithVek(vekB64: vek)
						self.onUnlocked()
					} catch {
						self.model?.busy = false
						self.model?.error = error.localizedDescription
					}
				case .missing:
					self.model?.busy = false
					self.model?.error = String(localized: "Enter your master password.")
				case .denied(let msg):
					self.model?.busy = false
					self.model?.error = msg.isEmpty ? nil : msg  // empty == user canceled
				}
			}
		}
	}

	private func unlockWithPassword(_ password: String) {
		guard let slot = loadSlot() else {
			model?.busy = false
			model?.error = String(
				localized:
					"This vault has no master password, or it hasn't synced. Open Bramble, unlock it once, then retry."
			)
			return
		}
		DispatchQueue.global(qos: .userInitiated).async { [weak self] in
			do {
				let ok = try unwrapVekPassword(
					password: password, saltB64: slot.salt, slotIdB64: slot.slotId,
					verifierB64: slot.verifier, wrapIvB64: slot.wrapIv, wrappedVekB64: slot.wrappedVek,
					magicVersion: slot.magicVersion)
				DispatchQueue.main.async {
					if ok {
						self?.onUnlocked()
					} else {
						self?.model?.busy = false
						self?.model?.error = String(localized: "Incorrect master password")
					}
				}
			} catch {
				DispatchQueue.main.async {
					self?.model?.busy = false
					self?.model?.error = error.localizedDescription
				}
			}
		}
	}

	// VEK is loaded in the native core; decrypt the bundle and show the list (or fill).
	private func onUnlocked() {
		// Start / slide the keep-unlocked window (no-op if the feature is off).
		if let vek = try? exportVek() { saveSession(vek) }
		// A passkey get() takes a separate path (the login bundle is irrelevant to it).
		if pendingPasskey != nil {
			if #available(iOS 17.0, *) { handlePasskeyUnlocked() } else { cancel(.failed) }
			return
		}
		guard let bundle = loadBundle() else {
			showList(matches: [], all: [], requestedHost: pendingHosts.first)
			return
		}
		do {
			let json = try decryptWithVek(ivB64: bundle.iv, ciphertextB64: bundle.ct)
			let creds = (try? JSONDecoder().decode([Cred].self, from: Data(json.utf8))) ?? []
			if let rid = pendingRecordId, let c = creds.first(where: { $0.recordId == rid }) {
				complete(c)
			} else {
				let matches = creds.filter { matchesRequested($0) }
				showList(matches: matches, all: creds, requestedHost: pendingHosts.first)
			}
		} catch {
			showError(String(localized: "Couldn't load logins"), error.localizedDescription)
		}
	}

	private func showList(matches: [Cred], all: [Cred], requestedHost: String?) {
		host(
			CredentialListView(
				matches: matches, all: all, requestedHost: requestedHost,
				onSelect: { [weak self] in self?.complete($0) },
				onCancel: { [weak self] in self?.cancel(.userCanceled) }))
	}

	private func complete(_ cred: Cred) {
		extensionContext.completeRequest(
			withSelectedCredential: ASPasswordCredential(user: cred.username, password: cred.password),
			completionHandler: nil)
	}

	// Normalize a service identifier or a stored URL/hostname to a bare registrable host:
	// prefer the parsed URL host (Safari passes the full page URL), else strip any
	// scheme/path/query/port by hand, then drop a leading "www." and lowercase. Without
	// this, a requested "https://github.com/login" never equals a stored "github.com".
	private func normalizeHost(_ raw: String) -> String {
		var s = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
		if s.isEmpty { return s }
		if let h = URL(string: s)?.host {
			s = h
		} else {
			if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
			if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
			if let q = s.firstIndex(of: "?") { s = String(s[..<q]) }
			if let colon = s.firstIndex(of: ":") { s = String(s[..<colon]) }
		}
		if s.hasPrefix("www.") { s = String(s.dropFirst(4)) }
		return s
	}

	// A login matches the page if any of its (normalized) hostnames equals the requested
	// host or is a subdomain either way (login.github.com ~ github.com).
	private func matchesRequested(_ c: Cred) -> Bool {
		guard !pendingHosts.isEmpty else { return false }
		let services = c.services.map { normalizeHost($0) }.filter { !$0.isEmpty }
		return services.contains { s in
			pendingHosts.contains { w in s == w || s.hasSuffix("." + w) || w.hasSuffix("." + s) }
		}
	}

	// --- App Group reads ---

	private func loadBundle() -> (iv: String, ct: String)? {
		guard let data = UserDefaults(suiteName: BrambleVault.appGroup)?.data(forKey: BrambleVault.bundleKey),
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let iv = d["iv"] as? String, let ct = d["ciphertext"] as? String
		else { return nil }
		return (iv, ct)
	}

	private func loadSlot() -> Slot? {
		guard let data = UserDefaults(suiteName: BrambleVault.appGroup)?.data(forKey: BrambleVault.slotKey),
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

	// --- keep-unlocked session (device-unlock-gated VEK cache, time-limited) ---

	private func keepUnlockedMinutes() -> Int {
		UserDefaults(suiteName: BrambleVault.appGroup)?.integer(forKey: BrambleVault.keepUnlockedKey) ?? 0
	}

	private func sessionBaseQuery() -> [String: Any] {
		[
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.sessionService,
			kSecAttrAccount as String: BrambleVault.vekAccount,
			kSecAttrAccessGroup as String: BrambleVault.accessGroup,
		]
	}

	private func saveSession(_ vek: String) {
		// 0 = off; positive = minute window; negative = never expire.
		guard keepUnlockedMinutes() != 0,
			let data = try? JSONSerialization.data(withJSONObject: [
				"vek": vek, "at": Date().timeIntervalSince1970,
			])
		else { return }
		SecItemDelete(sessionBaseQuery() as CFDictionary)
		var add = sessionBaseQuery()
		add[kSecValueData as String] = data
		add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
		SecItemAdd(add as CFDictionary, nil)
	}

	private func loadSession() -> String? {
		let minutes = keepUnlockedMinutes()
		guard minutes != 0 else { return nil }  // 0 = off
		var q = sessionBaseQuery()
		q[kSecReturnData as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		var item: CFTypeRef?
		guard SecItemCopyMatching(q as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
			let d = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
			let vek = d["vek"] as? String, let at = d["at"] as? Double
		else { return nil }
		// Positive = expiring window; negative = never expire (auto-lock "Never").
		if minutes > 0, Date().timeIntervalSince1970 - at > Double(minutes) * 60 {
			clearSession()
			return nil
		}
		return vek
	}

	private func clearSession() {
		SecItemDelete(sessionBaseQuery() as CFDictionary)
	}

	// --- hosting + Keychain ---

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

	private func vekExists() -> Bool {
		let q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: BrambleVault.biometricService,
			kSecAttrAccount as String: BrambleVault.vekAccount,
			kSecAttrAccessGroup as String: BrambleVault.accessGroup,
			kSecReturnData as String: false,
			kSecUseAuthenticationUI as String: kSecUseAuthenticationUISkip,
			kSecMatchLimit as String: kSecMatchLimitOne,
		]
		let status = SecItemCopyMatching(q as CFDictionary, nil)
		return status == errSecSuccess || status == errSecInteractionNotAllowed
	}

	// `.userPresence` access control makes SecItemCopyMatching present Face ID or the
	// device passcode; run off the main thread since it blocks while the prompt is up.
	private func readVek(reason: String, completion: @escaping (VekOutcome) -> Void) {
		DispatchQueue.global(qos: .userInitiated).async {
			let query: [String: Any] = [
				kSecClass as String: kSecClassGenericPassword,
				kSecAttrService as String: BrambleVault.biometricService,
				kSecAttrAccount as String: BrambleVault.vekAccount,
				kSecAttrAccessGroup as String: BrambleVault.accessGroup,
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
				completion(.denied(status == errSecUserCanceled ? "" : "Keychain status \(status)"))
			}
		}
	}

	private func showError(_ title: String, _ message: String) {
		let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: String(localized: "OK"), style: .default) { [weak self] _ in
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
private let brambleGlyphBase64 = "iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAABGdBTUEAALGPC/xhBQAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAARGVYSWZNTQAqAAAACAABh2kABAAAAAEAAAAaAAAAAAADoAEAAwAAAAEAAQAAoAIABAAAAAEAAACAoAMABAAAAAEAAACAAAAAAEiOBHcAAAHLaVRYdFhNTDpjb20uYWRvYmUueG1wAAAAAAA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIiB4OnhtcHRrPSJYTVAgQ29yZSA2LjAuMCI+CiAgIDxyZGY6UkRGIHhtbG5zOnJkZj0iaHR0cDovL3d3dy53My5vcmcvMTk5OS8wMi8yMi1yZGYtc3ludGF4LW5zIyI+CiAgICAgIDxyZGY6RGVzY3JpcHRpb24gcmRmOmFib3V0PSIiCiAgICAgICAgICAgIHhtbG5zOmV4aWY9Imh0dHA6Ly9ucy5hZG9iZS5jb20vZXhpZi8xLjAvIj4KICAgICAgICAgPGV4aWY6Q29sb3JTcGFjZT4xPC9leGlmOkNvbG9yU3BhY2U+CiAgICAgICAgIDxleGlmOlBpeGVsWERpbWVuc2lvbj4yNTA8L2V4aWY6UGl4ZWxYRGltZW5zaW9uPgogICAgICAgICA8ZXhpZjpQaXhlbFlEaW1lbnNpb24+MjUwPC9leGlmOlBpeGVsWURpbWVuc2lvbj4KICAgICAgPC9yZGY6RGVzY3JpcHRpb24+CiAgIDwvcmRmOlJERj4KPC94OnhtcG1ldGE+ClqepVwAABG3SURBVHgB7ZsL0F5FecfDLQQIoBjABHIFI+FWQNtyLx1HGI1aR0Ws7XBpnQ4gWKu02qIVkXbQ2tp26jg67QwEqoCh7VQBQVESVAJesE0BMzQJBgiBQAi5AAkQ+/sl79M8Lm+AfN/7fe/l7H/m/+2ze/ac8zz/3bO7Z8/7jRlTURWoClQFqgJVgapAVaAqUBWoClQFqgJVgapAVaAqUBWoClQFqgJVgapAVWBwFZhGaLKigQpMJea7WpzWwPgbHbINvgD+ssU7SafDigYoMIkY58Fo/EjnU+axRmGHRkW7JdhXkxwNJ8C9thSNWUP6OLwbPtkqq0lVYPAVGJQRYGea6lVwP7hnq9nWk66Eq+GGVtn2JrtygtfdF+7ROnkt6WPQ6z7fKuvbpN87gI39Xvg+eAg0PxaK5+A6+CBcCO+Di+Fy6DBvQz4LxTjoufvAiXA6nAWPhFPgeLgLFBuh5y6C18BrW3mSitFU4DhudhuMRdwrSV+gvp1iBVwKbUSpbZmjhnVeybWizjzqHw8rRkmBnbjPh+AqGI3Q7dQR5Y+hU1FfoVemgENRbTa8BzpExxz7NHaGw/tfwY/C7LtP7U/hUvgUtJM4nDt3H9hKdyfdHnhv3wwegq4lbGTvszecBo+BO8KAnfDv4F9Ap4kM7+15+jMJOr3cDO+FXUWv9NhTUeFzLSWeIV0Cz4E/apWZKPan4UVmEhzCL4NzYczpcdj49oPT4UFwMowO4eIuFnYO/S7qbOiH4TK4GD4A7YyuJzJ2I3M6vBjObB3YgdSOaV3LN8HA4Rj/AvUj7vkR7K53AHzoCXwFL2IYtxHOgPnp0knFVdSoZ3oTVNShwAZzYSe1hwI71bdg9kkfbdwMRyRjMraoa8wVKKA4t0KFmQePhyXOp8CRIcQznQN9irsNN5augtk3fT2vjWPHUWaM1jVmY288FND58FIY7/BZFBd8DqtZ4G+Sd07NMP8Z+F3oq5lTyjnwZHgQ9LhP+8vBOtadAU+CZ8HL4dfgd6B+trv3jZRnH/VZ30sY46ehMRt7V7FDV+++5ebjSCZAF1sZzrOfhA79Lv4CNvDvw0eigNQG/hJ8cyoLcyOGizlf86TD8CroYtG5Xzgv26g2iAu1iXB/qF9uBpX4NgU+4YvTgUnYV8PfTmXe24WhncZRIcO1iH6V65Zcp7H264j86zA/Udrfh1NghnUXwLLuSOfv5J7eO0Pf9LG8t7HEYjHXr3ahgKPBBXApLEV02Pcpy5hM5g5Y1h2tvPfWhwx91NfShwcouxAaY0WhgKK8Azq8l8JtouwKWC74HKadR8v6o52/BR/0JcOpZA5s54sxGqtTXOPhguj98HtwAywF8938T2BeA5AdcwC8FZb1u5W3UfUpQ59dvxhD6ZexzoO/B9stfCkebOxOeGfBH8NSHPM+9d+Ax8ISsyhQvHbndbNsPj4dWjpL3hiMxZja+acGZ0M1aQQOJ0qH7m0J8hOOvRu2mytPoHwRbCdkL5Tp24mwhLG4c3g33JafTiVqM9B4D9Etg6UIL1C2APpq5R5+iV0oOBf6Clee22v5x/HxfKjPJYzNGI3VmEvfH6TMjjKQ+AOiWgPLoB3OZ8O9YDv4VLzUEFperxfyjm6+CRzRLiDKjNWYnTZKf9XoHDhQOI1o1sEc7MPkfVL2gO0whcJPweUwn9dP9gp8vwROhe0wnsIPwjJGtTq13Qn9WOZO2g0wN9yPyR+1jWAmUH4RvB/mc/rZXkwsH4N+mWyHoyl07ZNjVDO163v8JhGshxGcn0BntInKsk9Bj0fdQUt/TmyXwoNhCbezc+xq9htlpX7Mfxanc0P+WRHEOPIfgEuKevmcQbMfINY/gsaeoTY5VrXrazi/L4QRlHPi9BSRu3vXpeNRrynpXGJXg4DaPAojfrXb1hopzunp9A14l4f/6wtvXe1GsE1NyxW/GoUWandMoVlHszt29GovvphzXd7huitV2QH7TSnfVFMN1CKQNVK7duuFqDvsdKQ7QN4ft1c7zwcc2l4fmQanapCH+VgLhST+bmDEMNIdwFe6gB9AVkWG9DXwtSnfVFMN1CKgRmoVyBpGWcfSTneAPQvP/DYeeBbjiciQGpgbIU2HGuRGfpy8WgWyhpapcZ4yot6Q0k51ADd1roS/k7zwFWdqyj+JbXCBfTHKDhPHmpSqgVoEfEjUKqCG+XXxneTnQDePho3hdoDD8OAL8HvwTOgrTMDXm2mRIX0E5g4whfxO6XhTTTVQi4AaqVVgGkZ+VfRV2t9Eqvk/wiPgkDHcDuBmxoehDj4EfW8N2HMnRobUrd08tM1Kx5puZi3USK0CaqiWATVW673hhdA2GDKG2wGu587rWnefT5pHgGPJ79o6ZvKDZNvrD0/5pps+xXk0zFqpoVoG1FithfsEX99sdemPTl8HfwlPSz5YrpOWy7XwSBhwyFsJ43jTU4f9qSEOqVqpWehyO3buIGrtMRs/l5MdfRzPLb8Jx6db+xHD3rk5AJasBjA2HX9XHKvp/zeymgTUSs2iAzjK5g9Daq3mJ8Cuw2kkb/jo0GdhOG/6cQsTvoidj1d7zBg1yVCzrIuaZqi52vccXLQsgeG8w1teqU4g/9/peNRreuriTm0CaqZ2oYua5kV11Ou59BPJaZ2/Buae+nbyzxV1Isgmp2qiNgE1U7usidr2NGbine+p4bQLmTx3uYPlwiWO1/RXtZiLNmoUULu8GFRbNe5ZlHP7FXiaAzqBvP8kWRu+vQZqcxIMqN2VMOtVrhWibtdTf/qVe+tT5H89eeWQdhXMwVT7xXpcjUb51U4NVyfd1Fitewr21K/B3KCfKzx0OMuB5LrV3qqdD85xhXZqmTVS67yuKqqPfvZQbvkEDCddsb42ubEz9vXpeNSr6VbNshb/gVb5H0vUsnyzmkXZsNGpXuS8tU/y5t+wXbAE3okhK16ZAr4NZL3UUk0Dr8E4OTLDSTvVAfKQtRGHbkpO7Yr9h7BT90qXHlhTrdRsXIpQTdU24A5sT8Bty5/BGMLux7aHBt6IkReHUa+mWzVrp8U6dMuLaDeJ1DbqqrnaDwudeCp17IDkxSLsVSk/G9u964rtU2APqr81neIaS20Daq72w0InOsCwHKgnv6QCPu0jik50APer/UfPwCEYeQq4gbzDWcX2KaBmN6ZT1PT1Ke+PQtR+WOhEB3Bh4nwUmIxxVGRIF8L8A4d0qJovoYCaqV3g1zCmRIb0v2BeFKZDr9zsRAfwbnekW7oweUvKb8D+Z7gplVXzpRVQKzVTu4Ca5kXfD+NAL6RuSjgcxQp1KfbE5JibGv+ejke9mm7VLGvhO7+bZ4ER2wiKGww3dSv4qzAH8fnioseSd5sz16n2i/VQo3Kv/28K3dRazXsKOr0GRqOWgTjd1I9BW/UJncpUjfLU7F5AfnDUuOwgFPUG/gk3ckAGk3uqW8bPFHVy/abbanMiDKjdlTDr8sU42IvpTJx6JDm8Hvu45KgB1R+E/GqD5sZVm/zA+KT7Ohh11FaNexoX4104bHod3Cl57IeO52CuU+0tmqhNwGngWpi1Udueh6v/xTAcdwvTd9jABIz6o9Ct+oROaqI2gSMx8puVmuY3q6g3rDQvNoZ6Ia/hvnTAYWpuZEj3gbNT3qBuT/lqblFATdQm4HeAvKPq9KC2ATXvRPvF9Yac+lnS7d490xX89U+eu9zV2jUdfxd29PyabtFCTQJjMewQoY1a+jYQUGs17/onYef2WNSdFt6RWj4f5gDy9rBbmivT8ajX1FQt8javw//apI9a5o0htVYrtVfrIWO4Q8gJ3Dm2fc/EjhXsC9jXJ6/2wHYjKPAwRv5+EOVNTdVCTQJqNT4ypGr5fCuvxmot1N42GDKG2wFO5842rjgZ7r/Z2vJnAcmGlM/DlR3kf9Kxppt+9FGTQG5UNVTLgBr/Viuj9u+JA0NJh9sBvsxN/wGuhgfCI2DgFxjLI0N6MNwt5e9LdtPNrIUaqVVADdUy4PTgAlDN1d42GDKG2wF8ij8MT4Fz4H4woIPZ8YnkJ8RB0mUw9/p0qFGmGjyYInblPynlH8BWy4AaXwVPgWp/D+wZ5HlLp66AsbB7EvtoGHgDhmVxvKmpGqhF4CiMrMsVcaCV+gbgOqAj2LEjV9l6kXVbzc1WngIc2vII4DtvWb84vRFZNViZIlWjPFVmDa22FvqwdASd7gClU3ljYywH3RQKPIGxIjINTtVgVYpfjdQqkDWMso6lI90BHkqeOmzNSPn12ItSvqmmGqhFQI3yEJ81jDodS0e6A/wvnj6dvHWHMOAwdmtkGpx+h9jzkJ41smOoYd/C99SFMBZ4j2HnUWBv8n4tjONNS41dDQLTMR6FoYPaxT5L1Om79PIUkIH9eRGB3wg+AJfACHzQU2M15nEw42Nkcuxq1/dwSHMoi8B+jn1wm6gcGS6BbopE3UFL723FmEdBijbjIP56PGJWszwdbK7Uj398wm+AEZjp3fAY2A6+Bv0pvB/mc/rZdh43pn1hO/ju/xOYY1QztRsInEoUvu/mAB8hfyEsN48o2ozJ/P1L6EeSfF4/2b7DG8MU2A7O7+fDMka1UrOBwtlEswaWDfgDyt4B94LtcBiF/wndMi3P7dX8Jnz9BtT3dnA3bzacB8sY1OhsOJB4N1Etg2XQCnYnvAA6BZTYmYJz4UpYnttreTduzoO7wBL7UOCxO2C7Dq02ajTQ8Km4Gdro7RrvZ5SfAXeDJfyk3MuLRBe4+VNu+O9q/3To2qddzGqhJofDRsDGPQv+CG5LEBdB7cQ8hPLbtnFeu2uNVtl8fJoFS9hpnQ621eHVQC3adXiKBxsuAN8Hvws3wLKx/I+Yi+BYmOHn0thBK8/pRt4dTb/RZ+jzR+FqWPpkrLfB90PXA42HQ+Tb4LYa1e/fzp8ZE8k4bJbijnZeH/Ql49Vk5sB2vthZXPQac0WhgKJ8EC6FpXg3UlY+ZZMp+2GbuuW5I5X33vqQoY9OX+U9l1J2AawNjwgvh9dR4VpYiugr4zSYYd0FsKw70nnv6b0zppLRx/Le7vnPzBV7xc6fHbvlk0/EvvDBwgHLPwnLNYDvzs6dy2HAbdQvwTdHQUo3YD8OV0A3n7T9/u7c/AwUu8NXQYdufXFI3x/6StpuN+7blJ8HF8OA65J/hadEAelG+LfwMzDuhbkZB/JXX57dkm3uX0W/BV4G220GfYhyhcxPldOBDZbhV7VLoI3zVfjX8Ex4EpwBPb4LfDlYx7qeczI8G14Or4EuVi+FHs8wr0/Zx+fI63sJF31ew5iNvfHYCQVuhYr3fXgiLHEuBT5BWeCryZcLw/K80cjbiPqSfdNXR4gSx1MwH1rXmI29AgW+AkPAJ7B/F5bifISyTame9W+GB8GhwOnPp10OdSr03t+C4bupPuprhrGcAVfCqGvMXcfOXfdgiwPuoAXGYVwMnV/vikLSv4fOzx9PZadi3wQvg3Ph0zBjLJn94HTokD4FHgC9jk9ubL74xD4JbaCH4TK4BP4C2iHXwwx9fC/Uz5npgI17OdTXjGPIfALG/Tx2n3+6jaH2/E77fRgXfCu8By6Hj8HVsF2D2tguDLPvPnU/hTbYWrgjdI1gQ7vYcjGXxSf7sohO4cJxJRd8lJvYQcZDG/SN0PsE9OHz0IZ2/s9wkek6QX8mwUPgLfBeWLGdCjicXgh9MmM47XaqLy749K1ilBQ4lvvcBren8V+g/jq4Ai6Fi1rUtsxj1tmea86jvr70JfIw2o8B7InTp0MXjQ6rDs/x3r4R2wZ1Pl8InXOd1x3Sne+dKhzmxTi4F3RdMBHOgF7vCDgVel3XE2ID9LquW66B10Gv1Zfo9w4QoruYjTnfTmFcNpJz9lPQRhsK7Ewxd9sJHBlsbNcoXvd5WFEV6F8FBmUE2J4WcJh3Fe+K3GFfrIGOFr5JOD1UDLACvobNg+VC73bK3COoaIAC04hxAYxOcCf2dFjRIAVc3d/V4rQGxV1DTQrY8LKiKlAVqApUBaoCVYGqQFWgKlAVqApUBaoCVYGqQFWgKlAVqApUBaoCVYGqwEAq8H8edQBcpvJh1QAAAABJRU5ErkJggg=="
