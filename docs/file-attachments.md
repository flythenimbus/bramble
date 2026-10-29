# File attachments (planned)

Design for storing files in a vault: attachments on an entry (a passport scan on
an airline login, a licence file on a software portal) and standalone "Files"
items for things that belong to no entry. This is issue #77.

The hard part is not encryption and it is not storage quota. It is that files
have to coexist with [P2P sync](p2p-sync.md), whose current shape makes the
obvious implementation unusable. That constraint drives the whole design, so it
comes first.

## Why files cannot live in the entries payload

Two properties of the code today:

1. **Every entry edit rewrites the whole vault.** `writeEntriesBlob`
   (`core/vault/entries-blob.ts`) re-encrypts the entire `EntriesPayload` under
   the VEK and writes a fresh VLT1 blob. There is no partial write, by design:
   the format is one `entriesCiphertext`, and that is what keeps slot rotation
   cheap (see [cryptography.md](cryptography.md)).
2. **Ongoing sync is a full-state push.** `broadcast()`
   (`core/sync/transport/roster-sync.ts`) serializes the whole payload and sends
   it to every peer whose last copy differs (until 2026-10-13, on every 4-second
   `REBROADCAST_MS` tick; see [sync-rebroadcast.md](sync-rebroadcast.md)). There
   is no delta protocol, because entry-level LWW over a full state is what makes
   the merge trivially convergent.

Both are good properties for entries, which are kilobytes. Put a 20 MB PDF in
that payload and renaming one login re-encrypts 20 MB, and every peer receives
~27 MB (base64 inside JSON) on every change, split across ~850 Noise frames
(`CHUNK_BYTES` is 32 KiB, bounded by `MAX_MSG` in `core-rust/src/handshake.rs`).

So the requirement is not "make the payload bigger". It is: **the bytes must not
participate in the broadcast at all.**

## The core move: split the manifest from the bytes

A file is stored as two separate things.

- The **manifest** (`FileRecord`): a few hundred bytes of stamped metadata. Lives
  in the entries payload, merges with the existing engine, rides the existing
  broadcast.
- The **blob**: the sealed file content. Lives in a per-platform blob store
  outside the vault blob, is **immutable**, is addressed by the hash of its own
  ciphertext, and moves only when a device asks for it, over a WebRTC connection
  (direct, or relayed by TURN) or the desktop link, never through the signalling
  relay (see "Transfer").

Immutability is the load-bearing choice. Blobs never merge, never conflict, and
need no ordering, so a leaderless gossip mesh can move them with no coordinator.
Editing a file produces a new blob plus a new manifest stamp; it never mutates an
existing blob. That makes every transfer idempotent, resumable, and safely
multi-source.

### On wormhole

Bramble already has all three magic-wormhole pieces: the pairing code is the
short PAKE code (with a SAS gate that is stronger for this use case), the Nostr
relay is the rendezvous mailbox, and WebRTC plus TURN is the transit. Taking
wormhole as a dependency would duplicate infrastructure the project already runs
and already reasons about in [p2p-sync.md](p2p-sync.md).

What is worth borrowing is wormhole's **architecture**, not its protocol: a small
authenticated control channel agrees on what moves, and a separate bulk transit
moves it. Roster-sync today has one lane and it is a broadcast lane. This design
adds the second lane.

(A genuine wormhole flow would be additive for *out-of-group* sending, "send this
file to my accountant". That is a sharing feature, not a storage one, and is out
of scope here.)

## How a file is encrypted

This is the part most easily got wrong by inventing a parallel scheme, so it is
written out in full. **A file uses the same envelope as an entry.** Start from
what already exists.

### What an entry does today

`encrypt_entry_core` (`core-rust/src/lib.rs`) does exactly three things:

```rust
let dek = random(32);                            // a key for this entry alone
let ciphertext  = aes_gcm(dek, iv,     plaintext_json);   // seal the data
let wrapped_dek = aes_gcm(VEK, dek_iv, dek);              // seal the key
```

and stores `{ciphertext, iv, wrappedDek, dekIv}`. In words: **a sealed box, plus
that box's key sealed under the vault key.** Only the VEK opens the key, and only
the key opens the box. That indirection is why rotating a password never has to
re-encrypt an entry: only the wrapping changes.

### What a file does

Identical shape, with a per-file **FEK** in place of the DEK, and two differences
that both come from size rather than from any change in the model:

1. The content is **split into chunks** and each chunk is sealed separately.
2. The sealed chunks are **stored outside the vault blob**, keyed by hash.

Attaching `passport.pdf` (5 MiB) runs this:

```
FEK        = random(32)                                   // this file alone
wrappedFek = AES-256-GCM(VEK, fekIv, FEK)                 // -> the FileRecord

K_meta     = HKDF-SHA256(FEK, info = "bramble/file/meta/v1")
K_content  = HKDF-SHA256(FEK, info = "bramble/file/content/v1")

metaBlob   = AES-256-GCM(K_meta, metaIv, {                // -> the FileRecord
               name: "passport.pdf", mime: "application/pdf",
               plaintextSize: 5242880, chunkCount: 20, noncePrefix: <7 bytes>
             })

for i in 0..20:                                           // -> the blob store
  nonce_i   = noncePrefix(7) || u32be(i) || (i == 19 ? 0x01 : 0x00)
  sealed_i  = AES-256-GCM(K_content, nonce_i, plaintext[i * 256KiB ..][..256KiB])

blob       = sealed_0 || sealed_1 || ... || sealed_19      // 5 MiB + 20 * 16 tag
hash       = SHA-256(blob)                                 // -> the FileRecord
```

The `FileRecord` that goes into the entries payload holds `wrappedFek`, `fekIv`,
`metaBlob`, `metaIv`, `hash` and `size`. The blob store holds `blob` under
`hash`. Nothing else exists.

To read it: unwrap the FEK with the VEK, derive the two subkeys, open `metaBlob`
for the name and chunk count, then open chunks from the blob store as needed.

### Why chunked, and why that nonce

AES-GCM is all-or-nothing: the tag only verifies once every byte has been
processed. Sealing a 100 MB file as one call means you cannot show the first page
of a PDF without decrypting and buffering all 100 MB, cannot stream it to a
download, and have to hold it twice in WASM linear memory. Chunking fixes all
three: each chunk carries its own tag, so chunk 0 is independently verifiable and
openable.

Chunking naively is where it goes wrong, and the nonce layout is what prevents
each failure. This is the **STREAM** construction (Hoang-Reyhanitabar-Rogaway-Vizár,
as used by age and Tink), not something invented here:

