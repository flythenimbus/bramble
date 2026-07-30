import AuthenticationServices
import Capacitor
import Foundation
import UIKit

// Credential exchange (FIDO CXP/CXF), iOS 26+. The OS runs the transfer: it shows the
// out-of-process consent UI, establishes both app identities, and moves the payload without
// anything touching the filesystem. We only supply and consume CXF JSON, which the shared
// TS mapper in @vault/core/exchange builds and parses. Apple's ASExportedCredentialData
// encodes CXF verbatim, so this layer is a JSONDecoder pass-through with no field mapping.
// See docs/credential-exchange.md.
//
// The whole surface is availability-gated: the deployment target stays at 15.0, and on
// anything older `isAvailable` reports false and the UI hides the entry points.

/// Where the AppDelegate leaves an import token for the JS side to pick up.
///
/// The activity can arrive at a cold launch into a LOCKED vault, so the token is parked
/// here rather than acted on: JS unlocks first, then asks for it. Reads are destructive so
/// a token can't be replayed into a second vault.
enum CredentialExchangeInbox {
	/// Apple's `ASCredentialExchangeActivityType`, spelled out so this file still compiles
	/// against pre-26 SDKs (the symbol is 26+).
	static let activityType = "ASCredentialExchangeActivity"
	/// Key for the `UUID` in the activity's userInfo (`ASCredentialImportToken`).
	static let tokenKey = "ASCredentialImportToken"
	/// Posted when a token lands, so the plugin can wake the webview if it is already up.
	static let didArrive = Notification.Name("BrambleCredentialExchangeTokenDidArrive")

	private static let lock = NSLock()
	private static var pending: UUID?

	static func deposit(_ token: UUID) {
		lock.lock()
		pending = token
		lock.unlock()
		NotificationCenter.default.post(name: didArrive, object: nil)
	}

	/// Takes the token and clears it; a second read gets nothing.
	static func take() -> UUID? {
		lock.lock()
		defer { lock.unlock() }
		let token = pending
		pending = nil
		return token
	}

	/// True when this is a credential-exchange handoff, in which case the AppDelegate must
	/// not pass it on to Capacitor's universal-link handling.
	static func accept(_ activity: NSUserActivity) -> Bool {
		guard activity.activityType == activityType else { return false }
		guard let token = activity.userInfo?[tokenKey] as? UUID else { return false }
		deposit(token)
		return true
	}
}

@objc(CredentialExchangePlugin)
public class CredentialExchangePlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "CredentialExchangePlugin"
	public let jsName = "CredentialExchange"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "requestExport", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "exportCredentials", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "consumeImportToken", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "importCredentials", returnType: CAPPluginReturnPromise),
	]

	/// The manager that `requestExport` negotiated with, held for the `exportCredentials`
	/// that follows: the two calls are one session and the second must reuse the first's
	/// instance. Typed `Any?` because a stored property can't carry an @available bound.
	private var pendingExport: Any?

	public override func load() {
		NotificationCenter.default.addObserver(
			self, selector: #selector(onTokenArrived), name: CredentialExchangeInbox.didArrive,
			object: nil)
	}

	@objc private func onTokenArrived() {
		notifyListeners("importAvailable", data: [:])
	}

	// MARK: - Capability

	@objc func isAvailable(_ call: CAPPluginCall) {
		// Reported even when unavailable, so the UI can say "needs iOS 26, this is 18.5"
		// rather than silently hiding the feature and leaving nothing to diagnose.
		let osVersion = UIDevice.current.systemVersion
		guard #available(iOS 26.0, *) else {
			call.resolve(["available": false, "providerEnabled": false, "osVersion": osVersion])
			return
		}
		// The exchange capability is declared by our credential-provider extension, so the
		// OS only offers us once the user has enabled Bramble under AutoFill. Reported
		// separately from `available` so the UI can say which of the two is missing.
		ASCredentialIdentityStore.shared.getState { state in
			call.resolve([
				"available": true, "providerEnabled": state.isEnabled, "osVersion": osVersion,
			])
		}
	}

	// MARK: - Export (we are the source)

	/// Opens the system's importer picker and returns the CXF version it negotiated. The
	/// caller builds a payload at that version and passes it to `exportCredentials`.
	@objc func requestExport(_ call: CAPPluginCall) {
		guard #available(iOS 26.0, *) else {
			call.reject("Credential exchange needs iOS 26 or later.")
			return
		}
		let importer = call.getString("importerBundleId")
		DispatchQueue.main.async {
			guard let anchor = self.bridge?.viewController?.view.window else {
				call.reject("No window to present the export sheet from.")
				return
			}
			let manager = ASCredentialExportManager(presentationAnchor: anchor)
			Task {
				do {
					let options = try await manager.requestExport(for: importer)
					self.pendingExport = manager
					call.resolve(["formatVersion": options.formatVersion.rawValue])
				} catch {
					self.pendingExport = nil
					call.reject(error.localizedDescription, nil, error)
				}
			}
		}
	}

	/// Hands the CXF payload to the OS, which delivers it to the app the user picked.
	@objc func exportCredentials(_ call: CAPPluginCall) {
		guard #available(iOS 26.0, *) else {
			call.reject("Credential exchange needs iOS 26 or later.")
			return
		}
		guard let json = call.getString("cxfJson"), let data = json.data(using: .utf8) else {
			call.reject("Missing the credential payload.")
			return
		}
		guard let manager = pendingExport as? ASCredentialExportManager else {
			call.reject("Call requestExport before exporting.")
			return
		}
		Task {
			// Cleared either way: an export session is single-use, and holding a stale
			// manager would let a later call export against the wrong destination.
			defer { self.pendingExport = nil }
			do {
				let payload = try JSONDecoder().decode(ASExportedCredentialData.self, from: data)
				try await manager.exportCredentials(payload)
				call.resolve()
			} catch {
				call.reject(error.localizedDescription, nil, error)
			}
		}
	}

	// MARK: - Import (we are the destination)

	@objc func consumeImportToken(_ call: CAPPluginCall) {
		guard let token = CredentialExchangeInbox.take() else {
			call.resolve([:])
			return
		}
		call.resolve(["token": token.uuidString])
	}

	/// Redeems a token for the exporter's payload. The token is one-shot on the OS side too.
	@objc func importCredentials(_ call: CAPPluginCall) {
		guard #available(iOS 26.0, *) else {
			call.reject("Credential exchange needs iOS 26 or later.")
			return
		}
		guard let raw = call.getString("token"), let token = UUID(uuidString: raw) else {
			call.reject("Missing the import token.")
			return
		}
		Task {
			do {
				let data = try await ASCredentialImportManager().importCredentials(token: token)
				let json = try JSONEncoder().encode(data)
				call.resolve(["cxfJson": String(decoding: json, as: UTF8.self)])
			} catch {
				call.reject(error.localizedDescription, nil, error)
			}
		}
	}
}
