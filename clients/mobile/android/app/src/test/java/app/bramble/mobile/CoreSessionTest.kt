package app.bramble.mobile

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

// Host-JVM tests for the guard around the :autofill process's single core vault key, over a fake
// core. The fill path borrows an unlock off the main thread now, so an unlock activity starting
// meanwhile must not read that window as "already unlocked" and then skip its relock on finish.
class CoreSessionTest {

    private class FakeCore(locked: Boolean) : CoreSession.Core {
        val locked = AtomicBoolean(locked)

        override fun isLocked(): Boolean = locked.get()

        override fun unlock(vekB64: String) = locked.set(false)

        override fun lock() = locked.set(true)
    }

    @Test
    fun `a borrowed unlock relocks a core that was locked`() {
        val core = FakeCore(locked = true)
        val lockedDuringRead = CoreSession.borrow("vek", core) { core.isLocked() }
        assertFalse(lockedDuringRead)
        assertTrue(core.isLocked())
    }

    @Test
    fun `a borrowed unlock relocks even when the read fails`() {
        val core = FakeCore(locked = true)
        try {
            CoreSession.borrow("vek", core) { throw IllegalStateException("decrypt failed") }
            fail("the read's failure should propagate")
        } catch (e: IllegalStateException) {
            assertEquals("decrypt failed", e.message)
        }
        assertTrue(core.isLocked())
    }

    @Test
    fun `a borrowed unlock leaves a core someone else unlocked as it was`() {
        val core = FakeCore(locked = false)
        CoreSession.borrow("vek", core) { }
        assertFalse(core.isLocked())
    }

    @Test
    fun `an unlock activity's lock check waits out a borrowed unlock`() {
        val core = FakeCore(locked = true)
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val fill = Thread { CoreSession.borrow("vek", core) { inside.countDown(); release.await() } }
        fill.start()
        assertTrue(inside.await(5, TimeUnit.SECONDS))

        // BrambleUnlockActivity.onCreate's coreWasLocked read, mid-borrow.
        val observed = AtomicReference<Boolean>()
        val checked = CountDownLatch(1)
        Thread {
            observed.set(CoreSession.withLock { core.isLocked() })
            checked.countDown()
        }.start()
        assertFalse(checked.await(200, TimeUnit.MILLISECONDS))

        release.countDown()
        assertTrue(checked.await(5, TimeUnit.SECONDS))
        fill.join(5_000)
        // It saw the core relocked, so finishCore will lock it again.
        assertEquals(true, observed.get())
    }
}
