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
    val nodeCount: Int = 0,
    val truncated: Boolean = false,
) {
    val hasFields: Boolean get() = usernameIds.isNotEmpty() || passwordIds.isNotEmpty() || otpIds.isNotEmpty()
    val allIds: List<AutofillId> get() = usernameIds + passwordIds + otpIds

    /** Hosts to match saved logins against. `webDomain` is attacker-controllable (any app can set
     * it on a virtual view structure) and the package name is not a web identity, so we honour a
     * webDomain ONLY from a verified browser (see TrustedBrowsers) and never derive a host from the
     * package. An untrusted caller gets no host-based auto-match; the user can still open the full
     * searchable list. */
    fun requestedHosts(isTrustedBrowser: Boolean): List<String> {
        if (isTrustedBrowser && webDomains.isNotEmpty()) {
            return webDomains.map { VaultReader.normalizeHost(it) }.filter { it.isNotEmpty() }
        }
        return emptyList()
    }
}

internal enum class Kind { USERNAME, PASSWORD, OTP }

/** What classification reads off one autofillable text field. */
internal class FieldSignals(
    val autofillHints: List<String> = emptyList(),
    val htmlTag: String? = null,
    val htmlAttributes: List<Pair<String, String>> = emptyList(),
    val inputType: Int = 0,
    val idEntry: String? = null,
    val hint: String? = null,
    val contentDescription: CharSequence? = null,
)

/** The parts of a node the walk reads: a ViewNode on device, a plain tree in tests. */
internal interface NodeReader<N> {
    fun webDomain(node: N): String?
    fun idPackage(node: N): String?

    /** Null unless the node is an autofillable text field. */
    fun field(node: N): FieldSignals?
    fun childCount(node: N): Int
    fun child(node: N, index: Int): N
}

internal class NodeScan<N>(
    val webDomains: List<String>,
    val idPackage: String?,
    val usernames: List<N>,
    val passwords: List<N>,
    val otps: List<N>,
    val nodeCount: Int,
    val truncated: Boolean,
)

@RequiresApi(Build.VERSION_CODES.O)
internal object StructureScan {
    // Far past any login screen; caps what a huge foreground app (a long chat) costs per window.
    const val MAX_NODES_PER_WINDOW = 20_000

    // Field-name signals sit at the start of a label.
    const val MAX_SIGNAL_CHARS = 256
    private const val CANCEL_CHECK_EVERY = 256

    private class Field<N>(val node: N, var kind: Kind?, val editableText: Boolean)