| Nonce part | Size | Stops |
|---|---|---|
| random prefix | 7 bytes | Catastrophic nonce reuse if a future code path ever reseals with the same FEK. Not strictly needed (the FEK is fresh per file) but it costs 7 bytes and removes a class of future bug. |
| chunk counter | 4 bytes BE | **Reordering and duplication.** Without it, chunk 5 and chunk 9 are interchangeable ciphertexts that both verify. |
| final flag | 1 byte | **Truncation.** The decryptor requires a chunk marked `0x01` before EOF, so lopping off the tail is a decrypt failure rather than a shorter file. |

7 + 4 + 1 is 12 bytes, the AES-GCM nonce length the codebase already uses
(`IV_LEN`). A 4-byte counter at 256 KiB per chunk caps a file at 1 PiB.

Chunk swapping *between* files is stopped by the per-file random prefix and by
the FEK being per-file in the first place.

### Why two subkeys instead of one

The metadata is one small AES-GCM call with a random IV; the content uses
structured STREAM nonces. Running both under the raw FEK means a random 12-byte
IV could, in principle, collide with a STREAM nonce under the same key, which is
the one thing GCM does not survive. Two HKDF-SHA256 subkeys with distinct `info`
strings make the question not arise, cost nothing, and match how the codebase
already domain-separates (`derive_kek_hkdf`, see
[cryptography.md](cryptography.md)). One wrapped key stays on disk.

### Why the hash is over ciphertext

`hash = SHA-256(blob)` is over the **sealed** bytes, not the plaintext. Two
consequences, both wanted:

- **The transfer layer is key-free.** A receiving device verifies exactly what it
  got with no access to the vault, and a blob can be relayed, cached, resumed, or
  fetched from two peers at once without any key material entering the transfer
  code. The merge's existing "touches an index, not secrets" property extends to
  files unchanged.
- **No convergent encryption.** Hashing plaintext (or keying from it) would give
  cross-file dedup, at the cost of a confirmation-of-file attack: anyone holding
  a candidate file could test whether the vault contains it. For a personal vault
  with a few dozen files that trade is plainly bad. The same file attached twice
  gets two FEKs, two ciphertexts, two hashes, and two copies. Accepted.

SHA-256 rather than BLAKE3 because `sha2` is already a dependency of the crate
and a new hash dependency buys nothing at these sizes.

### What each layer actually defends

| Layer | Protects against |
|---|---|
| FEK wrapped under VEK | Anyone without the vault key. Same boundary as an entry. |
| Per-chunk GCM tag | Any modification of the content, byte for byte. |
| STREAM nonce | Reorder, duplicate, splice, truncate. |
| `hash` in the manifest | A peer serving different bytes than the manifest names. |
| Sealed metadata | Filename and MIME type, which are often the whole secret ("divorce-settlement.pdf"). |

What is *not* hidden from other devices in the group: the number of files and
their sizes, which sit in the outer layer so the transfer can work without keys.
`size` is `plaintextSize + chunkCount * 16`, so it reveals the plaintext length
to within a few hundred bytes. This is the same class of leak the entry count
already is. The relay sees none of it. TURN, when it relays a transfer, sees how
many bytes crossed, which is about the file's size, and nothing of its name or
content: it carries only Noise ciphertext.

### The crypto call must be handle-based, not buffer-based

This is a constraint on the binding layers rather than on the algorithm, and it
is the single largest implementation risk in the feature.

Every crypto call on the extension is a `chrome.runtime.sendMessage` round trip
to the offscreen document (`clients/extension/src/crypto.ts`), JSON-serialized,
with a standing note that `sendMessage` mangles a `Uint8Array` so bytes travel as
base64 or `number[]`. Capacitor's bridge has the same shape. Every one of the
`CryptoAdapter`'s methods was designed for one entry at a time.

Route file content through that unchanged and a 100 MB attachment becomes ~400
chunk round trips of ~350 KB of base64 each, through a JSON IPC, in both
directions. That is a performance cliff, not a slow path.

So the rule is: **file bytes never cross an IPC or FFI boundary.** The seal runs
where the bytes already are.

- **Extension.** IndexedDB is shared across contexts in the extension's origin.
  The UI writes the picked file to a staging key, sends a small message naming
  it, and the offscreen document (which already holds the VEK) reads, seals chunk
  by chunk, writes the blob, and returns only the hash. One small message per
  file instead of hundreds of fat ones.
- **Mobile and desktop.** A uniffi call taking `(srcPath, dstPath, fek)` and
  returning the hash, sealing on the Rust side. Bytes never reach the JS bridge.

`core-rust/src/files.rs` is written for exactly this. It takes a FEK as a
parameter and never touches the global VEK slot, so the binding layer decides
where the bytes live, and it offers three levels:

- `seal_file_at_path` / `open_file_at_path` stream a file end to end. Never more
  than two chunks are resident, so a 4 GB attachment costs the same memory as a
  4 KB one, and the plaintext never crosses the uniffi bridge. This is the
  native path.
- `open_file_chunk_at_path` opens one chunk by index, which is what makes the
  chunking pay for itself at the UI: page one of a 100 MB PDF is a seek and
  256 KiB, not 100 MB.
- `SealStream` / `OpenStream` take and return one chunk at a time, for the
  extension, which has no filesystem. Its host reads a chunk from IndexedDB,
  seals it, writes it back, and repeats, so it too never holds the whole file.
  In wasm they are the `FileSealStream` / `FileOpenStream` classes, and they
  take the VEK only in their constructor (see "The extension" below).
- `seal_file` / `open_file` are the whole-buffer forms, for small payloads and
  tests.

Two details in the streaming sealer are load-bearing.

**It reads one chunk ahead** to learn whether the current one is final, rather
than computing that from the file's reported length. A file can change size
while being read, and the final flag is exactly what makes a truncated file fail
to open, so deriving it from a stale length would undo the guard.

**It writes to a staging path, not the final name.** A blob is addressed by the
hash of its own ciphertext, which is not known until the last chunk is written,
so the caller renames to `blobs/<hash>` once the call returns. That is the same
publish-after-verify discipline `BlobStore` applies on the TypeScript side, and
the reason both ends of the feature converge on the same shape.

## The manifest: `FileRecord`

```ts
FileRecord {
  id: string            // this attachment's identity, stable across edits
  hlc: Hlc              // merges exactly like an EncryptedEntry
  entryId?: string      // owning entry; absent = a standalone Files item
  hash: string          // SHA-256 of the blob: its address in the blob store
  size: number          // blob length in bytes
  wrappedFek: string    // FEK under the VEK
  fekIv: string
  metaBlob: string      // {name, mime, plaintextSize, chunkCount, noncePrefix}
  metaIv: string
}
```

