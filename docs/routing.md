# Routing and navigation

The router guards, the lock-state asymmetry that avoids redirect loops, the back
button, and the pop-out window handoff. Code: `packages/core/src/app/router.tsx`
and the shell adapter `packages/core/src/adapters/shell.ts`. The vault state these
guards read is described in [auth-and-unlock.md](auth-and-unlock.md).

## Context injection and the "not ready yet" rule

Route guards read a slice of vault state (`isLocked`, `ready`, `entries`) from
router context. That context starts as `undefined`, because vault state lives in
React (`VaultProvider`) and is injected through `<RouterProvider context={{ vault }}>`
only after mount. Every guard treats a missing `vault` as "context not ready,
don't decide" and relies on a post-hydration `router.invalidate()` to re-run once
it is populated.

## The load-bearing hydration asymmetry

This is the subtle part. There are two top-level guards:

- `authRoute` (the unlock screen at `/`) redirects to `/vault` when
  `!isLocked`. It is **intentionally not gated on `ready`**.
- `appLayoutRoute` (`_app`, the parent of every authed route) redirects to `/`
  when `ready && isLocked`. It **is** gated on `ready`.

The asymmetry keeps the two guards from looping during the brief
`(isLocked = false, ready = false)` window where mount hydration flips `isLocked`
before `ready`. Do not add a `ready` gate to `authRoute` "for symmetry": it would
reintroduce the loop.

`appLayoutRoute` runs before its child guards, so an auto-lock that also empties
`entries` lands on `/` rather than letting an entry guard bounce it to `/vault`.

## Entry guards

`entryDetailRoute` and `entryEditRoute` bail to `/vault` if the entry id is stale
(deleted here or in another context). Both are gated on `ready` so a detached
window booting straight onto a deep route does not bounce before `entries` has
hydrated.

## Memory history and the back button

Each React tree gets a fresh router using **memory history**, seeded with an
`initialPath`. Memory history keeps routes out of the URL, which is why pop-out
state must be handed over explicitly rather than read from the URL.

The header "Back" button prefers `router.history.back()` (return to wherever the
user actually came from). Each route's `staticData.back` is only a **fallback**
target, used when there is no history to go back to, for example a popped-out
window that booted straight onto a deep route. `paramKeys` lists the path params
the fallback `to` needs (edit falls back to `/vault/$entryId`), resolved in
`AppLayout` from the current params, since `staticData` cannot hold runtime
values.

## Pop-out handoff

The popup dismisses on focus loss, which breaks flows like the file picker. The
"pop out" affordance opens the current UI in a detached standalone window and
closes the originating popup.

State is carried across via a `PopOutHandoff`: the current route `path` (a router
href) and an optional `draft` (the active route's serializable form snapshot). It
is transported through `chrome.storage.session`, **not** the URL, because a draft
can contain a plaintext password. The new window calls `consumeHandoff()` once
during boot to read and clear it, seeding its router's `initialPath` so it resumes
where the user left off instead of restarting at the unlock screen. Pop-out window
creation is owned by the background, so the content script's "vault locked" hint
can request the same flow.
