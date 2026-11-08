# Desktop link onboarding: one vault, one check

Design for making it easier to link the desktop app and the browser extension. It has three
pieces: piece 1 (setup and one vault), piece 2 (one check instead of two: emoji only, no
code) and piece 3 (one browser vault, one desktop vault).

**Status (2026-11-04):** built on a worktree off main (`eaa0df5a`), not merged. Run end to end on
macOS with the dev desktop app and the extension in Chromium: first-run link, linking from
Settings into an empty vault and with Combine (a file included), approving then leaving, the app
locking mid-link, and main's extension pairing by code. Four of these flows are now an opt-in suite,
`pnpm test:e2e:desktop-link` (e2e/README.md). Not run: Firefox, Windows, Linux, and this extension
against an older desktop app.

Read [desktop-port.md](desktop-port.md) first for how the link works, and
[p2p-sync.md](p2p-sync.md) "Pairing code" for what the vault copy hands over.

## Why

People struggle with linking, and the user agrees. Today it goes like this:

1. Install the desktop app.
2. Install the extension.
3. Create a vault in the extension, even if all your entries already live in the desktop app.
4. Open the link screen on both sides (desktop: Settings > Connect a browser; extension:
   Settings > Desktop app).
5. Copy an 8-character code from the desktop into the extension.
6. Compare emoji on both screens and approve on the desktop.
7. A second vault called "Desktop vault" appears in the extension, holding the desktop's entries.

Most of the pain comes from two things (the user's words): **the double vault** (steps 3 and 7)
and **the double verification** (the code in step 5, then the emoji in step 6).

## Goals

- A new user who already has the desktop app ends up with exactly one vault in the extension.
  They never have to create one they don't need.
- Someone with vaults on both sides chooses whether to combine them or keep both, and the
  choice says plainly what will happen.
- Linking needs one check, not two (piece 2).

## Non-goals

- Changing what the link does once it is up (filling, sync, files).
- Moving phones or other devices from one vault to another.
- Delegated unlock (see desktop-port.md "Deferred: extension unlock delegation").
- Merging entries field by field. The import dedup stays as decided: no "update password" flow.
- Sending a vault from the browser to the desktop. **Decided by the user:** a vault only ever
  travels from the desktop to the browser.

## Anti-goals

These count as failures even if the feature otherwise works:

- Any path that drops entries or files without saying so.
- Anything that weakens what stands between a local attacker and the vault key (VEK).
- Anything between the desktop and this browser crossing the internet. **Decided by the user:**
  the link is all local.
- Leaving someone on an empty or locked vault picker after linking fails. Firefox already has
  this gap: `startJoin` switches to the new vault record, and a failed join leaves the user
  there. This work must not add another, and should close that one on the setup-screen path.

## Constraints from the code

- **The extension can't tell whether the desktop app is installed** until the user grants the
  `nativeMessaging` permission, which is optional and requested on use
  ([desktop-link-optional-permission.md](desktop-link-optional-permission.md)). So anything shown
  before that has to ask, not assume.
- **Granting the permission reloads the page.** Chromium binds a context's APIs when the context
  is created, so `requestPermission` in `DesktopLinkSection.tsx` reloads. A setup-screen flow has
  to come back to the link step after the reload, not to the Create tab.
- **Pairing and the vault copy can't run in the toolbar popup.** The popup closes when the user
  switches to the desktop app (9cea6430). The extension's first-run setup is the options tab,
  which is fine. Any other entry point must keep the existing "Continue in a window" rule.
- **The desktop and the extension share the setup screen.** Both render `SetupShell` in
  `packages/core/src/app/OptionsApp.tsx`, then `VaultSetup`. A banner there is one component,
  gated per platform: the extension has a `desktopLink` adapter, and the desktop has a `pairing`
  adapter.
- **The vault only travels from the desktop to the browser, and that stays.** The desktop arms a sync
  invite when it shows the code (`BrowserPairingSection.tsx`). The extension claims it over the
  link after pairing (`DesktopLinkSection.tsx`), then joins over the internet relay
  (`startEnrollInvite` listens there). That has to change; see "All local" below. The desktop's
  `approve` callback in `clients/desktop/src/sync/transport.ts` waits for the emoji approval.
- **The existing "Also copy this vault's entries" option drops files.** `acceptInvite` in
  `DesktopLinkSection.tsx` calls `importEntries(carry)` without attachments.
- **A vault's name follows it to every device in its group** (c4079187). So when a vault arrives
  in the browser it already has its real name, and renaming it anywhere renames it everywhere.
- **The "this browser has no vaults yet" wording already exists** (`outcome === "first"` in
  `DesktopLinkSection.tsx`). Nobody sees it today, because Settings needs a vault.
- **Import dedup has two tiers** (`splitAlreadyImported` in
  `packages/core/src/vault/entry-identity.ts`). Exact copies are dropped. A login with the same
  site, username and password is held back with an "Import them anyway" option.

## Piece 1: setup and one vault

### The banner

**Decided by the user:** a highlighted card above the tabs on today's setup screen, rather than
replacing the tabs or nesting the option inside "Join a device".

- In the extension: "Using Bramble desktop? Link it instead of making a new vault", with a
  **Link** button.
- Shown on first run and on "Add a vault". Settings > Desktop app stays as a third entry point.
- Shown wherever the platform can link: Chromium and Firefox. Hidden on mobile.
- Pressing **Link** runs the link flow from piece 2: permission, compare the emoji, master
  password, vault copy. It reuses the "first" wording.
- The desktop's setup screen gets no banner. The vault never travels toward the desktop, so a
  desktop always needs a vault of its own before it can link, and its Connect a browser dialog
  only opens from an unlocked vault.

### What linking does, case by case

After the link is up, both sides work out what each one holds, then:

| This browser | The desktop | What happens |
|---|---|---|
| No vault, or an empty one | Anything, empty or not | The browser takes the desktop's vault. An empty browser vault is removed. No question asked. |
| Not empty | Empty | Combine into the desktop's vault, without asking: the desktop has nothing to lose, and keeping them separate would only add an empty vault. Same rules and notes as **Combine into one** below. |
| Not empty | Not empty | Ask: **Combine into one** or **Keep them separate**. Neither is preselected. |
| Already shares the desktop's vault | | Switch to it. This exists today (`outcome === "switch"`). |

**Decided by the user:** case 3 asks, and offers today's behavior as one of the two answers.

"No question asked" means no combine question. The receiving side still enters the master
password of the vault it receives, as it does today.

**My call, which vault counts:** each side's open, unlocked vault. On the desktop that is the
vault the invite is pinned to (it runs one vault at a time). In the extension it is the vault on
screen; Settings > Desktop app only shows while that vault is unlocked. Combine copies from that
vault only. Other browser vaults are left alone.

**My call, "Add a vault" is explicit:** a user who presses the banner there asked for another
vault, so the desktop's vault arrives alongside the others (today's "add" outcome). The table
applies to first run and to Settings > Desktop app.