Added to `EntriesPayloadSchema` as `files?: FileRecord[]`, optional so a payload
written by an older build still parses. This is the same additive move
`settings` made.

**This needs no change to VLT1.** `mergeReplicas` is generic over anything
`Stamped` (an `id` plus an `hlc`), so `FileRecord` merges last-writer-wins per
id, and detaches reuse the tombstone machinery. Entries merge differently since
sync conflicts Phase A (concurrent versions are kept, see
[sync-conflicts.md](sync-conflicts.md)); files stay LWW because their content
never changes, only their name. The one place the two meet is an entry delete,
below. The VLT1 binary container in `vault-format.ts` is
untouched, exactly as the sync metadata was (see
[vault-format.md](vault-format.md)).

Renaming a file is a metadata-only change: reseal `metaBlob`, restamp, same
`hash`, no bytes move.

### Every writer that rebuilds a payload must thread the manifest

This is the sharpest edge in adding a field here, and it has now cut twice. A
payload writer that names the fields it keeps silently erases the ones it does
not, and the failure is invisible locally: the value is still on screen from
memory, and only disappears on reload or when a peer merges the emptied payload
back. `synced-settings` hit it; the manifest hits it in the same places.

Two writers rebuild a payload rather than editing one:

- **`buildPayload` in `vault/entry-mutations.ts`** reconstructs the whole payload
  from `VaultEntries` on every write, so the manifest is carried on that value
  (as `manifest`) for exactly the reason `settings` is. Attach a file, rename an
  unrelated login, and without this the attachment is gone. Covered by a suite
  that runs every mutation, since each rebuilds the state it persists and each is
  its own chance to drop it.
- **`reencryptOuterWithEntryChange` in the extension background** now spreads the
  decrypted payload instead of naming `entries` and `tombstones`. Naming them was
  already dropping `settings` on every background write, so a corner-prompt save
  or a passkey create erased the vault's synced settings; the spread fixes that
  and makes the site immune to the next field someone adds.

The general fix, if this happens a third time, is for `VaultEntries` to carry the
non-entry remainder of the payload as one opaque passthrough rather than a
growing list of named fields. Not worth refactoring the working settings path for
now, but it is the shape to reach for.

## Verifying the native path on a device

The Rust tests prove the construction on the host. What they cannot prove is that the
same code reached the phone intact and can write where the app is allowed to write, so
`FileSealInstrumentedTest` runs the seal/open round trip on real hardware, against
app-private storage, on the arm64 `.so` through the real uniffi binding. It also recomputes
the blob's SHA-256 independently in Kotlin and compares it to what Rust returned, which is
the cross-language check that matters: that hash is what a peer verifies a transfer against.

Run it **module-scoped**:

```
cd clients/mobile/android
JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
  ANDROID_SERIAL=<serial> ./gradlew :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=app.bramble.mobile.FileSealInstrumentedTest
```

The `:app:` prefix is load-bearing. Unqualified, `connectedDebugAndroidTest` runs across every
module, and the Capacitor plugin modules (`capacitor-cordova-android-plugins`,
`aparajita-capacitor-secure-storage`) fail `checkDebugAndroidTestDuplicateClasses`: the androidx
test graph requests four Kotlin versions, `kotlin-stdlib` resolves to 1.8.22, and nothing bumps
`kotlin-stdlib-jdk7`/`-jdk8` off 1.6.21, whose classes were folded into `kotlin-stdlib` in
Kotlin 1.8. Those modules have no instrumented tests of their own, so scoping the task costs
nothing and needs no build change. If a future module does need them, align the versions with a
`kotlin-bom` platform rather than excluding the shims: exclusions here would outlive their cause
and leave nothing to tell you when they had become stale.

## Mutations: attach, detach, rename

`vault/file-mutations.ts` is the sibling of EntryMutations and has the same
shape: each mutation is a transition `(current, input) -> next` whose effect is
the write, returning the next `VaultEntries` only after it succeeds.

It writes through **EntryMutations' own `persist`** rather than opening a second
write path. That keeps the autofill index unable to drift from disk whichever
kind of change caused the write, and it means there is still exactly one writer
to reason about. The cost is that attaching a file re-encrypts every entry,
which is the standing price of the VLT1 container holding one
`entriesCiphertext`, not something files introduce.

Two rules are worth stating because neither is forced by the types:

- **A detach drops the record and keeps a stamped tombstone**, exactly as an
  entry delete does. Dropping the record without a tombstone would let a stale
  peer re-add the attachment on the next gossip round.
- **A no-op does not write.** Detaching an unknown id, or renaming a file to the
  name it already has, returns the current state untouched. Any write
  re-encrypts the whole vault, so "no change" has to mean no write.

### Deleting an entry hides its attachments

`removeMany` doesn't tombstone an entry's files. It writes a **mark** for each
one the deleting device holds (`fileCascades`, one per file id, merged at the
latest stamp) and leaves the records in `files`. What a vault shows is
`shownFiles` in `sync/vault-merge.ts`, the one rule GC, backups, blob sync and
the UI all read: a file is shown unless it is detached, or its entry is gone
**and** a delete marked it.

Tombstoning the files at the delete, as this used to, lost data once entries
started keeping concurrent versions:

- **An entry kept from a delete conflict came back without its files.** Phase A
  keeps an entry that was edited on one device while deleted on another, and
  the user can choose to keep it. The delete had already tombstoned its files,
  and a tombstone beats the older record whatever happens to the entry. Now the
  marked records are still there, and a shown entry shows its files whatever
  marked them.
- **A file attached where the delete hadn't reached was left pointing at
  nothing.** An attach doesn't write a version of the entry, so the delete took
  the entry and the new file stayed, listed against an entry that no longer
  existed. A mark records exactly what the deleting device knew, so a file with
  no mark is one the delete never saw. `mergeEntriesPayload` treats it as it
  treats an edit the delete never saw: the entry's newest version stays shown,
  as a delete conflict, and the user keeps it or deletes it. Deleting it then
  marks the new file too.

An attach is refused if the entry is no longer in the vault (a sync took it
while the page was open), so a file can't be attached to an entry nobody can
see.

A build without attachments deletes without marks, since it can't see the
files. On updated devices such an entry comes back as a delete conflict, while
the old build keeps it deleted, until someone chooses there. Neither side
rewrites the other in the meantime, so nothing ping-pongs, and nothing is lost.

