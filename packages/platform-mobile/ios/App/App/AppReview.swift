import Capacitor
import Foundation
import StoreKit
import UIKit

// Local Capacitor plugin: the system "rate this app" prompt. StoreKit owns the whole policy here,
// which is the point of using it rather than a card of our own - the OS shows it at most three
// times per year per app, suppresses it once the current version has been rated, and silently does
// nothing in TestFlight builds. Our side only decides that this is a reasonable moment to ask
// (core/app/review-nudge.ts) and never learns whether a prompt appeared.
//
// Apple's HIG forbids firing this from a button, so nothing user-facing calls it directly; the
// Settings "Rate Bramble" row opens the App Store's write-review URL instead.
@objc(AppReviewPlugin)
public class AppReviewPlugin: CAPPlugin, CAPBridgedPlugin {
	public let identifier = "AppReviewPlugin"
	public let jsName = "AppReview"
	public let pluginMethods: [CAPPluginMethod] = [
		CAPPluginMethod(name: "requestReview", returnType: CAPPluginReturnPromise)
	]

	@objc func requestReview(_ call: CAPPluginCall) {
		DispatchQueue.main.async {
			guard let scene = self.activeWindowScene() else {
				// No foreground scene means nothing could be presented anyway. Resolve rather than
				// reject: the caller has already spent its ask and a rejection would only surface
				// an error for something the user never asked for.
				call.resolve()
				return
			}
			if #available(iOS 18.0, *) {
				AppStore.requestReview(in: scene)
			} else {
				SKStoreReviewController.requestReview(in: scene)
			}
			call.resolve()
		}
	}

	/// The scene the prompt attaches to. The bridge's own window is the right one on a phone, and
	/// the foreground-active fallback covers a scene we were not handed.
	private func activeWindowScene() -> UIWindowScene? {
		if let scene = self.bridge?.viewController?.view.window?.windowScene { return scene }
		return UIApplication.shared.connectedScenes
			.compactMap { $0 as? UIWindowScene }
			.first { $0.activationState == .foregroundActive }
	}
}
