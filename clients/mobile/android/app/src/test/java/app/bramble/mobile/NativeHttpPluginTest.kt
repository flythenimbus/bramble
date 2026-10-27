package app.bramble.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

// #123: DuckDuckGo answers OkHttp's default User-Agent with a bare 403, so the native transport
// names Bramble instead, unless a request set its own.
class NativeHttpPluginTest {

    private val ours = "Bramble/0.23.0 (Android)"

    @Test
    fun aRequestWithoutAUserAgentGetsBrambles() {
        val headers = withUserAgent(mapOf("Authorization" to "Bearer k"), ours)
        assertEquals(mapOf("Authorization" to "Bearer k", "User-Agent" to ours), headers)
    }

    @Test
    fun aRequestsOwnUserAgentIsKeptWhateverItsCase() {
        val own = mapOf("user-agent" to "Something/1")
        assertEquals(own, withUserAgent(own, ours))
    }
}
