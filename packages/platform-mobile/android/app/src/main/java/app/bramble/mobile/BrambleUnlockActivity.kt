package app.bramble.mobile

import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
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

// Shared auth-first unlock screen for Bramble's out-of-process providers (the classic
// AutofillService AND the Credential Manager passkey provider). Renders the biometric +
// master-password unlock, loads the VEK into the shared Rust core, slides the keep-unlocked
// window, then hands control to the subclass via onVekReady. A live keep-unlocked session skips
// the screen entirely. Nothing about the vault is shown before unlock; if we did the unlocking
// we relock on finish so the decrypted core never leaks past this task. See docs/mobile-port.md.
@RequiresApi(Build.VERSION_CODES.O)
abstract class BrambleUnlockActivity : AppCompatActivity() {

    protected var coreWasLocked = true
        private set

    private lateinit var root: FrameLayout
    private var passwordField: EditText? = null
    private var errorView: TextView? = null
    private var busy = false

    /** Parse intent extras here (runs before the unlock flow, which may skip to onVekReady). */
    protected abstract fun onPrepare()

    /** VEK is loaded into the core and the keep-unlocked window saved; do the provider's work. */
    protected abstract fun onVekReady(vekB64: String)

    /** User cancelled / backed out. Set the provider-specific cancel result before finish. */
    protected abstract fun onUnlockCancelled()