The marked records are kept for good, a few hundred bytes each, in the spirit of
a quarantine rather than a delete: they cost little and let any kept entry come
back whole. Their blobs stay on disk until GC exists; a GC that collects them is
safe, since a device that keeps the entry gets the bytes back from the device
whose edit kept it.

Standalone Files items (no `entryId`) are untouched by any entry delete.

### The FileSealer seam

Everything that touches raw file bytes sits behind `FileSealer`, so the mutation
layer never holds an attachment and nothing is marshalled across a boundary just
to be encrypted. `FileSource` has one variant per form a platform hands the bytes over in:

| Variant | Used by | The bytes are |
|---|---|---|
| `blob` | Extension, mobile | What `<input type=file>` yields. The extension parks it in IndexedDB for its crypto host; mobile spools it to a path |
| `staged` | Nothing yet | An IndexedDB key already written, for a caller that has one |
| `path` | Mobile, desktop | A filesystem path the native side opens directly (uniffi on mobile, the Rust shell on desktop) |
| `bytes` | Small files, tests | Already in memory |

The sealer returns only the manifest fields, a few hundred bytes, with the blob
already in the store.

Where `<input type=file>` would force the bytes into the webview, a platform can
supply `VaultFiles.pick`, and the attach button uses it instead. Desktop does: the
native dialog runs in the shell and returns a path (with its size, so the size limit
still applies before sealing), and `files_seal` seals from that path with the VEK the
shell holds. Mobile keeps the input, whose Blob it spools to a path.

### The size limit

