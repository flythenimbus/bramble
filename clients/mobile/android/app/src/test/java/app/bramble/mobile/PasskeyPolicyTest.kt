package app.bramble.mobile

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Host-JVM test for which passkeys the Credential Manager provider offers a caller and when it
// must verify the user afresh. See docs/passkey-provider.md.
class PasskeyPolicyTest {
    @Test
    fun noAllowListAllowsAnyCredential() {
        assertTrue(PasskeyPolicy.allows(null, "Q0lE"))
    }

    @Test
    fun theAllowListIsEnforcedByCanonicalSpelling() {
        assertTrue(PasskeyPolicy.allows(listOf("WFla", "Q0lE"), "Q0lE"))
        assertTrue(PasskeyPolicy.allows(listOf("_-8="), "_-8"))
        assertFalse(PasskeyPolicy.allows(listOf("WFla"), "Q0lE"))
        assertFalse(PasskeyPolicy.allows(listOf("not base64!"), "Q0lE"))
        // A list whose entries were all unreadable still restricts.
        assertFalse(PasskeyPolicy.allows(emptyList(), "Q0lE"))
    }

    @Test
    fun aBrowserOriginMayUseItsOwnSiteOrAParent() {
        assertTrue(PasskeyPolicy.originMayUse("https://example.com", "example.com"))
        assertTrue(PasskeyPolicy.originMayUse("https://login.Example.com:8443", "example.com"))
        assertTrue(PasskeyPolicy.originMayUse("http://localhost:4719", "localhost"))
    }

    @Test
    fun aBrowserOriginMayNotUseAnotherSite() {
        assertFalse(PasskeyPolicy.originMayUse("https://b.example", "a.example"))
        assertFalse(PasskeyPolicy.originMayUse("https://notexample.com", "example.com"))
        assertFalse(PasskeyPolicy.originMayUse("https://example.com", "login.example.com"))
        assertFalse(PasskeyPolicy.originMayUse("http://example.com", "example.com"))
        assertFalse(PasskeyPolicy.originMayUse("https://example.com", ""))
        assertFalse(PasskeyPolicy.originMayUse("not an origin", "example.com"))
    }

    @Test
    fun aFreshVerificationIsNeededForRequiredUvOrPrf() {
        assertTrue(PasskeyPolicy.needsVerification("required", wantsPrf = false))
        assertTrue(PasskeyPolicy.needsVerification("preferred", wantsPrf = true))
        assertFalse(PasskeyPolicy.needsVerification("preferred", wantsPrf = false))
        assertFalse(PasskeyPolicy.needsVerification(null, wantsPrf = false))
    }
}