    final override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        coreWasLocked = isLocked()
        root = FrameLayout(this).apply {
            setBackgroundColor(color(R.color.bramble_af_background))
            fitsSystemWindows = true
            // This sheet IS the provider UI: its fields must never be autofill targets.
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        }
        setContentView(root)
        onBackPressedDispatcher.addCallback(this, object : androidx.activity.OnBackPressedCallback(true) {
            override fun handleOnBackPressed() = cancelUnlock()
        })
        onPrepare()
        // A bridged one-shot VEK (e.g. the passkey list->sign handoff) or a live keep-unlocked
        // session skips the unlock screen entirely.
        val session = bridgeSessionVek() ?: KeepUnlockedStore.load(this)
        if (session != null) proceedWithVek(session) else showUnlock()
    }

    /**
     * A VEK to proceed with silently, skipping the unlock screen - e.g. a one-shot handoff from an
     * earlier step of the same ceremony. Default none (subclasses opt in). Distinct from the
     * keep-unlocked session so it works regardless of the auto-lock window.
     */
    protected open fun bridgeSessionVek(): String? = null

    protected fun cancelUnlock() {
        onUnlockCancelled()
        finishCore()
    }

    // Relock if we did the unlocking, so the decrypted core never leaks past this task.
    protected fun finishCore() {
        if (coreWasLocked) {
            try { lock() } catch (e: Exception) { /* ignore */ }
        }
        finish()
    }

    // --- unlock screen ---

    private fun showUnlock() {
        val scroll = ScrollView(this)
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(40), dp(24), dp(24))
        }
        col.addView(glyph(64), centered())
        col.addView(TextView(this).apply {
            text = getString(R.string.af_unlock_title)
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
            card.addView(filledButton(getString(R.string.af_unlock_biometrics)) { doBiometric() })
            card.addView(spacer(dp(14)))
        }
        val pw = EditText(this).apply {
            hint = getString(R.string.af_master_password)
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
        card.addView(outlinedButton(getString(R.string.af_unlock_vault)) { doPassword(pw.text.toString()) })
        col.addView(card)
        scroll.addView(col)
        setContent(scroll)

        // Cached biometric present: pop the prompt right away; password is the fallback.
        if (BiometricUnlock.isAvailable(this)) doBiometric()
    }

    private fun doBiometric() {
        if (busy) return
        setError(null)
        BiometricUnlock.unlock(this, getString(R.string.af_biometric_prompt_title)) { result ->
            when (result) {
                is BiometricUnlock.Result.Ok -> proceedWithVek(result.vekB64)
                BiometricUnlock.Result.NoSecret -> setError(getString(R.string.af_err_enter_password))
                BiometricUnlock.Result.Invalidated -> setError(getString(R.string.af_err_biometrics_changed))
                BiometricUnlock.Result.Cancelled -> { /* stay on the password screen */ }
                is BiometricUnlock.Result.Error -> setError(result.message)
            }
        }
    }

    // Master-password unlock: Argon2id via the shared core against the vault's password slot.
    private fun doPassword(password: String) {
        if (busy || password.isEmpty()) return
        val slot = try { VaultReader.decode(this).passwordSlot } catch (e: Exception) { null }
        if (slot == null) {
            setError(getString(R.string.af_err_no_password))
            return
        }
        busy = true
        setError(null)
        Thread {
            val outcome = try {
                val ok = unwrapVekPassword(
                    password, b64(slot.salt), b64(slot.slotId), b64(slot.verifier),
                    b64(slot.wrapIv), b64(slot.wrappedVek), verifierPrefix(),
                )
                if (ok) Result.success(exportVek()) else Result.success(null)
            } catch (e: Exception) {
                Result.failure(e)
            }
            runOnUiThread {
                busy = false
                outcome.onSuccess { vek ->
                    if (vek != null) proceedWithVek(vek) else setError(getString(R.string.af_err_incorrect_password))
                }
                outcome.onFailure { setError(it.message ?: getString(R.string.af_err_unlock_failed)) }
            }
        }.start()
    }

    // VEK in hand: load it into the core + slide the keep-unlocked window (off the main thread),
    // then hand off to the subclass. The subclass does its own reads on its own thread.
    private fun proceedWithVek(vekB64: String) {
        showSpinner()
        Thread {
            val ok = try {
                unlockWithVek(vekB64)
                KeepUnlockedStore.save(this, vekB64)
                true
            } catch (e: Exception) {
                false
            }
            runOnUiThread {
                if (ok) {
                    onVekReady(vekB64)
                } else {
                    setError(getString(R.string.af_err_unlock_failed))
                    if (passwordField == null) showUnlock()
                }
            }
        }.start()
    }

    // --- view helpers (programmatic UI; no XML layouts), shared with subclasses ---

    protected fun setContent(view: View) {
        root.removeAllViews()
        root.addView(view, FrameLayout.LayoutParams(MATCH, MATCH))
    }

    protected fun showSpinner() {
        val box = FrameLayout(this)
        box.addView(ProgressBar(this).apply { isIndeterminate = true }, FrameLayout.LayoutParams(dp(48), dp(48), Gravity.CENTER))
        setContent(box)
    }

    protected fun setError(message: String?) {
        val e = errorView ?: return
        if (message == null) {
            e.visibility = View.GONE
        } else {
            e.text = message
            e.visibility = View.VISIBLE
        }
    }

    protected fun glyph(sizeDp: Int) = ImageView(this).apply {
        setImageResource(R.mipmap.ic_launcher)
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    protected fun centered() = LinearLayout.LayoutParams(WRAP, WRAP).apply { gravity = Gravity.CENTER_HORIZONTAL }

    protected fun spacer(h: Int) = View(this).apply { layoutParams = LinearLayout.LayoutParams(MATCH, h) }

    protected fun filledButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(Color.BLACK)
        background = roundedFill(color(R.color.bramble_af_foreground), color(R.color.bramble_af_foreground))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
    }

    protected fun outlinedButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(color(R.color.bramble_af_foreground))
        background = roundedFill(color(R.color.bramble_af_card), color(R.color.bramble_af_border))
        setOnClickListener { onClick() }
        layoutParams = LinearLayout.LayoutParams(MATCH, WRAP)
    }

    protected fun textButton(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(color(R.color.bramble_af_muted))
        setBackgroundColor(Color.TRANSPARENT)
        setOnClickListener { onClick() }
    }

    protected fun roundedFill(fill: Int, stroke: Int) = android.graphics.drawable.GradientDrawable().apply {
        cornerRadius = dp(11).toFloat()
        setColor(fill)
        setStroke(dp(1), stroke)
    }

    protected fun color(res: Int) = androidx.core.content.ContextCompat.getColor(this, res)

    protected fun dp(value: Int): Int =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics).toInt()

    protected fun b64(bytes: ByteArray): String = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

    protected val MATCH get() = ViewGroup.LayoutParams.MATCH_PARENT
    protected val WRAP get() = ViewGroup.LayoutParams.WRAP_CONTENT
}
