package app.bramble.mobile

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AppCompatActivity
import uniffi.vault_crypto.exportVek
import uniffi.vault_crypto.isLocked
import uniffi.vault_crypto.lock
import uniffi.vault_crypto.unlockWithVek
import uniffi.vault_crypto.unwrapVekPassword

// The autofill unlock screen + searchable credential list. Launched by the service's
// dataset-level authentication: authenticate FIRST (biometric or master password), then
// reveal the list. On pick it returns the chosen Dataset, which the framework fills
// directly. Nothing about the vault is shown before a successful unlock. The Android peer
// of the iOS CredentialProviderViewController. See docs/mobile-port.md.
@RequiresApi(Build.VERSION_CODES.O)
class AutofillUnlockActivity : AppCompatActivity() {

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
    private var coreWasLocked: Boolean = true

    // Loaded after unlock.
    private var logins: List<AutofillLogin> = emptyList()
    private var matches: List<AutofillLogin> = emptyList()

    private lateinit var root: FrameLayout

    @Suppress("UNCHECKED_CAST")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        usernameIds = parcelableIds(EXTRA_USERNAME_IDS)
        passwordIds = parcelableIds(EXTRA_PASSWORD_IDS)
        otpIds = parcelableIds(EXTRA_OTP_IDS)
        hosts = intent.getStringArrayListExtra(EXTRA_HOSTS) ?: emptyList()
        label = intent.getStringExtra(EXTRA_LABEL) ?: ""
        showAll = intent.getBooleanExtra(EXTRA_SHOW_ALL, false)
        coreWasLocked = isLocked()

