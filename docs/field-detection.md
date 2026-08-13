# Field detection

How Bramble decides which inputs on a page are a username, password, card field,
OTP box, or custom field. Code: `packages/platform-extension/src/detection.ts`,
exercised by real-site fixtures in `fixtures/sites.dom.test.ts`. How the detected
fields are filled is in [autofill.md](autofill.md).

## Pure DOM helpers

Every function here is a pure DOM query: no module state, no event listeners
(content-script.ts owns those). Each takes an optional `doc` argument so the
detectors can be tested against HTML fixtures without touching the live document.

A recurring pattern is the **attributes-then-label ladder**: a field's own
attributes (`name`, `id`, `placeholder`, `autocomplete`, `aria-label`) are the
higher-priority hint; the associated `<label>` text (explicit `for=`, wrapping
`<label>`, `aria-labelledby`) is a lower-priority fallback for forms whose only
human-readable hint lives in the label.

## Username and login fields

`detectLoginFields` resolves the username via a five-rung ladder, stopping at the
first hit:

1. The password's nearest preceding text input in DOM order (most reliable).
2. An explicit `autocomplete~="username"` or `autocomplete="email"`.
3. A single visible email input.
4. Attribute heuristics on text inputs (`USERNAME_HINT_RE`).
5. Associated `<label>` text.

Negative hints (`search`, `captcha`, `coupon`, `otp`, `code`) filter out
look-alikes at each rung, and carry localized search terms. Those matter more
than they look: rung 1 takes the password's nearest preceding text input, so an
untranslated search box in the header wins and the username gets typed into it.

