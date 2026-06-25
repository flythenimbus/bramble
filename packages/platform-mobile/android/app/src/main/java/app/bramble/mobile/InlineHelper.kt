package app.bramble.mobile

import android.app.PendingIntent
import android.content.Context
import android.graphics.drawable.Icon
import android.os.Build
import android.service.autofill.InlinePresentation
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import androidx.autofill.inline.UiVersions
import androidx.autofill.inline.v1.InlineSuggestionUi

// Builds inline keyboard suggestions (API 30+). Opt-in only: the service attaches these
// solely when the keyboard-suggestions pref is on, mirroring the iOS QuickType opt-in.
// Inline rows carry a name + username (or the "Unlock" affordance) and an icon, never a
// password. See docs/mobile-port.md.
@RequiresApi(Build.VERSION_CODES.R)
object InlineHelper {

    fun supports(spec: InlinePresentationSpec): Boolean =
        UiVersions.getVersions(spec.style).contains(UiVersions.INLINE_UI_VERSION_1)

    fun build(
        context: Context,
        spec: InlinePresentationSpec,
        title: String,
        subtitle: String,
        attribution: PendingIntent,
        pinned: Boolean = false,
    ): InlinePresentation? {
        if (!supports(spec)) return null
        val content = InlineSuggestionUi.newContentBuilder(attribution).setTitle(title)
        if (subtitle.isNotEmpty()) content.setSubtitle(subtitle)
        runCatching { content.setStartIcon(Icon.createWithResource(context, R.mipmap.ic_launcher)) }
        return InlinePresentation(content.build().slice, spec, pinned)
    }
}
