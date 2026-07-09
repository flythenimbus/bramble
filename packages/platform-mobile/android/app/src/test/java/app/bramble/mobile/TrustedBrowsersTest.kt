package app.bramble.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Host-JVM tests for the pure autofill-authorization logic. The part that needs a real
// PackageManager (TrustedBrowsers.isTrustedBrowser resolving a caller's signing certificate) is
// covered on-device; here we lock down the security-critical pure logic:
//  - a non-browser / spoofed-webDomain caller gets NO host-based match (empty requestedHosts),
//  - a web host is never derived from the package name (the reverse-DNS guess is gone),
//  - cert fingerprints are formatted/sized exactly like the allow-list expects.
class TrustedBrowsersTest {

    // usernameIds/passwordIds/otpIds infer to List<AutofillId>; emptyList() never instantiates
    // the framework type, so this constructs cleanly on the host JVM.
    private fun parsed(pkg: String?, webDomains: List<String>) =
        ParsedStructure(
            packageName = pkg,
            webDomains = webDomains,
            usernameIds = emptyList(),
            passwordIds = emptyList(),
            otpIds = emptyList(),
            username = null,
            password = null,
        )

    @Test
    fun untrustedCallerGetsNoHostsEvenWithSpoofedWebDomain() {
        // A malicious app sets webDomain = "paypal.com"; not a verified browser -> no auto-match.
        val hosts = parsed("com.evil.app", listOf("paypal.com")).requestedHosts(isTrustedBrowser = false)
        assertTrue("an untrusted caller must get no host-based match", hosts.isEmpty())
    }

    @Test
    fun packageNameIsNeverTurnedIntoAWebHost() {
        // com.paypal.evil must NOT resolve to paypal.com (the old reverse-DNS guess is removed),
        // whether or not it is (wrongly) treated as a browser -- it carries no webDomain.
        assertTrue(parsed("com.paypal.evil", emptyList()).requestedHosts(isTrustedBrowser = false).isEmpty())
        assertTrue(parsed("com.paypal.evil", emptyList()).requestedHosts(isTrustedBrowser = true).isEmpty())
    }

    @Test
    fun certFingerprintIsUppercaseColonHex() {
        // SHA-256("test"), formatted the way the allow-list stores signing-cert fingerprints.
        val expected =
            "9F:86:D0:81:88:4C:7D:65:9A:2F:EA:A0:C5:5A:D0:15:A3:BF:4F:1B:2B:0B:82:2C:D1:5D:6C:15:B0:F0:0A:08"
        assertEquals(expected, TrustedBrowsers.certFingerprint("test".toByteArray()))
    }

    @Test
    fun allowlistJsonIncludesEveryBrowserAndFingerprint() {
        // The passkey provider feeds this to CallingAppInfo.getOrigin(); it must carry every
        // package + fingerprint in the GPM privileged-apps shape. (getOrigin parses it on-device.)
        val json = TrustedBrowsers.allowlistJson()
        assertTrue(json.startsWith("{\"apps\":["))
        assertTrue(json.contains("\"cert_fingerprint_sha256\""))
        for ((pkg, fingerprints) in TrustedBrowsers.BROWSERS) {
            assertTrue("missing $pkg", json.contains("\"package_name\":\"$pkg\""))
            for (fp in fingerprints) assertTrue("missing fingerprint $fp for $pkg", json.contains(fp))
        }
    }

    @Test
    fun allowlistFingerprintsAreWellFormed() {
        // Catch a typo'd fingerprint (wrong length / bad chars) that would silently break a browser.
        val fingerprint = Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$")
        assertTrue("the allow-list must not be empty", TrustedBrowsers.BROWSERS.isNotEmpty())
        for ((pkg, fingerprints) in TrustedBrowsers.BROWSERS) {
            assertFalse("$pkg has no fingerprints", fingerprints.isEmpty())
            for (fp in fingerprints) {
                assertTrue("$pkg fingerprint malformed: $fp", fingerprint.matches(fp))
            }
        }
    }
}
