package app.bramble.mobile

import android.graphics.Typeface
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.RequiresApi

// The autofill unlock + searchable credential list. Launched by the service's dataset-level
// authentication. The auth-first unlock (biometric / master password) is the shared
// BrambleUnlockActivity; once the VEK is loaded this reads the logins and renders the
// searchable list, returning the chosen Dataset which the framework fills directly. The
// Android peer of the iOS CredentialProviderViewController list. See docs/mobile-port.md.
@RequiresApi(Build.VERSION_CODES.O)
class AutofillUnlockActivity : BrambleUnlockActivity() {

    companion object {
        const val EXTRA_USERNAME_IDS = "app.bramble.autofill.USERNAME_IDS"
        const val EXTRA_PASSWORD_IDS = "app.bramble.autofill.PASSWORD_IDS"
        const val EXTRA_OTP_IDS = "app.bramble.autofill.OTP_IDS"
        const val EXTRA_HOSTS = "app.bramble.autofill.HOSTS"
        const val EXTRA_LABEL = "app.bramble.autofill.LABEL"
        const val EXTRA_SHOW_ALL = "app.bramble.autofill.SHOW_ALL"
    }

    private lateinit var usernameIds: List<AutofillId>
    private lateinit var passwordIds: List<AutofillId>
    private lateinit var otpIds: List<AutofillId>
    private lateinit var hosts: List<String>
    private var label: String = ""
    private var showAll: Boolean = false

    // Loaded after unlock.
    private var logins: List<AutofillLogin> = emptyList()
    private var matches: List<AutofillLogin> = emptyList()

    override fun onPrepare() {
        usernameIds = parcelableIds(EXTRA_USERNAME_IDS)
        passwordIds = parcelableIds(EXTRA_PASSWORD_IDS)
        otpIds = parcelableIds(EXTRA_OTP_IDS)
        hosts = intent.getStringArrayListExtra(EXTRA_HOSTS) ?: emptyList()
        label = intent.getStringExtra(EXTRA_LABEL) ?: ""
        showAll = intent.getBooleanExtra(EXTRA_SHOW_ALL, false)
    }

    // VEK loaded by the base; decrypt the logins off the main thread, then show the list.
    override fun onVekReady(vekB64: String) {
        Thread {
            val loaded = try { VaultReader.readLogins(this) } catch (e: Exception) { null }
            runOnUiThread {
                if (loaded == null) {
                    setError(getString(R.string.af_err_load_logins))
                } else {
                    logins = loaded
                    matches = loaded.filter { VaultReader.matches(it, hosts) }
                    showList("")
                }
            }
        }.start()
    }

    override fun onUnlockCancelled() {
        setResult(RESULT_CANCELED)
    }

    @Suppress("DEPRECATION")
    private fun parcelableIds(key: String): List<AutofillId> =
        intent.getParcelableArrayListExtra(key) ?: emptyList()

    // --- credential list ---

