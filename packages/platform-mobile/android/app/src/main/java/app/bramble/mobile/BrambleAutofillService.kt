package app.bramble.mobile

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.IntentSender
import android.os.Build
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.InlinePresentation
import android.service.autofill.SaveCallback
import android.service.autofill.SaveInfo
import android.service.autofill.SaveRequest
import android.util.Log
import android.widget.inline.InlinePresentationSpec
import androidx.annotation.RequiresApi
import java.util.concurrent.atomic.AtomicInteger
import uniffi.vault_crypto.isLocked
import uniffi.vault_crypto.lock
import uniffi.vault_crypto.unlockWithVek

// Bramble's classic AOSP AutofillService. Runs in our own package (a dedicated :autofill
// process), reads the real encrypted vault directly, and authenticates itself before any
// entry data is revealed. Locked fills surface a single "Unlock to autofill" dataset whose
// dataset-level authentication launches the unlock Activity; the Activity authenticates,
// shows a searchable list, and returns the chosen Dataset, which the framework fills
// directly. When the keep-unlocked window is live, fills skip auth and the matched logins
// fill straight from the dropdown. Opt-in inline keyboard suggestions and TOTP fill round
// out the parity with the iOS Credential Provider. See docs/mobile-port.md.
@RequiresApi(Build.VERSION_CODES.O)
class BrambleAutofillService : AutofillService() {

    private val requestCode = AtomicInteger(1)

    override fun onFillRequest(
        request: FillRequest,
        cancellationSignal: CancellationSignal,
        callback: FillCallback,
    ) {
        // Record whether the active keyboard offers inline suggestions, so Settings can hide
        // the keyboard-suggestions toggle on keyboards that can't show them (e.g. AOSP).
        val inlineRequested =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.R && request.inlineSuggestionsRequest != null
        AutofillCaps.recordInlineSupport(this, inlineRequested)

        val structure = request.fillContexts.lastOrNull()?.structure
        if (structure == null || isOwnApp(structure) || !VaultReader.hasVault(this)) {
            // Never autofill into Bramble's own UI (its webview fields are served from
            // localhost): no "Unlock to autofill" on the master-password or entry forms.
            callback.onSuccess(null)
            return
        }
        val parsed = StructureParser.parse(structure)
        // Resolve the hosts we may auto-match: a verified browser vouches for its webDomain; a
        // native app is matched only to domains it is proven to own via Digital Asset Links (its
        // spoofable webDomain and package name are never trusted). Either may be empty, leaving the
        // user the manual searchable list.
        val trustedBrowser = TrustedBrowsers.isTrustedBrowser(this, parsed.packageName)
        val hosts =
            if (trustedBrowser) parsed.requestedHosts(isTrustedBrowser = true)
            else DigitalAssetLinks.verifiedDomainsFor(this, parsed.packageName)
        // Page-side diagnostics only (field counts + the page's own domain/package). Never
        // logs vault data.
        Log.d(
            BrambleAutofill.LOG_TAG,
            "onFillRequest user=${parsed.usernameIds.size} pass=${parsed.passwordIds.size} " +
                "otp=${parsed.otpIds.size} pkg=${parsed.packageName} browser=$trustedBrowser hosts=$hosts " +
                "inlineReqByKeyboard=$inlineRequested",
        )
        if (!parsed.hasFields || parsed.packageName == packageName) {
            callback.onSuccess(null)
            return
        }
        val response = try {
            buildResponse(request, parsed, hosts)
        } catch (e: Exception) {
            Log.e(BrambleAutofill.LOG_TAG, "onFillRequest failed", e)
            null
        }
        callback.onSuccess(response)
    }

    private fun buildResponse(
        request: FillRequest,
        parsed: ParsedStructure,
        hosts: List<String>,
    ): FillResponse {
        val inline = inlineContext(request)
        val builder = FillResponse.Builder()
        val session = KeepUnlockedStore.load(this)
        val filled = session != null && addDirectDatasets(builder, parsed, hosts, session, inline)
        if (!filled) addLockedDataset(builder, parsed, hosts, inline)
        addSaveInfo(builder, parsed)
        return builder.build()
    }

