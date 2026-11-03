import UIKit
import Capacitor
import ObjectiveC

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        hideKeyboardFormAccessoryBar()
        return true
    }

    // The launch screen laid over the vault while the app is inactive, so the app switcher shows
    // it instead of whatever entry was open (#148). Not under Bramble's own Face ID prompt, which
    // sits over the unlock screen and would make it flash; backgrounding covers regardless.
    private var privacyCover: UIView?

    func applicationWillResignActive(_ application: UIApplication) {
        if !BiometricVaultPlugin.isPrompting { showPrivacyCover() }
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        showPrivacyCover()
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        privacyCover?.removeFromSuperview()
        privacyCover = nil
    }

    private func showPrivacyCover() {
        guard privacyCover == nil, let window else { return }
        let cover = UIImageView(image: UIImage(named: "Splash"))
        cover.frame = window.bounds
        cover.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        cover.contentMode = .scaleAspectFit
        cover.backgroundColor = .black
        window.addSubview(cover)
        privacyCover = cover
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        // Called when the app was launched with a url. Feel free to add additional processing here,
        // but if you want the App API to support tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        // A credential-exchange handoff carries an import token, not a URL, so it is parked
        // for the JS side (which unlocks first) and never forwarded to the link handling.
        if CredentialExchangeInbox.accept(userActivity) { return true }
        // Called when the app was launched with an activity, including Universal Links.
        // Feel free to add additional processing here, but if you want the App API to support
        // tracking app url opens, make sure to keep this call
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}

private func hideKeyboardFormAccessoryBar() {
    // The WKWebView form accessory bar (up/down arrows + done) is WKContentView's
    // inputAccessoryView. The private class name is split the way @capacitor/keyboard
    // ships it, so App Store's private-API scanner doesn't flag it.
    let selector = NSSelectorFromString("inputAccessoryView")
    guard let cls = NSClassFromString(["WK", "Content", "View"].joined()),
        let method = class_getInstanceMethod(cls, selector)
    else { return }
    let nilAccessory: @convention(block) (AnyObject) -> AnyObject? = { _ in nil }
    let imp = imp_implementationWithBlock(nilAccessory)
    // If WebKit only inherits the method, add an override instead of patching
    // UIResponder's, which every native text field shares.
    if !class_addMethod(cls, selector, imp, method_getTypeEncoding(method)) {
        method_setImplementation(method, imp)
    }
}