    private fun showList(query: String) {
        val outer = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        val header = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(20), dp(16), dp(20), dp(12))
        }
        header.addView(glyph(26))
        header.addView(TextView(this).apply {
            text = getString(R.string.app_name)
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 19f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        header.addView(textButton(getString(R.string.af_cancel)) { cancelUnlock() })
        outer.addView(header)

        val search = EditText(this).apply {
            hint = getString(R.string.af_search_logins)
            setHintTextColor(color(R.color.bramble_af_muted))
            setTextColor(color(R.color.bramble_af_foreground))
            inputType = InputType.TYPE_CLASS_TEXT
            background = roundedFill(color(R.color.bramble_af_input), color(R.color.bramble_af_border))
            setPadding(dp(12), dp(10), dp(12), dp(10))
            setText(query)
            setSelection(query.length)
        }
        val searchWrap = FrameLayout(this).apply { setPadding(dp(20), 0, dp(20), dp(8)) }
        searchWrap.addView(search)
        outer.addView(searchWrap)

        val listCol = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), 0, dp(20), dp(24))
        }
        val scroll = ScrollView(this).apply { addView(listCol) }
        outer.addView(scroll)

        renderRows(listCol, query)
        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) = renderRows(listCol, s?.toString() ?: "")
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        setContent(outer)
    }

    private fun renderRows(container: LinearLayout, query: String) {
        container.removeAllViews()
        val tokens = searchTokens(query)
        if (logins.isEmpty()) {
            container.addView(emptyLabel(getString(R.string.af_empty_no_logins)))
            return
        }
        if (tokens.isNotEmpty()) {
            val filtered = logins.filter { it.matchesQuery(tokens) }
            if (filtered.isEmpty()) container.addView(emptyLabel(getString(R.string.af_empty_no_match, query)))
            else filtered.forEach { container.addView(row(it)) }
            return
        }
        if (!showAll && matches.isNotEmpty()) {
            container.addView(sectionLabel(if (label.isNotEmpty()) getString(R.string.af_section_for, label) else getString(R.string.af_section_matches)))
            matches.forEach { container.addView(row(it)) }
            val others = logins.filter { o -> matches.none { it.id == o.id } }
            if (others.isNotEmpty()) {
                container.addView(sectionLabel(getString(R.string.af_section_all_items)))
                others.forEach { container.addView(row(it)) }
            }
        } else {
            val title = if (matches.isEmpty() && label.isNotEmpty()) getString(R.string.af_section_no_matches, label) else getString(R.string.af_section_items_count, logins.size)
            container.addView(sectionLabel(title))
            logins.forEach { container.addView(row(it)) }
        }
    }

    private fun row(login: AutofillLogin): View {
        val rowView = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = roundedFill(color(R.color.bramble_af_card), color(R.color.bramble_af_border))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            isClickable = true
            setOnClickListener { complete(login) }
        }
        val chip = TextView(this).apply {
            text = initials(login.displayTitle(this@AutofillUnlockActivity))
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 14f
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            background = roundedFill(color(R.color.bramble_af_chip), color(R.color.bramble_af_chip))
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(12) }
        }
        rowView.addView(chip)
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        texts.addView(TextView(this).apply {
            text = login.displayTitle(this@AutofillUnlockActivity)
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
        })
        if (login.username.isNotEmpty()) {
            texts.addView(TextView(this).apply {
                text = login.username
                setTextColor(color(R.color.bramble_af_muted))
                textSize = 13f
                maxLines = 1
            })
        }
        rowView.addView(texts)
        return wrapRow(rowView)
    }

    private fun complete(login: AutofillLogin) {
        val dataset = Datasets.fillDataset(this, login, usernameIds, passwordIds, otpIds, System.currentTimeMillis())
        val result = android.content.Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, dataset)
        setResult(RESULT_OK, result)
        finishCore()
    }

    private fun sectionLabel(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(color(R.color.bramble_af_muted))
        textSize = 13f
        setPadding(0, dp(16), 0, dp(8))
    }

    private fun emptyLabel(text: String) = TextView(this).apply {
        this.text = text
        setTextColor(color(R.color.bramble_af_muted))
        textSize = 13f
        gravity = Gravity.CENTER
        setPadding(dp(8), dp(40), dp(8), dp(40))
    }

    private fun wrapRow(view: View): View = FrameLayout(this).apply {
        setPadding(0, dp(5), 0, dp(5))
        addView(view)
    }
}

/** Split a query into lowercased tokens, as the main app's `queryTokens` does. */
internal fun searchTokens(q: String): List<String> =
    q.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }

/**
 * Every token must appear somewhere in the entry, matching the main app's search rather than
 * the single-substring test this used to do: "acme staging" found nothing, because no one
 * field contains that string. One joined haystack (not per-field) so the tokens may land in
 * different fields, which is what makes a name plus a domain work as a query.
 */
internal fun AutofillLogin.matchesQuery(tokens: List<String>): Boolean {
    val haystack = "$name $username ${hostnames.joinToString(" ")}".lowercase()
    return tokens.all { haystack.contains(it) }
}

private fun initials(s: String): String {
    val words = s.split(' ', '.').filter { it.isNotEmpty() }
    val chars = if (words.size >= 2) "${words[0].first()}${words[1].first()}" else s.take(2)
    return chars.uppercase()
}