**My call, the definition of empty:** nothing on it that anyone could miss:

- no entries, counting trash and quarantined entries (quarantined entries are kept forever);
- no files;
- no other device in its sync roster;
- no synced settings the user set, such as an email alias provider and its API key.

Unlock methods and recovery codes don't count, because on an empty vault they protect nothing.
A vault with zero entries but a phone in its roster is not empty, so it lands in the "not empty"
rows. Removing a vault that fails any of these tests would lose data, so test the check hard.

**My call, what the desktop discloses:** the request that asks the desktop what it holds returns
only the vault's name, whether it is empty, an entry count for the case 3 screen, and whether this
app has a backup target for the vault, which no other device can see. It is answered only while the desktop is unlocked, and only to the browser that paired in the Connect
dialog that is open right now. That is the same binding as fix 1 in
piece 2, so a stolen link key learns nothing at any other time.

### Combine into one

Used for case 3 when the user picks it, and for case 2 without asking. All the calls below are
mine unless marked otherwise.

- **The desktop's vault is the one that stays.**
- **The browser's entries and files are copied into it** through `importEntries` with their
  attachments, using the normal two-tier dedup. Unlike today's checkbox, files must come along. The copy
  is read from the disk, not from the window's memory: a save in another window never reaches this one.
- **A copy of an entry the desktop's vault holds is folded into that entry,** by the same write. Its
  tags are added, its old passwords joined (newest five), and an entry archived on one side only comes
  back, since hiding a login in use is worse than showing an archived one. The change syncs as an edit
  and leaves `updatedAt` alone. Dates and breach results stay as the desktop has them. Without this,
  the browser's tags would stay behind in the old vault (the user's decision, 2026-11-06: fold them).
