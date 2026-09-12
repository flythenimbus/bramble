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
2. **Ongoing sync is a full-state push every 4 seconds.** `broadcast()`
   (`core/sync/transport/roster-sync.ts`) serializes the whole payload and sends
   it to every peer on each `REBROADCAST_MS` tick. There is no delta protocol,
   because entry-level LWW over a full state is what makes the merge trivially
   convergent.

Both are good properties for entries, which are kilobytes. Put a 20 MB PDF in
that payload and renaming one login re-encrypts 20 MB, and every peer receives
~27 MB (base64 inside JSON) every 4 seconds, split across ~850 Noise frames
(`CHUNK_BYTES` is 32 KiB, bounded by `MAX_MSG` in `core-rust/src/handshake.rs`).

So the requirement is not "make the payload bigger". It is: **the bytes must not
participate in the broadcast at all.**

## The core move: split the manifest from the bytes

A file is stored as two separate things.

- The **manifest** (`FileRecord`): a few hundred bytes of stamped metadata. Lives
  in the entries payload, merges with the existing engine, rides the existing
  4-second broadcast.
- The **blob**: the sealed file content. Lives in a per-platform blob store
  outside the vault blob, is **immutable**, is addressed by the hash of its own
  ciphertext, and moves only when a device asks for it, over a direct connection
  that structurally cannot use TURN (see "Transfer").

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
already is, and it is not visible to the relay or to TURN, which see only Noise
ciphertext.

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

**This needs no change to the merge engine and no change to VLT1.**
`mergeReplicas` is generic over anything `Stamped` (an `id` plus an `hlc`), so
`FileRecord` merges by the existing entry-level LWW rules, and deletes reuse the
existing tombstone machinery. The VLT1 binary container in `vault-format.ts` is
untouched, exactly as the sync metadata was (see
[vault-format.md](vault-format.md)).

Renaming a file is a metadata-only change: reseal `metaBlob`, restamp, same
`hash`, no bytes move.

## The blob store

A new adapter, `BlobStore`, deliberately never the VLT1 blob:

| Target | Backing |
|---|---|
| Extension | **IndexedDB**, one record per crypto chunk. Not `chrome.storage.local`: it is a serializing key-value store, so a 50 MB value is a base64 or array round-trip on every touch. IndexedDB stores `ArrayBuffer` natively and reads one chunk without deserializing the rest. `unlimitedStorage` and the existing `navigator.storage.persist()` call (see [storage.md](storage.md)) already lift quota and eviction. **Verify before building:** storage.md's "clearing browsing data does not wipe the vault" claim is documented for `storage.local` specifically, and whether extension-origin IndexedDB gets the same treatment on both browsers needs checking, not assuming. |
| Mobile | `Filesystem` `Directory.Data`, at `blobs/<hash>`, next to the existing `vault-<id>.vlt1`. Deliberately **not** the App Group: autofill never needs attachments, so the credential provider's footprint stays small. |
| Desktop | The app data dir, same layout. |

Interface: `has(hash)`, `read(hash, offset, length)`, `write(hash, offset, bytes)`,
`commit(hash)`, `delete(hash)`, `list()`.

Because every sealed chunk is exactly `262144 + 16` bytes except the last, crypto
chunk `i` starts at a computable offset. Random access for a preview is a seek,
with no index to store or keep in sync.

Writes land in `tmp/<hash>.part` and are renamed only after the full-blob hash
verifies, so an interrupted transfer can never become a corrupt blob. This is the
same instinct as the vault's backup-key write ordering in
[storage.md](storage.md).

## Transfer: a separate, deliberately TURN-free connection

### The rule

**File bytes move only over a direct peer-to-peer path. Never over TURN, and
never over relay-forward.**

Entry sync keeps both fallbacks and is unaffected. This is a hard architectural
boundary, not a tuning knob, and it exists for two reasons that point the same
way: the project pays for the Cloudflare TURN relay, where entry sync rounds to
nothing and a 100 MB file per device pair does not; and the project should not be
in the position of carrying users' passport scans through its own infrastructure,
even as ciphertext it cannot read. "We never see it" is a far weaker statement
than "it never goes near us."

### Enforced structurally, not by a runtime check

The obvious implementation is to call `getStats()`, find the selected candidate
pair, and refuse if either side has `candidateType === "relay"`. Do not do this.

