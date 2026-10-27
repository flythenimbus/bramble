package app.bramble.mobile

import java.util.concurrent.Executor

// Runs autofill requests off the service's main thread and replies through their callback,
// dropping one the system has cancelled (it stops waiting after 5s) before or after its work.
internal class AutofillWorker(
    private val executor: Executor,
    private val onError: (Exception) -> Unit,
) {
    fun <T> run(
        isCancelled: () -> Boolean = { false },
        work: () -> T?,
        reply: (T?) -> Unit,
    ) {
        executor.execute {
            if (isCancelled()) return@execute
            val result = try {
                work()
            } catch (e: Exception) {
                onError(e)
                null
            }
            if (isCancelled()) return@execute
            try {
                reply(result)
            } catch (e: Exception) {
                onError(e)
            }
        }
    }
}
