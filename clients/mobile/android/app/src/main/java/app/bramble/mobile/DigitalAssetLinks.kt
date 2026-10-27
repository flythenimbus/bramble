package app.bramble.mobile

import android.content.Context
import android.util.Log
import java.net.InetAddress
import java.net.URL
import java.util.Collections
import java.util.concurrent.TimeUnit
import javax.net.ssl.HttpsURLConnection
import org.json.JSONArray

// Digital Asset Links: safely restores native-app -> web autofill. A non-browser app has no
// trustworthy web domain (its webDomain is spoofable and its package name is not a web identity),
// so we never auto-match one on a guess. Instead we CONFIRM the association: fetch the candidate
// domain's https://<domain>/.well-known/assetlinks.json and require a statement that grants THIS
// app (its package + real signing cert) a credential relation. Only then do we offer that domain's
// logins. So com.github.android fills github.com only because github.com's assetlinks.json vouches
// for it. See docs/mobile-port.md.
//
// The check is I/O, so verifiedDomainsFor() never blocks the autofill request: it serves a cached
// result and refreshes in the background. The first request for a new app therefore shows the
// searchable list; once the cache warms, later requests auto-fill.
object DigitalAssetLinks {

    private const val PREFS = "bramble_dal_cache"
    private val TTL_MS = TimeUnit.DAYS.toMillis(7)
    private const val CONNECT_TIMEOUT_MS = 4000
    private const val READ_TIMEOUT_MS = 4000
    private const val MAX_BODY_BYTES = 256 * 1024

    // Relations that let a domain vouch for an app handling its logins.
    private val ACCEPTED_RELATIONS =
        setOf("delegate_permission/common.get_login_creds", "delegate_permission/common.handle_all_urls")

    // Packages with a refresh in flight, so concurrent fill requests don't fetch in parallel.
    private val refreshing = Collections.synchronizedSet(HashSet<String>())

    /** One `statement` from an assetlinks.json file, reduced to the fields the grant check needs. */
    internal data class AssetStatement(
        val relations: List<String>,
        val namespace: String,
        val packageName: String,
        val certFingerprints: List<String>,
    )

    /** Verified web domains this app is associated with, from the cache. NON-BLOCKING: on a cache
     * miss or a stale entry it kicks off a background refresh and returns whatever is cached now
     * (possibly empty). */
    fun verifiedDomainsFor(context: Context, packageName: String?): List<String> {
        val pkg = packageName ?: return emptyList()
        val cached = readCache(context, pkg)
        if (cached == null || cached.expiresAt <= nowMillis()) refreshAsync(context, pkg)
        return cached?.domains ?: emptyList()
    }

    /** Reverse-DNS candidate domain(s) for a package (com.github.android -> github.com). Only a
     * HINT: each is confirmed against its own assetlinks.json before it is trusted. Exposed for
     * tests. */
    internal fun candidateDomains(pkg: String): List<String> {
        val parts = pkg.split('.').filter { it.isNotEmpty() }
        if (parts.size < 2) return emptyList()
        return listOf("${parts[1]}.${parts[0]}".lowercase())
    }

    /** Whether any `statements` (already parsed) grant `pkg`, signed by one of `appFingerprints`, a
     * login relation for android_app. Pure and default-deny; the security-critical decision.
     * Exposed for tests. */
    internal fun grants(
        statements: List<AssetStatement>,
        pkg: String,
        appFingerprints: Set<String>,
    ): Boolean {
        if (appFingerprints.isEmpty()) return false
        val app = appFingerprints.map { normalizeFingerprint(it) }.toSet()
        return statements.any { st ->
            st.namespace == "android_app" &&
                st.packageName == pkg &&
                st.relations.any { it in ACCEPTED_RELATIONS } &&
                st.certFingerprints.any { normalizeFingerprint(it) in app }
        }
    }

    private fun normalizeFingerprint(s: String): String = s.trim().uppercase()

    // ---- background refresh (I/O) ----

    private fun refreshAsync(context: Context, pkg: String) {
        if (!refreshing.add(pkg)) return
        val appContext = context.applicationContext
        Thread {
            try {
                val fingerprints = TrustedBrowsers.signingFingerprints(appContext.packageManager, pkg)
                val verified =
                    if (fingerprints.isEmpty()) {
                        emptyList()
                    } else {
                        candidateDomains(pkg).filter { domain -> verifyAssociation(domain, pkg, fingerprints) }
                    }
                writeCache(appContext, pkg, verified, nowMillis() + TTL_MS)
            } catch (e: Exception) {
                Log.w(BrambleAutofill.LOG_TAG, "DAL refresh failed for $pkg", e)
            } finally {
                refreshing.remove(pkg)
            }
        }
            .apply { isDaemon = true }
            .start()
    }

    private fun verifyAssociation(domain: String, pkg: String, appFingerprints: Set<String>): Boolean {
        val body = fetch("https://$domain/.well-known/assetlinks.json") ?: return false
        return grants(parseStatements(body), pkg, appFingerprints)
    }

