package app.bramble.mobile

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// Host-JVM tests for how the autofill service hands requests off its main thread (issue #56): the
// caller never waits on the work, requests run one at a time, and a request the system has
// cancelled is dropped instead of being finished for nobody.
class AutofillWorkerTest {

    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val errors = CopyOnWriteArrayList<Exception>()
    private val worker = AutofillWorker(executor) { errors.add(it) }

    @After
    fun tearDown() {
        executor.shutdownNow()
    }

    private fun drain() {
        val done = CountDownLatch(1)
        executor.execute { done.countDown() }
        assertTrue(done.await(5, TimeUnit.SECONDS))
    }

    @Test
    fun `run returns while the work is still blocked`() {
        val gate = CountDownLatch(1)
        val replies = CopyOnWriteArrayList<String?>()
        worker.run(work = { gate.await(); "response" }, reply = { replies.add(it) })
        // Back on the caller's thread with the work parked: the main looper is free.
        assertTrue(replies.isEmpty())
        gate.countDown()
        drain()
        assertEquals(listOf<String?>("response"), replies)
    }

    @Test
    fun `requests queued behind a slow one are skipped once cancelled`() {
        val gate = CountDownLatch(1)
        val ran = CopyOnWriteArrayList<Int>()
        val replies = CopyOnWriteArrayList<Int?>()
        worker.run(work = { gate.await(); ran.add(0); 0 }, reply = { replies.add(it) })
        val cancelled = AtomicBoolean(false)
        for (i in 1..3) {
            worker.run({ cancelled.get() }, work = { ran.add(i); i }, reply = { replies.add(it) })
        }
        worker.run(work = { ran.add(4); 4 }, reply = { replies.add(it) })
        // The system timed the three out while the first held the worker.
        cancelled.set(true)
        gate.countDown()
        drain()
        assertEquals(listOf(0, 4), ran)
        assertEquals(listOf<Int?>(0, 4), replies)
    }

    @Test
    fun `a request cancelled during its work gets no reply`() {
        val cancelled = AtomicBoolean(false)
        val replied = AtomicBoolean(false)
        worker.run({ cancelled.get() }, work = { cancelled.set(true); "late" }, reply = { replied.set(true) })
        drain()
        assertFalse(replied.get())
    }

    @Test
    fun `a failing request replies null and the worker keeps serving`() {
        val replies = CopyOnWriteArrayList<String?>()
        worker.run(work = { throw IllegalStateException("parse failed") }, reply = { replies.add(it) })
        worker.run(work = { "second" }, reply = { throw IllegalStateException("callback gone") })
        worker.run(work = { "third" }, reply = { replies.add(it) })
        drain()
        assertEquals(listOf(null, "third"), replies)
        assertEquals(listOf("parse failed", "callback gone"), errors.map { it.message })
    }
}