Rungs 1 to 3 are language-free and carry ordinary login forms on any site. Rungs
4 and 5 read prose, so `USERNAME_HINT_RE` carries localized identifier terms
(issue #46). They decide only the shape rung 1 cannot help with: an
**identifier-first** page, where the password lives on a later step and there is
no password field to anchor to.

Two rules keep that list from doing damage. Every term must stand alone, so the
"name" half of *nom d'utilisateur* / *nombre de usuario* is deliberately absent —
a bare "name" would claim every cardholder and full-name field. And short ASCII
terms are `\b`-bounded, so Portuguese `conta` cannot match `contact`; non-Latin
terms are not, because `\b` is ASCII-only and CJK has no word separators.
Accented forms are alternated with their stripped spelling, since `name`/`id`
attributes usually drop the diacritic while the visible label keeps it.

Exercised by `content/detection.i18n.dom.test.ts`, which tests both directions:
missing a username costs autofill, but claiming the wrong field types the login
into a search box, which is worse.

## Card fields

`detectCardFields` is token-first: it prefers proper `autocomplete="cc-*"` tokens
and falls back to regex hints. A combined MM/YY field is only treated as present
when there is no split month/year pair, avoiding double-fill. A bare cardholder
name is too weak a signal on its own, so `cardFieldsPresent` requires a real card
field (number, CVV, or expiry) before the card picker is offered.

## OTP fields

`otpInputs` runs a four-rung ladder, strongest first:

1. `autocomplete~="one-time-code"` tokens. Several matches means a segmented
   widget tagging every box, so all of them are returned.
2. Attribute then label hints (`OTP_HINT_RE`), excluding card, coupon, promo,
   postal, address and redeemable-code fields (`OTP_NEGATIVE_RE`). A matched
   single-character input is one box of a **segmented widget**, so the contiguous
   run of single-character siblings is gathered (`segmentedSiblings`). The word
   "code" on its own (`WEAK_CODE_RE`) is too common to trust, so it only counts
   when the field is also length-bounded like a code.
3. **Structural:** an untagged run of `SEGMENTED_MIN_BOXES` (4) or more
   single-character inputs sharing a parent. Nothing else on the web is shaped
   like that, and it needs no readable text.
4. **Structural:** a lone digits-only field of code length (`maxlength` 4-8 plus
   `inputmode`/`type`/`pattern` evidence). The weakest rung, so it fires only
   when exactly one field qualifies; more than one and we'd be guessing which box
   the code belongs in.

Rungs 3 and 4 exist because rung 2 only covers languages someone thought to add.
Issue #47 was reported as broken TOTP autofill on Microsoft and otto.de; a corpus
of 17 realistic 2FA shapes found only 4 detected, and the misses were every
localized phrasing of "verification code" plus every untagged segmented widget.
The corpus is now `content/detection.otp.dom.test.ts` — add rows there rather
than editing the regex blind.

A "single-character box" (`isSingleCharBox`) is a text-like input that takes one
character, said with `maxlength="1"` **or** with a one-character `pattern`.
Cloudflare's 2FA form is the reason for the second: none of its boxes carry a
`maxlength` at all except the first, which takes `maxlength="6"` so an OS-level
code autofill can drop the whole code into it. Each box declares its width as
`pattern="\d{1}"` instead.

`splitOtpFields` then divides what the ladder found into the **boxes** a code is
typed across and the one field that holds it **whole**. Segmented widgets
increasingly ship both: N visible boxes plus a visually-hidden input carrying the
assembled code for the form (and for OS code autofill). That mirror answers the
same `one-time-code` query as the boxes, so it used to be filled as if it were
another box, receiving one character of the code, or the empty string past the
end of it. On a widget that reads the mirror as its source of truth, that empty
write resets the widget immediately after a correct fill, which is how
Cloudflare's 2FA screen ended up reported as "autofill does nothing". How each is
written is in [autofill.md](autofill.md).

`OTP_HINT_RE` also carries localized terms, and bounds `otp`/`otc`/`totp` on
letters rather than `\b` so they match inside `idTxtBx_SAOTCC_OTC`, where the
underscore is a word character and `\b` fails. Android's `StructureParser.kt`
holds its own copy of these heuristics and is **not** kept in sync
automatically.

Visibility is deliberately not filtered here, matching the rest of the module, so
a hidden 2FA field on a login step is still found (see the skanetrafiken
fixture). That is harmless: `kindOf` ranks OTP last, so login and card fields
still win.

## Captcha

`hasInteractiveCaptcha` matches only **interactive** challenge widgets (reCAPTCHA
v2, hCaptcha, Turnstile, Arkose/FunCaptcha, and the relevant iframes). Invisible,
score-based checks (reCAPTCHA v3) are deliberately excluded because they do not
block submission. `isRendered` filters out 0x0 containers and
`display:none`/`visibility:hidden`/`opacity:0` elements, so an invisible token
field is not mistaken for an interactive challenge. Auto-submit must not fire when
an interactive captcha is present.

## Field-kind precedence

`candidateKind` classifies a single element as `login`, `card`, `otp`, or null.
The load-bearing rule: **login wins over card**, except CVV-as-password. So a
field that satisfies the login detector is treated as a login even when its label
says "card number" (real example: banks like BMO where the username *is* the
debit card number). The one exception is a `type=password` CVV on a real payment
form, which is classified as a card field.

## Custom fields

A custom field carries a user-chosen name like "Postal code". `deriveMatcher`
normalizes it into a canonical form (`postalcode`) and a hyphen form
(`postal-code`) for flexible token matching. Matching tries the autocomplete
token first, then attributes, then the label. Exact normalized matches count at
any length, but substring matches require a key of 5+ characters so short names
like "name" or "city" cannot match "username" or "velocity".

Custom fields fill text-like inputs only (`CUSTOM_FILLABLE_TYPES`). Password and
email are explicitly excluded, so a stray custom match cannot dump a value into a
credential or email field. Custom fields are also lowest priority overall: they
never fill a detected primary field.

## Password-change forms

`findNewPasswordOnChangeForm` returns the new-password field only when the form is
unambiguous: 2+ password fields, one confidently identified as new (via
`autocomplete="new-password"` or a `new`/`set` hint, and not matching
old/current/confirm/verify/repeat), and its value matches a confirm field. If the
form is ambiguous or mid-edit it returns null rather than guessing, so an
unconfirmed password is never captured.

## Signup detection

`signup-detect.ts` decides whether a focused password field belongs to an
account-creation or password-rotation flow (signup, password-reset, or a
change-password form) so the autofill dropdown can offer a **generated strong
password** (`password-gen.ts`) without firing on ordinary login pages. See
[autofill.md](autofill.md) for the dropdown row and the save/update flow.

The design principle is to lean on **language-independent structural signals** so
non-English pages work without reading their prose. `scoreSignupForm` sums
weighted signals (all in `WEIGHTS`, tune there) and offers above `THRESHOLD`
(100):

- **Strong (each reaches the threshold alone):** `autocomplete="new-password"` on
  the field, a confirm-password pair (2+ non-current password fields in scope), or
  a change form (a `current-password` sibling while the focused field is not it,
  marking the focused field as the new password to rotate to).
- **Supporting (structural, language-independent):** a terms/privacy link or agree
  checkbox in the form, a name field (`given-name`/`family-name`), the field's
  `pattern`/`minlength>=8`, a strength meter (`<meter>`/`role=progressbar`), and a
  long form (>4 inputs).
- **Supporting (text, boosters only):** the URL path (`/signup`, `/register`, …)
  and a small multilingual keyword dictionary matched against submit buttons,
  headings, and the title.
- **Negative:** login URLs, "forgot password"/"remember me" text, and a
  returning-user damper when the site already has saved logins (skipped when a
  strong signal fires).

The veto is narrow: only when the **focused** field is itself a `current-password`
(a login field, or the "old password" box on a change form) do we suppress. A
`current-password` *sibling* is not a veto but a change-form signal (above), so the
new-password field of a change form still gets the offer. The scope is the field's
enclosing `<form>` when present, else the document; visibility is gated by
`isRendered`, so a display:none honeypot password field can't fabricate a confirm
pair. The offer is also suppressed once the field holds a value (the user is typing
their own). Exercised by `signup-detect.dom.test.ts`.

## Fixtures

`fixtures/sites.dom.test.ts` runs the detectors against real HTML captured from
sites (GitHub, BMO, Discord, Twitch, Amazon, Microsoft, Skånetrafiken, and
others). This locks in behaviour on real-world quirks: honeypots, off-screen
hidden fields, missing `<form>` wrappers, custom component libraries, GitHub's
tokenless `name="otp"` 2FA field, BMO's card-number-as-login, and invisible
Turnstile that must not block autofill.

`cloudflare-2fa` is the segmented-widget shape in full: six boxes with no
`maxlength`, a hidden mirror, and `autocomplete="one-time-code"` on all seven.
`content/fill.otp.dom.test.ts` fills it, and fills widget doubles that each
accept a different write (a character at a time, the whole code, a paste, the
mirror only).

`skanetrafiken-login` is the counter-example worth keeping in mind: it was
reported as a non-English detection failure (issue #46), but the site ships
correct `autocomplete` tokens, so the Swedish labels are never consulted and both
fields resolve on rung 1. What actually failed there was save capture, not
detection, and the same fixture drives `content/capture.dom.test.ts`. The
language gap is real but lives elsewhere: rungs 4 and 5 are English-only, so a
non-English **two-step** page (identifier first, no password field yet) resolves
no username at all, and `NEGATIVE_HINT_RE` misses non-English search boxes.