        root = FrameLayout(this).apply {
            setBackgroundColor(color(R.color.bramble_af_background))
            fitsSystemWindows = true
            // This sheet IS the autofill UI: its master-password and search fields must never
            // be autofill targets for any provider (us or another). Excludes all descendants.
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = cancel()
        })

        // A live keep-unlocked session skips the unlock screen entirely.
        val session = KeepUnlockedStore.load(this)
        if (session != null) {
            proceedWithVek(session)
        } else {
            showUnlock()
        }
    }

    @Suppress("DEPRECATION")
    private fun parcelableIds(key: String): List<AutofillId> =
        intent.getParcelableArrayListExtra(key) ?: emptyList()

    // --- unlock screen ---

    private var passwordField: EditText? = null
    private var errorView: TextView? = null
    private var busy = false

    private fun showUnlock() {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(40), dp(24), dp(24))
        }
        col.addView(glyph(64), centered())

        col.addView(TextView(this).apply {
            text = "Enter your master password to unlock your vault"
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 20f
            setPadding(0, dp(20), 0, dp(20))
        })

        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            background = roundedFill(color(R.color.bramble_af_card), color(R.color.bramble_af_border))
            setPadding(dp(18), dp(18), dp(18), dp(18))
        }

        if (BiometricUnlock.isAvailable(this)) {
            card.addView(filledButton("Unlock with biometrics") { doBiometric() })
            card.addView(spacer(dp(14)))
        }

        val pw = EditText(this).apply {
            hint = "Master password"
            setHintTextColor(color(R.color.bramble_af_muted))
            setTextColor(color(R.color.bramble_af_foreground))
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            imeOptions = EditorInfo.IME_ACTION_DONE
            background = roundedFill(color(R.color.bramble_af_input), color(R.color.bramble_af_border))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setOnEditorActionListener { _, _, _ -> doPassword(text.toString()); true }
        }
        passwordField = pw
        card.addView(pw)
        card.addView(spacer(dp(14)))

        errorView = TextView(this).apply {
            setTextColor(color(R.color.bramble_af_destructive))
            textSize = 13f
            visibility = View.GONE
        }
        card.addView(errorView)

        card.addView(outlinedButton("Unlock Vault") { doPassword(pw.text.toString()) })
        col.addView(card)
        scroll.addView(col)
        setContent(scroll)

        // Cached biometric present: pop the prompt right away; password is the fallback.
        if (BiometricUnlock.isAvailable(this)) doBiometric()
    }

    private fun doBiometric() {
        if (busy) return
        setError(null)
        BiometricUnlock.unlock(this, "Unlock Bramble") { result ->
            when (result) {
                is BiometricUnlock.Result.Ok -> proceedWithVek(result.vekB64)
                BiometricUnlock.Result.NoSecret -> setError("Enter your master password.")
                BiometricUnlock.Result.Invalidated -> setError("Biometrics changed. Use your master password.")
                BiometricUnlock.Result.Cancelled -> { /* stay on the password screen */ }
                is BiometricUnlock.Result.Error -> setError(result.message)
            }
        }
    }

    // Master-password unlock: Argon2id via the shared core against the vault's password slot.
    private fun doPassword(password: String) {
        if (busy || password.isEmpty()) return
        val slot = try {
            VaultReader.decode(this).passwordSlot
        } catch (e: Exception) {
            null
        }
        if (slot == null) {
            setError("This vault has no master password.")
            return
        }
        busy = true
        setError(null)
        Thread {
            val outcome = try {
                val ok = unwrapVekPassword(
                    password,
                    b64(slot.salt),
                    b64(slot.slotId),
                    b64(slot.verifier),
                    b64(slot.wrapIv),
                    b64(slot.wrappedVek),
                    verifierPrefix(),
                )
                if (ok) Result.success(exportVek()) else Result.success(null)
            } catch (e: Exception) {
                Result.failure(e)
            }
            runOnUiThread {
                busy = false
                outcome.onSuccess { vek ->
                    if (vek != null) proceedWithVek(vek) else setError("Incorrect master password")
                }
                outcome.onFailure { setError(it.message ?: "Unlock failed") }
            }
        }.start()
    }

    // VEK in hand: load the core, decrypt the logins (off the main thread), then show the list.
    private fun proceedWithVek(vekB64: String) {
        showSpinner()
        Thread {
            val loaded = try {
                unlockWithVek(vekB64)
                val all = VaultReader.readLogins(this)
                KeepUnlockedStore.save(this, vekB64)
                all
            } catch (e: Exception) {
                null
            }
            runOnUiThread {
                if (loaded == null) {
                    setError("Couldn't load logins.")
                    if (passwordField == null) showUnlock()
                } else {
                    logins = loaded
                    matches = loaded.filter { VaultReader.matches(it, hosts) }
                    showList("")
                }
            }
        }.start()
    }

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
            text = "Bramble"
            setTextColor(color(R.color.bramble_af_foreground))
            textSize = 19f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, 0, 0)
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        })
        header.addView(textButton("Cancel") { cancel() })
        outer.addView(header)

        val search = EditText(this).apply {
            hint = "Search logins"
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
        val q = query.trim().lowercase()
        if (logins.isEmpty()) {
            container.addView(emptyLabel("No logins saved yet.\nAdd one in Bramble."))
            return
        }
        if (q.isNotEmpty()) {
            val filtered = logins.filter { it.matchesQuery(q) }
            if (filtered.isEmpty()) container.addView(emptyLabel("No logins match “$query”."))
            else filtered.forEach { container.addView(row(it)) }
            return
        }
        if (!showAll && matches.isNotEmpty()) {
            container.addView(sectionLabel(if (label.isNotEmpty()) "For $label" else "Matches"))
            matches.forEach { container.addView(row(it)) }
            val others = logins.filter { o -> matches.none { it.id == o.id } }
            if (others.isNotEmpty()) {
                container.addView(sectionLabel("All items"))
                others.forEach { container.addView(row(it)) }
            }
        } else {
            val title = if (matches.isEmpty() && label.isNotEmpty()) "No matches for $label" else "Items (${logins.size})"
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
            text = initials(login.displayTitle())
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
            text = login.displayTitle()
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

    private fun cancel() {
        setResult(RESULT_CANCELED)
        finishCore()
    }

    // Don't leak the unlocked core into other processes: relock if we did the unlocking.
    private fun finishCore() {
        if (coreWasLocked) {
            try { lock() } catch (e: Exception) { /* ignore */ }
        }
        finish()
    }

    // --- tiny view helpers (programmatic UI; no XML layouts) ---

    private fun setContent(view: View) {
        root.removeAllViews()
        root.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    private fun showSpinner() {
        val box = FrameLayout(this)
        box.addView(ProgressBar(this).apply { isIndeterminate = true }, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.CENTER))
        setContent(box)
    }

    private fun setError(message: String?) {
        val e = errorView ?: return
        if (message == null) {
            e.visibility = View.GONE
        } else {
            e.text = message
            e.visibility = View.VISIBLE
        }
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

    private fun glyph(sizeDp: Int) = ImageView(this).apply {
        setImageResource(R.mipmap.ic_launcher)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    private fun centered() = LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL }

    private fun spacer(h: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(MATCH, h) }

    private fun filledButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.BLACK)
        background = roundedFill(color(R.color.bramble_af_foreground), color(R.color.bramble_af_foreground))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
    }

    private fun outlinedButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(color(R.color.bramble_af_foreground))
        background = roundedFill(color(R.color.bramble_af_card), color(R.color.bramble_af_border))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
    }

    private fun textButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(color(R.color.bramble_af_muted))
        setBackgroundColor(Color.TRANSPARENT)
        setOnClickListener { onClick() }
    }

    private fun roundedFill(fill: Int, stroke: Int) = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(11).toFloat()
        setColor(fill)
        setStroke(dp(1), stroke)
    }

    private fun color(res: Int) = androidx.core.content.ContextCompat.getColor(this, res)

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    private fun b64(bytes: ByteArray) = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

    private val MATCH get() = ViewGroup.LayoutParams.MATCH_PARENT
    private val WRAP get() = ViewGroup.LayoutParams.WRAP_CONTENT
}

private fun AutofillLogin.matchesQuery(q: String): Boolean =
    name.lowercase().contains(q) ||
        username.lowercase().contains(q) ||
        hostnames.any { it.lowercase().contains(q) }

private fun initials(s: String): String {
    val words = s.split(' ', '.').filter { it.isNotEmpty() }
    val chars = if (words.size >= 2) "${words[0].first()}${words[1].first()}" else s.take(2)
    return chars.uppercase()
}
