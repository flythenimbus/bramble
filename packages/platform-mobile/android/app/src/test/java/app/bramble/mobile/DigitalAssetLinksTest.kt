package app.bramble.mobile

import java.net.InetAddress
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Host-JVM tests for the security-critical Digital Asset Links decision: does a domain's
// assetlinks.json authorize this app to fill that domain's logins? grants() is pure (it runs on
// already-parsed statements), so we can assert default-deny here. The org.json parsing, the HTTPS
// fetch, and the cache are exercised on-device.
class DigitalAssetLinksTest {

    private val appPkg = "com.github.android"
    private val appFp =
        "AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"

    private fun statement(
        relations: List<String> = listOf("delegate_permission/common.get_login_creds"),
        namespace: String = "android_app",
        pkg: String = appPkg,
        certs: List<String> = listOf(appFp),
    ) = DigitalAssetLinks.AssetStatement(relations, namespace, pkg, certs)

    @Test
    fun grantsWhenPackageRelationAndCertAllMatch() {
        assertTrue(DigitalAssetLinks.grants(listOf(statement()), appPkg, setOf(appFp)))
    }

    @Test
    fun grantsOnHandleAllUrlsRelationToo() {
        val s = statement(relations = listOf("delegate_permission/common.handle_all_urls"))
        assertTrue(DigitalAssetLinks.grants(listOf(s), appPkg, setOf(appFp)))
    }

    @Test
    fun certMatchIsCaseInsensitive() {
        // assetlinks.json may list a lowercase fingerprint; the app's is uppercase.
        assertTrue(DigitalAssetLinks.grants(listOf(statement(certs = listOf(appFp.lowercase()))), appPkg, setOf(appFp)))
    }

    @Test
    fun deniesOnPackageMismatch() {
        assertFalse(DigitalAssetLinks.grants(listOf(statement(pkg = "com.evil.app")), appPkg, setOf(appFp)))
    }

    @Test
    fun deniesOnCertMismatch() {
        val other = "11:" + appFp.substring(3)
        assertFalse(DigitalAssetLinks.grants(listOf(statement(certs = listOf(other))), appPkg, setOf(appFp)))
    }

    @Test
    fun deniesOnUnrelatedRelation() {
        val s = statement(relations = listOf("delegate_permission/common.use_as_origin"))
        assertFalse(DigitalAssetLinks.grants(listOf(s), appPkg, setOf(appFp)))
    }

    @Test
    fun deniesOnWebNamespace() {
        assertFalse(DigitalAssetLinks.grants(listOf(statement(namespace = "web")), appPkg, setOf(appFp)))
    }

    @Test
    fun deniesWhenAppHasNoFingerprints() {
        assertFalse(DigitalAssetLinks.grants(listOf(statement()), appPkg, emptySet()))
    }

    @Test
    fun candidateDomainReversesFirstTwoLabels() {
        // Only a hint that must still pass grants(): the guess for com.paypal.evil is paypal.com,
        // but paypal.com's real assetlinks.json would not list that package, so it is never matched.
        assertEquals(listOf("github.com"), DigitalAssetLinks.candidateDomains("com.github.android"))
        assertEquals(listOf("paypal.com"), DigitalAssetLinks.candidateDomains("com.paypal.evil"))
    }

    @Test
    fun candidateDomainEmptyForSingleLabelOrBlank() {
        assertTrue(DigitalAssetLinks.candidateDomains("android").isEmpty())
        assertTrue(DigitalAssetLinks.candidateDomains("").isEmpty())
    }

    // ---- B3: SSRF hardening on the assetlinks.json fetch ----

    @Test
    fun ipLiteralsAreDetected() {
        assertTrue(DigitalAssetLinks.isIpLiteral("10.0.0.1"))
        assertTrue(DigitalAssetLinks.isIpLiteral("169.254.169.254"))
        assertTrue(DigitalAssetLinks.isIpLiteral("::1"))
        assertTrue(DigitalAssetLinks.isIpLiteral("fd00::1"))
        assertFalse(DigitalAssetLinks.isIpLiteral("github.com"))
        assertFalse(DigitalAssetLinks.isIpLiteral("1.2.3")) // not four octets
    }

    @Test
    fun globalAddressExcludesPrivateLoopbackAndLinkLocal() {
        // getByName on a literal parses it without a DNS lookup, so these stay offline.
        for (priv in
            listOf("127.0.0.1", "10.0.0.1", "192.168.1.1", "172.16.0.1", "169.254.169.254", "100.64.0.1", "fd00::1", "::1")) {
            assertFalse(priv, DigitalAssetLinks.isGlobalAddress(InetAddress.getByName(priv)))
        }
        for (pub in listOf("8.8.8.8", "1.1.1.1")) {
            assertTrue(pub, DigitalAssetLinks.isGlobalAddress(InetAddress.getByName(pub)))
        }
    }

    @Test
    fun publicHostRejectsBareNamesAndIpLiteralsWithoutDns() {
        assertFalse(DigitalAssetLinks.isPublicHost("localhost")) // no dot -> rejected before any DNS
        assertFalse(DigitalAssetLinks.isPublicHost("10.0.0.1")) // IP literal -> rejected before any DNS
        assertFalse(DigitalAssetLinks.isPublicHost("")) // empty
    }
}
