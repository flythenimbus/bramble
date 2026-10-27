package app.bramble.mobile

// The Rust core holds one vault key for the whole :autofill process. The fill path's borrowed
// unlock and the unlock activities' lock check and relock go through this guard, so neither
// sees the other half-done. Never hold it across user interaction or a structure walk.
internal object CoreSession {

    interface Core {
        fun isLocked(): Boolean
        fun unlock(vekB64: String)
        fun lock()
    }

    private val native = object : Core {
        override fun isLocked(): Boolean = uniffi.vault_crypto.isLocked()
        override fun unlock(vekB64: String) = uniffi.vault_crypto.unlockWithVek(vekB64)
        override fun lock() = uniffi.vault_crypto.lock()
    }

    fun <T> withLock(block: () -> T): T = synchronized(this) { block() }

    /** Unlocks with [vekB64] for [read], then puts back the lock state the core had, even on failure. */
    fun <T> borrow(vekB64: String, core: Core = native, read: () -> T): T = withLock {
        val wasLocked = core.isLocked()
        try {
            core.unlock(vekB64)
            read()
        } finally {
            if (wasLocked) core.lock()
        }
    }
}
