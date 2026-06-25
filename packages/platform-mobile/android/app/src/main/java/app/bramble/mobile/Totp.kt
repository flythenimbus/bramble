package app.bramble.mobile

import android.net.Uri
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// Computes a live TOTP code from a stored key, for one-time-code autofill (parity with the
// iOS ProvidesOneTimeCodes path). Mirrors util/totp.ts: accepts an `otpauth://totp/...`
// URI or a bare base32 secret; RFC 6238 defaults (SHA1, 6 digits, 30s). Only the digits
// ever leave here, never the seed. Returns null for HOTP / garbage so callers can skip it.
object Totp {

    fun generate(key: String?, nowMillis: Long): String? {
        val raw = key?.trim()
        if (raw.isNullOrEmpty()) return null
        return try {
            var secretB32 = raw
            var digits = 6
            var period = 30L
            var algorithm = "SHA1"
            if (raw.startsWith("otpauth://", ignoreCase = true)) {
                if (!raw.startsWith("otpauth://totp", ignoreCase = true)) return null // HOTP unsupported
                val uri = Uri.parse(raw)
                secretB32 = uri.getQueryParameter("secret") ?: return null
                uri.getQueryParameter("digits")?.toIntOrNull()?.let { digits = it }
                uri.getQueryParameter("period")?.toLongOrNull()?.let { period = it }
                uri.getQueryParameter("algorithm")?.let { algorithm = it.uppercase() }
            }
            val secret = base32Decode(secretB32) ?: return null
            val counter = (nowMillis / 1000L) / period
            hotp(secret, counter, digits, macAlgorithm(algorithm))
        } catch (e: Exception) {
            null
        }
    }

    private fun macAlgorithm(algorithm: String): String = when (algorithm) {
        "SHA256" -> "HmacSHA256"
        "SHA512" -> "HmacSHA512"
        else -> "HmacSHA1"
    }

    private fun hotp(secret: ByteArray, counter: Long, digits: Int, mac: String): String {
        val msg = ByteArray(8)
        var c = counter
        for (i in 7 downTo 0) {
            msg[i] = (c and 0xff).toByte()
            c = c shr 8
        }
        val hmac = Mac.getInstance(mac).apply { init(SecretKeySpec(secret, mac)) }.doFinal(msg)
        val offset = hmac[hmac.size - 1].toInt() and 0x0f
        val binary = ((hmac[offset].toInt() and 0x7f) shl 24) or
            ((hmac[offset + 1].toInt() and 0xff) shl 16) or
            ((hmac[offset + 2].toInt() and 0xff) shl 8) or
            (hmac[offset + 3].toInt() and 0xff)
        val mod = Math.pow(10.0, digits.toDouble()).toInt()
        return (binary % mod).toString().padStart(digits, '0')
    }

    private fun base32Decode(input: String): ByteArray? {
        val clean = input.replace("[\\s-]".toRegex(), "").trimEnd('=').uppercase()
        if (clean.isEmpty()) return null
        val alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
        var buffer = 0
        var bitsLeft = 0
        val out = ArrayList<Byte>(clean.length * 5 / 8)
        for (ch in clean) {
            val v = alphabet.indexOf(ch)
            if (v < 0) return null
            buffer = (buffer shl 5) or v
            bitsLeft += 5
            if (bitsLeft >= 8) {
                bitsLeft -= 8
                out.add(((buffer shr bitsLeft) and 0xff).toByte())
            }
        }
        return out.toByteArray()
    }
}
