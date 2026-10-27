package app.bramble.mobile

import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import okhttp3.Call

/**
 * Keeps Bramble running while a request is in flight, so leaving the app does not freeze it.
 *
 * Android freezes a left app within about a minute: measured on a Pixel 8 (Android 17), it stays
 * the "previous app" for ~60s, then is cached and frozen 10s later, WebView included. A request
 * frozen mid-flight is worse than one that fails: the frozen time counts against its timeout, so
 * an upload the server has already stored comes back as "timeout" when Bramble is reopened. A
 * foreground service exempts the process. It is Android's side of the background time
 * NativeHttp.swift asks iOS for. See docs/cloud-storage-backups.md.
 *
 * Started with `startService` rather than `startForegroundService`, so there is no five-second
 * promise to break when a short request ends before the service gets going. The notification is
 * deferred (Android 12+), so a request that finishes within ten seconds shows nothing.
 */
class TransferService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        try {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification(),
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
                } else {
                    0
                },
            )
            Transfers.onProtected(true)
        } catch (e: Exception) {
            // Refused: the app was already left (Android 12+), or the day's dataSync budget is
            // spent (Android 15+). Requests carry on unprotected; see Transfers.interrupted.
            Transfers.onProtected(false)
            stopSelf()
        }
        return START_NOT_STICKY
    }

    /** Android 15+ ends a dataSync service after six hours in a day. Stop cleanly, as iOS does. */
    override fun onTimeout(startId: Int, fgsType: Int) {
        Transfers.expireAll()
        Transfers.onProtected(false)
        stopSelf()
    }

    override fun onDestroy() {
        Transfers.onProtected(false)
        super.onDestroy()
    }

    private fun notification(): android.app.Notification {
        val manager = getSystemService(NotificationManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(
                    CHANNEL_ID,
                    getString(R.string.transfer_channel_name),
                    NotificationManager.IMPORTANCE_LOW,
                ),
            )
        }
        val open = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_upload)
            .setContentTitle(getString(R.string.transfer_notification_title))
            .setContentText(getString(R.string.transfer_notification_text))
            .setContentIntent(open)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_DEFERRED)
            .build()
    }

    private companion object {
        const val CHANNEL_ID = "transfers"
        const val NOTIFICATION_ID = 7201
    }
}

/**
 * Holds [TransferService] while any request is in flight, one begin/end pair per request.
 *
 * The service lingers briefly after the last request ends, because one backup is several requests
 * (a WebDAV upload is a PUT then a MOVE, then the prune) with JavaScript running between them, and
 * a service stopped in one of those gaps cannot be restarted once the app has been left.
 */
internal object Transfers {
    class Transfer(val leftAtStart: Int) {
        @Volatile var expired = false
        @Volatile var call: Call? = null
    }

    private const val LINGER_MS = 5_000L

    private val lock = Any()
    private val active = mutableSetOf<Transfer>()
    private val main = Handler(Looper.getMainLooper())
    private var requested = false
    @Volatile private var keptAlive = false
    @Volatile private var timesLeft = 0
    // Always the application context, which lives as long as the process: not a leak.
    @SuppressLint("StaticFieldLeak")
    private var app: Context? = null
    private val stop = Runnable {
        synchronized(lock) {
            if (active.isNotEmpty() || !requested) return@Runnable
            requested = false
            app?.let { it.stopService(Intent(it, TransferService::class.java)) }
        }
    }

    fun begin(context: Context): Transfer {
        val t = Transfer(timesLeft)
        synchronized(lock) {
            app = context.applicationContext
            active += t
            main.removeCallbacks(stop)
            if (!requested) {
                try {
                    context.startService(Intent(context, TransferService::class.java))
                    requested = true
                } catch (e: IllegalStateException) {
                    // Background start refused (Android 8+): the app was already left.
                }
            }
        }
        return t
    }

    fun end(t: Transfer) {
        synchronized(lock) {
            active -= t
            if (active.isEmpty()) main.postDelayed(stop, LINGER_MS)
        }
    }

    /** The activity stopped: Bramble was left, or the screen went off. */
    fun onAppLeft() {
        timesLeft++
    }

    fun onProtected(on: Boolean) {
        keptAlive = on
        if (!on) synchronized(lock) { requested = false }
    }

    fun expireAll() {
        synchronized(lock) {
            for (t in active) {
                t.expired = true
                t.call?.cancel()
            }
        }
    }

    /**
     * Whether a failed request should read as "interrupted" rather than as a failure: the service
     * ran out of time, or Bramble was left while nothing was keeping it running. Either way the
     * request may have landed, and the honest thing is to retry it rather than back off.
     */
    fun interrupted(t: Transfer): Boolean = t.expired || (timesLeft != t.leftAtStart && !keptAlive)
}