- **Its email alias provider and backup targets come across, each only if the desktop's vault has
  none of its own** (the user's decision, 2026-11-06). The provider is a synced setting: it is read
  before the switch and written after, so it reaches every device in the desktop's group, key
  included. Backup targets belong to this browser and never sync: their credentials are opened under
  the old key before the switch and sealed under the new one after, with no backup history and no
  inherited folder, so their snapshots carry the new vault's stamp and pruning can't reach the old
  ones'. Whether the desktop has a target comes from the app, and an app that won't say counts as
  having none, since losing the browser's is worse than a second destination. A target that won't
  open isn't carried, and the dialog says how many: one from the old device-global list can be sealed
  under a sibling vault's key and still work there. Any stored alias value counts, shaped like a
  provider this build knows or not: extension and app version independently, so a newer one's is
  neither overwritten nor lost.
- **Once the copy is done, the old vault goes off the list, and nothing is asked** (the user's
  decision, 2026-11-07, replacing a delete-or-keep question, which replaced a checkbox and a "(before
  linking)" label). Combine gives a merge; Keep them separate is the way to keep the old vault. Nothing
  deletes it: it stays on disk, and its key is dropped from memory. Its registry record keeps the hash
  of its bytes at the copy and which vault holds the copy, for a later "Purge archived vaults" to check
  (not built). It is listed again if the vault holding its copy is deleted, or if no other vault is
  left, so it can't be stranded.
- **A dialog only when there is something to say:** look-alikes the dedup held back, named, with "Copy
  them anyway"; versions of an entry in a sync conflict other than the one shown; an alias provider or
  backup targets that gave way to the desktop's own; targets that wouldn't open. Left alone, these stay
  in the hidden vault. With nothing to say there is no dialog.
- **It stays listed where hiding it could lose something by accident** (the user's rule, 2026-11-06:
  a failed copy, damaged entries, an unfinished link): files that did not copy, entries it could not
  decrypt, tags past the 32 an entry can carry, an alias provider or backup target that failed to
  store, a save into it during the copy, or a pairing that did not finish. The dialog says why.
- **The screen says up front that this browser will now unlock with the desktop's master
  password.**
- **If the old vault also syncs with other devices,** one warning line names them and says only
  this browser moves. They stay on the old vault.
- **Failure is loud, not silent.** The order stays safe, as it is today: the desktop's vault
  arrives first, then the copy runs, and the originals stay untouched in the old vault. If any
  entry or file fails to copy, say how many, and the old vault stays listed. Never report success
  after a partial copy. A dialog that can't be dismissed shows while the copy runs, so the result
  isn't lost by leaving the screen. Not built: a retry after a failed copy.
- **Memory:** today the entries are held decrypted across the vault switch, because the two
  vaults have different keys and only one is loaded at a time. Files make that bigger. How to
  carry large files without holding them all in memory is for the builder to decide.

### Keep them separate

Today's behavior, except the vault arrives under its own name instead of "Desktop vault".

### All local

**Decided by the user:** nothing between the desktop and this browser travels over the internet.

- **The vault copy runs over the link.** For an invite the desktop armed for the link, the
  enrollment rides the native-messaging pipe, the way ongoing sync already can (`linkPeerSource`
  in `clients/desktop/src/sync/link-peers.ts`). The desktop never opens a relay room for that
  invite, and accepts the enrollment only on the link connection that claimed it.
- **The desktop and this browser sync with each other only over the link.** Confirmed by the
  user: on the same machine there is no reason to involve the network. The browser still reaches
  phones and other computers through the relay as it does today, but the desktop-to-browser
  session never falls back to the relay, and the two never pair with each other there.
- **Files too.** Attachments between the desktop and this browser go only over the link. Today
  the file session (`blob-sync.ts`) runs the link and the relay mesh side by side, so the two can
  also reach each other over WebRTC (direct, or through TURN). The relay path must skip the linked
  desktop, the same way entry sync must. Files to and from phones keep using the relay mesh.
- **No network needed.** Linking, the vault copy and the first file transfer work with the machine
  offline.
- **It costs nothing in piece 2.** This is fix 2 from the review below, so it is now built in
  piece 1 whatever piece 2 decides.

### Left to the builder

- How each side learns what the other holds. This is probably a new link request behind a `caps`
  entry, so older peers see nothing new (see the `Caps` request in `socket.rs`). It sits behind
  the existing lock gate in `answer_for`, plus the dialog binding above.
- Copy, layout and states. The brainstorm mockups weren't committed; the wording above is a
  starting point.
- i18n: new strings go through `i18n:extract`, `i18n:translate` and `i18n:compile`.
- Tests, including e2e for each case in the table.

## Piece 2: one check instead of two

**Status:** decided 2026-11-04, after a security review and an adversarial test of the link.

### Decision: emoji only, no code

**Decided by the user:** linking uses one check, the emoji comparison, and the typed code goes.
The user had hoped the desktop link would feel distinct from ordinary device pairing; they accepted
the shared ceremony because everything travels over the local link, which keeps the flow simple.

The flow:

1. Desktop: Settings > Connect a browser. A password vault re-enters its master password first,
   as today, because that signs the browser into the roster.
2. Extension: **Link** (setup banner or Settings > Desktop app), then the browser permission if
   it isn't granted yet.
3. Both screens show the same emoji. The user confirms the match on BOTH screens: **They match**
   in the extension, **Approve** on the desktop.
4. Extension: enter the master password the vault uses (to wrap the browser's own copy).
5. The vault arrives over the link, with no second check, then piece 1's rules apply.

What it has to guarantee:

- **No code, nothing to crack.** The link handshake drops the PSK (`Noise_XXpsk3` becomes plain
  `Noise_XX`). That removes the offline brute force (pairing-hardening.md item 4) instead of
  patching it.
- **Nothing to steer, either.** After the handshake the browser commits to a random nonce (sends
  its SHA-256), the app answers with its own nonce, and the browser reveals its nonce, which the app
  checks against the commitment. The emoji come from SHA-256 over the handshake hash and both nonces
  (`link-sas.ts`, `sas_material` in `socket.rs`). Neither side picks its nonce after seeing the
  other's, so a relay in the middle cannot search for inputs that make both screens agree. Each
  handshake message has a deadline, so a stalled or stalling peer cannot hold the window open.
- **The extension trusts the desktop only after the user confirms on the extension.** A fake
  desktop can claim approval itself, so the desktop's word is not enough. The extension writes the
  app's key (`desktopLink.appPublicKey`) only after **They match** on its own screen. This closes
  pairing-hardening.md item 2 for this flow.
- **The desktop shows emoji only inside an open Connect dialog.** Requests that arrive with no
  dialog open are refused, so nothing can make the desktop show prompts nobody asked for.
- **The invite goes only to the browser that just paired** in that dialog (review path 1).
- **The vault copy runs over the link only** (piece 1 "All local", review path 2).
- **Skipping the second check applies only to link invites.** The decision comes from the
  desktop's own state, never from anything the joiner sends. Phone and QR joins keep their own
  emoji check, and link invites are never shown as text or QR.
- **A new extension still links with an older app**, through the code plus emoji, the only way
  that app knows. The reverse is gone: this app offers no code, so an extension from before the
  emoji cannot link to it (decided 2026-11-04, after testing). A relay invite can never be talked
  into skipping approval.

**My call, keeping it feeling distinct:** the link screens use their own words. They never say
"pairing code", "join a device" or "your other device". They say "your desktop app" and name it,
and the emoji prompt reads as linking this browser to the app, not adding a device. The ceremony
is shared; the language isn't.

**The polling path changes.** An already-linked browser picking up the vault later can't skip the
check, because its link wasn't confirmed in this dialog. It relinks with the emoji instead, which
is the same one step.

### One browser, one desktop

**Decided by the user:** the link is strictly "this browser and the desktop" everywhere, not only
for the invite. Two places treat every linked browser as one today, and both get fixed here:

- **Fills go only to the browser being filled.** `socket.rs` sends a panel fill to every live
  outbox (`boxes.values()`), so the plaintext credential reaches every connected browser, and a
  connection using a stolen key receives it too. Send it only to the link that
  reported the page the panel is filling, and if no link reported one, send nothing.
- **The page each browser reports belongs to that browser.** `ActiveTab` is stored once for the
  whole process, and the last writer wins, so any linked browser can overwrite it. An empty value
  also switches off the panel's hostname check. Keep the reported page per link,
  and judge a fill against the page reported by the browser it is going to. An empty report
  only clears that browser's own entry.
- **A browser is linked to a vault, not to the app.** Found in testing (2026-11-04): the desktop
  kept one list of linked browsers for the whole app, so a new vault showed browsers linked
  long before it existed, and a browser linked while one vault was open could fill from any
  other. `pairing.json` now keeps a list per vault, and a browser is served only while a vault
  it is linked to is open: checked when it connects, on every frame it sends and before
  anything is pushed to it, and opening another vault closes its connection. The app-wide list
  an earlier build kept stays as it was; a vault with no list of its own takes the links made
  since it existed, so nothing that worked stops.

**Out of scope here:** other link hardening is tracked separately.

### Background: the question

Linking checks twice. The 8-character code secures the browser-to-app link (`Noise_XXpsk3`,
`pairing.rs`). Then the vault copy, which is an ordinary sync invite, runs its own emoji
comparison. The proposal was to skip the emoji comparison, and the desktop's Approve click, when
the invite arrived over the link.

### Background: review (2026-11-03, code reading only)

**Verdict: not safe as a drop-in change.** The emoji check is the only human gate before the VEK
leaves the desktop. The joiner's master-password check runs after the bundle (VEK, entries,
recovery slots) has already arrived (p2p-sync.md, "What actually authorises a join"). Remove the
check and whoever holds the invite gets the whole vault, for good. Three paths let the wrong
holder get it:

1. **Any linked browser can claim the invite, not only the one that typed the code. This exists
   today.** `Request::SyncInvite` calls `claim_invite()` in `socket.rs` for any KK-authenticated
   peer. That includes a second browser profile linked earlier, or anyone with a stolen extension
   link key (a bearer credential at rest, per desktop-port.md). Today the desktop shows emoji
   while the real extension shows nothing to compare against. With no emoji, this is silent, and
   it turns "one credential at a time while unlocked" into what desktop-port.md's "Do not ship
   the VEK" section forbids.
   **Fix:** bind the armed invite to the static key that completed `XXpsk3` with this dialog's
   code. Side effect: the polling path that lets an already-linked browser pick up the vault later
   needs a fresh code or keeps the emoji.
2. **The vault copy runs over the internet relay, not the link.** `startEnrollInvite` listens on
   the relay. Without the emoji, the invite's PSK is the only gate, and it works from any machine.
   Every place the invite string passes inside the extension becomes a place the vault can leak.
   **Fix:** for link-delivered invites, run the enrollment over the link (the local peer source
   already exists for ongoing sync). Accept it only on the connection that claimed the invite,
   and never open a relay room for it. **Now required by piece 1** ("All local").
3. **A stand-in for the desktop can recover the 8-character code offline. This exists today.**
   The code is about 39 bits, used as a PSK (`psk_for` in `pairing.rs`). The extension is the
   initiator, and its third handshake message is authenticated with the PSK. A same-user process
   can rewrite the browser's native-messaging host manifest (on macOS this needs no permission
   prompt), receive that message, and test all 30^8 codes offline. Rough, unmeasured estimate: a
   few minutes per high-end GPU, close to the 3-minute TTL with several. It then pairs with the
   real desktop on the first attempt, and fix 1 doesn't stop it. Today the emoji prompt appears
   while the extension says "code not accepted". Without the emoji, nothing appears.
   **Fix:** a PAKE (CPace or SPAKE2) so every guess costs an online attempt, or an explicit
   decision to accept the risk.

