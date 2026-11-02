package app.bramble.mobile

import java.io.File
import java.io.IOException
import java.io.RandomAccessFile

// A small file two processes rewrite: the :autofill provider appends, the app drains. Every
// read-modify-write holds an exclusive lock on a sidecar file, and the write lands by rename, so no
// update is lost and a plain reader never sees half a file. A FileLock belongs to the whole process,
// so the monitor serialises this process's own threads first.
object LockedFile {
    private val monitor = Any()

    /** Replace the contents with `change(current)`; null removes the file. */
    fun update(file: File, change: (String?) -> String?) {
        synchronized(monitor) {
            RandomAccessFile(File(file.path + ".lock"), "rw").channel.use { channel ->
                channel.lock().use {
                    val next = change(if (file.exists()) file.readText() else null)
                    if (next == null) {
                        file.delete()
                    } else {
                        val tmp = File(file.path + ".tmp")
                        tmp.writeText(next)
                        if (!tmp.renameTo(file)) throw IOException("couldn't replace ${file.name}")
                    }
                }
            }
        }
    }

    /** The contents, removing the file in the same locked step; null when there is none. */
    fun take(file: File): String? {
        var taken: String? = null
        update(file) { current ->
            taken = current
            null
        }
        return taken
    }
}
