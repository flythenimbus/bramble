import AVFoundation
import Capacitor
import Foundation
import UIKit

// Local Capacitor plugin: native QR scanning via AVFoundation. iOS WKWebView can't reach
// the camera through getUserMedia on the capacitor:// scheme (WebKit gates media capture to
// an http/https-scheme allowlist, separate from the secure-context check that lets WebCrypto
// work), so the in-webview jsQR path used on Android is dead on iOS. This presents a native
// AVCaptureSession that reads .qr metadata. No third-party deps. Used for sync pairing codes
// and TOTP otpauth:// QRs. See docs/mobile-port.md.
@objc(QrScannerPlugin)
public class QrScannerPlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "QrScannerPlugin"
	public let jsName = "QrScanner"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise)
	]

	@objc func scan(_ call: CAPPluginCall) {
		// AVFoundation triggers the system camera prompt the first time (notDetermined).
		switch AVCaptureDevice.authorizationStatus(for: .video) {
		case .authorized:
			presentScanner(call)
		case .notDetermined:
			AVCaptureDevice.requestAccess(for: .video) { granted in
				if granted {
					self.presentScanner(call)
				} else {
					call.reject("Camera permission denied", "denied")
				}
			}
		default:
			call.reject("Camera permission denied. Enable it in Settings, then try again.", "denied")
		}
	}

	private func presentScanner(_ call: CAPPluginCall) {
		DispatchQueue.main.async {
			guard let presenter = self.bridge?.viewController else {
				call.reject("No view controller to present the scanner")
				return
			}
			let scanner = QrScannerViewController()
			scanner.onResult = { value in
				if let value = value {
					call.resolve(["value": value])
				} else {
					call.resolve(["value": NSNull()]) // user cancelled
				}
			}
			scanner.modalPresentationStyle = .fullScreen
			presenter.present(scanner, animated: true)
		}
	}
}

// Full-screen camera preview that resolves the first decoded QR string (or nil on Cancel).
private class QrScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
	var onResult: ((String?) -> Void)?

	private let session = AVCaptureSession()
	private var preview: AVCaptureVideoPreviewLayer?
	private var finished = false
	private var configured = false

	override func viewDidLoad() {
		super.viewDidLoad()
		view.backgroundColor = .black

		let cancel = UIButton(type: .system)
		cancel.setTitle("Cancel", for: .normal)
		cancel.setTitleColor(.white, for: .normal)
		cancel.titleLabel?.font = .systemFont(ofSize: 17, weight: .semibold)
		cancel.backgroundColor = UIColor(white: 0.07, alpha: 0.9)
		cancel.translatesAutoresizingMaskIntoConstraints = false
		cancel.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)
		view.addSubview(cancel)
		NSLayoutConstraint.activate([
			cancel.leadingAnchor.constraint(equalTo: view.leadingAnchor),
			cancel.trailingAnchor.constraint(equalTo: view.trailingAnchor),
			cancel.bottomAnchor.constraint(equalTo: view.bottomAnchor),
			cancel.heightAnchor.constraint(equalToConstant: 96),
		])
	}

	// Configure once the VC is fully presented, so any failure path can dismiss reliably.
	override func viewDidAppear(_ animated: Bool) {
		super.viewDidAppear(animated)
		if configured { return }
		configured = true

		guard
			let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
				?? AVCaptureDevice.default(for: .video),
			let input = try? AVCaptureDeviceInput(device: device),
			session.canAddInput(input)
		else {
			finish(nil) // no camera (e.g. simulator)
			return
		}
		session.addInput(input)

		let output = AVCaptureMetadataOutput()
		guard session.canAddOutput(output) else {
			finish(nil)
			return
		}
		session.addOutput(output)
		output.setMetadataObjectsDelegate(self, queue: .main)
		output.metadataObjectTypes = [.qr]

		let preview = AVCaptureVideoPreviewLayer(session: session)
		preview.videoGravity = .resizeAspectFill
		preview.frame = view.layer.bounds
		if let conn = preview.connection, conn.isVideoOrientationSupported {
			conn.videoOrientation = .portrait
		}
		view.layer.insertSublayer(preview, at: 0) // below the Cancel button
		self.preview = preview

		// startRunning() blocks; keep it off the main thread.
		DispatchQueue.global(qos: .userInitiated).async { self.session.startRunning() }
	}

	override func viewDidLayoutSubviews() {
		super.viewDidLayoutSubviews()
		preview?.frame = view.layer.bounds
	}

	override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

	@objc private func cancelTapped() { finish(nil) }

	func metadataOutput(
		_ output: AVCaptureMetadataOutput,
		didOutput metadataObjects: [AVMetadataObject],
		from connection: AVCaptureConnection
	) {
		guard
			let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
			obj.type == .qr, let value = obj.stringValue
		else { return }
		finish(value)
	}

	private func finish(_ value: String?) {
		if finished { return }
		finished = true
		if session.isRunning {
			DispatchQueue.global(qos: .userInitiated).async { self.session.stopRunning() }
		}
		let cb = onResult
		dismiss(animated: true) { cb?(value) }
	}
}