`MAX_ATTACHMENT_BYTES` is 90 MB per file. `attach()` refuses anything bigger before it
seals or spools a byte, so the limit is a refusal at the door, never data dropped later.
It is a practical limit, not a backup one: backups have no size limit and always carry
every attachment (see [cloud-storage-backups.md](cloud-storage-backups.md), "Backups with
attachments"). What it bounds is that every attachment is replicated to every device and
the extension opens one into memory.

### Opening an attachment

`VaultFiles.present(record)` decrypts one attachment and hands it to the OS to open,
share or save. It is optional, and `canOpenFiles` gates the Open button, since a
platform may have no way to give a file to another app.

On mobile the file is decrypted natively, chunk by chunk, straight to a copy under
`Cache/open/<uuid>/<name>`, so the plaintext never crosses the bridge, and that copy
goes to the share sheet (`@capacitor/share`). A folder per open keeps two same-named
files apart; a slash in the sealed name is kept from becoming a folder.

The copy is plaintext, and Bramble cannot know when the receiving app is done with it:
a viewer reads the file after the share sheet has closed. So it is deleted when the
vault locks, and at startup for anything a crash left behind, not when the share
resolves. That makes one ordering load-bearing: the auto-lock grace is armed before
the sheet opens, because the sheet backgrounds the app and an "Immediately" auto-lock
would otherwise lock at once and sweep the copy before the chosen app read it.

Every path handed to Rust goes through `pathFromUri`, which decodes Capacitor's
percent-encoded `file://` URIs. Hashes and UUIDs never needed it; a user's file name
with a space does.

Desktop does the same in the Rust shell (`src-tauri/src/files.rs`): `files_open`
decrypts to `cache/open/<uuid>/<name>` under the app cache dir and hands it to the OS
default app through the opener plugin, and the copies are swept at startup and on
every lock. The sealed name is sanitized for every desktop filesystem first
(separators, `:*?"<>|`, control characters, a leading dot).

### The extension

The crypto host (the offscreen document on Chrome, the event page on Firefox) holds the
wasm, the background holds the VEKs, and the view holds the file. Moving a 90 MB file
between them as `chrome.runtime` messages is the cliff described above, so the bytes
move through IndexedDB instead, which every extension context shares, and only keys
travel as messages (`clients/extension/src/files.ts`, `files/host.ts`, `files/idb.ts`).

- **Attach.** The view parks the picked `Blob` in the `handoff` store and sends
  `CRYPTO_FILE_SEAL` naming it. The background injects the vault's VEK and, from the
  same resolution, the vault id, so a file is always stored under the vault whose key
  sealed it. The host loads the VEK, constructs a `FileSealStream`, and from then on
  needs only the stream: it reads 256 KiB slices of the Blob, seals each, appends it to
  a staging object, and publishes that under the hash `finish()` returns. The VEK slot
  is the host's shared scratch register, and the rule is that loading a key and using
  it happen in one synchronous section (see
  [multiple-vaults.md](multiple-vaults.md), "The atomicity rule"). The stream is what
  lets this op await IndexedDB between chunks anyway: after its constructor it holds
  the file's content key, not the VEK. The view drops the handoff however the seal
  ends.
- **Open.** `CRYPTO_FILE_OPEN` runs the same way back, into a `Blob` parked in the
  handoff store, and the view saves it as a download under its sealed name. The Blob is
  `application/octet-stream` whatever the file is, because a blob URL of the
  extension's origin that a browser rendered instead of saving would run with the
  extension's privileges. The downloaded copy is the user's; the parked one is dropped
  once read.
- **Parked plaintext** is cleared on every lock and at browser start, for a crash
  between parking and pickup.
- **The popup cannot pick a file.** It dismisses on focus loss, which takes the file
  input down with it (see [routing.md](routing.md), "Pop-out handoff"). So in the
  attached popup the Attach button opens the detached window on the same entry
  instead (`filePickerNeedsWindow`), and the file is picked there.

### Building iOS

The Swift plugin methods (`NativeCrypto.swift`) call uniffi glue that
`scripts/build-crypto-ffi.sh ios` generates into the gitignored
`ios/App/VaultCryptoFFI/`, alongside the XCFramework. A checkout that skips that step
builds against stale glue with no file functions in it, and fails to compile.

## The blob store

A new adapter, `BlobStore`, deliberately never the VLT1 blob:

| Target | Backing |
|---|---|
| Extension | **IndexedDB** (`bramble-files`), in two layers: `objects` maps `[vaultId, "blob" \| "staged", name]` to an object id and size, and `parts` holds that object's bytes as `[objectId, index]`, one sealed chunk (262,160 bytes) per part, so chunk *i* is part *i* and a range read is a key range. Publishing staged bytes is one small write to `objects`, not a copy. Not `chrome.storage.local`: it is a serializing key-value store, so a 50 MB value is a base64 or array round-trip on every touch. `unlimitedStorage` and the existing `navigator.storage.persist()` call (see [storage.md](storage.md)) already lift quota and eviction. **Still unverified:** storage.md's "clearing browsing data does not wipe the vault" claim is documented for `storage.local` specifically, and whether extension-origin IndexedDB gets the same treatment on both browsers needs checking, not assuming. |
| Mobile | `Filesystem` `Directory.Data`, at `blobs/<hash>`, next to the existing `vault-<id>.vlt1`. Deliberately **not** the App Group: autofill never needs attachments, so the credential provider's footprint stays small. |
| Desktop | The app data dir, at `blobs/<vaultId>/<hash>`, written by commands in the Rust shell (`src-tauri/src/files.rs`). Blob bytes cross the IPC only for backup and restore, and then raw (`tauri::ipc::Request` / `Response`), never as JSON number arrays. |

Because every sealed chunk is exactly `262144 + 16` bytes except the last, crypto
chunk `i` starts at a computable offset. Random access for a preview is a seek,
with no index to store or keep in sync.

### One implementation, three backends

The split matters more than the platforms do. The native backends can only be
exercised on a device, so **none of the logic that can quietly corrupt a file
lives in them.**

- **`BlobStore`** (`core/vault/blob-store.ts`) holds everything interesting:
  staging, resume, verify-before-publish, range clamping, sweep. One
  implementation, unit-tested against a memory backend.
- **`BlobBackend`** is what each platform supplies: dumb byte I/O, no validation,
  no verification, no policy. Append to a staged object, read a range, publish,
  discard, and the same four for committed blobs.

Bytes are staged and never visible as a blob until the accumulated content
hashes to the address it was requested under. That is the same instinct as the
vault's backup-key write ordering in [storage.md](storage.md): the window where a
reader could see a half-written thing is designed out rather than made unlikely.

**Resume rehashes rather than trusts.** The staged prefix outlives its receipt
and the process; the running hash does not. So reopening a partial receive
replays the staged bytes through a fresh hasher (one local pass, only on resume)
instead of refetching a large attachment from zero. A prefix corrupted at rest is
therefore caught at commit rather than published under the right address.

**A failed commit discards the staging**, rather than keeping it for a retry: a
retry would append to a poisoned prefix and could never converge on the right
hash.

`sweep(keep)` is the GC *mechanism* only. The grace period that stops an offline
device's still-referenced bytes being collected is policy, and belongs to
whatever computes `keep`.

Hashing is `BlobHasher` from `core-rust/src/files.rs`, incremental because the
alternative is holding a whole attachment in memory and because WebCrypto has no
streaming digest.

## Transfer: a separate connection, WebRTC only

### The rule

**File bytes move only over a WebRTC peer connection, direct or relayed by TURN,
or over the desktop app's local link. Never relay-forwarded through the
signalling relay.**

Decided 2026-10-12, replacing the first rule, which kept files off TURN too. That
rule had two reasons. One was cost: the project pays for the Cloudflare TURN
relay, where entry sync rounds to nothing and a 100 MB file per device pair does
not. The other was that the project should not carry users' passport scans
through its infrastructure even as ciphertext it cannot read. Neither held up:

- What TURN carries is the same DTLS + Noise channel as everything else, and
  inside it each file is sealed under its own key (see "How a file is
  encrypted"). The operator learns addresses, timing and sizes, never contents,
  which is what entry sync already discloses on the privacy page.
- TURN is self-hostable: point the ICE endpoint at your own coturn.
- The cost is bounded. The hosted TURN stops handing out credentials at the free
  tier ([turn-credentials.md](turn-credentials.md)), a budget entries and files
  now share.

Meanwhile the rule cost real users their files: a symmetric NAT, a phone behind
carrier-grade NAT, or a full-tunnel VPN left a file visible and unfetchable for
good.

What stays out is relay-forward. When a peer has no `RTCPeerConnection`, entry
sync forwards its traffic through the Nostr relay in small encrypted messages;
files never take that path. The relay caps a message at 64 KiB and runs every
socket through one Durable Object, and it is the project's own service in a way
a metered, self-hostable TURN relay is not. TURN needs WebRTC as well, so Firefox,
which has none in any extension context, still gets files only from the desktop
app.

### Enforced structurally

The blob session's mesh runs with `webrtcOnly`: a peer that cannot do WebRTC is
reported ("found, but it needs a WebRTC connection") rather than reached through
relay-forward, and relay `data` events are ignored outright, so nothing can
arrive that way either. `mesh-webrtc-only.test.ts` pins both, and that the
session's connections get the TURN servers like entry sync's.

Until 2026-10-12 the session also built its ICE list through `stunOnly()`, which
dropped every `turn:` URL (within each entry's `urls`, since Cloudflare returns
mixed arrays), so relaying was impossible rather than refused. That filter went
with the rule.

### The blob connection is a second mesh, not a second PC

`Mesh` keys peers by remote pubkey in a `Map<string, Peer>`, one connection each,
so bolting a second `RTCPeerConnection` into it would mean surgery on the
discovery, announce and reconnect paths. None of that is necessary.
`MeshOptions` already carries `roomLabel`, which exists precisely so enrollment
and ongoing sync occupy separate rooms. A blob session is therefore a **second
mesh session** over the same machinery:

| | Entry sync | Blob transfer |
|---|---|---|
| Room label | `"bramble/sync"` | `"bramble/blob"` |
| ICE servers | `fetchIceServers(iceUrl)` | the same |
| Data channel | `"sync"` | `"sync"`, on a connection of its own |
| Relay-forward fallback | yes | **no** |
| Noise session | KK over roster keys | KK over the same roster keys |

So `startBlobSync()` mirrors `startRosterSync()`, and `mesh.ts`,
`signaling-client.ts`, `handshake.ts` and `secure-channel.ts` are all reused
unchanged. It runs its own Noise KK handshake with the same device static keys
via `runInitiator` / `runResponder`: no new trust anchor, no new key material.

As built it has its own relay socket. Sharing one would save an announce stream and
a keepalive per client, and can come later; it changes nothing about what crosses
the relay, which for files is only signalling.

The mesh enforces the rule with `webrtcOnly` (see "Enforced structurally").

One session, several paths. `startBlobSync` takes the mesh (unless `relay: false`,
which the extension passes where there is no `RTCPeerConnection`) plus any
`localSources`, and runs them all under one transfer state. Two sessions over one
store could stage the same file twice at once. Peers are keyed per path, so the same
device over the mesh and over the desktop link is two peers, and a reconnect on one
path supersedes only that path's peer.

This also resolves the head-of-line blocking that a shared channel would have
caused. `broadcast()` awaits `sendSecure` sequentially per peer, so bulk data on
the `"sync"` channel would stall entry sync for minutes. On a separate SCTP
association the two cannot block each other, so a throttle becomes a politeness
knob for link saturation rather than a correctness requirement.

### The protocol

`core/sync/transport/blob-sync.ts`. Peers authenticate exactly as entry sync's do
(`peer-auth.ts`, shared so the two cannot drift: roster membership, then Noise KK
over the device keys), then speak four messages over the Noise session:

- `have {h}`: every blob this device holds. On connect, on change, and every 30 s
  as a heartbeat; a peer silent for four beats is dropped. Each device re-lists its
  own store every 10 s and announces at once if that changed, which is how a file
  attached on a host with no attach hook (desktop, mobile) is offered within
  seconds.
- `want {h, o, n}`: send me `n` bytes of `h` from offset `o`, at most one window
  (`WINDOW`, 1 MiB).
- `data {h, o, d}`: one slice of a wanted window (`SLICE`, 23 KiB, so its base64
  fits one Noise frame).
- `nope {h}`: I do not hold that.

What a device wants is every live `FileRecord` its own manifest names, re-read on
every poke (after a merge, an attach, a restore). A file the manifest does not name
is never fetched, whatever a peer announces.

Two different chunkings, which must not be conflated:

- **Crypto chunks** are the blob's internal 256 KiB structure, fixed at seal time.
- **Transfer windows** are arbitrary byte ranges over the already-sealed blob.

The transfer layer works purely in byte ranges over opaque bytes. It never needs
`chunkCount`, and therefore never needs a key. Bytes are **pulled, never pushed**:
they move only in answer to a `want`.

A window's slices are held until the window is complete and then appended to the
store's staging in one write (on mobile each write is a bridge call), so what is
staged is always whole windows. A transfer cut off keeps that prefix and resumes
from it, from whichever peer has the file next. Nothing becomes a blob until the
whole file hashes to its own name: a wrong byte from a broken or hostile peer costs
a retry (that peer is passed over for that file for two minutes) and never a wrong
file. One transfer runs at a time.

The holder re-reads the roster on every `want`, so a device revoked mid-session
gets no more bytes. `blob-sync.test.ts` pins the pull, the resume, the hash
refusal, the revocation, and a file attached after both sessions started.

**Replicate all, on every device, in v1.** Every device fetches every file its
manifest names. That is what lets a backup be whole from any device (see "Export,
backup, import"), and it needs no GC to be safe: nothing is ever deleted early. The
per-device "on demand" policy below is deferred.

**Known inefficiency:** `Channel.send` takes a `string`
(`core/sync/transport/channel.ts`), so ranges travel base64 and a 100 MB file
moves ~133 MB. Acceptable for v1, fixed later by binary frames on the data
channel.

### The desktop link: the one path that is not the mesh

**Status (2026-10-29): built late.** This section was written assuming a Firefox desktop link that
did not exist until 2026-10-29 (see [desktop-port.md](desktop-port.md#firefox)). Firefox still adds
files only while it is linked: `addFiles` (`flags.ts`) is off there and `useCanAddFiles` turns it on
for a paired link, because an unlinked Firefox would keep a new file to itself and every other
device's backup would wait on it. Unlinked, it lists and opens the files it holds, offers no
attach, and imports leave attachments out with a counted line saying why.

Firefox has no `RTCPeerConnection` in any extension context, so on Firefox the mesh
can never carry a file. Its one way to a file is the native-messaging link to the
desktop app on the same machine, which already carries entry sync. Files ride that
link as well, and nothing on it leaves the machine.

Both ends have older versions in the wild that would misread a new frame. An old
extension takes any frame that is not sync or fill as the answer to its pending
request, and an old app answers an unknown op with an error that the extension
would take the same way. Either would put the link one frame out of step, so every
later fill returns the previous one's answer. So capability is negotiated in a
request an old app answers harmlessly:

- When the extension opens its link, before anything else can use it, it asks
  `{op: "caps", caps: ["files"]}`. A current app answers `{ok: true, caps:
  ["files"]}` (even while locked: it says nothing about any vault) and records that
  this connection speaks files. An old app answers with an error, which this
  request consumes, and the extension sends it no file frame.
- `socket.rs` refuses `link_blob_send` and `link_blob_poke` for a connection that
  has not said it speaks files, so an old extension is never sent one.

Over the link a file conversation is a numbered stream (`blob-link.ts`), because
either end can restart, lock or reconnect while the other runs. The roles are fixed
so the two ends never race to open one: the browser dials (a fresh random stream id
when it starts and whenever the app pokes it), and the app listens (a frame on a
stream it has not seen is a new peer, superseding that browser's last). The app
pokes a browser it has no stream with: on start, when the browser declares files,
and every minute. Each end speaks only on its current stream and drops frames for
any other, so a late frame from an old conversation is never read as the first of a
new one.

Two link fixes came with this. Outbound frames on the extension's held link are
sealed and sent on one chain, because Noise frames must reach the app in the order
they were sealed and file traffic made concurrent seals common. And on Firefox the
sync host runs inside the background page, whose own `runtime.sendMessage` never
reaches its own listeners, so entry sync's link frames had never left Firefox at
all. Link sends now go through the sync bridge, in process on Firefox.

### What the rule costs, stated plainly

Entries and files still have **different reachability** in one case: pairs
without WebRTC, where either peer has no `RTCPeerConnection` and `mesh.ts` is
forwarding entries through the Nostr relay. Firefox is always this case on the
mesh, and gets files only from the desktop app on the same machine (above). A
file also waits, while entries arrive, on a pair with no direct path when TURN
isn't there: the ICE endpoint is unreachable, the hosted TURN has reached its
monthly ceiling, or a self-hoster runs none.

In those cases the manifest still syncs, so the file is **visible and
unfetchable**. That is expected, and the UI says so rather than spinning: the row
reads "Not on this device yet. Waiting for a device that has it." and offers no
Open until the bytes are here (it looks again every few seconds). A backup of
that vault waits too, and says which file it is waiting for, because a backup is
whole or it is not taken. A sharper message naming the peer and the reason needs
the session's status in the view, which on the extension runs in another
context; it is scoped in "Saying why a file has not arrived" below.

`e2e/sync/attachments-sync.spec.ts` drives both sides of the rule over a real
relay: a 6 MB file crosses between two browsers byte for byte while the relay
carries a few tens of KB, and a joiner with no WebRTC gets the entry, shows the
file as waiting, and the relay still carries none of it.

Devices that are never online at the same time are the other gap, for files as
for entries: the **bucket mailbox** below, in the user's own storage, is the
answer to that.

### Saying why a file has not arrived

Built 2026-10-13. Status only, with no manual retry: the session already retries
by itself (a hello every 30 s, a `have` every 10 s, a peer that failed a transfer
passed over for 2 minutes), so a button would save at most those waits, and the
cases it could not fix (the other device locked or asleep, no path at all,
Firefox without the desktop app) are the ones users will meet. What was missing
was the row saying which case it is, and showing progress: it read "Waiting for a
device that has it" even while a 60 MB file was coming in, which on Android's
slow bridge is minutes.

**What the row says**, for a file this device doesn't hold, from what its own
session can observe (`statusOf` in `blob-sync.ts`, in this order):

| State | When | Line |
|---|---|---|
| Downloading | a transfer of this file is active | "Downloading from Laptop, 40%" (never 100% before it is whole) |
| Queued | a connected device has it; another file is coming in first | "Laptop has it. Coming next." |
| Retrying | every connected device that has it is passed over after a failed transfer | "Laptop has it. Trying again shortly." |
| Unreachable | the file mesh found a device 20 s ago or more and no connection opened | "A device is online but can't connect to this one." |
| Not on connected devices | file peers are connected, none lists it in `have` | "None of your connected devices has it yet." |
| Desktop app only | no WebRTC here (Firefox) and the desktop link is down | "This browser gets files only from the Bramble desktop app." |
| Nobody online | none of the above, or a platform with no session to ask | "Not on this device yet. Waiting for a device that has it." |

Unreachable outranks not-on-connected: the device that can't be reached may be
the one with the file. The 20 s grace covers ICE, which takes seconds; before it a
found device is still connecting. A device unheard from for two minutes is
forgotten.

Unreachable devices stay anonymous. The mesh signs with a throwaway Nostr key per
session (`makeNostr`), and which roster device it is becomes known only after the
Noise handshake over a WebRTC channel, which is the thing that failed. Naming it
would mean putting an identity in the hello, which tells the relay more than it
learns today: not worth it for one line of copy.

**The pieces:**

1. **Core, `blob-sync.ts`.** `status(hashes)` on `BlobSyncSession` builds a
   snapshot from state the session already keeps (`active` and its offset, each
   peer's `has`, `passOver`, `wanted`, labels from `currentRoster`) and asks the
   pure `statusOf` about each file it doesn't hold. Devices found but never
   connected come from `onPeerState(remote, "found" | "open" | "closed")`, a hook
   on `mesh.ts` passed through `startMeshSession`, so nothing parses status
   strings.
2. **`VaultFiles.transferStatus?(hashes)`**, and `fileStatus` among the vault
   actions. Optional: a platform without it keeps the plain line.
3. **Hosts.**
   - Extension: the session runs in the offscreen document (Chrome) or the event
     page (Firefox), so the popup asks through the background with
     `BLOB_STATUS {vaultId, hashes}` (zod-checked, `extensionOnly`). The host
     answers for the vault its session is pinned to, and null otherwise.
   - Desktop (`sync/roster.ts`) and mobile (`sync/sync-manager.ts`): in-process.
     The sync module answers through `core/sync/blob-status.ts` and the files
     adapter asks there, since the two importing each other would be a cycle.
4. **UI, `entry-modes/attachments.tsx`.** `useArrivals` checks which of the
   entry's files are held and, while any is missing, asks for all the missing
   ones in one request every 4 s. It polls rather than subscribes because on the
   extension the session lives in another context.

**Tests.** `statusOf` case by case and a live session (`blob-sync.test.ts`), the
mesh's found hook (`mesh-webrtc-only.test.ts`), each row line and the one request
per look (`attachments.test.tsx`), the extension host's pinned-vault answer
(`offscreen-roster-sync.test.ts`). End to end, the "without WebRTC" test in
`attachments-sync.spec.ts` waits for the unreachable line. Downloading isn't
asserted end to end: over loopback a 6 MB file arrives between two looks.

**Not in scope:** a retry button (above); the replication count ("on 2 of 3
devices"), which needs every device's holdings including offline ones and goes
with GC in step 4; the bucket mailbox (step 6).

## Replication, garbage collection, and quota

### The new failure mode: a manifest with no bytes anywhere

Files introduce a state entries cannot reach: a `FileRecord` every device agrees
on, whose blob no device still holds. `BLOB_HAVE` makes that computable, so the
UI can show "on 2 of 3 devices" and warn at 1. Turning a silent data-loss path
into a visible one is the same instinct as the SAS gate in
[p2p-sync.md](p2p-sync.md): the point is that the bad state is *noticed*.

### Garbage collection needs a grace period

The referenced set is computable from the outer layer alone (the `hash` field),
so GC never unwraps a key. But deleting every unreferenced blob immediately is
wrong: a device that has been offline may hold a manifest that still references
it, and merging that manifest back in would resurrect a reference whose bytes the
group has already collected.

So: delete a local blob only once it has been unreferenced for a grace period
(order of days), not on the first sweep that notices it. The alternative,
tracking per-peer acknowledgement, reintroduces the coordination this design
exists to avoid.

### Selective sync, per device

Deferred: v1 replicates every file to every device (see "The protocol"). A phone
should not be forced to mirror 2 GB of scans forever, so the policy to come is:

- **Replicate all** (default on desktop): fetch every blob the manifest names.
- **On demand** (default on mobile): sync the manifest, fetch bytes when the user
  opens the file.

On demand inherits the existing "both devices online and unlocked" limitation, so
the UI has to be honest rather than showing a spinner: "Not on this device. Open
Bramble on Laptop to fetch it."

## The async escape hatch, with no server to trust

Files sharpen the synchronous-only limitation, because a file is exactly what you
want on the device you do not have with you.

There is a clean answer that adds no trusted infrastructure: **the user's own
bucket as a content-addressed blob mailbox.**
[cloud-storage-backups.md](cloud-storage-backups.md) already targets
S3-compatible and WebDAV. A sealed blob needs no server logic at all, just PUT
and GET by hash, and the store never sees a key or a filename. It is the same
dumb-pipe trust model as the relay, opt-in, and it gives offline replication
without anyone operating anything. Content addressing is what makes it safe:
there is nothing to get wrong, because the name of the object is a hash of the
object.

## Export, backup, import

- **Backups carry every attachment. Done.** A vault with attachments is backed up as
  one self-contained ZIP (`vault.bramble` plus `blobs/<hash>`), still named `.bramble`; a
  vault without them is backed up as its raw blob, exactly as before. A ZIP needs no new
  reader outside the app, and no new crypto is involved, because each blob is
  self-contained ciphertext whose FEK is already wrapped inside the manifest. There is no
  size limit and no partial backup: a vault that cannot be backed up whole (a file not on
  this device yet, or a sealed list with no key) waits and says why. Full design, the
  multipart and streamed uploads, and the strict streaming reader:
  [cloud-storage-backups.md](cloud-storage-backups.md), "Backups with attachments".
- **Attachment storage is per vault.** Each vault's files live in their own store
  (`FileAdapter.forVault`; on mobile and desktop, `blobs/<vaultId>/`). A shared store could not
  tell which files were whose, so a sweep driven by one vault's manifest would have
  deleted every other vault's attachments, and a backup could not know which files to
  pack. Deleting a vault deletes its attachment store.
- **Portable vault** (an exported *selection*, sealed under a per-file key, see
  [cryptography.md](cryptography.md)) carries entries only for now, and its dialog says
  attachments aren't transferred, and how many. Carrying them means resealing each blob under that
  export's key, for the same reason the entries are resealed: otherwise the file is a
  second door to the vault.
- **KeePass export carries every attachment**, on every target. KDBX4 puts attachments in
  the inner header ahead of the XML that names them, so `kdbx::Writer` writes the file front
  to back: attachments first, each opened chunk by chunk straight into the gzip, AES-CBC and
  HMAC-block pipeline, then the entries with `<Binary>` references. Every file's stream is
  keyed before any is read, so the VEK is not needed once streaming starts. Neither the
  file nor any attachment is held whole. On the extension, the crypto host feeds the
  writer's output into Blob parts as it is ready. On the desktop app and the phones,
  `kdbx::save_to_path` reads each blob from its file and writes the database into a fresh
  folder among the decrypted copies, which the lock sweeps. That file then goes to the save
  dialog's path (desktop) or the share sheet (phones) from where it is, and is deleted
  afterwards. Whole or not at all: an attachment not on this device yet, or not at its
  recorded size, refuses the export before a byte is written. A file whose entry is gone goes
  on one extra entry, "Attachments". Core makes names unique per entry ("scan (2).pdf"),
  since KeePass keys attachments by name. Proven by `keepassxc-cli attachment-export` in
  `e2e/extension/kdbx-export.spec.ts`, and natively by round trips through the reader in
  core-rust's and the desktop app's tests.
- **KeePass import keeps every attachment**, on the entry that holds it, on every target.
  The reader returns the inner header's attachments and each entry's `<Binary>` references;
  WASM hands them back as bytes, which the extension parks in handoffs (a database can be far
  larger than a message may be), and the native cores write each to a file in a fresh folder
  among the decrypted copies, which the lock sweeps. Each platform's sealer then reads them in
  the form it already takes, and `importMany` writes the entries and their file records in one
  write, after every file has sealed: whole or not at all. Re-importing a database brings the
  files an earlier import lacked, onto the entries already here, and only once (an entry that
  already has a file of that name and size is left alone). Proven against a database KeePassXC
  wrote, in core-rust's tests and `e2e/extension/import-keepass.spec.ts`. See
  [encrypted-import.md](encrypted-import.md).
- **Sending to another app** (credential exchange) carries no attachments. The row says so
  when the vault has any, and the transfer's first warning repeats it.
- Issue #98 (local favicon upload) can reuse this store, though at under ~50 KB
  an icon is small enough to live in entry plaintext and probably should.

## Deferred / known limitations

- **Revocation is unchanged and now matters more.** A revoked device keeps its
  blobs offline exactly as it keeps the VEK. Revoke still means "stops future
  sync", not "wipes that device", and the data at stake is now passport scans
  rather than passwords alone. VEK rotation remains the real fix.
- **Sizes and file counts are visible to group members.** Not to the relay;
  TURN sees a relayed transfer's volume, which is about the file's size. See
  "What each layer actually defends".
- **Files are less reachable than entries on pairs without WebRTC.** A vault can
  be fully synced while a file in it cannot transfer, most often on Firefox
  without the desktop app. See "What the rule costs". It is the one most likely
  to be reported as a bug.
- **A suspended mobile app cannot serve blobs.** "The phone is the only replica"
  is a bad state, and the replication count above is what should push users out
  of it.
- **No dedup.** Deliberate, see "Why the hash is over ciphertext".
- **No field-level or partial-file merge.** A file's bytes never change, only its
  name. Two devices renaming the same file concurrently resolve last-writer-wins
  on the file record, so one name is lost; entries keep both versions instead.

## Phasing

0. **Landed.** `core-rust/src/files.rs` (the chunked AEAD and `BlobHasher`, pure
   and VEK-free), `stunOnly()` in `core/sync/transport/ice.ts`, the `FileRecord`
   manifest and its merge, `BlobStore` over `BlobBackend`, and the attach /
   detach / rename mutations with the entry-delete marks. All covered by tests
   that run without a device, including the native streaming sealer
   (`seal_file_at_path` and friends), which is exercised against real files on
   disk. What is missing is the glue: the `BlobBackend` implementations, the
   wasm and uniffi bindings, and the UI.
1. The three `BlobBackend` implementations and the `FileSealer` behind each
   (staged-IndexedDB on the extension, a path-taking uniffi call on mobile and
   desktop, per "The crypto call must be handle-based"), plus the attachment UI.
   Exported to both wasm and uniffi so it works under iOS Lockdown Mode.
   Mobile, desktop and the extension are built. No feature flag (decided 2026-10-02):
   attachments ship on every target at once, so there is nothing to stage behind one.
2. **Built.** The second mesh session (`startBlobSync`, `roomLabel:
   "bramble/blob"`, no relay-forward). It was TURN-free (`stunOnly`) until
   2026-10-12, and now takes TURN like entry sync.
3. **Built.** `have` / `want` / `data` / `nope` over that session on every target,
   the desktop link as a second path (the only one Firefox has), and the "not on
   this device yet" state, which says why a file hasn't arrived and how far it has
   got (see "Saying why a file has not arrived"). The replication count waits for
   step 4.
4. GC with the grace period, and per-device sync policy.
5. Backups and export carry every attachment, whole or not at all, of any size (done:
   one ZIP per backup, see above). KeePass export and import carry them too.
6. Bucket mailbox for async replication, which is the real answer for devices
   that are never online at the same time.

Two things to pressure-test: the GC grace period (get it wrong and files
vanish), and how much of the hosted TURN's monthly budget files take, since
entries share it and a month that runs out leaves both without TURN.
