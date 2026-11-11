package app.bramble.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

// Host-JVM tests for the paths that don't touch android.net.Uri (a stub here): bare secrets and
// steam:// keys. Vectors match util/totp.test.ts.
class TotpTest {

    private val seed = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    @Test
    fun bareSecretUsesRfcDefaults() {
        assertEquals("287082", Totp.generate(seed, 59_000L))
        assertEquals("081804", Totp.generate(seed, 1_111_111_109_000L))
    }

    @Test
    fun steamKeyYieldsSteamGuardCodes() {
        val key = "steam://$seed"
        assertEquals("PV9M4", Totp.generate(key, 59_000L))
        assertEquals("PY4YB", Totp.generate(key, 1_111_111_109_000L))
        assertEquals("VHHQY", Totp.generate(key, 1_234_567_890_000L))
        assertEquals("9N776", Totp.generate(key, 2_000_000_000_000L))
    }

    @Test
    fun steamKeyWithoutSecretIsRejected() {
        assertNull(Totp.generate("steam://", 59_000L))
        assertNull(Totp.generate("steam://not!base32", 59_000L))
    }
}
