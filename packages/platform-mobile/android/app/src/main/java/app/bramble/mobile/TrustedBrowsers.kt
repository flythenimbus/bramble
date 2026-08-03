package app.bramble.mobile

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import java.security.MessageDigest

// A curated allow-list of browsers we trust to vouch for a web page's origin. An autofill
// request's `webDomain` is attacker-controllable (any app can set it on a virtual view
// structure), so we honour it ONLY when the caller is a known browser: its package is listed
// here AND its actual signing certificate matches an allow-listed SHA-256 fingerprint. The
// certificate is OS-verified, so a malicious app cannot impersonate a browser.
//
// Source of the package + fingerprint values: Google's GPM privileged-apps list
//   https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json
// This is a maintained subset; keep it in sync (ideally by bundling the full file). A WRONG or
// MISSING fingerprint fails closed: that browser is treated as untrusted and its web autofill
// stops working, so confirm every entry on-device before shipping. The passkey provider reuses
// the same data via allowlistJson() for CallingAppInfo.getOrigin().
object TrustedBrowsers {

    // packageName -> allowed signing-cert SHA-256 fingerprints (uppercase, colon-separated hex,
    // matching the getPackageInfo signing-cert digest format).
    val BROWSERS: Map<String, Set<String>> = mapOf(
        "com.android.chrome" to
            setOf(
                "F0:FD:6C:5B:41:0F:25:CB:25:C3:B5:33:46:C8:97:2F:AE:30:F8:EE:74:11:DF:91:04:80:AD:6B:2D:60:DB:83",
                "19:75:B2:F1:71:77:BC:89:A5:DF:F3:1F:9E:64:A6:CA:E2:81:A5:3D:C1:D1:D5:9B:1D:14:7F:E1:C8:2A:FA:00",
            ),
        "org.mozilla.firefox" to
            setOf("A7:8B:62:A5:16:5B:44:94:B2:FE:AD:9E:76:A2:80:D2:2D:93:7F:EE:62:51:AE:CE:59:94:46:B2:EA:31:9B:04"),
        "com.microsoft.emmx" to
            setOf("01:E1:99:97:10:A8:2C:27:49:B4:D5:0C:44:5D:C8:5D:67:0B:61:36:08:9D:0A:76:6A:73:82:7C:82:A1:EA:C9"),
        "com.brave.browser" to
            setOf("9C:2D:B7:05:13:51:5F:DB:FB:BC:58:5B:3E:DF:3D:71:23:D4:DC:67:C9:4F:FD:30:63:61:C1:D7:9B:BF:18:AC"),
        "com.duckduckgo.mobile.android" to
            setOf("BB:7B:B3:1C:57:3C:46:A1:DA:7F:C5:C5:28:A6:AC:F4:32:10:84:56:FE:EC:50:81:0C:7F:33:69:4E:B3:D2:D4"),
        "com.opera.mini.native" to
            setOf("57:AC:BC:52:5F:1B:2E:BD:19:19:6C:D6:F0:14:39:7C:C9:10:FD:18:84:1E:0A:E8:50:FE:BC:3E:1E:59:3F:F2"),
        // Vivaldi self-signs its three channels with one key. Added while diagnosing #42, but not a
        // fix for it: the reported failure is the get-flow entry, not origin trust.
        "com.vivaldi.browser" to
            setOf("E8:A7:85:44:65:5B:A8:C0:98:17:F7:32:76:8F:56:89:B1:66:2E:C4:B2:BC:5A:0B:C0:EC:13:8D:33:CA:3D:1E"),
        "com.vivaldi.browser.snapshot" to
            setOf("E8:A7:85:44:65:5B:A8:C0:98:17:F7:32:76:8F:56:89:B1:66:2E:C4:B2:BC:5A:0B:C0:EC:13:8D:33:CA:3D:1E"),
        "com.vivaldi.browser.sopranos" to
            setOf("E8:A7:85:44:65:5B:A8:C0:98:17:F7:32:76:8F:56:89:B1:66:2E:C4:B2:BC:5A:0B:C0:EC:13:8D:33:CA:3D:1E"),
        // Privacy browsers NOT in Google's GPM list, so permanent MANUAL entries. Fingerprints are read
        // on-device (never guessed), not from GPM. Vanadium (GrapheneOS Chromium, shipped as Trichrome)
        // is signed with the GrapheneOS release key. See docs/sec-audit-7726.md B2 / #9.
        "app.vanadium.browser" to
            setOf("C6:AD:B8:B8:3C:6D:4C:17:D2:92:AF:DE:56:FD:48:8A:51:D3:16:FF:8F:2C:11:C5:41:02:23:BF:F8:A7:DB:B3"),
        // IronFox (hardened Gecko, Mull successor; package changed from us.spotco.fennec_dos).
        "org.ironfoxoss.ironfox" to
            setOf("C5:E2:91:B5:A5:71:F9:C8:CD:9A:97:99:C2:C9:4E:02:EC:97:03:94:88:93:F2:CA:75:6D:67:B9:42:04:F9:04"),
        // Firefox from F-Droid (Fenix, "Fennec" flavour): a SEPARATE package with F-Droid's signing key,
        // so the GPM org.mozilla.firefox entry doesn't cover it. Common on GrapheneOS. Read on-device.
        "org.mozilla.fennec_fdroid" to
            setOf("06:66:53:58:EF:D8:BA:05:BE:23:6A:47:A1:2C:B0:95:8D:7D:75:DD:93:9D:77:C2:B3:1F:53:98:53:7E:BD:C5"),
    )

