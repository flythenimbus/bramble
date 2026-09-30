package app.bramble.mobile

import java.util.Base64
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Host-JVM tests for the pure-Kotlin ports the autofill provider relies on: the VLT1
// container parser (validated against a real exported vault) and the TOTP generator
// (validated against the RFC 6238 reference vectors). These cover the logic that can't be
// exercised on-device without the master password.
class AutofillLogicTest {

    // --- autofill picker search ---

    private fun login(name: String, username: String, vararg hosts: String) =
        AutofillLogin("id-$name", name, username, "pw", null, hosts.toList())

    @Test
    fun `search matches every token, across different fields`() {
        // The whole point of the fix: one field holds "acme", another holds the domain, and a
        // query naming both used to find nothing because it was tested as a raw substring.
        val entry = login("Acme Staging", "ops@acme.io", "staging.acme.io")
        assertTrue(entry.matchesQuery(searchTokens("acme staging")))
        assertTrue(entry.matchesQuery(searchTokens("ops staging.acme")))
        // Order is irrelevant, and so is repeated whitespace.
        assertTrue(entry.matchesQuery(searchTokens("  staging   acme ")))
    }

    @Test
    fun `search narrows rather than widens as tokens are added`() {
        val entry = login("Acme Staging", "ops@acme.io", "staging.acme.io")
        // Every token has to land: one miss rejects the entry, so a second word never
        // broadens the result the way an OR would.
        assertFalse(entry.matchesQuery(searchTokens("acme production")))
    }

    @Test
    fun `search is case insensitive and empty queries match nothing here`() {
        val entry = login("Acme Staging", "ops@acme.io", "staging.acme.io")
        assertTrue(entry.matchesQuery(searchTokens("ACME")))
        // A blank query yields no tokens; the caller shows the sectioned list instead of
        // filtering, so this only asserts the tokenizer does not invent one.
        assertEquals(emptyList<String>(), searchTokens("   "))
    }

    // --- app-URI projection + native-app matching ("fill and save") ---

    @Test
    fun `appIdsOf projects Android app ids from entry URLs, both conventions`() {
        assertEquals(
            listOf("com.instagram.android", "com.example.app"),
            VaultReader.appIdsOf(
                listOf(
                    "androidapp://com.instagram.android",
                    "https://instagram.com",
                    "android://sha256abc@com.example.app",
                    "android://sha256abc@com.example.app/",
                    "iosapp://com.example.app",
                    "bare.host",
                    "",
                ),
            ),
        )
        assertEquals(
            listOf("Case.Sensitive.Pkg"),
            VaultReader.appIdsOf(listOf("ANDROIDAPP://Case.Sensitive.Pkg")),
        )
        assertEquals(emptyList<String>(), VaultReader.appIdsOf(emptyList()))
    }

    @Test
    fun `app matching is exact package equality, never a domain inference`() {
        val entry = login("Instagram", "me@x.y", "instagram.com")
        assertFalse(VaultReader.matchesApp(entry, "com.instagram.android"))
        val associated = AutofillLogin(
            "id-2", "Instagram", "me@x.y", "pw", null,
            listOf("instagram.com"), listOf("com.instagram.android"),
        )
        assertTrue(VaultReader.matchesApp(associated, "com.instagram.android"))
        assertFalse(VaultReader.matchesApp(associated, "com.instagram.evil"))
        assertFalse(VaultReader.matchesApp(associated, "android.instagram.com"))
        assertFalse(VaultReader.matchesApp(associated, ""))
    }

    @Test
    fun `combined matching unions hosts and app ids, and an empty context matches nothing`() {
        // android.net.Uri isn't mocked on the host JVM, so only the empty-hosts branch runs.
        val associated = AutofillLogin(
            "id-1", "Instagram", "me@x.y", "pw", null,
            listOf("instagram.com"), listOf("com.instagram.android"),
        )
        assertTrue(VaultReader.matches(associated, emptyList(), "com.instagram.android"))
        assertFalse(VaultReader.matches(associated, emptyList(), null))
        val hostOnly = login("Instagram", "me@x.y", "instagram.com")
        assertFalse(VaultReader.matches(hostOnly, emptyList(), "com.instagram.android"))
    }


    // A real VLT1 v2 vault blob (a password slot + a recovery slot + an empty entries
    // payload), base64-encoded. Decoded structure is asserted below.
    private val realVaultB64 =
        "VkxUMQICAQB8NJOLV2EGI1dxkpzJrr1Y0gnGgMLSu6Myncco1F0gB00tlGzLsYZ8dOn7PN9XVL423S/3DY3O" +
            "onanRFHv8OmTCwJ65rKVHi+VHs5cfsjAZe9IDjgG+PekhusgFQaG82TsDqqQpVcXPOdVyQdXxQ4ZSxfWF" +
            "y2mDMS1xNSuTgMAfNNWSO6CSxPsNogcrceAAKcpKUgoVInZIzXynMRd0xezUvuZrEbtr2AIt1YDwneRgb7" +
            "rvDbJntJH4tnG49is8H2D5MJaxFTZeZf6Pacn+ioSKM9tiI3KmOqZ6RUYJTUFBtoUq0dYnSnvA8TuNfCJe" +
            "OTxjXKrVPJRR+0LJj08fns/j4gYRYDcdCmlQ/LcQuhHQ3Yz0sBBFitNgH7BpETQb8jJ1vkIgrOvjxLrqMw" +
            "C+mcXheFAgFxy"

    @Test
    fun decodesRealVaultContainer() {
        val blob = decodeVaultBlob(Base64.getDecoder().decode(realVaultB64))
        val slot = blob.passwordSlot
        assertNotNull("real vault must expose its master-password slot", slot)
        assertEquals(16, slot!!.slotId.size)
        assertEquals(16, slot.salt.size)
        assertEquals(32, slot.verifier.size)
        assertEquals(12, slot.wrapIv.size)
        assertEquals(48, slot.wrappedVek.size)
        assertEquals(12, blob.entriesIv.size)
        // This vault has no entries yet, so the VEK-encrypted payload is small but present.
        assertEquals(46, blob.entriesCiphertext.size)
    }

    @Test
    fun verifierPrefixIsMagicPlusVersion() {
        assertArrayEquals(byteArrayOf(0x56, 0x4c, 0x54, 0x31, 0x02), verifierPrefix())
    }

    // RFC 6238 Appendix B reference vectors for SHA1, 6 digits (the seed "12345678901234567890").
    private val rfcSecretB32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"

    @Test
    fun totpMatchesRfc6238() {
        assertEquals("287082", Totp.generate(rfcSecretB32, 59_000L))
        assertEquals("081804", Totp.generate(rfcSecretB32, 1_111_111_109_000L))
        assertEquals("005924", Totp.generate(rfcSecretB32, 1_234_567_890_000L))
    }

    @Test
    fun totpToleratesLowercaseSpacesAndPadding() {
        // The generator uppercases, strips separators, and ignores base32 padding.
        assertEquals("287082", Totp.generate("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", 59_000L))
    }

    @Test
    fun totpRejectsGarbageAndBlanks() {
        assertEquals(null, Totp.generate(null, 59_000L))
        assertEquals(null, Totp.generate("", 59_000L))
        assertEquals(null, Totp.generate("not!base32!", 59_000L))
    }
}