    /** Pre-order walk of every window root. Null when [isCancelled] turns true mid-walk. */
    fun <N> scan(
        roots: List<N>,
        reader: NodeReader<N>,
        maxNodesPerWindow: Int = MAX_NODES_PER_WINDOW,
        isCancelled: () -> Boolean = { false },
    ): NodeScan<N>? {
        val fields = ArrayList<Field<N>>()
        val webDomains = LinkedHashSet<String>()
        var idPackage: String? = null
        var visited = 0
        var truncated = false
        // Iterative, children pushed in reverse: the same pre-order as recursion, at any depth.
        val stack = ArrayDeque<N>()
        for (root in roots) {
            stack.clear()
            stack.addLast(root)
            var budget = maxNodesPerWindow
            while (stack.isNotEmpty()) {
                if (budget-- <= 0) {
                    truncated = true
                    break
                }
                if (++visited % CANCEL_CHECK_EVERY == 0 && isCancelled()) return null
                val node = stack.removeLast()
                reader.webDomain(node)?.takeIf { it.isNotEmpty() }?.let { webDomains.add(it) }
                if (idPackage == null) {
                    idPackage = reader.idPackage(node)?.takeIf { it.isNotEmpty() && it != "android" }
                }
                reader.field(node)?.let { signals ->
                    val kind = classify(signals)
                    val editable = isEditableText(signals)
                    if (kind != null || editable) fields.add(Field(node, kind, editable))
                }
                for (i in reader.childCount(node) - 1 downTo 0) stack.addLast(reader.child(node, i))
            }
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
        return NodeScan(
            webDomains = webDomains.toList(),
            idPackage = idPackage,
            usernames = fields.filter { it.kind == Kind.USERNAME }.map { it.node },
            passwords = fields.filter { it.kind == Kind.PASSWORD }.map { it.node },
            otps = fields.filter { it.kind == Kind.OTP }.map { it.node },
            nodeCount = visited,
            truncated = truncated,
        )
    }

    fun isEditableText(signals: FieldSignals): Boolean {
        // EditText-like: has an input type, or is an HTML <input>.
        if (signals.inputType != 0) return true
        val tag = signals.htmlTag?.lowercase()
        return tag == "input" || tag == "textarea"
    }

    fun classify(signals: FieldSignals): Kind? {
        for (raw in signals.autofillHints) {
            val h = raw.lowercase()
            // Chromium hands a page's autocomplete token over as a hint, verbatim: `one-time-code`.
            val token = h.replace("-", "").replace("_", "")
            when {
                h.contains("password") -> return Kind.PASSWORD
                token.contains("otp") || token.contains("2fa") || token.contains("onetime") -> return Kind.OTP
                h.contains("username") || h.contains("email") || h == View.AUTOFILL_HINT_USERNAME -> return Kind.USERNAME
            }
        }
        for ((rawName, rawValue) in signals.htmlAttributes) {
            val name = rawName.lowercase()
            if (name != "type" && name != "autocomplete") continue
            val value = rawValue.lowercase()
            if (name == "type" && value == "password") return Kind.PASSWORD
            if (name == "autocomplete") {
                when {
                    value.contains("password") -> return Kind.PASSWORD
                    value.contains("one-time-code") || value.contains("otp") -> return Kind.OTP
                    value.contains("username") || value.contains("email") -> return Kind.USERNAME
                }
            }
        }
        passwordByInputType(signals.inputType)?.let { return it }
        // Field-name / hint text as a last resort.
        val text = listOfNotNull(signals.idEntry, signals.hint, signals.contentDescription)
            .joinToString(" ") { it.take(MAX_SIGNAL_CHARS) }.lowercase()
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

@RequiresApi(Build.VERSION_CODES.O)
object StructureParser {

    /** Null when [isCancelled] turns true mid-walk. */
    fun parse(structure: AssistStructure, isCancelled: () -> Boolean = { false }): ParsedStructure? {
        val roots = (0 until structure.windowNodeCount).map { structure.getWindowNodeAt(it).rootViewNode }
        val scan = StructureScan.scan(roots, ViewNodeReader, isCancelled = isCancelled) ?: return null
        return ParsedStructure(
            packageName = structure.activityComponent?.packageName ?: scan.idPackage,
            webDomains = scan.webDomains,
            usernameIds = scan.usernames.mapNotNull { it.autofillId },
            passwordIds = scan.passwords.mapNotNull { it.autofillId },
            otpIds = scan.otps.mapNotNull { it.autofillId },
            username = scan.usernames.firstOrNull()?.let { currentText(it) }?.ifEmpty { null },
            password = scan.passwords.firstOrNull()?.let { currentText(it) }?.ifEmpty { null },
            nodeCount = scan.nodeCount,
            truncated = scan.truncated,
        )
    }

    private fun currentText(node: AssistStructure.ViewNode): String? {
        val v = node.autofillValue
        if (v != null && v.isText) return v.textValue?.toString()
        return node.text?.toString()
    }

    private object ViewNodeReader : NodeReader<AssistStructure.ViewNode> {
        override fun webDomain(node: AssistStructure.ViewNode): String? = node.webDomain

        override fun idPackage(node: AssistStructure.ViewNode): String? = node.idPackage

        override fun field(node: AssistStructure.ViewNode): FieldSignals? {
            if (node.autofillId == null || node.autofillType != View.AUTOFILL_TYPE_TEXT) return null
            val html = node.htmlInfo
            return FieldSignals(
                autofillHints = node.autofillHints?.filterNotNull() ?: emptyList(),
                htmlTag = html?.tag,
                htmlAttributes = html?.attributes?.map { (it.first ?: "") to (it.second ?: "") } ?: emptyList(),
                inputType = node.inputType,
                idEntry = node.idEntry,
                hint = node.hint,
                contentDescription = node.contentDescription,
            )
        }

        override fun childCount(node: AssistStructure.ViewNode): Int = node.childCount

        override fun child(node: AssistStructure.ViewNode, index: Int): AssistStructure.ViewNode =
            node.getChildAt(index)
    }
}

// NOTE: the old packageDomainGuesses() reverse-DNS heuristic (com.github.android -> github.com)
// was removed: a sideloaded app could pick a package like com.paypal.evil and harvest the
// victim's paypal.com login. Native-app -> web association must be proven (Digital Asset Links),
// not guessed from the package name; that verified path is a follow-up. Until then a non-browser
// app gets no host-based auto-match, only the manual searchable list.
