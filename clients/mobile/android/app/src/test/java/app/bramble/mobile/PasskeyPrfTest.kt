package app.bramble.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Host-JVM test for the PRF inputs the Credential Manager provider takes from a request: the
// canonical-spelling rule every platform applies, and a credential's own evalByCredential entry
// winning over eval, as WebAuthn's prf extension says. See docs/passkey-prf.md.
class PasskeyPrfTest {
    private val own = PrfSalts("AQ==", null)
    private val fallback = PrfSalts("Ag==", "Aw==")

    @Test
    fun selectPrefersTheCredentialsOwnSalts() {
        assertEquals(own, PasskeyPrf.select(fallback, mapOf("Q0lE" to own), "Q0lE"))
    }

    @Test
    fun selectMatchesAnySpellingOfTheCredentialId() {
        // Padded, and in the + / alphabet: the same id bytes, so the same credential.
        assertEquals(own, PasskeyPrf.select(fallback, mapOf("_-8=" to own), "_-8"))
        assertEquals(own, PasskeyPrf.select(fallback, mapOf("/+8" to own), "_-8"))
    }

    @Test
    fun selectFallsBackToEval() {
        assertEquals(fallback, PasskeyPrf.select(fallback, mapOf("WFla" to own), "Q0lE"))
        assertEquals(fallback, PasskeyPrf.select(fallback, mapOf("not base64!" to own), "Q0lE"))
    }

    @Test
    fun selectReturnsNullWithNoInputs() {
        assertNull(PasskeyPrf.select(null, mapOf("WFla" to own), "Q0lE"))
    }

    @Test
    fun saltsConvertCanonicalBase64UrlToStandard() {
        assertEquals(PrfSalts("QQ==", "/+8="), PasskeyPrf.salts("QQ", "_-8"))
        assertEquals(PrfSalts("", null), PasskeyPrf.salts("", null))
    }

    @Test
    fun saltsRefuseAnySpellingButTheCanonicalOne() {
        // A lenient decoder here and a strict one elsewhere would derive different keys (or none).
        for (bad in listOf("QQ==", "QR", " QQ", "+/8", "QQQQQ", "not base64!")) {
            assertNull(bad, PasskeyPrf.salts(bad, null))
            assertNull(bad, PasskeyPrf.salts("QQ", bad))
        }
    }
}