`packages/platform-mobile/src/native-webrtc.ts` is a hand-written shim
re-creating the `RTCPeerConnection` surface over the pure-Rust `webrtc` crate,
because iOS WKWebView on `capacitor://` has no WebRTC at all (see
[p2p-sync.md](p2p-sync.md)). It implements `createDataChannel`, `createOffer`,
`setLocalDescription` and the signalling callbacks, and **no `getStats`**. Adding
it means a change in `core-rust/src/webrtc.rs`, a uniffi export, and the shim,
for a guard whose whole job is to be unfailing. A policy check that silently
no-ops on one platform is worse than no check, because it reads as enforcement.

Worse, `getStats` is a snapshot. ICE can fail over to a relay candidate pair
mid-transfer, so a check at transfer start proves nothing about byte 80,000,000.

So instead: **blobs get their own `RTCPeerConnection`, built from an ICE list
with every `turn:` and `turns:` entry removed.** There are no relay candidates to
gather and no TURN credentials in scope, so relaying is not refused, it is
impossible. It cannot regress by someone forgetting a guard, it needs no new
platform API, and it holds identically on the iOS shim, which already takes an
`iceServers` list and already defaults it to `[]`.

The filter is the entire mechanism, and it belongs next to `fetchIceServers` in
`core/sync/transport/ice.ts` so it is one auditable function:

```ts
/** Drop every TURN entry. Blob transfer is direct-only, by construction. */
export function stunOnly(servers: RTCIceServer[]): RTCIceServer[] {
  const direct = (u: string) => u.startsWith("stun:");
  return servers
    .map((s) => ({ ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(direct) }))
    .filter((s) => s.urls.length > 0);
}
```

Note it filters the **urls within each entry**, not just whole entries: a minting
endpoint is free to return one server object whose `urls` array mixes `stun:` and
`turn:`, and Cloudflare's does. Dropping only whole entries would silently pass
TURN through.

STUN is kept deliberately. A STUN binding request returns a device its own public
`IP:port` and carries no payload, so it is categorically not a path files travel:
keeping it costs nothing against the rule above and buys direct cross-NAT hole
punching, which is the difference between "files sync at home" and "files sync
between your laptop and your phone on cellular".

### The blob connection

One extra `RTCPeerConnection` per peer, alongside the existing one:

| | Entry sync | Blob transfer |
|---|---|---|
| ICE servers | `fetchIceServers(iceUrl)` | `stunOnly(fetchIceServers(iceUrl))` |
| Data channel | `"sync"` | `"blob"` |
| Relay-forward fallback | yes | **no** |
| Noise session | KK over roster keys | KK over the same roster keys |

Signalling is the existing relay path and is a few hundred bytes, so the second
connection is cheap. It runs its own Noise KK handshake with the same device
static keys, reusing `runInitiator` / `runResponder` unchanged: no new trust
anchor, no new key material, just a second session over a second channel.

This also resolves the head-of-line blocking that a shared channel would have
caused. `broadcast()` awaits `sendSecure` sequentially per peer, so bulk data on
the `"sync"` channel would stall entry sync for minutes. On a separate SCTP
association the two cannot block each other, so a throttle becomes a politeness
knob for link saturation rather than a correctness requirement.

### The protocol

After any merge a device computes what it is missing:

```
wanted = { r.hash for r in liveFileRecords(manifest) } - blobStore.list()
```

Three message kinds on the blob session:

- `BLOB_HAVE {hashes}` on connect and thereafter only on change, never per tick.
- `BLOB_WANT {hash, fromByte}`
- `BLOB_DATA {hash, offset, bytes}`

Two different chunkings, which must not be conflated:

- **Crypto chunks** are the blob's internal 256 KiB structure, fixed at seal time.
- **Transfer ranges** are arbitrary byte windows over the already-sealed blob.

The transfer layer works purely in byte ranges over opaque bytes. It never needs
`chunkCount`, and therefore never needs a key. Resume is just a larger
`fromByte`, and correctness rests on one SHA-256 check at the end. Because blobs
are immutable and content-addressed, a device can pull 0-50 MB from the laptop
and 50-100 MB from the phone, resume across reconnects, and still need only that
one check.

**Pull, never push.** The 4-second broadcast stays exclusively for the manifest.
Bytes move only in response to a `BLOB_WANT`.

**Known inefficiency:** `Channel.send` takes a `string`
(`core/sync/transport/channel.ts`), so ranges travel base64 and a 100 MB file
moves ~133 MB. Acceptable for v1, fixed later by binary frames on the data
channel.

### What the rule costs, stated plainly

Entries and files now have **different reachability**, and this is the first
place in the product where two things in one vault sync over different paths.
Three cases where entries sync and a file will not:

1. **Both peers behind symmetric NAT** (some carrier-grade NAT, some corporate
   networks). STUN cannot punch it, TURN could, TURN is disallowed.