    // Keep-unlocked window live: decrypt and offer the matched logins for a direct fill,
    // plus a "Show all" entry into the searchable list. No re-auth. Returns false to fall
    // back to the auth dataset.
    private fun addDirectDatasets(
        builder: FillResponse.Builder,
        parsed: ParsedStructure,
        hosts: List<String>,
        vekB64: String,
        inline: InlineContext?,
    ): Boolean {
        return try {
            val wasLocked = isLocked()
            unlockWithVek(vekB64)
            val logins = VaultReader.readLogins(this)
            if (wasLocked) lock()
            KeepUnlockedStore.save(this, vekB64) // slide the window forward

            val matches = logins.filter { VaultReader.matches(it, hosts) }
            val now = System.currentTimeMillis()
            for (login in matches) {
                builder.addDataset(
                    Datasets.fillDataset(
                        this, login, parsed.usernameIds, parsed.passwordIds, parsed.otpIds, now,
                        inline?.next(login.displayTitle(this), login.username),
                    )
                )
            }
            builder.addDataset(showAllDataset(parsed, hosts, inline))
            true
        } catch (e: Exception) {
            Log.e(BrambleAutofill.LOG_TAG, "directFill failed; falling back to auth", e)
            false
        }
    }

    // Locked: one dataset that authenticates before revealing anything.
    @Suppress("DEPRECATION")
    private fun addLockedDataset(
        builder: FillResponse.Builder,
        parsed: ParsedStructure,
        hosts: List<String>,
        inline: InlineContext?,
    ) {
        val pres = Datasets.presentation(this, getString(R.string.app_name), getString(R.string.af_ds_unlock))
        val inlinePres = inline?.next(getString(R.string.app_name), getString(R.string.af_ds_unlock))
        val dataset = Dataset.Builder(pres)
        for (id in parsed.allIds) setAuthValue(dataset, id, pres, inlinePres)
        dataset.setAuthentication(authSender(parsed, hosts, showAll = false))
        builder.addDataset(dataset.build())
    }

    // A "Show all logins" entry: authenticates (or reuses the live session) into the full
    // searchable list. Used in the unlocked dropdown so the user can reach non-matching logins.
    @Suppress("DEPRECATION")
    private fun showAllDataset(parsed: ParsedStructure, hosts: List<String>, inline: InlineContext?): Dataset {
        val pres = Datasets.presentation(this, getString(R.string.af_ds_show_all_logins), getString(R.string.af_ds_search_vault))
        val inlinePres = inline?.next(getString(R.string.af_ds_show_all), getString(R.string.af_ds_search_vault))
        val builder = Dataset.Builder(pres)
        for (id in parsed.allIds) setAuthValue(builder, id, pres, inlinePres)
        builder.setAuthentication(authSender(parsed, hosts, showAll = true))
        return builder.build()
    }

    @Suppress("DEPRECATION")
    private fun setAuthValue(
        builder: Dataset.Builder,
        id: android.view.autofill.AutofillId,
        pres: android.widget.RemoteViews,
        inline: InlinePresentation?,
    ) {
        if (inline != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            builder.setValue(id, null, pres, inline)
        } else {
            builder.setValue(id, null, pres)
        }
    }

    // Attach a SaveInfo so Android offers "Save to Bramble?" after a sign-in, when the user
    // has opted into save capture. Needs a password field to save against.
    private fun addSaveInfo(builder: FillResponse.Builder, parsed: ParsedStructure) {
        if (!offerToSaveEnabled() || parsed.passwordIds.isEmpty()) return
        val type = SaveInfo.SAVE_DATA_TYPE_PASSWORD or
            (if (parsed.usernameIds.isNotEmpty()) SaveInfo.SAVE_DATA_TYPE_USERNAME else 0)
        val save = SaveInfo.Builder(type, parsed.passwordIds.toTypedArray())
        if (parsed.usernameIds.isNotEmpty()) save.setOptionalIds(parsed.usernameIds.toTypedArray())
        builder.setSaveInfo(save.build())
    }

    private fun offerToSaveEnabled(): Boolean {
        val prefs = getSharedPreferences(BrambleAutofill.CAPACITOR_PREFS, Context.MODE_PRIVATE)
        // Default true (DEFAULT_OFFER_TO_SAVE): absent means on.
        return prefs.getString(BrambleAutofill.PREF_OFFER_TO_SAVE, null)?.trim() != "false"
    }