    /** True iff `packageName` is an allow-listed browser AND its real signing cert matches. */
    fun isTrustedBrowser(context: Context, packageName: String?): Boolean {
        val pkg = packageName ?: return false
        val allowed = BROWSERS[pkg] ?: return false
        return signingFingerprints(context.packageManager, pkg).any { it in allowed }
    }

    /** The allow-list as the JSON string `CallingAppInfo.getOrigin()` expects (Google's GPM
     * privileged-apps format), built from BROWSERS so there is a single source of truth. The
     * package names and fingerprints contain no JSON-special characters, so plain concatenation is
     * safe. Used by the passkey provider to decide whether to trust a caller-supplied origin. */
    fun allowlistJson(): String {
        val apps =
            BROWSERS.entries.joinToString(",") { (pkg, fingerprints) ->
                val signatures =
                    fingerprints.joinToString(",") {
                        """{"build":"release","cert_fingerprint_sha256":"$it"}"""
                    }
                """{"type":"android","info":{"package_name":"$pkg","signatures":[$signatures]}}"""
            }
        return """{"apps":[$apps]}"""
    }

    /** SHA-256 of a signing certificate's DER bytes, formatted like the allow-list (uppercase,
     * colon-separated). Exposed for unit tests. */
    internal fun certFingerprint(der: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(der)
        return digest.joinToString(":") { "%02X".format(it) }
    }

    /** The SHA-256 fingerprints of a package's current signing certificates (uppercase,
     * colon-separated). Empty if the package is absent or unreadable. Shared with the Digital
     * Asset Links check. */
    internal fun signingFingerprints(pm: PackageManager, pkg: String): Set<String> =
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNING_CERTIFICATES)
                (info.signingInfo?.apkContentsSigners ?: emptyArray())
                    .map { certFingerprint(it.toByteArray()) }
                    .toSet()
            } else {
                @Suppress("DEPRECATION")
                val info = pm.getPackageInfo(pkg, PackageManager.GET_SIGNATURES)
                @Suppress("DEPRECATION")
                (info.signatures ?: emptyArray()).map { certFingerprint(it.toByteArray()) }.toSet()
            }
        } catch (e: Exception) {
            emptySet()
        }
}
