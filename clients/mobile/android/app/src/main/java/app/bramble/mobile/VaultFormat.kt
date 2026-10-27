package app.bramble.mobile

// Kotlin port of the parts of vault-format.ts the autofill provider needs: decode the
// VLT1 v2 container to reach the master-password slot (for master-password unlock) and
// the VEK-encrypted entries blob (decrypted after unlock). Encoding/slot-mutation stays
// in the TS source of truth; this is read-only. See docs/vault-format.md.

private val MAGIC = byteArrayOf(0x56, 0x4c, 0x54, 0x31) // "VLT1"
private const val VERSION = 0x02
private const val MAX_SLOTS = 16

private const val LEN_IV = 12
private const val LEN_SALT = 16
private const val LEN_VERIFIER = 32
private const val LEN_SLOT_ID = 16
private const val LEN_WRAP_IV = 12
private const val LEN_WRAPPED_VEK = 48 // 32-byte VEK + 16-byte GCM tag

private const val SLOT_KIND_PASSWORD = 0x01

private const val HEADER_FIXED_LEN = 4 + 1 + 1 // magic + version + slotCount
private const val TLV_PREFIX_LEN = 1 + 2 // kind + len (u16 big-endian)

/** A master-password slot: the Argon2id inputs plus the AES-wrapped VEK. */
class PasswordSlot(
    val slotId: ByteArray,
    val salt: ByteArray,
    val verifier: ByteArray,
    val wrapIv: ByteArray,
    val wrappedVek: ByteArray,
)

/** A decoded vault: the password slot (if any) and the VEK-encrypted entries blob. */
class VaultBlob(
    val passwordSlot: PasswordSlot?,
    val entriesIv: ByteArray,
    val entriesCiphertext: ByteArray,
)

/** Magic+version bytes that bind a verifier to this format version (= verifierPrefix()). */
fun verifierPrefix(): ByteArray = MAGIC + byteArrayOf(VERSION.toByte())

/** Parse a VLT1 v2 blob. Bounds-checked against the untrusted byte stream; throws on a bad blob. */
fun decodeVaultBlob(bytes: ByteArray): VaultBlob {
    require(bytes.size >= HEADER_FIXED_LEN) { "vault blob too short: ${bytes.size}" }
    for (i in MAGIC.indices) {
        require(bytes[i] == MAGIC[i]) { "invalid vault magic bytes (not a VLT1 file)" }
    }
    val version = bytes[MAGIC.size].toInt() and 0xff
    require(version == VERSION) { "unsupported vault version: $version (expected $VERSION)" }

    val slotCount = bytes[MAGIC.size + 1].toInt() and 0xff
    require(slotCount in 1..MAX_SLOTS) { "vault has $slotCount slots (max $MAX_SLOTS)" }

    var passwordSlot: PasswordSlot? = null
    var off = HEADER_FIXED_LEN
    for (i in 0 until slotCount) {
        require(off + TLV_PREFIX_LEN <= bytes.size) { "slot $i truncated (header overruns blob)" }
        val kind = bytes[off++].toInt() and 0xff
        val len = ((bytes[off].toInt() and 0xff) shl 8) or (bytes[off + 1].toInt() and 0xff)
        off += 2
        require(off + len <= bytes.size) { "slot $i truncated (payload overruns blob)" }
        val payload = bytes.copyOfRange(off, off + len)
        off += len
        if (kind == SLOT_KIND_PASSWORD && passwordSlot == null) {
            passwordSlot = decodePasswordPayload(payload)
        }
    }

    require(off + LEN_IV <= bytes.size) { "vault blob truncated (entries IV overruns blob)" }
    val entriesIv = bytes.copyOfRange(off, off + LEN_IV)
    off += LEN_IV
    val entriesCiphertext = bytes.copyOfRange(off, bytes.size)
    return VaultBlob(passwordSlot, entriesIv, entriesCiphertext)
}

private fun decodePasswordPayload(payload: ByteArray): PasswordSlot {
    val want = LEN_SLOT_ID + LEN_SALT + LEN_VERIFIER + LEN_WRAP_IV + LEN_WRAPPED_VEK
    require(payload.size >= want) { "password slot payload too short: ${payload.size}" }
    var off = 0
    val slotId = payload.copyOfRange(off, off + LEN_SLOT_ID); off += LEN_SLOT_ID
    val salt = payload.copyOfRange(off, off + LEN_SALT); off += LEN_SALT
    val verifier = payload.copyOfRange(off, off + LEN_VERIFIER); off += LEN_VERIFIER
    val wrapIv = payload.copyOfRange(off, off + LEN_WRAP_IV); off += LEN_WRAP_IV
    val wrappedVek = payload.copyOfRange(off, off + LEN_WRAPPED_VEK)
    return PasswordSlot(slotId, salt, verifier, wrapIv, wrappedVek)
}
