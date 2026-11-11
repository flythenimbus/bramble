package app.bramble.mobile

import android.net.Uri
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

// Computes a live TOTP code from a stored key, for one-time-code autofill (parity with the
// iOS ProvidesOneTimeCodes path). Mirrors util/totp.ts: accepts an `otpauth://totp/...`
// URI, a Steam Guard key (`steam://`, `otpauth://steam/` or `encoder=steam`) or a bare base32
// secret; RFC 6238 defaults (SHA1, 6 digits, 30s). Only the code ever leaves here, never the
// seed. Returns null for HOTP / garbage so callers can skip it.
object Totp {

    private const val STEAM_ALPHABET = "23456789BCDFGHJKMNPQRTVWXY"

    fun generate(key: String?, nowMillis: Long): String? {
        val raw = key?.trim()
        if (raw.isNullOrEmpty()) return null
        return try {
            var secretB32 = raw
            var digits = 6
            var period = 30L
            var algorithm = "SHA1"
            var steam = false
            if (raw.startsWith("steam://", ignoreCase = true)) {
                secretB32 = raw.substring("steam://".length)
                steam = true
            } else if (raw.startsWith("otpauth://", ignoreCase = true)) {
                val uri = Uri.parse(raw)
                val host = uri.host?.lowercase()
                steam = host == "steam" || uri.getQueryParameter("encoder").equals("steam", ignoreCase = true)
                if (host != "totp" && !steam) return null // HOTP unsupported
                secretB32 = uri.getQueryParameter("secret") ?: return null
                uri.getQueryParameter("digits")?.toIntOrNull()?.let { digits = it }
                uri.getQueryParameter("period")?.toDoubleOrNull()?.let { period = it.toLong() }
                uri.getQueryParameter("algorithm")?.let { algorithm = it.uppercase().replace("-", "") }
            }
            val secret = base32Decode(secretB32) ?: return null
            if (steam) return steamCode(truncate(secret, (nowMillis / 1000L) / 30L, "HmacSHA1"))
            if (period <= 0 || digits !in 1..10) return null
            val counter = (nowMillis / 1000L) / period
            val mod = Math.pow(10.0, digits.toDouble()).toLong()
            (truncate(secret, counter, macAlgorithm(algorithm)) % mod).toString().padStart(digits, '0')
        } catch (e: Exception) {
            null
        }
    }

    private fun steamCode(binary: Int): String {
        var n = binary
        val out = StringBuilder()
        repeat(5) {
            out.append(STEAM_ALPHABET[n % STEAM_ALPHABET.length])
            n /= STEAM_ALPHABET.length
        }
        return out.toString()
    }

    private fun macAlgorithm(algorithm: String): String = when (algorithm) {
        "SHA256" -> "HmacSHA256"
        "SHA512" -> "HmacSHA512"
        else -> "HmacSHA1"
    }

    // RFC 4226 dynamic truncation: the 31-bit value a code is cut from.
    private fun truncate(secret: ByteArray, counter: Long, mac: String): Int {
        val msg = ByteArray(8)
        var c = counter
        for (i in 7 downTo 0) {
            msg[i] = (c and 0xff).toByte()
            c = c shr 8
        }
        val hmac = Mac.getInstance(mac).apply { init(SecretKeySpec(secret, mac)) }.doFinal(msg)
        val offset = hmac[hmac.size - 1].toInt() and 0x0f
        return ((hmac[offset].toInt() and 0x7f) shl 24) or
            ((hmac[offset + 1].toInt() and 0xff) shl 16) or
            ((hmac[offset + 2].toInt() and 0xff) shl 8) or
            (hmac[offset + 3].toInt() and 0xff)
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
