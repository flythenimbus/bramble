package app.bramble.mobile

import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.MessageDigest
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * File attachment sealing, on the device. See docs/file-attachments.md.
 *
 * This runs on real hardware for the reasons the host tests cannot: it is the only thing that
 * exercises the arm64 `.so`, the uniffi binding, and app-private storage together. The Rust
 * tests already prove the construction; what is unproven until here is that the same code
 * reached the phone intact and can write where the app is actually allowed to write.
 */
@RunWith(AndroidJUnit4::class)
class FileSealInstrumentedTest {

    private lateinit var dir: File

    /** 256 KiB, matching CHUNK_LEN in files.rs, so the size cases below straddle real boundaries. */
    private val chunkLen = 256 * 1024

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        dir = File(context.filesDir, "file-seal-test").apply {
            deleteRecursively()
            mkdirs()
        }
        uniffi.vault_crypto.unlockWithVek(Base64.encodeToString(ByteArray(32) { 0x7c }, Base64.NO_WRAP))
    }

    @After
    fun tearDown() {
        uniffi.vault_crypto.lock()
        dir.deleteRecursively()
    }

    private fun body(len: Int) = ByteArray(len) { ((it * 7) % 251).toByte() }

    private fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }

    @Test
    fun sealsAndOpensAFileAtEveryChunkBoundary() {
        // Zero, sub-chunk, exactly one chunk, one byte over, and multi-chunk: the boundaries
        // where an off-by-one in the streaming sealer would produce a spurious final chunk.
        for (len in intArrayOf(0, 1, chunkLen - 1, chunkLen, chunkLen + 1, 3 * chunkLen)) {
            val src = File(dir, "in-$len.bin")
            val staging = File(dir, "staging-$len")
            val out = File(dir, "out-$len.bin")
            val plaintext = body(len)
            src.writeBytes(plaintext)

            val meta = """{"name":"passport.pdf","mime":"application/pdf","plaintextSize":$len}"""
            val sealed = uniffi.vault_crypto.sealFile(src.absolutePath, staging.absolutePath, meta)

            assertEquals("bytes on disk for $len", staging.length(), sealed.size.toLong())
            // The address really is SHA-256 of the blob, computed independently in Kotlin. This
            // is the cross-language check: a peer verifies a transfer against this exact value.
            assertEquals("hash for $len", sha256Hex(staging.readBytes()), sealed.hash)

            assertEquals(
                meta,
                uniffi.vault_crypto.openFileMeta(
                    sealed.wrappedFek, sealed.fekIv, sealed.metaBlob, sealed.metaIv
                )
            )

            val written = uniffi.vault_crypto.openFileToPath(
                sealed.wrappedFek, sealed.fekIv, sealed.noncePrefix,
                staging.absolutePath, out.absolutePath
            )
            assertEquals("plaintext length for $len", len.toLong(), written.toLong())
            assertArrayEquals("round trip for $len", plaintext, out.readBytes())
        }
    }

    @Test
    fun opensOneChunkWithoutReadingTheRest() {
        val src = File(dir, "big.bin")
        val staging = File(dir, "big-staging")
        val plaintext = body(3 * chunkLen + 10)
        src.writeBytes(plaintext)
        val sealed = uniffi.vault_crypto.sealFile(
            src.absolutePath, staging.absolutePath, """{"name":"a","mime":"b","plaintextSize":0}"""
        )

        for (index in 0L until 4L) {
            val chunk = Base64.decode(
                uniffi.vault_crypto.openFileChunk(
                    sealed.wrappedFek, sealed.fekIv, sealed.noncePrefix, staging.absolutePath,
                    index.toULong()
                ),
                Base64.DEFAULT
            )
            val start = index.toInt() * chunkLen
            val end = minOf(plaintext.size, start + chunkLen)
            assertArrayEquals("chunk $index", plaintext.copyOfRange(start, end), chunk)
        }
    }

    @Test
    fun aTruncatedBlobDoesNotOpen() {
        val src = File(dir, "trunc.bin")
        val staging = File(dir, "trunc-staging")
        src.writeBytes(body(3 * chunkLen))
        val sealed = uniffi.vault_crypto.sealFile(
            src.absolutePath, staging.absolutePath, """{"name":"a","mime":"b","plaintextSize":0}"""
        )
        // Drop the final chunk. The new last chunk was sealed as interior, so the STREAM final
        // flag rejects it rather than yielding a silently shorter file.
        staging.writeBytes(staging.readBytes().copyOfRange(0, 2 * (chunkLen + 16)))

        var threw = false
        try {
            uniffi.vault_crypto.openFileToPath(
                sealed.wrappedFek, sealed.fekIv, sealed.noncePrefix,
                staging.absolutePath, File(dir, "trunc-out").absolutePath
            )
        } catch (e: Throwable) {
            threw = true
        }
        assertTrue("a truncated blob must not open", threw)
    }

    @Test
    fun anotherVaultsKeyCannotOpenTheFile() {
        val src = File(dir, "k.bin")
        val staging = File(dir, "k-staging")
        src.writeBytes(body(5000))
        val sealed = uniffi.vault_crypto.sealFile(
            src.absolutePath, staging.absolutePath, """{"name":"a","mime":"b","plaintextSize":5000}"""
        )

        uniffi.vault_crypto.unlockWithVek(Base64.encodeToString(ByteArray(32) { 0x01 }, Base64.NO_WRAP))
        var threw = false
        try {
            uniffi.vault_crypto.openFileMeta(
                sealed.wrappedFek, sealed.fekIv, sealed.metaBlob, sealed.metaIv
            )
        } catch (e: Throwable) {
            threw = true
        }
        assertTrue("a different vault's VEK must not unwrap the FEK", threw)
    }

    @Test
    fun aRenameResealsMetadataWithoutTouchingTheBlob() {
        val src = File(dir, "r.bin")
        val staging = File(dir, "r-staging")
        src.writeBytes(body(5000))
        val sealed = uniffi.vault_crypto.sealFile(
            src.absolutePath, staging.absolutePath, """{"name":"old.pdf","mime":"application/pdf"}"""
        )
        val hashBefore = sha256Hex(staging.readBytes())

        val renamed = uniffi.vault_crypto.resealFileMeta(
            sealed.wrappedFek, sealed.fekIv, """{"name":"new.pdf","mime":"application/pdf"}"""
        )
        assertEquals(
            """{"name":"new.pdf","mime":"application/pdf"}""",
            uniffi.vault_crypto.openFileMeta(
                sealed.wrappedFek, sealed.fekIv, renamed.ciphertext, renamed.iv
            )
        )
        // A rename moves no bytes: same blob, same address, same FEK.
        assertEquals(hashBefore, sha256Hex(staging.readBytes()))
        assertEquals(sealed.hash, hashBefore)
    }

    @Test
    fun twoSealsOfTheSameFileGetDifferentAddresses() {
        // No convergent encryption, deliberately: a fresh FEK and nonce prefix per seal is what
        // rules out confirmation-of-file. The cost is no dedup.
        val src = File(dir, "same.bin")
        src.writeBytes(body(5000))
        val meta = """{"name":"a","mime":"b","plaintextSize":5000}"""
        val a = uniffi.vault_crypto.sealFile(src.absolutePath, File(dir, "a").absolutePath, meta)
        val b = uniffi.vault_crypto.sealFile(src.absolutePath, File(dir, "b").absolutePath, meta)
        assertNotEquals(a.hash, b.hash)
        assertEquals(a.size, b.size)
    }
}