    /** Parse an assetlinks.json body into statements (org.json; device-side). Malformed input
     * yields an empty list, so it fails closed. */
    private fun parseStatements(json: String): List<AssetStatement> =
        try {
            val arr = JSONArray(json)
            (0 until arr.length()).mapNotNull { i ->
                val s = arr.optJSONObject(i) ?: return@mapNotNull null
                val target = s.optJSONObject("target") ?: return@mapNotNull null
                val relations = s.optJSONArray("relation").toStringList()
                val certs = target.optJSONArray("sha256_cert_fingerprints").toStringList()
                AssetStatement(
                    relations = relations,
                    namespace = target.optString("namespace"),
                    packageName = target.optString("package_name"),
                    certFingerprints = certs,
                )
            }
        } catch (e: Exception) {
            emptyList()
        }

    private fun JSONArray?.toStringList(): List<String> {
        if (this == null) return emptyList()
        return (0 until length()).map { optString(it) }
    }

    private fun fetch(urlStr: String): String? {
        var conn: HttpsURLConnection? = null
        return try {
            val url = URL(urlStr)
            if (!url.protocol.equals("https", ignoreCase = true)) return null
            // SSRF hardening (B3): the host is derived from the caller's OWN package name, but its DNS
            // is attacker-controllable, so refuse an IP literal, a bare (non-registrable) hostname, or a
            // host that resolves to a private / loopback / link-local address (e.g. the cloud metadata
            // endpoint 169.254.169.254). The response is never exfiltrated, so this is defense in depth;
            // a resolve-then-connect (DNS-rebinding) gap remains, acceptable given the low impact.
            if (!isPublicHost(url.host)) return null
            conn =
                (url.openConnection() as HttpsURLConnection).apply {
                    connectTimeout = CONNECT_TIMEOUT_MS
                    readTimeout = READ_TIMEOUT_MS
                    // assetlinks.json must live at the exact well-known URL; do not chase a redirect
                    // to another location.
                    instanceFollowRedirects = false
                    requestMethod = "GET"
                }
            if (conn.responseCode != 200) return null
            conn.inputStream.use { input ->
                val buf = ByteArray(MAX_BODY_BYTES)
                var total = 0
                while (total < MAX_BODY_BYTES) {
                    val n = input.read(buf, total, MAX_BODY_BYTES - total)
                    if (n < 0) break
                    total += n
                }
                String(buf, 0, total, Charsets.UTF_8)
            }
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()
        }
    }

    /** A host we will fetch assetlinks.json from: a dotted domain name (not an IP literal, not a bare
     * hostname) whose DNS resolves entirely to global (public) addresses. Does the DNS lookup, so it
     * is called on the background refresh thread. Exposed for tests. */
    internal fun isPublicHost(host: String): Boolean {
        if (host.isEmpty() || !host.contains('.')) return false // require a registrable domain
        if (isIpLiteral(host)) return false
        return try {
            val addrs = InetAddress.getAllByName(host)
            addrs.isNotEmpty() && addrs.all { isGlobalAddress(it) }
        } catch (e: Exception) {
            false // unresolvable -> not fetchable
        }
    }

    /** True for an IPv4/IPv6 address literal; we only fetch named domains, never a raw IP. Test-exposed. */
    internal fun isIpLiteral(host: String): Boolean {
        if (host.contains(':')) return true // IPv6
        val octets = host.split('.')
        return octets.size == 4 &&
            octets.all {
                val n = it.toIntOrNull()
                n != null && n in 0..255
            }
    }

    /** False for loopback / any-local / link-local / private (RFC1918 + CGNAT 100.64/10) /
     * unique-local-v6 (fc00::/7) / multicast; true otherwise. Test-exposed. */
    internal fun isGlobalAddress(addr: InetAddress): Boolean {
        if (addr.isLoopbackAddress ||
            addr.isAnyLocalAddress ||
            addr.isLinkLocalAddress ||
            addr.isSiteLocalAddress ||
            addr.isMulticastAddress
        ) {
            return false
        }
        val b = addr.address
        if (b.size == 16 && (b[0].toInt() and 0xfe) == 0xfc) return false // fc00::/7 unique-local v6
        if (b.size == 4 && (b[0].toInt() and 0xff) == 100 && (b[1].toInt() and 0xff) in 64..127) {
            return false // 100.64.0.0/10 CGNAT
        }
        return true
    }

    // ---- cache (SharedPreferences: survives the short-lived :autofill process) ----

    private data class CacheEntry(val domains: List<String>, val expiresAt: Long)

    // Value format: "<expiresAtMillis>|<domain1>,<domain2>" (domains may be empty).
    private fun readCache(context: Context, pkg: String): CacheEntry? {
        val raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(pkg, null) ?: return null
        val bar = raw.indexOf('|')
        if (bar < 0) return null
        val expiresAt = raw.substring(0, bar).toLongOrNull() ?: return null
        val domains = raw.substring(bar + 1).split(',').filter { it.isNotEmpty() }
        return CacheEntry(domains, expiresAt)
    }

    private fun writeCache(context: Context, pkg: String, domains: List<String>, expiresAt: Long) {
        context
            .getSharedPreferences(PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(pkg, "$expiresAt|${domains.joinToString(",")}")
            .apply()
    }

    private fun nowMillis(): Long = System.currentTimeMillis()
}