**Lower risk:**

- The decision to skip approval must come only from the desktop's own state (which invite it
  armed for the link). It must never come from anything the joiner sends, and link invites must
  never be shown as text or QR.
- Version skew must not let an ordinary relay invite skip approval.
- A process that can read the screen can race the user with the code. On Windows and X11 the
  same attacker can usually log keystrokes already, so little extra is lost there. On macOS and
  Wayland it's a real but narrow gap.

**Removing the emoji is reasonable only with fixes 1 and 2, plus either fix 3 or an explicit
decision to accept that risk.**

**Alternative: keep the emoji and drop the code.** The link itself would use emoji comparison
with no typing, and the vault copy would ride that verified link with no second check.
`pairing.rs` rejected a plain "Allow" click because a fake request looks identical to the real
one. Emoji prompts don't look identical: a fake connection shows different symbols. This also
removes finding 3, since no low-entropy code is left to guess. The cost is that comparing is
weaker than typing for users who don't really look.

## Piece 3: one browser vault, one desktop vault

**Status (2026-11-05):** built and run end to end on macOS in Chromium (`pnpm
test:e2e:desktop-link`, "a link per vault"); not run on Firefox, Windows or Linux, or against an
upgraded install's single link. Before it, the desktop's half of "A browser is linked to a vault"
above was done and the extension's was not. A browser profile holds one link (`desktopLink` in `storage.local`),
whichever vault it was made from. So with one browser profile holding ext-a and ext-b, and one
desktop app holding desk-a and desk-b:

- Linking ext-b to desk-b mints a new key and replaces the profile's only link. ext-a's link to
  desk-a is gone, and desk-a's list keeps a key nobody holds.
- ext-b's Settings offers "Link again" whenever the desktop's open vault is not ext-b's. Pressing it
  does the same.
- Disconnecting in ext-b's Settings removes the profile's only link and hands the browser permission
  back, so ext-a loses its link too.

Two people sharing one computer account, each with their own vault, break each other's links the
same way.

### The rule

**Decided by the user:**

- A link pairs one desktop vault with the one browser vault that holds the same vault (the same
  sync group). Within a browser profile that is one-to-one: ext-a with desk-a, ext-b with desk-b.
  Across browsers it is one-to-many, as today: Chrome, Firefox and a second profile can each pair
  with desk-a.
- Nothing done from one browser vault changes another vault's link: not linking, not a link
  abandoned or refused part way, not disconnecting.
- When the vault open in the browser and the vault open in the desktop app are not a pair, there is
  no link. Nothing is shown about it, and nothing crosses: no filling from the desktop, no quick
  search (panel) fill into the browser, no sync with the desktop.
- A pairing is never half made. There is no link without the vault in the browser: no "Not now" at
  the copy step, and when the desktop cannot prepare its invite, linking tries again rather than
  linking without it.

