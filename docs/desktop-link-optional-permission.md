# Desktop link: making `nativeMessaging` optional

Plan for moving `nativeMessaging` out of the Chromium extension's required `permissions` and into
`optional_permissions`, asked for at the moment the user chooses to connect the desktop app rather
than at install. The goal is one fewer line in the install prompt, and the one being removed is
"Communicate with cooperating native applications", which reads badly on a password manager.

Read [desktop-port.md](desktop-port.md) first. This document only describes the deltas, plus the
browser behaviour a spike measured on **2026-08-28** against **Brave 151.1.93.138** by hand and
**Google Chrome for Testing 151.0.7922.34** under Playwright. Every claim in
[What the spike measured](#what-the-spike-measured) is observed, not inferred.

Finding 1 is the load-bearing one and is captured as a repeatable manual probe:
`e2e/extension/desktop-link-binding-refresh.spec.ts`, which needs `MANUAL_GRANT=1 HEADED=1` and a
human to click Allow. It is not automated and cannot be (finding 8). The shipped ungranted state is
covered by `e2e/extension/desktop-link-permission.spec.ts`, which is fully automated and runs
anywhere.

## Bottom line

- **It is allowed.** Chrome's non-optional list is `debugger`, `declarativeNetRequest`, `devtools`,
  `geolocation`, `mdns`, `proxy`, `tts`, `ttsEngine`, `wallpaper`. `nativeMessaging` is not on it.
- **Existing paired users keep working.** Chromium's `extensions/docs/permissions.md`: "Granted
  permissions are the permissions that the extension has ever been granted by the user (and have not
  been revoked by the user)." A required-to-optional move keeps the grant and does not disable the
  extension. The plan detects the ungranted case anyway rather than relying on this.
- **The desktop app needs no change.** `packages/platform-desktop/src-tauri/src/manifest.rs` keys the
  host manifest on the extension id, which is fixed by the `key` in the Chromium manifest and is
  unaffected.
- **This is not a manifest edit.** A granted permission never reaches a context that already exists,
  including the service worker that owns the native port. Pairing has to move to a context created
  after the grant. That is the whole cost of the change, and it is most of the work below.
- **Firefox is untouched.** Its manifest declares `nativeMessaging` in neither array, so the adapter
  gate stays closed and the Settings section stays hidden, exactly as today.

## What the spike measured

A throwaway MV3 extension with `optional_permissions: ["nativeMessaging"]`, a probe page rendered as
both the action popup and a detached window, and a service worker that stamps a fresh instance id at
every start so a restart is visible. Every context reported to a local collector over `sendBeacon`,
so a page torn down mid-call still gets its last event out. `connectNative` was pointed at a host
name with no manifest on disk, which makes the two failure modes distinguishable: "Specified native
messaging host not found" means the permission check passed and only the host is missing, while a
forbidden error would mean it did not.

**1. No context that already exists ever gains the binding.** After the grant, `permissions.contains`
returns `true` while `typeof chrome.runtime.connectNative` stays `"undefined"`, in the service worker
*and* in the page that called `request()` itself. Binding state is fixed when a context is created.
Reproduced identically on Brave and on Chrome for Testing, so this is upstream Chromium behaviour
rather than a vendor quirk, which is what makes it safe to design against.

```
Brave 151, by hand
sw   instance onq58thf  workerAgeMs 38299  contains true  bindingType "undefined"
page detached-window    after-grant        contains true  bindingType "undefined"

Chrome for Testing 151, under Playwright
worker (pre-existing)  contains true  binding "undefined"
page that requested                   binding "undefined"
page created after                    binding "function"
```

**2. A worker that restarts after the grant works completely.** Dropping the keepalive port and
leaving the worker idle for 45s produced a new instance with the binding present and the permission
check passing.

```
sw instance gwn71izk  workerAgeMs 3  contains true  bindingType "function"
native: { attempted: true, disconnectReason: "Specified native messaging host not found." }
```

**3. The action popup is destroyed by the permission dialog.** `request:resolved` never fired and
`request:still-pending-after-1s` never fired, yet `permissions.onAdded` did. The grant lands; the
promise dies with the page; the flow that was waiting on it is simply gone.

**4. A detached window survives it.** `request:still-pending-after-1s` fired 1008ms after the call,
and `resolved granted:true` came back after a genuine 5.2s human click on Allow.

**5. `permissions.remove()` shows no dialog and does not destroy the page.** It resolved `true`
in place, and `permissions.onRemoved` fired in the worker. Revoking on unlink is safe.

**6. Re-granting after a remove is silent within the same browser session.** A second `request()`
resolved `granted: true` in 4ms with no prompt. Unlinking and re-pairing later in the same session
will not ask twice.

**7. Binding presence is never a valid permission test.** It is stale in both directions: absent
after a grant, and still `"function"` in a page after a revoke that already flipped `contains` to
`false`. Only `permissions.contains()` is authoritative.

**8. The grant cannot be automated at all, in either mode.** Headless has no way to draw the prompt,
so `permissions.request()` hangs and never settles: not a rejection, no timeout, nothing to catch.
Headed shows a real dialog that a human has to click, and Playwright cannot reach native browser UI.
So every measurement here that crosses a grant was hand-driven, and nothing about this permission
can be a CI gate.

This was briefly and wrongly recorded the other way. Two headed Playwright runs resolved in about
four seconds and were read as the browser auto-accepting under automation; the operator had in fact
clicked Allow both times, including on the run staged specifically to test for auto-accept. Fast
resolution is not evidence of automation. If anyone is tempted to re-derive this, the honest check
is to walk away from the machine.

The same limit means **finding 4 rests on one hand-driven run**. Confirming "the pop-out survives the
dialog and the action popup does not" requires a person watching a real prompt, so it has no
automated backstop and must be re-checked by hand if it is ever doubted.

## Why the obvious plan fails

The natural design is to request the permission in Settings and have the background pick it up from
`chrome.permissions.onAdded`. Finding 1 kills it: that handler runs in the worker that already
exists, so `NativeSession`'s constructor
(`packages/platform-extension/src/background/desktop-link.ts:66`) calls a `connectNative` that is
`undefined` and throws a `TypeError` straight into `openDesktopLink`'s catch. A silently dead link,
with the permission granted and nothing saying why.

Waiting for the worker to recycle does not rescue it either. Every open view holds a runtime port for
its lifetime (`packages/platform-extension/src/view-port.ts`), which is what "Immediate" auto-lock is
built on, and that port keeps the worker alive. Its own comment acknowledges recycles happen under a
still-open view, but not on a timescale an interactive pairing flow can wait for. The pairing window
being open is precisely what stops the worker restarting.

`chrome.runtime.reload()` would force the restart, and is rejected: it clears `storage.session`, so
it relocks the vault in the middle of a flow the user deliberately started.

## The design that works

**Grant in a pop-out, pair in a reloaded context, let the background catch up.**

1. Connect is clicked in Settings. Settings renders only in `popup.html`, so this is either the
   action popup or the detached pop-out (`options.html` mounts `OptionsApp`, the setup flow).
2. In the action popup, pop out first. `background/popout.ts` already carries route and draft through
   `POPOUT_HANDOFF_KEY`, and `armViewGrace()` already covers the lock gap in the handoff, so the
   typed code survives the move.
3. In the pop-out, call `permissions.request()`. Finding 4 says the window survives the dialog and
   the promise resolves.
4. Reload the pop-out. Finding 1 says this is the only way to get a context with the binding.
5. Lend that context's native pipe to the background, which runs the handshake over it.
6. The background picks up native messaging on its next natural restart. `background.ts:51` already
   calls `openDesktopLink()` at every start, so the steady state self-heals with no new signalling.

Step 5 is the only architectural move, and the smallest one that works. The obvious reading of
finding 1 is "pairing must move to the page", which would mean a second copy of the Noise handshake
living next to the first and drifting from it. It does not have to. Only the TRANSPORT is
permission-gated, so the page opens the native port and relays opaque frames over a runtime port
while the key generation, the state machine and the write to `storage.local` all stay in the
background exactly as they are. `LinkTransport` is the seam: `NativeSession` for a worker that can
open its own pipe, `ProxiedSession` for one borrowing a page's.

The page is a dumb pipe and never inspects a frame, so nothing confined to the offscreen document
leaves it and no key material passes anywhere new.

Two consequences worth stating. The proxy port is guarded by `isExtensionSender`, because a port is
another way in and a page-origin sender must no more be able to drive native messaging than it can
drive `CRYPTO_*` (see `docs/sec-audit-7726.md` A3). And the background acknowledges the port before
the page asks to pair, because a pair request that overtakes its own transport finds none
registered, which is a race that only appears on a cold worker.

Everything after pairing stays where it is. Delegation, sync frames and `reportActiveTab` are all
background-owned and none of them is on a path where a sub-minute delay is visible.

## Execution plan

**Phase 1: manifest and gate.** Move `"nativeMessaging"` from `permissions` to
`"optional_permissions"` in `packages/manifests/chromium/manifest.json`. Change `canNativeMessage()`
in `packages/platform-extension/src/desktop-link.ts:30` to read both arrays, so Firefox stays gated
off and the "turns itself on the day Firefox lands" property survives.

**Phase 2: adapter surface.** Add to `DesktopLinkAdapter` in
`packages/core/src/adapters/desktop-link.ts`:

```ts
permission?: {
	granted(): Promise<boolean>;
	request(): Promise<boolean>;
	drop(): Promise<void>;
};
```

Optional, so a host that grants at install omits it and the UI reads absent as always-granted.
Implement it in the page against `api.permissions`, never dispatched to the background.

**Phase 3: lend the transport (done).** `LinkTransport` in
`packages/platform-extension/src/background/desktop-link.ts` splits the pipe from the handshake, and
`ProxiedSession` implements it over a runtime port from the page. `openNativeProxy()` in
`packages/platform-extension/src/desktop-link.ts` is the page half: native port in, runtime port
out, no frame ever read. `pairWithDesktop` picks the lent transport when one is registered and a
direct `NativeSession` otherwise, so a worker that restarted after the grant needs no page at all.
One state machine, one wire format, nothing to keep in sync.

**Phase 4: background hardening.** One `hasNativeMessaging()` in
`packages/platform-extension/src/background/desktop-link.ts` reading `permissions.contains`, gating
`openDesktopLink()` and `ensureHeld()` so an ungranted browser arms nothing, in the same shape as the
existing unpaired short-circuit. Register `permissions.onRemoved` to `closeDesktopLink()`. Add
`permitted: boolean` to `desktopLinkStatus()` so the UI can tell "paired but revoked in
chrome://extensions" from "not paired". Do not add an `onAdded` handler that tries to connect: per
finding 1 it cannot work, and having one would be a trap for the next reader.

**Phase 5: UI.** `DesktopLinkSection.tsx` keeps its current visibility (the adapter is already
present for every Chromium user, so no section appears or disappears). Connect gains the
grant-then-pop-out-then-reload path. Add the revoked-while-paired row with a Reconnect action, and
call `permission.drop()` from unlink.

**Phase 6: tests, i18n, docs.**

- `packages/platform-extension/src/desktop-link.test.ts`: gate cases for `optional_permissions`, and
  a case asserting the gate does not consult binding presence.
- `packages/platform-extension/src/background/desktop-link.test.ts`: the mock needs `api.permissions`.
  Add "arms nothing without the grant", mirroring the existing "a browser with no desktop app" case.
- `DesktopLinkSection.test.tsx`: ungranted, denied, and revoked-while-paired.
- New strings mean `pnpm i18n:extract`; the catalogs fall back to English silently otherwise.
- Update the Firefox and "link's lifetime" sections of `desktop-port.md`, both of which assert the
  manifest gate, and the header comment in `manifest.rs`.

## Risks

- **Two browsers, one Chromium version.** Brave 151 and Chrome for Testing 151 agree, and they share
  the upstream bindings layer, so the finding is about Chromium rather than a vendor. What is not
  covered is version drift: nothing here says Chromium 160 behaves the same. The binding-refresh
  probe is the cheap way to re-answer that, and if it ever stops holding the correct response is to
  DELETE the page-side pairing path, not to repair the probe.
- **Nothing that crosses a grant has an automated backstop.** Finding 8 means every one of those
  measurements needs a person, so version drift will not announce itself: CI will stay green through
  a Chromium release that invalidates the design. Re-run the probe by hand when bumping the
  `minimum_chrome_version` floor, and treat that as the trigger rather than waiting for a failure.
- **Findings 3 to 6 are hand-driven and single-run.** One Brave session, no reproduction. They are
  UX-shaped rather than load-bearing, so the cost of one being wrong is a clumsy flow rather than a
  broken link.
- **Pairing now depends on a window staying open.** Lending the transport means the pairing window
  closing mid-handshake kills it. That is handled (the port's disconnect fails the pending request
  with a named error rather than leaving it pending forever), but it is a failure mode the old
  background-only path did not have.
- **The install prompt does not become clean.** `<all_urls>`, `webAuthenticationProxy` and `identity`
  remain. This removes one line, not the warning screen.
