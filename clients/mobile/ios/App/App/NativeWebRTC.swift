import Capacitor
import Foundation

// Local Capacitor plugin bridging the native WebRTC data channel (pure-Rust webrtc-rs in
// VaultCryptoFFI, via uniffi) to the webview. iOS WKWebView on the capacitor:// scheme
// exposes no RTCPeerConnection, so the shared @core sync transport dies on device; the JS
// shim (native-webrtc.ts) re-creates that surface on top of these methods + events. The
// uniffi free functions (webrtcCreatePeer(...), ...) live at App-module scope and are
// reached module-qualified as `App.<fn>`. iOS-only: the Android WebView has WebRTC, so
// this plugin (and the webrtc symbols) ship only in the iOS build. See docs/p2p-sync.md.
@objc(NativeWebRTCPlugin)
public class NativeWebRTCPlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "NativeWebRTCPlugin"
	public let jsName = "NativeWebRTC"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "createPeer", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "createDataChannel", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "createOffer", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "createAnswer", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "setLocalDescription", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "setRemoteDescription", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "addIceCandidate", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
		CAPPluginMethod(name: "close", returnType: CAPPluginReturnPromise),
	]

	// --- helpers (mirrors NativeCrypto.swift) ---

	// Off Capacitor's bridge queue, which runs every plugin call in the app: a webrtc-rs call stuck
	// on the network stalls sync alone, not the vault's reads and writes. Serial keeps peer order.
	private let work = DispatchQueue(label: "app.bramble.webrtc", qos: .userInitiated)

	private func run(_ call: CAPPluginCall, _ body: @escaping () throws -> Void) {
		work.async {
			do { try body() } catch { Self.fail(call, error) }
		}
	}

	private static func fail(_ call: CAPPluginCall, _ error: Error) {
		if case let CryptoError.Crypto(message) = error {
			call.reject(message)
		} else {
			call.reject(error.localizedDescription)
		}
	}

	// Peer handles are u32 minted in Rust; they round-trip as JS numbers.
	private func u32(_ call: CAPPluginCall, _ key: String) -> UInt32? {
		guard let v = call.getInt(key) else {
			call.reject("Missing \(key)")
			return nil
		}
		return UInt32(truncatingIfNeeded: v)
	}

	// --- peer lifecycle ---

	@objc func createPeer(_ call: CAPPluginCall) {
		guard let ice = call.getString("iceServersJson") else {
			call.reject("Missing iceServersJson")
			return
		}
		// A fresh observer per peer (uniffi retains it for the peer's lifetime); it forwards
		// events tagged with the peer handle to JS, so no shared/lazy plugin state is needed.
		let observer = WebRtcEventBridge(plugin: self)
		run(call) {
			let id = try App.webrtcCreatePeer(iceServersJson: ice, observer: observer)
			call.resolve(["value": Int(id)])
		}
	}

	@objc func createDataChannel(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer"), let label = call.getString("label") else { return }
		run(call) {
			try App.webrtcCreateDataChannel(peer: peer, label: label)
			call.resolve()
		}
	}

	@objc func createOffer(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer") else { return }
		run(call) { call.resolve(["value": try App.webrtcCreateOffer(peer: peer)]) }
	}

	@objc func createAnswer(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer") else { return }
		run(call) { call.resolve(["value": try App.webrtcCreateAnswer(peer: peer)]) }
	}

	@objc func setLocalDescription(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer") else { return }
		run(call) {
			try App.webrtcSetLocalDescription(peer: peer)
			call.resolve()
		}
	}

	@objc func setRemoteDescription(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer"), let type = call.getString("type"),
			let sdp = call.getString("sdp") else { return }
		run(call) {
			try App.webrtcSetRemoteDescription(peer: peer, sdpType: type, sdp: sdp)
			call.resolve()
		}
	}

	@objc func addIceCandidate(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer"), let json = call.getString("candidateJson") else { return }
		run(call) {
			try App.webrtcAddIceCandidate(peer: peer, candidateJson: json)
			call.resolve()
		}
	}

	@objc func send(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer"), let data = call.getString("data") else { return }
		run(call) {
			try App.webrtcSend(peer: peer, data: data)
			call.resolve()
		}
	}

	@objc func close(_ call: CAPPluginCall) {
		guard let peer = u32(call, "peer") else { return }
		// Queued too, so it can't overtake the peer's calls still waiting here.
		run(call) {
			App.webrtcClose(peer: peer)
			call.resolve()
		}
	}
}

// Forwards Rust connection events to JS via notifyListeners. The uniffi WebRtcObserver
// protocol is Sendable (the Rust trait is Send+Sync); events fire on webrtc-rs runtime
// threads, so each is hopped to main before touching the bridge. @unchecked: the only
// stored state is a weak plugin ref read on main.
final class WebRtcEventBridge: WebRtcObserver, @unchecked Sendable {
	private weak var plugin: CAPPlugin?

	init(plugin: CAPPlugin) {
		self.plugin = plugin
	}

	private func emit(_ event: String, _ data: [String: Any]) {
		let plugin = plugin
		DispatchQueue.main.async { plugin?.notifyListeners(event, data: data) }
	}

	func onIceCandidate(peer: UInt32, candidateJson: String) {
		emit("iceCandidate", ["peer": Int(peer), "candidateJson": candidateJson])
	}
	func onIceGatheringComplete(peer: UInt32) {
		emit("iceGatheringComplete", ["peer": Int(peer)])
	}
	func onDataChannelOpen(peer: UInt32) {
		emit("dataChannelOpen", ["peer": Int(peer)])
	}
	func onDataChannel(peer: UInt32) {
		emit("dataChannel", ["peer": Int(peer)])
	}
	func onMessage(peer: UInt32, data: String) {
		emit("message", ["peer": Int(peer), "data": data])
	}
	func onConnectionState(peer: UInt32, state: String) {
		emit("connectionState", ["peer": Int(peer), "state": state])
	}
	func onIceConnectionState(peer: UInt32, state: String) {
		emit("iceConnectionState", ["peer": Int(peer), "state": state])
	}
}
