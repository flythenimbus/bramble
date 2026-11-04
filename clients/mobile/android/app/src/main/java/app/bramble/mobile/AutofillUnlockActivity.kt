package app.bramble.mobile

import android.app.Dialog
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.BaseAdapter
import android.widget.LinearLayout
import android.widget.ListView
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

        const val EXTRA_MATCH_PACKAGE = "app.bramble.autofill.MATCH_PACKAGE"
        const val EXTRA_CALLER_CERTS = "app.bramble.autofill.CALLER_CERTS"
        const val EXTRA_ASSOC_URI = "app.bramble.autofill.ASSOC_URI"
        const val EXTRA_ASSOC_LABEL = "app.bramble.autofill.ASSOC_LABEL"
    }

    private lateinit var usernameIds: List<AutofillId>
    private lateinit var passwordIds: List<AutofillId>
    private lateinit var otpIds: List<AutofillId>
    private lateinit var hosts: List<String>
    private var label: String = ""
    private var showAll: Boolean = false
    private var matchPackage: String? = null
    private var callerCerts: Set<String> = emptySet()
    private var assocUri: String? = null
    private var assocLabel: String? = null

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
        matchPackage = intent.getStringExtra(EXTRA_MATCH_PACKAGE)
        callerCerts = intent.getStringArrayListExtra(EXTRA_CALLER_CERTS)?.toSet() ?: emptySet()
        assocUri = intent.getStringExtra(EXTRA_ASSOC_URI)
        assocLabel = intent.getStringExtra(EXTRA_ASSOC_LABEL)
    }

    // VEK loaded by the base; decrypt the logins off the main thread, then show the list.
    override fun onVekReady(vekB64: String) {
        Thread {
            val loaded = try { VaultReader.readLogins(this) } catch (e: Exception) { null }
            runOnUiThread {
                if (loaded == null) {
                    setError(getString(R.string.af_err_load_logins))
                } else {
                    logins = sortedByTitle(loaded) { it.displayTitle(this) }
                    matches = logins
                        .filter { VaultReader.matches(it, hosts, matchPackage, callerCerts) }
                        .sortedBy { VaultReader.rank(it, hosts, matchPackage, callerCerts) }
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

        // A recycling list: building a row per login at once (thousands, rebuilt per keystroke)
        // is what got the iOS peer killed at its memory cap.
        val adapter = RowsAdapter()
        val list = ListView(this).apply {
            divider = null
            dividerHeight = 0
            selector = ColorDrawable(Color.TRANSPARENT)
            setPadding(dp(20), 0, dp(20), dp(24))
            clipToPadding = false
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f)
            this.adapter = adapter
        }
        outer.addView(list)

        adapter.show(query)
        search.addTextChangedListener(object : TextWatcher {
            override fun afterTextChanged(s: Editable?) {
                adapter.show(s?.toString() ?: "")
                list.setSelection(0)
            }
            override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
            override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}
        })
        setContent(outer)
    }

    private inner class RowsAdapter : BaseAdapter() {
        private var rows: List<PickerRow> = emptyList()
        private var query = ""

        fun show(query: String) {
            this.query = query
            rows = pickerRows(logins, matches, showAll, label.isNotEmpty(), searchTokens(query))
            notifyDataSetChanged()
        }

        override fun getCount() = rows.size
        override fun getItem(position: Int) = rows[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getViewTypeCount() = 3
        override fun getItemViewType(position: Int) = when (rows[position]) {
            is PickerRow.Section -> 0
            is PickerRow.Login -> 1
            is PickerRow.Empty -> 2
        }
        // Rows take their own taps; the list itself has nothing to select.
        override fun areAllItemsEnabled() = false
        override fun isEnabled(position: Int) = false

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View =
            when (val r = rows[position]) {
                is PickerRow.Section -> ((convertView as? TextView) ?: sectionLabel("")).apply { text = sectionText(r.kind) }
                is PickerRow.Empty -> ((convertView as? TextView) ?: emptyLabel("")).apply {
                    text = if (r.kind == EmptyKind.NO_LOGINS) getString(R.string.af_empty_no_logins)
                    else getString(R.string.af_empty_no_match, query)
                }
                is PickerRow.Login -> (convertView ?: row()).also { bindRow(it, r.login) }
            }
    }

    private fun sectionText(kind: SectionKind): String = when (kind) {
        SectionKind.MATCHES ->
            if (label.isNotEmpty()) getString(R.string.af_section_for, label) else getString(R.string.af_section_matches)
        SectionKind.OTHER_LOGINS -> getString(R.string.af_section_other_logins)
        SectionKind.NO_MATCHES -> getString(R.string.af_section_no_matches, label)
        SectionKind.ALL_LOGINS -> getString(R.string.af_section_logins_count, logins.size)
    }

    private class RowViews(val row: View, val chip: TextView, val title: TextView, val username: TextView)

    private fun row(): View {
        val rowView = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            background = roundedFill(color(R.color.bramble_af_card), color(R.color.bramble_af_border))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            isClickable = true
        }
        val chip = TextView(this).apply {
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 14f
            gravity = Gravity.CENTER
            setTypeface(typeface, Typeface.BOLD)
            background = roundedFill(color(R.color.bramble_af_chip), color(R.color.bramble_af_chip))
            layoutParams = LinearLayout.LayoutParams(dp(40), dp(40)).apply { marginEnd = dp(12) }
        }
        rowView.addView(chip)
        val texts = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val title = TextView(this).apply {
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            maxLines = 1
        }
        val username = TextView(this).apply {
            setTextColor(color(R.color.bramble_af_muted))
            textSize = 13f
            maxLines = 1
        }
        texts.addView(title)
        texts.addView(username)
        rowView.addView(texts)
        return wrapRow(rowView).apply { tag = RowViews(rowView, chip, title, username) }
    }

    private fun bindRow(view: View, login: AutofillLogin) {
        val v = view.tag as RowViews
        val title = login.displayTitle(this)
        v.chip.text = initials(title)
        v.title.text = title
        v.username.text = login.username
        v.username.visibility = if (login.username.isNotEmpty()) View.VISIBLE else View.GONE
        v.row.setOnClickListener { complete(login) }
    }

    private fun complete(login: AutofillLogin) {
        val uri = assocUri
        if (uri != null && VaultReader.offersAssociation(login, hosts, matchPackage, callerCerts)) {
            showAssociationPrompt(login, uri, assocLabel ?: uri)
        } else {
            finishWithDataset(login)
        }
    }

    private fun showAssociationPrompt(login: AutofillLogin, uri: String, label: String) {
        val message = getString(
            if (uri.startsWith("androidapp://")) R.string.af_assoc_message_app else R.string.af_assoc_message_web,
            label,
            login.displayTitle(this),
        )
        val dialog = Dialog(this)
        dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(22), dp(22), dp(22), dp(20))
            background = roundedFill(color(R.color.bramble_af_card), color(R.color.bramble_af_border))
        }
        card.addView(TextView(this).apply {
            text = getString(R.string.af_assoc_title)
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 18f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(0, 0, 0, dp(8))
        })
        card.addView(TextView(this).apply {
            text = message
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 15f
            setPadding(0, 0, 0, dp(18))
        })
        card.addView(filledButton(getString(R.string.af_assoc_save)) {
            dialog.dismiss()
            VaultReader.activeVaultId(this)?.let { vaultId ->
                try {
                    PendingAssociation.write(this, login.id, uri, vaultId, label)
                } catch (e: Exception) {
                    // The fill survives a failed save.
                }
            }
            finishWithDataset(login)
        })
        card.addView(spacer(dp(10)))
        card.addView(outlinedButton(getString(R.string.af_assoc_just)) {
            dialog.dismiss()
            finishWithDataset(login)
        })
        val wrap = FrameLayout(this).apply {
            setPadding(dp(24), 0, dp(24), 0)
            addView(card)
        }
        dialog.setContentView(wrap)
        dialog.window?.apply {
            setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
            setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        dialog.setOnCancelListener { finishWithDataset(login) }
        dialog.show()
    }

    private fun finishWithDataset(login: AutofillLogin) {
        // Nothing to put in this form (a code-only page and a login without a TOTP key): fill nothing.
        val dataset = Datasets.fillDataset(this, login, usernameIds, passwordIds, otpIds, System.currentTimeMillis())
            ?: return cancelUnlock()
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

/** One row of the autofill picker. Sections are kinds, not strings, so this stays JVM-testable. */
internal sealed class PickerRow {
    data class Section(val kind: SectionKind) : PickerRow()
    class Login(val login: AutofillLogin) : PickerRow()
    data class Empty(val kind: EmptyKind) : PickerRow()
}

internal enum class SectionKind { MATCHES, OTHER_LOGINS, NO_MATCHES, ALL_LOGINS }

internal enum class EmptyKind { NO_LOGINS, NO_RESULTS }

/**
 * The picker's rows: a search is one flat list over the whole vault; otherwise the page's
 * matches first and every other login after them, or the whole vault when nothing matches
 * (or the caller asked for all of it).
 */
internal fun pickerRows(
    logins: List<AutofillLogin>,
    matches: List<AutofillLogin>,
    showAll: Boolean,
    hasLabel: Boolean,
    tokens: List<String>,
): List<PickerRow> {
    if (logins.isEmpty()) return listOf(PickerRow.Empty(EmptyKind.NO_LOGINS))
    if (tokens.isNotEmpty()) {
        val found = logins.filter { it.matchesQuery(tokens) }
        return if (found.isEmpty()) listOf(PickerRow.Empty(EmptyKind.NO_RESULTS)) else found.map { PickerRow.Login(it) }
    }
    if (!showAll && matches.isNotEmpty()) {
        val matched = matches.mapTo(HashSet()) { it.id }
        val others = logins.filter { it.id !in matched }
        val rows = mutableListOf<PickerRow>(PickerRow.Section(SectionKind.MATCHES))
        matches.mapTo(rows) { PickerRow.Login(it) }
        if (others.isNotEmpty()) {
            rows.add(PickerRow.Section(SectionKind.OTHER_LOGINS))
            others.mapTo(rows) { PickerRow.Login(it) }
        }
        return rows
    }
    val title = if (matches.isEmpty() && hasLabel) SectionKind.NO_MATCHES else SectionKind.ALL_LOGINS
    return listOf<PickerRow>(PickerRow.Section(title)) + logins.map { PickerRow.Login(it) }
}

/** A to Z by title, ignoring case and accents (#112: it was vault order, newest last). */
internal fun sortedByTitle(logins: List<AutofillLogin>, title: (AutofillLogin) -> String): List<AutofillLogin> {
    val collator = java.text.Collator.getInstance().apply { strength = java.text.Collator.PRIMARY }
    return logins.sortedWith { a, b -> collator.compare(title(a), title(b)) }
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
