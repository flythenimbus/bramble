package app.bramble.mobile

import android.text.InputType
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Host-JVM tests for the structure walk behind onFillRequest, over a plain tree standing in for
// AssistStructure.ViewNode (the framework type can't be built off-device). Issue #56: a long chat
// in a big app must cost a bounded walk, and a real login form must still be found.
class StructureParserTest {

    private class Node(
        val name: String = "",
        val field: FieldSignals? = null,
        val children: List<Node> = emptyList(),
        val webDomain: String? = null,
        val idPackage: String? = null,
    )

    private class Reader : NodeReader<Node> {
        var visited = 0

        override fun webDomain(node: Node): String? {
            visited++
            return node.webDomain
        }

        override fun idPackage(node: Node): String? = node.idPackage

        override fun field(node: Node): FieldSignals? = node.field

        override fun childCount(node: Node): Int = node.children.size

        override fun child(node: Node, index: Int): Node = node.children[index]
    }

    private val text = FieldSignals(inputType = InputType.TYPE_CLASS_TEXT)
    private val password =
        FieldSignals(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD)

    // A Messenger-like thread: rows of avatar + bubble + timestamp, the bubble carrying the whole
    // message as its content description, and a multi-line composer at the bottom.
    private fun chatWindow(messages: Int): Node {
        val rows = (0 until messages).map { i ->
            Node(
                "row$i",
                children = listOf(
                    Node("avatar$i"),
                    Node("bubble$i", children = listOf(Node("text$i"))),
                    Node("time$i"),
                ),
            )
        }
        val composer = Node(
            "composer",
            FieldSignals(
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE,
                idEntry = "composer_edit_text",
                hint = "Aa",
                contentDescription = "Message",
            ),
        )
        return Node("root", children = listOf(Node("list", children = rows), composer))
    }

    private fun loginWindow(): Node =
        Node(
            "dialog",
            children = listOf(
                Node("email", FieldSignals(autofillHints = listOf("emailAddress"))),
                Node("pw", password),
            ),
        )

    private fun scan(vararg windows: Node, budget: Int = StructureScan.MAX_NODES_PER_WINDOW, reader: Reader = Reader()) =
        StructureScan.scan(windows.toList(), reader, budget)!!

    @Test
    fun `a login form is read in pre-order and the box just before the password becomes the username`() {
        val form = Node(
            "form",
            children = listOf(
                Node("search", text),
                Node("group", children = listOf(Node("user", text))),
                Node("pw", password),
                Node("code", FieldSignals(htmlAttributes = listOf("autocomplete" to "one-time-code"))),
            ),
        )
        val result = scan(form)
        assertEquals(listOf("user"), result.usernames.map { it.name })
        assertEquals(listOf("pw"), result.passwords.map { it.name })
        assertEquals(listOf("code"), result.otps.map { it.name })
        assertFalse(result.truncated)
    }

    @Test
    fun `a chat has nothing to fill and costs one visit per node`() {
        val reader = Reader()
        val result = scan(chatWindow(messages = 1_000), reader = reader)
        assertTrue(result.usernames.isEmpty() && result.passwords.isEmpty() && result.otps.isEmpty())
        // root + list + 1,000 rows of 5 nodes + composer
        assertEquals(5_003, result.nodeCount)
        assertEquals(result.nodeCount, reader.visited)
        assertFalse(result.truncated)
    }

    @Test
    fun `a chat past the budget stops at the budget and a login dialog in another window is still found`() {
        val reader = Reader()
        // 50,000 messages: 250,003 nodes in the thread window.
        val result = scan(chatWindow(messages = 50_000), loginWindow(), reader = reader)
        assertTrue(result.truncated)
        // The whole budget for the thread, then the three dialog nodes.
        assertEquals(StructureScan.MAX_NODES_PER_WINDOW + 3, result.nodeCount)
        assertEquals(result.nodeCount, reader.visited)
        assertEquals(listOf("email"), result.usernames.map { it.name })
        assertEquals(listOf("pw"), result.passwords.map { it.name })
    }

    @Test
    fun `deep nesting walks without recursion and keeps the field at the bottom`() {
        // Deep enough to overflow a recursive walk.
        var node = Node("pw", password)
        repeat(100_000) { node = Node("level$it", children = listOf(node)) }
        val result = scan(node, budget = 200_000)
        assertEquals(listOf("pw"), result.passwords.map { it.name })
        assertEquals(100_001, result.nodeCount)

        val bounded = scan(node)
        assertTrue(bounded.truncated)
        assertEquals(StructureScan.MAX_NODES_PER_WINDOW, bounded.nodeCount)
    }

