package app.bramble.mobile

import android.app.assist.AssistStructure
import android.os.Build
import android.view.View
import android.view.autofill.AutofillId
import androidx.annotation.RequiresApi

// Walks an AssistStructure to find the autofillable fields (username / password / one-time
// code) and the target identity: the browser web domain (getWebDomain) for web forms, else
// the app package (getIdPackage). Classification leans on autofill hints, HTML autocomplete
// attributes, input types, and field-name text, requiring a positive signal so we never
// fill an unrelated box. The Android peer of the iOS extension's host matching.
@RequiresApi(Build.VERSION_CODES.O)
class ParsedStructure(
    val packageName: String?,
    val webDomains: List<String>,
    val usernameIds: List<AutofillId>,
    val passwordIds: List<AutofillId>,
    val otpIds: List<AutofillId>,
    val username: String?,
    val password: String?,
) {
    val hasFields: Boolean get() = usernameIds.isNotEmpty() || passwordIds.isNotEmpty() || otpIds.isNotEmpty()
    val allIds: List<AutofillId> get() = usernameIds + passwordIds + otpIds

    /** Requested hosts to match against the vault: web domains, else a guess from the package. */
    fun requestedHosts(): List<String> {
        if (webDomains.isNotEmpty()) return webDomains.map { VaultReader.normalizeHost(it) }.filter { it.isNotEmpty() }
        return packageDomainGuesses(packageName)
    }
}

private enum class Kind { USERNAME, PASSWORD, OTP }

@RequiresApi(Build.VERSION_CODES.O)
object StructureParser {

    private class Field(val id: AutofillId, var kind: Kind?, val editableText: Boolean, val value: String?)

    fun parse(structure: AssistStructure): ParsedStructure {
        val fields = ArrayList<Field>()
        val webDomains = LinkedHashSet<String>()
        var pkg: String? = structure.activityComponent?.packageName
        for (i in 0 until structure.windowNodeCount) {
            walk(structure.getWindowNodeAt(i).rootViewNode, fields, webDomains) { p -> if (pkg == null) pkg = p }
        }
        // A login form with a password but no signalled username: the editable text field
        // just before the first password is almost always the username.
        val firstPwIdx = fields.indexOfFirst { it.kind == Kind.PASSWORD }
        if (firstPwIdx > 0 && fields.none { it.kind == Kind.USERNAME }) {
            for (j in firstPwIdx - 1 downTo 0) {
                val f = fields[j]
                if (f.kind == null && f.editableText) {
                    f.kind = Kind.USERNAME
                    break
                }
            }
        }
        return ParsedStructure(
            packageName = pkg,
            webDomains = webDomains.toList(),
            usernameIds = fields.filter { it.kind == Kind.USERNAME }.map { it.id },
            passwordIds = fields.filter { it.kind == Kind.PASSWORD }.map { it.id },
            otpIds = fields.filter { it.kind == Kind.OTP }.map { it.id },
            username = fields.firstOrNull { it.kind == Kind.USERNAME }?.value?.ifEmpty { null },
            password = fields.firstOrNull { it.kind == Kind.PASSWORD }?.value?.ifEmpty { null },
        )
    }

    private fun walk(
        node: AssistStructure.ViewNode,
        fields: MutableList<Field>,
        webDomains: MutableSet<String>,
        onPackage: (String) -> Unit,
    ) {
        node.webDomain?.takeIf { it.isNotEmpty() }?.let { webDomains.add(it) }
        node.idPackage?.takeIf { it.isNotEmpty() && it != "android" }?.let { onPackage(it) }

        val id = node.autofillId
        if (id != null && node.autofillType == View.AUTOFILL_TYPE_TEXT) {
            val kind = classify(node)
            val editable = isEditableText(node)
            if (kind != null || editable) {
                fields.add(Field(id, kind, editable, currentText(node)))
            }
        }
        for (i in 0 until node.childCount) walk(node.getChildAt(i), fields, webDomains, onPackage)
    }

    private fun currentText(node: AssistStructure.ViewNode): String? {
        val v = node.autofillValue
        if (v != null && v.isText) return v.textValue?.toString()
        return node.text?.toString()
    }

    private fun isEditableText(node: AssistStructure.ViewNode): Boolean {
        // EditText-like: has an input type, or is an HTML <input>.
        if (node.inputType != 0) return true
        val tag = node.htmlInfo?.tag?.lowercase()
        return tag == "input" || tag == "textarea"
    }

    private fun classify(node: AssistStructure.ViewNode): Kind? {
        node.autofillHints?.forEach { raw ->
            val h = raw.lowercase()
            when {
                h.contains("password") -> return Kind.PASSWORD
                h.contains("otp") || h.contains("2fa") || h.contains("one_time") || h.contains("onetime") -> return Kind.OTP
                h.contains("username") || h.contains("email") || h == View.AUTOFILL_HINT_USERNAME -> return Kind.USERNAME
            }
        }
        node.htmlInfo?.attributes?.forEach { attr ->
            val name = attr.first.lowercase()
            val value = attr.second.lowercase()
            if (name == "type" && value == "password") return Kind.PASSWORD
            if (name == "autocomplete") {
                when {
                    value.contains("password") -> return Kind.PASSWORD
                    value.contains("one-time-code") || value.contains("otp") -> return Kind.OTP
                    value.contains("username") || value.contains("email") -> return Kind.USERNAME
                }
            }
        }
        passwordByInputType(node.inputType)?.let { return it }
        // Field-name / hint text as a last resort.
        val text = listOfNotNull(node.idEntry, node.hint, node.contentDescription?.toString())
            .joinToString(" ").lowercase()
        return when {
            text.contains("pass") || text.contains("pwd") -> Kind.PASSWORD
            text.contains("otp") || text.contains("one-time") || text.contains("2fa") || text.contains("totp") -> Kind.OTP
            text.contains("user") || text.contains("email") || text.contains("login") || text.contains("phone") -> Kind.USERNAME
            else -> null
        }
    }

    private fun passwordByInputType(inputType: Int): Kind? {
        val cls = inputType and android.text.InputType.TYPE_MASK_CLASS
        val variation = inputType and android.text.InputType.TYPE_MASK_VARIATION
        if (cls == android.text.InputType.TYPE_CLASS_TEXT) {
            when (variation) {
                android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD,
                android.text.InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD,
                android.text.InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD -> return Kind.PASSWORD
                android.text.InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS,
                android.text.InputType.TYPE_TEXT_VARIATION_WEB_EMAIL_ADDRESS -> return Kind.USERNAME
            }
        }
        if (cls == android.text.InputType.TYPE_CLASS_NUMBER &&
            variation == android.text.InputType.TYPE_NUMBER_VARIATION_PASSWORD
        ) {
            return Kind.PASSWORD
        }
        return null
    }
}

// Best-effort domains for a native app with no web domain: reverse the package's first two
// labels (com.github.android -> github.com) and also try the bare package, so a login saved
// against either still matches. When neither matches, the unlock list's "show all" covers it.
private fun packageDomainGuesses(pkg: String?): List<String> {
    if (pkg.isNullOrEmpty()) return emptyList()
    val out = LinkedHashSet<String>()
    val parts = pkg.split('.').filter { it.isNotEmpty() }
    if (parts.size >= 2) out.add("${parts[1]}.${parts[0]}".lowercase())
    out.add(pkg.lowercase())
    return out.toList()
}
