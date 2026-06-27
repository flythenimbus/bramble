package app.bramble.mobile

import android.content.Context
import android.os.Build
import android.service.autofill.Dataset
import android.service.autofill.InlinePresentation
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import androidx.annotation.RequiresApi

// Builds the dropdown presentations and the filled Dataset for a login. Shared by the
// service (unlocked direct fills) and the unlock Activity (the value returned from
// dataset-level authentication, which the framework applies directly). Username + the live
// TOTP code fill their fields; the password fills its own.
@RequiresApi(Build.VERSION_CODES.O)
object Datasets {

    /** A dropdown / inline row: icon + title + subtitle. */
    fun presentation(context: Context, title: String, subtitle: String): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.autofill_dataset)
        views.setTextViewText(R.id.autofill_title, title)
        views.setTextViewText(R.id.autofill_subtitle, subtitle)
        return views
    }

    /** Fill a login into the form's fields (username, password, and the live TOTP code). */
    @Suppress("DEPRECATION")
    fun fillDataset(
        context: Context,
        login: AutofillLogin,
        usernameIds: List<AutofillId>,
        passwordIds: List<AutofillId>,
        otpIds: List<AutofillId>,
        nowMillis: Long,
        inline: InlinePresentation? = null,
    ): Dataset {
        val pres = presentation(context, login.displayTitle(context), login.username)
        val builder = Dataset.Builder(pres)
        fun put(id: AutofillId, value: String) {
            if (inline != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                builder.setValue(id, AutofillValue.forText(value), pres, inline)
            } else {
                builder.setValue(id, AutofillValue.forText(value))
            }
        }
        if (login.username.isNotEmpty()) for (id in usernameIds) put(id, login.username)
        for (id in passwordIds) put(id, login.password)
        if (otpIds.isNotEmpty()) {
            Totp.generate(login.totp, nowMillis)?.let { code -> for (id in otpIds) put(id, code) }
        }
        return builder.build()
    }
}

fun AutofillLogin.displayTitle(context: Context): String =
    name.ifEmpty { username.ifEmpty { context.getString(R.string.af_no_name) } }
