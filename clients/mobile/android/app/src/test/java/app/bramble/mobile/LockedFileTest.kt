package app.bramble.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

// Host-JVM test for the lock every provider -> app handoff file is rewritten under: concurrent
// appends must all survive (an unlocked read-modify-write dropped 70% of racing pairs).
class LockedFileTest {
    @get:Rule val dir = TemporaryFolder()

    @Test
    fun concurrentAppendsAreNeverLost() {
        val file = File(dir.root, "pending.txt")
        val threads = (0 until 8).map { t ->
            Thread { repeat(50) { i -> LockedFile.update(file) { old -> (old ?: "") + "$t-$i\n" } } }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertEquals(400, file.readText().lines().filter { it.isNotEmpty() }.toSet().size)
    }

    @Test
    fun takeReturnsTheContentsAndRemovesTheFile() {
        val file = File(dir.root, "pending.txt")
        LockedFile.update(file) { "a" }
        assertEquals("a", LockedFile.take(file))
        assertFalse(file.exists())
        assertNull(LockedFile.take(file))
    }
}