### Constraints from the code

- **The desktop keeps one vault unlocked** (`vault_crypto`), and its open vault is meta
  `active-vault` (`pairing::open_vault_id`). Its per-vault lists and the admission gate (connect,
  every frame, every push, closing on `vault_opened`) are the enforcement point.
- **The desktop has one sync identity for every vault** (`clients/desktop/src/sync/keys.ts`: "both
  keypairs are shared by all of them"). The extension cannot tell desk-a from desk-b by it, only
  whether a browser vault's roster contains the desktop at all. Which desktop vault a link reaches
  is decided by the desktop's lists, never by the extension.
- **The extension syncs only its open vault** (`retargetSync` on every active-vault change in
  `background/session.ts`), and each of its vaults already has its own sync identity (`syncKeyFor`).
- **A browser profile cannot hold two copies of a vault.** Joining a group the browser already has
  opens that vault instead (`startJoin`'s dedup), and linking from a vault outside the desktop's
  group while another browser vault is in it already ends at "You already share this vault"
  (outcome `switch`).
- **The native-messaging permission is per browser profile**, granted once for every vault.
- **The desktop's upgrade rule can admit one key in several vaults.** A desktop vault with no list
  of its own takes the app-wide links made since it existed (`pairing::vault_peers`), so a link
  from before the per-vault lists can be on more than one vault.

### Where a link lives

Each browser vault has at most one link: its own key pair and the desktop's key, stored under that
vault's id the way its sync identity is. A link is made by the emoji check as today, then attached
to a vault only once the flow ends with that vault holding the desktop's vault:

| Outcome of linking from browser vault X | The link attaches to |
| --- | --- |
| take (X empty) | the vault the copy creates, which replaces X |
| add (setup's "add a vault") | the vault the copy creates |
| combine | the desktop's vault, now in the browser; X is hidden, and nothing deletes it |
| ask, then combine or keep separate | the vault holding the desktop's vault |
| switch (another browser vault already holds it) | that vault, replacing its previous link |

In `switch`, the vault that already pairs gets the new link: it is a re-link of the same pair, and
X stays unlinked. When X is that vault (it was disconnected, or its link didn't finish), linking
stays in it and says so.

### A pairing is all or nothing

- **The desktop's invite.** It is prepared before the link window opens. If that fails, the window
  does not open: the password dialog shows the error, and Continue tries again. Today a failed
  invite still opens the window, for a link without the copy; that goes.
- **The copy step.** It offers no "Not now". Leaving it (closing it, going back, closing the tab)
  abandons the link: nothing is attached in the browser, and the desktop forgets that browser. The
  link in progress rides a pipe the page lends, even to a background with its own, so it lives
  exactly as long as the page running the copy: when that pipe closes, the browser drops the link
  and the desktop drops the pending browser and stops waiting for it.
- **The claim.** If the browser cannot get the invite (the desktop answered without one, or the
  claim did not arrive), it says so and offers Try again, which claims again while the desktop's
  Connect window is open. Once that window has closed, linking starts over.
- **The desktop's list.** A browser joins a vault's list only when it reports its pairing complete:
  the copy finished, or it switched to the vault that already holds this one. Until then it is
  pending, served for the claim and the copy only, and forgotten when the Connect window closes
  (locking the app closes it too, and the copy needs the vault unlocked anyway), when the
  connection it was confirmed on closes, after five minutes, or when the app quits. A pending
  browser's page reports do not make it the panel's fill target.
- **Removed from the sync group.** A browser removed from a vault's roster, here or on another
  device, loses its link to that vault too, so it can't keep filling from a vault it no longer syncs
  with. The desktop learns which link is which device when a browser passes sync's check over the
  link, keeps that per vault, and acts on a tombstone for that device id: when gossip merges, when
  Settings removes a device, and when sync starts, so it also catches a browser that's offline. A
  device merely missing from the roster keeps its link, since it may be from a group this vault has
  left. A browser removed before it ever synced over the link keeps its link until it's removed here.
- **Removed on the desktop.** A browser removed from a vault's list there is refused from then on.
  The desktop says so in a way the browser can tell apart from "another vault is open", and that
  browser vault drops its link and offers Link. The refusal is sealed after the handshake, so only
  the app this browser paired with can make it drop a link, and a hello naming a key it does not
  hold learns nothing. A pairings file that fails the desktop's own seal is unsure, not proof: it
  answers "another vault is open", so no browser drops its link over it.

### What holds the pipe

The extension holds the link of its open vault, and only that. Changing the open vault drops the
held link and, if the newly open vault has a link, opens that one. Requests, panel fills and sync
ride it as today. A vault with no link holds nothing.

Locked, no vault is open, and filling while locked is the link's point (desktop-port.md). The
extension then holds the link of the vault it would unlock into, the one last opened, including
after the browser restarts.

The one exception is a link still being made. The vault copy rides it, and the copy itself changes
the open vault (to the vault it creates), so a link in progress stays held through those changes
until it attaches or is abandoned.

The desktop admits the link only while its pair is open, which it already does. Filling with the
desktop's quick search therefore reaches the browser only while both open vaults are a pair.

### Settings

The browser's "Desktop app" section describes the open vault's link. A vault with no link offers
Link, which makes a link for this vault and touches no other. The "Link again" prompt that replaced
the profile's link goes, and so does "Linked to this browser, but the app shares a different vault,
not this one".

Disconnect removes this vault's link only, or, for a vault with none of its own, the profile's
single link from an earlier build that it speaks with. The browser permission goes back only when no
vault in the profile has a link left. A link still in progress does not show as linked.

### Upgrade

- **Extension:** the profile's single link goes to the browser vault whose roster contains the
  desktop's sync identity, learned by asking the desktop once it answers. Until then it stays where
  it is and works as today. If no vault's roster contains it, the link is dropped and the user links
  again. The desktop has one sync identity for all its vaults, so when more than one browser vault's
  roster holds it, the link waits for proof: it goes to the vault open when sync over it passes the
  desktop's roster check. A sealed "not linked to this app" drops it too. It never replaces a link
  its vault already has, and a failed read of the vaults or their rosters keeps it as it is.
- **Desktop:** a link from before the per-vault lists that two or more vaults admit is pinned to the
  first vault that syncs with that browser over the link (the vault that sync was for, even if
  another has opened since); until then it is admitted as today.

### Tests

Unit tests per side, and in `pnpm test:e2e:desktop-link` (the borrowed-pipe mode included):

- ext-a with desk-a and ext-b with desk-b both work, each when its pair is open.
- Linking ext-b, a link from ext-b abandoned part way, and disconnecting ext-b all leave ext-a's
  link working.
- With ext-a open in the browser and desk-b open in the desktop app: no link, no fill, no panel
  fill, no sync frame.
- Linking from ext-b to desk-a while ext-a already pairs with it ends in ext-a, and ext-b stays
  unlinked.
- Leaving the copy step leaves nothing on either side: no link in the browser, nothing on the
  desktop's list.
- A desktop invite that fails opens no window, and Continue tries again; a failed claim offers Try
  again.
- A browser removed on the desktop drops its link.
- A browser removed from the sync group, here or on another device, drops its link.
- Two browser profiles both pair with desk-a.
- The permission is handed back only when the last link goes.
- Upgrade: a single link reaches the vault that syncs with the desktop; with none, it is dropped.

### Left to the builder

- The storage key for a vault's link, and how a link in progress waits between the emoji check and
  attaching.
- Whether a re-link of the same pair (`switch`) reuses that vault's key or mints a new one. A new
  one leaves the old entry on the desktop's list until removed there.
- The wire for "pairing complete" and for "not linked to any vault": additive, as `syncRestart` was,
  with an older app or extension behaving as today.
- How the extension asks for the desktop's sync identity during the upgrade without a lent pipe.

## Who decided what

**The user:**

- Link from the setup screen, as well as from Settings.
- The banner (option B).
- Case 3 asks, with today's behavior as one answer and neither preselected.
- A security review and an adversarial test before any change to the emoji check.
- Piece 2: emoji only, no code, everything over the local link.
- Files between the desktop and the browser go over the link only.
- One browser, one desktop: fills and the reported page are per browser.
- Linked browsers are per vault. A browser gets nothing while another vault is open, and
  existing links go to the vaults that existed when each was made.
- No code from the desktop for an extension from before the emoji, and none armed.
- No browser-to-desktop direction, ever.
- The link is all local: the vault copy and desktop-to-browser sync never use the internet.
- Piece 3: links are one-to-one between a browser vault and a desktop vault within a profile, and
  one-to-many across browsers. Nothing done in one browser vault may break another vault's link.
  Two open vaults that are not a pair have no link, nothing is shown, and quick search filling does
  not reach the browser. Linking from a vault that does not hold the desktop's vault resolves to the
  one that does, or creates it.
- Piece 3: a pairing is never missing. No "Not now" at the copy step, and an invite the desktop
  cannot prepare is retried rather than linked without.
- Piece 3 upgrade: the single link goes to the browser vault that already syncs with the desktop;
  with none, it is dropped and linked again.

**My calls (flag any you disagree with):**

- The desktop's vault is the one that stays when combining.
- The old browser vault is kept, with a local-only label, until the user deletes it.
- Other devices stay on the old vault.
- The definition of empty.
- Each side's open, unlocked vault is the one that counts.
- The banner on "Add a vault" always adds the desktop's vault alongside the others.
- What the desktop discloses about its vault, and to whom.
- Confirming the emoji on both screens, and the desktop refusing link requests with no dialog open.
- Distinct wording for the link screens.
- Case 2 combines into the desktop's empty vault without asking.
- After a combine the old vault is hidden and nothing is asked (2026-11-07). Deleting hidden vaults is
  for a later "Purge archived vaults".
- A copy of an entry the desktop's vault holds folds into it: tags, old passwords, and active wins.
- An alias provider or backup target comes across only where the desktop's vault has none. Where it
  has its own, the dialog says so.
- The old vault stays listed after a failed copy, with damaged entries, or with an unfinished link.
- Held-back duplicates are named in the dialog, with "Copy them anyway". Left out, they stay in the
  hidden vault.
- Failure is loud on a partial copy.
- Piece 3: the extension holds its open vault's link, and a link in progress stays held until it
  attaches or is abandoned.
- Piece 3: in `switch`, the vault that already pairs takes the new link.
- Piece 3: the browser permission goes back only with the last link.
- Piece 3: the desktop lists a browser only once it reports the pairing complete, so an abandoned
  link leaves nothing on either side.
- Piece 3: retrying is Continue in the desktop's password dialog, and Try again in the browser while
  the desktop's Connect window is open.
- Piece 3: a browser removed on the desktop drops its link when told, and offers Link.
- Piece 3: the desktop pins a pre-per-vault link that several vaults admit to the first vault it
  syncs with.
