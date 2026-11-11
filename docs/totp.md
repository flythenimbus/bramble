# TOTP (stored authenticator keys)

A login entry can carry an authenticator key so Bramble generates the live 2FA
code at fill time. Parsing and code generation are in
`packages/core/src/util/totp.ts`; the fill-time computation runs in the
background service worker.

## Only digits ever reach the page

The stored authenticator key (an `otpauth://` URI or bare secret) is treated like
any other secret: it stays in the vault, and the live code is computed in the
background. Only the resulting digits are filled into a page's one-time-code
field. The seed never reaches page context. See [autofill.md](autofill.md) for
how the OTP field is detected and filled.

## Accepted input shapes

`parseTotp` accepts the shapes a user can actually end up with:

- A full **`otpauth://totp/...` URI**, which a scanned QR code yields. It carries
  issuer, account, digits, period, and algorithm. It is read loosely, the way
  Android and iOS autofill (`Totp.kt`, `Totp.swift`) always have, not by the
  strict key-URI grammar, which refuses URIs other apps export: an empty label,
  a spaced secret, `period=30.000000`, a `?` inside a value (#204).
- A **Steam Guard key**: `steam://<secret>` (Bitwarden), `otpauth://steam/...`
  (Aegis) or `encoder=steam` (KeePassXC). Steam uses SHA1 and 30 seconds but
  shows 5 characters from its own alphabet. KDBX export writes the KeePassXC
  form; CXF has no Steam encoding, so it exports as a custom field (#55).
- A **bare base32 secret**, which sites print under the QR as a "setup key",
  possibly with the spaces or dashes they group it into. Whitespace and dashes
  are stripped and the secret is uppercased before parsing.

For a bare secret, the RFC 6238 defaults are applied (SHA1, 6 digits, 30-second
period), which is the near-universal configuration for a setup key.

Anything else returns `null` so callers can show a clear "invalid key" state
rather than a wrong code:

- empty input,
- HOTP (counter-based) URIs, since only TOTP is generated,
- an unknown algorithm, or digits outside 1 to 10,
- Google's `otpauth-migration://` export blob,
- an unparseable secret.

## Code generation

`totpAt` returns the current code plus how many whole seconds remain in the
time-step, for a given clock (defaulting to now). It is split out from the React
layer so it can be unit-tested against the RFC 6238 test vectors.