    // PendingIntent into the unlock Activity, carrying the field ids + requested hosts so the
    // Activity can build the chosen Dataset. Mutable so the framework can attach its extras.
    private fun authSender(parsed: ParsedStructure, hosts: List<String>, showAll: Boolean): IntentSender {
        val intent = Intent(this, AutofillUnlockActivity::class.java).apply {
            putParcelableArrayListExtra(AutofillUnlockActivity.EXTRA_USERNAME_IDS, ArrayList(parsed.usernameIds))
            putParcelableArrayListExtra(AutofillUnlockActivity.EXTRA_PASSWORD_IDS, ArrayList(parsed.passwordIds))
            putParcelableArrayListExtra(AutofillUnlockActivity.EXTRA_OTP_IDS, ArrayList(parsed.otpIds))
            putStringArrayListExtra(AutofillUnlockActivity.EXTRA_HOSTS, ArrayList(hosts))
            putExtra(AutofillUnlockActivity.EXTRA_LABEL, hosts.firstOrNull() ?: "")
            putExtra(AutofillUnlockActivity.EXTRA_SHOW_ALL, showAll)
        }
        return PendingIntent.getActivity(this, requestCode.getAndIncrement(), intent, pendingIntentFlags()).intentSender
    }

    // Inline suggestions are opt-in: only built when the keyboard-suggestions pref is on and
    // the keyboard requested them (API 30+).
    private fun inlineContext(request: FillRequest): InlineContext? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return null
        if (!quickTypeEnabled()) return null
        val inlineRequest = request.inlineSuggestionsRequest ?: return null
        val specs = inlineRequest.inlinePresentationSpecs
        if (specs.isEmpty() || inlineRequest.maxSuggestionCount <= 0) return null
        return InlineContext(this, specs, inlineRequest.maxSuggestionCount, attributionIntent())
    }

    private fun attributionIntent(): PendingIntent {
        val intent = Intent(this, MainActivity::class.java)
        return PendingIntent.getActivity(this, 0, intent, pendingIntentFlags())
    }

    private fun pendingIntentFlags(): Int {
        var flags = PendingIntent.FLAG_CANCEL_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) flags = flags or PendingIntent.FLAG_MUTABLE
        return flags
    }

    private fun quickTypeEnabled(): Boolean {
        val prefs = getSharedPreferences(BrambleAutofill.CAPACITOR_PREFS, Context.MODE_PRIVATE)
        return prefs.getString(BrambleAutofill.PREF_AUTOFILL_QUICKTYPE, null)?.trim() == "true"
    }

    // True when the request comes from Bramble itself (its own webview UI). A provider must
    // not offer to fill or save inside its own app.
    private fun isOwnApp(structure: android.app.assist.AssistStructure): Boolean =
        structure.activityComponent?.packageName == packageName

    // Label for a saved capture: the web domain only when the caller is a verified browser (so a
    // spoofed webDomain can't seed a mislabeled entry that later matches the real site), else the
    // caller package.
    private fun saveLabel(parsed: ParsedStructure): String {
        if (TrustedBrowsers.isTrustedBrowser(this, parsed.packageName)) {
            parsed.webDomains.firstOrNull()?.let { return VaultReader.normalizeHost(it) }
        }
        return parsed.packageName ?: ""
    }

    // The user confirmed "Save to Bramble?". Capture the submitted username + password and
    // hand them to the main app, which saves through its proven entry-creation path. We do
    // not write the encrypted vault from here (no re-implemented blob/entry crypto).
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        try {
            val structure = request.fillContexts.lastOrNull()?.structure
            if (structure != null && !isOwnApp(structure)) {
                val parsed = StructureParser.parse(structure)
                val password = parsed.password ?: ""
                if (password.isNotEmpty() && parsed.packageName != packageName) {
                    PendingSave.write(this, saveLabel(parsed), parsed.username ?: "", password)
                    val launch = Intent(this, MainActivity::class.java)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
                    startActivity(launch)
                }
            }
        } catch (e: Exception) {
            Log.e(BrambleAutofill.LOG_TAG, "onSaveRequest failed", e)
        }
        callback.onSuccess()
    }
}

// Hands out a capped sequence of inline presentations, one per dataset, reusing the last
// spec when there are more datasets than specs.
@RequiresApi(Build.VERSION_CODES.R)
private class InlineContext(
    private val context: Context,
    private val specs: List<InlinePresentationSpec>,
    private val max: Int,
    private val attribution: PendingIntent,
) {
    private var used = 0

    fun next(title: String, subtitle: String): InlinePresentation? {
        if (used >= max) return null
        val spec = specs.getOrNull(minOf(used, specs.size - 1)) ?: return null
        val pres = InlineHelper.build(context, spec, title, subtitle, attribution) ?: return null
        used++
        return pres
    }
}
