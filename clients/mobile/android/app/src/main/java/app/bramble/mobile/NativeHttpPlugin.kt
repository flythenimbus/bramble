package app.bramble.mobile

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit
import okhttp3.Call
import okhttp3.Callback
import okhttp3.CookieJar
import okhttp3.Headers.Companion.toHeaders
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response

/**
 * Outbound HTTP for hosts the WebView cannot reach.
 *
 * The WebView's origin is `https://localhost`, which an API that sends no CORS headers grants
 * nothing, so requests to those hosts leave from here instead. The JS name matches iOS's
 * `NativeHttp` so one shared adapter drives both. See @core/adapters/http.
 *
 * Two rules, and both need saying because the obvious implementations break them:
 *
 * **No ambient cookies.** `HttpURLConnection` is not usable here. It obeys the process-global
 * `CookieHandler.getDefault()`, and Capacitor's Bridge registers `CapacitorCookies` as a built-in
 * (Bridge.java) whose `load()` calls `CookieHandler.setDefault(...)` with `ACCEPT_ALL`, wiring the
 * WebView's cookie jar into every `java.net` client in this process. That happens whether or not
 * `CapacitorCookies` is enabled in config: the `enabled` flag only gates the JS-side shim. There
 * is no per-connection opt-out, which is why this uses OkHttp and states `CookieJar.NO_COOKIES`
 * on its own client. An ambient session outranking an Authorization header has already cost this
 * repo a day once (1255ab7b).
 *
 * **No redirects.** A redirect out of an API call means the session was rejected and the
 * destination is an HTML login page. The 3xx is returned as itself so the caller can say "bad
 * key" instead of failing opaquely on the login page.
 */
@CapacitorPlugin(name = "NativeHttp")
class NativeHttpPlugin : Plugin() {
    /**
     * One client for the plugin, so the connection pool is reused across calls.
     *
     * Requests are enqueued, never executed in place: Capacitor runs every plugin method in the
     * app on one shared thread ("CapacitorPlugins", Bridge.java), so a blocking call here would
     * hold up every other plugin, crypto and storage included, for as long as an upload takes.
     * iOS has the same rule for the same reason.
     */
    // OkHttp's default names the library, and DuckDuckGo answers that with a bare 403 (#123).
    private val userAgent by lazy {
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName
        } catch (e: Exception) {
            null
        }
        "Bramble/${version ?: "0"} (Android)"
    }

    private val client = OkHttpClient.Builder()
        .cookieJar(CookieJar.NO_COOKIES)
        .followRedirects(false)
        .followSslRedirects(false)
        // Writes time out per operation (OkHttp's default is 10s, too short for one write on a poor
        // uplink). Read and call timeouts are set per request in send(), scaled to the body.
        .connectTimeout(20, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .build()

    private fun headersOf(call: PluginCall): MutableMap<String, String> {
        val headers = mutableMapOf<String, String>()
        call.getObject("headers")?.let { obj ->
            for (key in obj.keys()) obj.getString(key)?.let { headers[key] = it }
        }
        return headers
    }

    @PluginMethod
    fun send(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("Missing url")
        val method = call.getString("method") ?: "GET"
        val headers = headersOf(call)

        // Bodies cross as base64, as the crypto plugin's bytes do: the bridge is JSON, and a
        // JSON string cannot carry arbitrary bytes.
        val body = call.getString("body")?.let { Base64.decode(it, Base64.NO_WRAP) }

        // OkHttp refuses a body on GET/HEAD and insists on one for POST/PUT/PATCH, so absence
        // has to mean "empty" everywhere else. Phrased as "which methods take no body" rather
        // than listing the ones that need one, so WebDAV's verbs (PROPFIND, MKCOL, REPORT)
        // work when backups start using this in turn.
        val requestBody = when {
            method in BODYLESS_METHODS -> null
            else -> (body ?: ByteArray(0))
                .toRequestBody(headers["Content-Type"]?.toMediaTypeOrNull())
        }
        enqueue(call, url, method, headers, requestBody, (body?.size ?: 0).toLong())
    }

    /**
     * `send`, with the body streamed from a file rather than carried across the bridge: a backup
     * too large for one message, spooled to disk by the webview a chunk at a time. OkHttp sends
     * the file's length as Content-Length, so a server can tell a short body from a whole one.
     */
    @PluginMethod
    fun sendFile(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("Missing url")
        val method = call.getString("method") ?: "PUT"
        val path = call.getString("path") ?: return call.reject("Missing path")
        val file = File(path)
        if (!file.isFile) return call.reject("The body file is missing")
        val headers = headersOf(call)
        val requestBody = file.asRequestBody(headers["Content-Type"]?.toMediaTypeOrNull())
        enqueue(call, url, method, headers, requestBody, file.length())
    }

    private fun enqueue(
        call: PluginCall,
        url: String,
        method: String,
        headers: Map<String, String>,
        requestBody: RequestBody?,
        bodySize: Long,
    ) {
        // Keeps the process running if Bramble is left mid-request. See TransferService.
        val transfer = Transfers.begin(context)
        val pending: Call
        try {
            val request = Request.Builder()
                .url(url)
                .method(method, requestBody)
                .headers(withUserAgent(headers, userAgent).toHeaders())
                .build()

            // The read timer starts once the body is handed to the OS, which may still be draining
            // megabytes of it over a slow uplink, so a flat read limit fails an upload that is still
            // moving. Scaled to the body at an 8 KiB/s floor, as on iOS; the call limit covers the
            // send and the wait after it.
            val idle = 60L + bodySize / 8_192L
            pending = client.newBuilder()
                .readTimeout(idle, TimeUnit.SECONDS)
                .callTimeout(maxOf(600L, 2 * idle), TimeUnit.SECONDS)
                .build()
                .newCall(request)
        } catch (e: Exception) {
            // A malformed URL or header: nothing was sent.
            Transfers.end(transfer)
            return call.reject(e.message ?: e.toString())
        }

        transfer.call = pending
        if (transfer.expired) pending.cancel()
        pending.enqueue(object : Callback {
            override fun onResponse(c: Call, response: Response) {
                try {
                    val bytes = response.use { it.body?.bytes() ?: ByteArray(0) }
                    call.resolve(
                        JSObject()
                            .put("status", response.code)
                            .put("body", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    )
                } catch (e: IOException) {
                    fail(e)
                } finally {
                    Transfers.end(transfer)
                }
            }

            override fun onFailure(c: Call, e: IOException) {
                try {
                    fail(e)
                } finally {
                    Transfers.end(transfer)
                }
            }

            private fun fail(e: IOException) {
                if (Transfers.interrupted(transfer)) {
                    // Same code as iOS, so the shared adapter reports it as interrupted, not failed.
                    call.reject("Bramble was closed before this finished", "interrupted")
                } else {
                    // Offline, DNS, TLS, timeout. All of them mean the same thing to the caller:
                    // the host was not reached, so nothing happened on the other end.
                    call.reject(e.message ?: e.toString())
                }
            }
        })
    }

    override fun handleOnStop() {
        super.handleOnStop()
        Transfers.onAppLeft()
    }

    private companion object {
        val BODYLESS_METHODS = setOf("GET", "HEAD")
    }
}

/** The request's own User-Agent when it set one, else [userAgent]. */
internal fun withUserAgent(headers: Map<String, String>, userAgent: String): Map<String, String> =
    if (headers.keys.any { it.equals("User-Agent", ignoreCase = true) }) headers
    else headers + ("User-Agent" to userAgent)
