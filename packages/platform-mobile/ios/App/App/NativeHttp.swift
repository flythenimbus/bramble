import Capacitor
import Foundation
import UIKit

/**
 * Outbound HTTP for hosts the WKWebView cannot reach.
 *
 * The WebView's origin is `capacitor://localhost`, which an API that sends no CORS headers grants
 * nothing, so requests to those hosts leave from here instead. The `jsName` matches Android's
 * plugin so one shared adapter drives both. See @core/adapters/http.
 *
 * Two rules, and `CapacitorHttp` keeps neither, which is why this exists rather than using it:
 * its `HttpRequestHandler` calls `setCookiesFromResponse` on every reply, parsing the host's
 * `Set-Cookie` into the Capacitor cookie manager and syncing it into the WebView, and outbound
 * the `URLRequest` default of `httpShouldHandleCookies = true` attaches whatever is in shared
 * storage. An ambient session outranking an Authorization header has already cost this repo a
 * day once (1255ab7b).
 *
 * So: an ephemeral session that accepts no cookies and a delegate that refuses redirects. A
 * redirect out of an API call means the session was rejected and the destination is an HTML
 * login page, so the 3xx is returned as itself and the caller can say "bad key" rather than
 * failing opaquely somewhere else.
 */
@objc(NativeHttpPlugin)
public class NativeHttpPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeHttpPlugin"
    public let jsName = "NativeHttp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "send", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendFile", returnType: CAPPluginReturnPromise)
    ]

    /// Answers every redirect with "do not follow", which surfaces the 3xx as the response.
    private class RefuseRedirects: NSObject, URLSessionTaskDelegate {
        func urlSession(
            _ session: URLSession,
            task: URLSessionTask,
            willPerformHTTPRedirection response: HTTPURLResponse,
            newRequest request: URLRequest,
            completionHandler: @escaping (URLRequest?) -> Void
        ) {
            completionHandler(nil)
        }
    }

    private let redirectDelegate = RefuseRedirects()

    /// One session for the plugin, so connections are reused and the delegate is retained once.
    /// Cookies are refused four ways because each one alone has been enough to miss: no storage,
    /// no accept policy, no set, and `httpShouldHandleCookies = false` per request below.
    private lazy var session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        // Per-request timeouts are set in send(), scaled to the body. This is only the ceiling.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 3600
        return URLSession(configuration: config, delegate: redirectDelegate, delegateQueue: nil)
    }()

    /// The request `call` describes, minus its body. Nil, with the call rejected, if malformed.
    private func request(for call: CAPPluginCall) -> URLRequest? {
        guard let raw = call.getString("url"), let url = URL(string: raw) else {
            call.reject("Missing or unparseable url")
            return nil
        }
        var request = URLRequest(url: url)
        request.httpMethod = call.getString("method") ?? "GET"
        request.httpShouldHandleCookies = false
        if let headers = call.getObject("headers") {
            for (name, value) in headers {
                if let value = value as? String {
                    request.setValue(value, forHTTPHeaderField: name)
                }
            }
        }
        return request
    }

    /// iOS's request timeout counts only data RECEIVED, and nothing arrives while a body is
    /// uploading, so it has to cover the whole upload. Measured: a 2 MiB upload at 20 KiB/s,
    /// bytes moving the entire time, died at exactly 60s with a flat limit. Scaled to the body
    /// at an 8 KiB/s floor (a poor 2G uplink), a small request keeps ~60s to notice a stall and
    /// a vault gets time: 2 MiB gets about five minutes.
    private func timeout(forBody size: Int) -> TimeInterval {
        60 + Double(size) / 8_192
    }

    @objc func send(_ call: CAPPluginCall) {
        guard var request = request(for: call) else { return }
        // Bodies cross as base64, as the crypto plugin's bytes do: the bridge is JSON, and a JSON
        // string cannot carry arbitrary bytes.
        if let encoded = call.getString("body") {
            guard let body = Data(base64Encoded: encoded) else {
                call.reject("Request body was not valid base64")
                return
            }
            request.httpBody = body
        }
        request.timeoutInterval = timeout(forBody: request.httpBody?.count ?? 0)
        run(call) { done in self.session.dataTask(with: request, completionHandler: done) }
    }

    /// `send`, with the body streamed from a file rather than carried across the bridge: a backup
    /// too large for one message, spooled to disk by the webview a chunk at a time. The length
    /// is the file's, declared in full, so a server can tell a short body from a whole one.
    @objc func sendFile(_ call: CAPPluginCall) {
        guard var request = request(for: call) else { return }
        guard let path = call.getString("path") else {
            call.reject("Missing path")
            return
        }
        let file = URL(fileURLWithPath: path)
        guard let size = (try? FileManager.default.attributesOfItem(atPath: path))?[.size] as? Int
        else {
            call.reject("The body file is missing")
            return
        }
        request.timeoutInterval = timeout(forBody: size)
        run(call) { done in self.session.uploadTask(with: request, fromFile: file, completionHandler: done) }
    }

    private func run(
        _ call: CAPPluginCall,
        makeTask: (@escaping @Sendable (Data?, URLResponse?, Error?) -> Void) -> URLSessionTask
    ) {
        // A request outlives the app being left. iOS suspends an app within seconds of it going to
        // the background, which would freeze an upload partway, so each request asks for the time
        // to finish. If even that runs out, the request is stopped here and reported as
        // "interrupted", which the caller retries, rather than surfacing later as a network error
        // nobody can explain. Created before the background time is asked for, and only started
        // after, so the expiry handler always has a real task to cancel.
        let state = NSLock()
        var expired = false
        var background = UIBackgroundTaskIdentifier.invalid
        let finishBackground = {
            state.lock()
            let id = background
            background = .invalid
            state.unlock()
            if id != .invalid { UIApplication.shared.endBackgroundTask(id) }
        }

        // Resolved from the completion handler, never waited on. The bridge dispatches EVERY
        // plugin call in the app on one serial queue, so blocking here would stall every other
        // plugin for the length of a network request. See BiometricVault's keychainQueue.
        let task = makeTask { data, response, error in
            defer { finishBackground() }
            state.lock()
            let wasExpired = expired
            state.unlock()
            if wasExpired {
                call.reject("Bramble was closed before this finished", "interrupted")
                return
            }
            if let error = error {
                // Offline, DNS, TLS, timeout. All mean the host was not reached, so nothing
                // happened on the other end.
                call.reject(error.localizedDescription)
                return
            }
            guard let http = response as? HTTPURLResponse else {
                call.reject("The host did not answer with an HTTP response")
                return
            }
            call.resolve([
                "status": http.statusCode,
                "body": (data ?? Data()).base64EncodedString()
            ])
        }
        let id = UIApplication.shared.beginBackgroundTask(withName: "Bramble transfer") {
            state.lock()
            expired = true
            state.unlock()
            task.cancel()
            finishBackground()
        }
        state.lock()
        background = id
        state.unlock()
        task.resume()
    }
}