2. **A full-tunnel VPN that kills the LAN path.** Android's `VpnService`
   full-tunnel is the known case (see [p2p-sync.md](p2p-sync.md)); it is exactly
   why TURN was added for entries.
3. **Relay-forward-only pairs**, where neither peer exposes
   `RTCPeerConnection` and `mesh.ts` is forwarding through the Nostr relay.

In all three the manifest still syncs, so the file is **visible and
unfetchable**. That state is not a bug, it is the rule working, and the UI has to
say so in those words rather than spinning: "Sync is connected, but this file
needs a direct connection to Laptop. Put both devices on the same network." An
unexplained permanent spinner would make a deliberate policy look like a defect,
and it is the most likely support question this feature generates.

Two mitigations soften it without touching the rule: the **bucket mailbox**
below, which is the user's own storage rather than the project's, and a possible
later setting letting a self-hoster who has configured **their own** ICE endpoint
opt back into TURN. That distinction (default endpoint vs user-configured) does
not exist in the config layer today and should not be invented until someone
asks.

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

A phone should not be forced to mirror 2 GB of scans. Per-device policy:

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

- **`.bramble` must carry blobs** or export becomes a silent data-loss trap: the
  user takes a backup, restores it, and the attachments are gone. Keep VLT1
  untouched and define a **BRB1 archive**: the VLT1 blob, an index, and the
  already-sealed blobs concatenated. No new crypto is needed, because each blob
  is self-contained ciphertext whose FEK is already wrapped inside the manifest.
- **Portable vault** (an exported *selection*, sealed under a per-file key, see
  [cryptography.md](cryptography.md)) has to reseal any included blob under that
  export's key, for the same reason the entries are resealed: otherwise the file
  is a second door to the vault.
- **KDBX binaries are currently dropped** (`core-rust/src/kdbx.rs`,
  `// 3 Binary (attachments out of scope)`). Issue #77 cites KeePass explicitly,
  so round-tripping attachments through KDBX is a headline part of the feature,
  not a footnote. See [encrypted-import.md](encrypted-import.md).
- Issue #98 (local favicon upload) can reuse this store, though at under ~50 KB
  an icon is small enough to live in entry plaintext and probably should.

## Deferred / known limitations

- **Revocation is unchanged and now matters more.** A revoked device keeps its
  blobs offline exactly as it keeps the VEK. Revoke still means "stops future
  sync", not "wipes that device", and the data at stake is now passport scans
  rather than passwords alone. VEK rotation remains the real fix.
- **Sizes and file counts are visible to group members.** Not to the relay, and
  not to TURN, which blobs never reach at all. See "What each layer actually
  defends".
- **Files are less reachable than entries, permanently.** The no-TURN rule means
  a vault can be fully synced while a file in it cannot transfer. See "What the
  rule costs". This is the single biggest behavioural difference between files
  and everything else in the vault, and the one most likely to be reported as a
  bug.
- **A suspended mobile app cannot serve blobs.** "The phone is the only replica"
  is a bad state, and the replication count above is what should push users out
  of it.
- **No dedup.** Deliberate, see "Why the hash is over ciphertext".
- **No field-level or partial-file merge.** A file is replaced wholesale. Two
  devices editing the same file concurrently resolve by the same entry-level LWW
  as everything else, and the loser's blob is dropped by GC.

## Phasing

1. `FileRecord`, manifest merge, `BlobStore` adapters, chunked AEAD in core-rust
   (`seal_file_chunk` / `open_file_chunk`, exported to both wasm and uniffi so it
   works under iOS Lockdown Mode). Local only, no sync, behind a flag in
   `flags.json`.
2. `stunOnly()` plus the second, TURN-free `RTCPeerConnection` and its Noise
   session. Land this **before** any blob ever moves, so no release exists in
   which a file could take the TURN path.
3. `BLOB_HAVE` / `WANT` / `DATA` over that session, plus the replication-count UI
   and the "needs a direct connection" state.
4. GC with the grace period, and per-device sync policy.
5. BRB1 archive: export, backup, and KDBX binaries.
6. Bucket mailbox for async replication, which is the real answer for the pairs
   that can never establish a direct path.

Three things to pressure-test before committing to the design: the GC grace
period (get it wrong and files vanish), the `stunOnly` filter against what the
minting endpoint actually returns (assert on a real `/ice-servers` response in a
test, since a mixed `urls` array is the trap), and how often real device pairs
fail to find a direct path, because that number decides whether step 6 is a
nicety or the main event.
