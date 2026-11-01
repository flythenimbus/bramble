package app.bramble.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Host-JVM test for the PRF input choice the Credential Manager provider makes: a credential's own
// evalByCredential entry wins over eval, as WebAuthn's prf extension says. See docs/passkey-prf.md.
class PasskeyPrfTest {
    private val own = PrfSalts("AQ==", null)
    private val fallback = PrfSalts("Ag==", "Aw==")

    @Test
    fun selectPrefersTheCredentialsOwnSalts() {
        assertEquals(own, PasskeyPrf.select(fallback, mapOf("Q0lE" to own), "Q0lE"))
    }

    @Test
    fun selectFallsBackToEval() {
        assertEquals(fallback, PasskeyPrf.select(fallback, mapOf("WFla" to own), "Q0lE"))
    }

    @Test
    fun selectReturnsNullWithNoInputs() {
        assertNull(PasskeyPrf.select(null, mapOf("WFla" to own), "Q0lE"))
    }
}