    @Test
    fun `a cancelled request stops walking`() {
        val reader = Reader()
        var polls = 0
        val result = StructureScan.scan(listOf(chatWindow(messages = 50_000)), reader) {
            polls++
            true
        }
        assertNull(result)
        assertEquals(1, polls)
        assertEquals(255, reader.visited)
    }

    @Test
    fun `web domains and the first real id package are collected along the way`() {
        val page = Node(
            "browser",
            idPackage = "android",
            children = listOf(
                Node("toolbar", idPackage = "org.example.browser"),
                Node("web", webDomain = "accounts.example.com", children = listOf(Node("pw", password))),
                Node("frame", webDomain = "auth.example.net", idPackage = "org.other"),
            ),
        )
        val result = scan(page)
        assertEquals(listOf("accounts.example.com", "auth.example.net"), result.webDomains)
        assertEquals("org.example.browser", result.idPackage)
    }

    @Test
    fun `classification keeps its signals in priority order`() {
        assertEquals(Kind.PASSWORD, StructureScan.classify(FieldSignals(autofillHints = listOf("password"))))
        assertEquals(Kind.OTP, StructureScan.classify(FieldSignals(autofillHints = listOf("smsOTPCode"))))
        assertEquals(Kind.USERNAME, StructureScan.classify(FieldSignals(autofillHints = listOf("username"))))
        // The first decisive attribute wins, as before.
        assertEquals(
            Kind.USERNAME,
            StructureScan.classify(
                FieldSignals(htmlAttributes = listOf("autocomplete" to "username", "type" to "password")),
            ),
        )
        assertEquals(Kind.PASSWORD, StructureScan.classify(FieldSignals(htmlAttributes = listOf("TYPE" to "Password"))))
        assertEquals(
            Kind.USERNAME,
            StructureScan.classify(
                FieldSignals(inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS),
            ),
        )
        assertEquals(
            Kind.PASSWORD,
            StructureScan.classify(
                FieldSignals(inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD),
            ),
        )
        assertEquals(Kind.PASSWORD, StructureScan.classify(FieldSignals(idEntry = "et_pwd")))
        assertEquals(Kind.USERNAME, StructureScan.classify(FieldSignals(hint = "Phone or email")))
        assertNull(StructureScan.classify(FieldSignals(hint = "Aa", contentDescription = "Message")))
        assertTrue(StructureScan.isEditableText(FieldSignals(htmlTag = "INPUT")))
        assertFalse(StructureScan.isEditableText(FieldSignals(htmlTag = "div")))
    }

    @Test
    fun `a code-only page from chromium is found by its one-time-code hint`() {
        // #47: the signals Vanadium sent for otto.de's code field, read on device. The autocomplete
        // token arrives as a hint, and htmlInfo carries no autocomplete attribute.
        val code = FieldSignals(
            autofillHints = listOf("one-time-code"),
            htmlTag = "input",
            htmlAttributes = listOf(
                "name" to "code", "type" to "text", "label" to "Code aus der Authenticator-App",
                "ua-autofill-hints" to "", "id" to "fti-ci-input-code",
                "crowdsourcing-autofill-hints" to "NO_SERVER_DATA",
                "computed-autofill-hints" to "HTML_TYPE_ONE_TIME_CODE", "visibility" to "visible", "maxlength" to "6",
            ),
        )
        assertEquals(Kind.OTP, StructureScan.classify(code))
        val result = scan(Node(webDomain = "www.otto.de", children = listOf(Node("code", code))))
        assertEquals(listOf("code"), result.otps.map { it.name })
        assertTrue(result.usernames.isEmpty() && result.passwords.isEmpty())
    }

    @Test
    fun `only the start of a long label is read`() {
        val filler = "a".repeat(StructureScan.MAX_SIGNAL_CHARS)
        assertNull(StructureScan.classify(FieldSignals(contentDescription = "$filler password")))
        assertEquals(
            Kind.PASSWORD,
            StructureScan.classify(FieldSignals(contentDescription = "Password " + "a".repeat(1_000_000))),
        )
        // A huge attribute that can't classify is never lowercased, and the one that can still wins.
        assertEquals(
            Kind.PASSWORD,
            StructureScan.classify(
                FieldSignals(htmlAttributes = listOf("value" to "x".repeat(1_000_000), "type" to "password")),
            ),
        )
    }
}
