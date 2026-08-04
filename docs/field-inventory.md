# PR 3 plan: single-pass page-field inventory

> Contributed plan, kept verbatim. Not implemented. Retained as the spec for a
> `detection.ts` performance refactor we want to own ourselves, because the
> detector decides where an authorized secret gets written. Read alongside
> [field-detection.md](field-detection.md) and [autofill.md](autofill.md). "PR
> 2c", "PR 4" and similar references are to the contributor's original stack and
> are not commitments.

## Purpose and stack position

Make `parsePageFields()` perform one composed-DOM traversal per cache miss, then derive its login, card, and OTP results from that immutable-per-call inventory. This removes the current repeated whole-page walks while preserving detector results and priority ladders.

PR 3 is independent of the approved PR 2 mutation-controller stack. Review it as a focused `detection.ts` performance refactor, not as a continuation of observer scheduling. It may merge after PR 2c, but it must not depend on controller, mutation-classification, timer, or capability-deduplication code. The dropped PR 2d remains dropped.

## Measured problem boundary

`parsePageFields()` currently calls `detectCardFields()`, `detectLoginFields()`, and `otpInputs()` in sequence. On a fieldless page this causes repeated `deepQuery()` / `deepQueryAll()` traversals: card detection alone can walk once for each token and twice for each hint fallback, login walks several more times, and OTP walks again. `deepQueryAll()` also recursively allocates `Array.from(parent.children)` at every parent. Label fallback can issue a root-wide `querySelectorAll(label[for=...])` for each inspected input.

This PR optimizes only the `PageFieldModel` parse and the public login/card/OTP detector calls that naturally use the same machinery. It does not build a persistent DOM index and does not try to share a snapshot across mutations. `field-model.ts` remains the sole cache owner.

## Internal architecture

Add a private-to-the-content-module field inventory, either near the top of `detection.ts` or in a small `field-inventory.ts` if keeping the mechanics separate makes the review clearer. Do not export it from a package barrel or expose it to content-message code.

A minimal shape is:

```ts
interface FieldInventory {
	doc: Document;
	inputs: readonly InputEntry[];
	forms: ReadonlyMap<HTMLFormElement, InputRange>;
	labelsByRootAndFor: ReadonlyMap<Document | ShadowRoot, ReadonlyMap<string, readonly HTMLLabelElement[]>>;
	idsByRoot: ReadonlyMap<Document | ShadowRoot, ReadonlyMap<string, Element>>;
	labelText(el: HTMLInputElement): string;
}

interface InputEntry {
	el: HTMLInputElement;
	index: number;
	root: Document | ShadowRoot;
	wrappingLabel: HTMLLabelElement | null;
}

interface InputRange {
	start: number; // inclusive input index
	end: number;   // exclusive input index
}
```

Exact names are flexible. Keep only data used by the detectors. In particular, do not add a generic selector cache, mutation support, visibility state, values, arbitrary attributes, all-element array, or cross-parse/global node map.

Build the inventory with one iterative composed-preorder walk:

- visit each element once;
- preserve the existing order exactly: the element itself, then its open shadow-root descendants, then its light-DOM descendants;
- skip closed roots, as today;
- use cursor frames over live `children` collections (or an equivalent allocation-light iterator), not recursion plus `Array.from(parent.children)` at every parent;
- record inputs in visit order;
- carry the current tree root and nearest wrapping label in traversal frames;
- record a form's input-index interval on entry/exit so the first password can select all inputs in its composed subtree without rescanning the form;
- index `label[for]` values and the first ID-bearing element per tree root while visiting elements.

The form interval is important. Filtering only by each input's nearest form would subtly exclude a programmatically nested-form subtree that today's `deepQueryAll(form)` includes. An interval preserves the current scoped traversal semantics at constant cost after collection. For a password with no form, use the full input range.

The walker should use element/tag/property checks rather than repeatedly running general selectors. Preserve selector semantics deliberately:

- current detector selectors exclude inputs carrying `readonly` or `disabled` attributes; do not silently switch those checks to `readOnly` / `disabled` property semantics where they can differ;
- preserve type/no-type distinctions used by `USERNAME_TEXT_SELECTOR`;
- preserve the exact composed preorder across sibling open-shadow hosts;
- leave the public generic `deepQuery()` and `deepQueryAll()` behavior available for unrelated callers. They may share the new iterative walk if that is a small mechanical change, but their refactor is not required to claim the one-walk `parsePageFields()` result.

## Label lookup and caching

Label lookup is part of this PR, not a later generic indexing project. Without it, a parse with many fallback candidates can still perform one root-wide `label[for]` query per input and cannot honestly be described as near `O(N + I)`.

Create a per-inventory label resolver with these semantics, in the current concatenation order:

1. all same-root `<label for="input-id">` elements in root tree order;
2. the nearest wrapping label across open-shadow boundaries;
3. each whitespace-separated `aria-labelledby` target in token order, resolving in the input's root first and then in the document.

Build `label[for]` and first-ID indexes during the composed walk, partitioned by `Document | ShadowRoot`. The document ID index must contain only light-document elements; shadow-root IDs belong only to their shadow-root index. This preserves the existing root-first/document-fallback boundary and prevents one component's shadow IDs from leaking into another component's labels.

Cache the final label string per input and cache `textContent` per referenced label/ID element for the lifetime of the inventory. Compute both lazily: attribute/token winners should not pay to read label text. Cache empty strings too so an empty or missing association is not recomputed by card, login, and OTP fallbacks.

Index raw `for`/ID values rather than interpolating page-controlled IDs into selectors. This removes repeated selector parsing and avoids malformed IDs causing work or exceptions. Add an explicit compatibility test for quotes, backslashes, spaces, and other CSS-significant IDs. Treat exact raw HTML association as the intended existing semantics; document in the PR if this fixes the current `CSS.escape`-unavailable malformed-selector limitation rather than preserving that accidental failure.

Do not retain label caches beyond the parse. Mutation invalidation continues to discard the `PageFieldModel`, and the inventory becomes unreachable after detector derivation.

The inventory/index build is `O(N)` in visited elements and `O(I + L + D)` retained references for inputs, labels, and ID-bearing elements. Detector passes are a fixed number of linear scans over inputs. Reading distinct referenced elements' `textContent` is memoized; its cost is proportional to the distinct label text subtrees actually reached, rather than repeated once per detector/category. Avoid claiming a mathematical bound that excludes the browser's `textContent` subtree cost; the operational guarantee is one composed element traversal, no per-input root query, and at most one text read per referenced element.

## Detector derivation and exact precedence

Implement private helpers such as `detectLoginFromInventory`, `detectCardFromInventory`, and `otpFromInventory`. They consume one inventory and must reproduce current results; do not combine all categories into one clever state machine. A fixed handful of cheap input-array scans is easier to audit and remains near `O(N + I)` because the number of categories is constant.

### Login

Preserve the existing ladder exactly:

1. first eligible password in composed order;
2. latest eligible text-like input preceding that password inside the password's nearest form interval, rejecting negative attribute hints;
3. first explicit `username` token or exact `autocomplete="email"` match in composed order;
4. first eligible email input;
5. first text-like candidate whose attributes pass username heuristics;
6. first text-like candidate whose cached label passes username heuristics.

The scoped range must work when username and password are in separate open-shadow hosts under one light-DOM form. A password in a shadow-internal form must use only that form's composed subtree. Preserve the current behavior with multiple passwords: pairing is anchored on the first eligible password, and a prior password does not become a username candidate.

### Card

For each card slot preserve:

- `cc-*` autocomplete-token match before hints;
- across hint candidates, scan all attribute hints before scanning any labels;
- first match in composed order;
- password exclusion for number/name/expiry and allowance for CVV;
- split month/year suppressing combined expiry when either split field was found;
- the existing regexes, exclusions, and known shallow false positives.

Do not derive all slots from the first apparently card-like group or add form clustering in this performance PR. That would be a detector-policy change.

### OTP

Preserve:

- all eligible `one-time-code` token inputs, in composed order, winning immediately;
- card detection computed from the same inventory and card-field identity exclusions;
- for hint fallback, each input's attribute check followed immediately by that same input's label check (unlike card's global attribute-before-label rule);
- all existing negative/type exclusions;
- the first hinted input only;
- the current `segmentedSiblings()` behavior and order, including its light-DOM `parent.querySelectorAll("input")` semantics.

Do not broaden segmented OTP traversal across shadow roots or redefine it as literal adjacent siblings here.

### Classification

Leave `kindOf()` priority unchanged: password-typed CVV wins as card; selected login fields and otherwise-password inputs win as login; remaining detected card fields precede OTP. The `PageFieldModel` public shape does not change.

## Public and standalone callers

Keep these public signatures and return types stable:

- `detectLoginFields(doc?)`
- `detectCardFields(doc?)`
- `otpInputs(doc?, precomputedCard?)`
- `parsePageFields(doc?)`
- `candidateKind`, `isAutofillCandidate`, and `PageFieldModel`

`parsePageFields(doc)` constructs exactly one inventory and passes it to all three private derivations. Each standalone detector constructs one inventory for its own call. `otpInputs(doc, precomputedCard)` still honors the supplied card result and constructs only the input/label inventory it needs; it must not silently recompute or replace the caller's card identities.

Do not make external callers construct or pass inventories. Do not overload the public APIs with an optional snapshot argument that could be stale or belong to another document.

`capture.ts` currently calls several standalone detectors and generic queries during a capture attempt. Rewriting that flow, `findNewPasswordOnChangeForm()`, signup detection, custom-field filling, captcha detection, and generic `deepQuery(All)` callers is out of scope. They have different data/value/security semantics and should not turn this focused parse optimization into a page-wide detection framework. A later measured change may explicitly compose capture work, but PR 3 must not do so opportunistically.

## Migration steps

Use reviewable commits (or clearly separated diff sections) within one PR:

1. Add the iterative inventory plus root-partitioned label/ID indexes and focused inventory tests, without changing public detector results.
2. Add inventory-consuming private login/card/OTP helpers and equivalence tests for the existing priority ladders.
3. Route `parsePageFields()` through one shared inventory; route each public standalone detector through one per-call inventory; remove the old repeated private scan helpers only after all callers migrate.
4. Add deterministic work-count coverage and a non-gating diagnostic benchmark fixture.

Delete obsolete `ccByToken`, `findByHint`, and `findUsernameNearPassword` scan implementations once their inventory equivalents are active. Do not leave both paths selectable by flags.

This should remain one PR. Splitting parser inventory and label indexing into separate PRs would either leave a knowingly incomplete complexity claim or require a temporary abstraction/API that is immediately replaced. Separate commits provide the same review checkpoints without shipping an intermediate per-input root-query design. If the diff becomes unreviewable, extract only the self-contained inventory/label resolver as PR 3a and stack detector migration as PR 3b; do not merge 3a until its API is proven by the 3b branch, and do not introduce a generic DOM-index service.

## Deterministic tests

Retain the complete existing detection, shadow-DOM, field-model, site-fixture, capture, signup, and fill suites. Add focused cases that lock down ambiguities the refactor could otherwise change.

Behavioral equivalence:

- mixed light DOM and multiple/nested open-shadow roots preserve exact composed input order; closed roots remain invisible;
- username and password pair across separate shadow hosts within one form;
- a password in a shadow-internal form does not pair with an earlier input outside that form;
- nested/programmatically constructed form scope follows the form's composed subtree interval;
- multiple passwords retain first-password anchoring and preceding-candidate behavior;
- login autocomplete, email, attribute, and label rungs retain priority when different inputs satisfy different rungs;
- each card slot prefers a later token match over an earlier attribute or label match;
- each card slot prefers any attribute match over an earlier label-only match;
- split expiry suppresses combined expiry exactly as before;
- CVV may be password-typed and retains precedence in `kindOf()`;
- OTP token groups preserve composed order;
- OTP per-input attribute/label order is preserved when an earlier label match competes with a later attribute match;
- card fields remain excluded from OTP;
- segmented OTP retains its existing same-parent light-DOM grouping;
- duplicate IDs, duplicate `label[for]` associations, root-local IDs, document fallback, repeated `aria-labelledby` tokens, and CSS-significant IDs preserve label concatenation/root isolation;
- readonly/disabled attributes and input-type/no-type distinctions match current selectors.

Work-count coverage should be deterministic, not a wall-clock CI threshold. Keep instrumentation narrow and test-only where possible. Acceptable implementation choices are a small internal metrics sink passed to the inventory builder in tests or spies around an extracted composed walker and label resolver. Assert at least:

- a fieldless tree with thousands of nested elements reports exactly one inventory traversal and one visit per reachable element, with no root `querySelector(All)` calls from page-field parsing;
- adding 0, 10, or 1,000 inputs changes input-classification operations linearly with a fixed category multiplier, not document traversals;
- a page forcing label fallback reads each referenced label/ID element's text at most once per inventory even when card, login, and OTP inspect the same input;
- nested open roots are included in the same single traversal rather than initiating independent document rescans;
- standalone `detectCardFields()` and `otpInputs()` each construct one inventory, while one `parsePageFields()` constructs one total inventory for all three categories.

Do not expose production-global counters or assert exact elapsed milliseconds. If a diagnostic benchmark is added, keep it non-gating and report median parse time for large fieldless, input-heavy, and label-heavy fixtures only as developer evidence; correctness rests on operation counts and detector-result tests.

Focused verification:

```text
pnpm --filter @vault/platform-extension test -- src/content/detection.dom.test.ts src/content/detection.shadow.dom.test.ts src/content/field-model.dom.test.ts src/fixtures/sites.dom.test.ts
pnpm --filter @vault/platform-extension test -- src/content/capture.dom.test.ts src/content/signup-detect.dom.test.ts src/content/fill.dom.test.ts
pnpm --filter @vault/platform-extension typecheck
pnpm --filter @vault/platform-extension test
```

Use the actual existing fill test filename(s) if they differ; the final full-suite command is mandatory.

## Security and lifecycle invariants

- Never read or cache input `value` while building the inventory. Detection needs metadata and element identity only.
- Never log page attributes, label text, IDs, DOM nodes, field values, credentials, or timing tied to a real page.
- Keep all node and text caches local to one synchronous detector call; no observer, timer, module-global cache, or persistent cross-origin/page state is introduced.
- Resolve labels only within the input's own open tree, with the existing explicit document fallback for `aria-labelledby`; never search arbitrary sibling shadow roots.
- Treat page-controlled IDs and `for` tokens as inert map keys, not selector/code fragments.
- Use iterative traversal so adversarially deep DOM does not overflow the JavaScript call stack.
- Do not change candidate priority, fill permissions, readonly/disabled behavior, closed-shadow boundaries, vault messaging, auto-lock behavior, or mutation invalidation.

Secure and efficient implementation notes:

- Use `Map` keyed by raw page strings and exact `Document`/`ShadowRoot` identity; never use ordinary objects where keys such as `__proto__` can alter prototypes, and never interpolate a page-controlled ID into HTML, CSS, code, logs, or an exception message.
- Keep the traversal iterative and linear. Add adversarial deep-tree, broad-tree, duplicate-ID, and CSS-significant-token tests that assert visit counts and bounded per-parse retention rather than elapsed time.
- Do not call page-defined callbacks or mutate the DOM while building an inventory. Inventory construction and detector derivation must remain one synchronous, side-effect-free snapshot operation.
- Treat exact preservation of disabled/readonly semantics, root isolation, form scope, and classification priority as security-sensitive: these determine where a later authorized secret is written. A performance refactor must not broaden eligibility.
- Release all input, label, ID, root, and text-cache references when the synchronous parse returns. Do not close over an inventory from an observer, timer, message handler, or cached `PageFieldModel`.

## Risks and mitigations

- **Order drift at shadow boundaries:** lock down host-shadow-before-host-light preorder and cross-host fixtures before migration.
- **Form-scope drift:** use input-index intervals for composed form subtrees rather than nearest-form equality or `compareDocumentPosition()` across disconnected shadow trees.
- **Attribute/property semantic drift:** encode current selector predicates explicitly and test fieldset/attribute edge cases before replacing selectors.
- **Priority drift from over-fused loops:** keep independent fixed-order derivation passes and explicit login/card/OTP ladders.
- **Label leakage across roots:** partition indexes by exact `Document`/`ShadowRoot` identity and test duplicate IDs in separate roots.
- **Memory growth on huge pages:** retain only input entries, form ranges, labels, ID-bearing elements, and lazily reached text; do not retain every element or carry the inventory past the synchronous parse.
- **Premature generic indexing:** keep the inventory purpose-built for page-field parsing and leave capture/signup/custom-fill scans alone.
- **Misleading complexity claim:** document native label-text subtree work, prove one composed traversal and bounded repeated metadata work with counters, and avoid wall-clock promises.

## Acceptance criteria

- `parsePageFields()` builds one inventory and performs no detector-triggered whole-document or whole-root rescans.
- Existing public detector APIs and all current fixture results remain unchanged, except an explicitly documented raw-ID label-association correctness fix if covered by tests.
- Composed preorder, form pairing, detector ladders, card/CVV precedence, OTP grouping, and root-local label semantics have direct regression tests.
- Work-count tests demonstrate one element traversal and linear input classification on large synthetic pages.
- No persistent DOM index, page-value cache, new observer behavior, or PR 4 concern enters the implementation.

## Non-goals

- Mutation filtering, coalescing, scheduling, capability deduplication, or observer-root changes
- Attribute or shadow-root observation (PR 4 analysis)
- Picker positioning or PR 5 alternatives
- Persistent/incremental DOM indexing
- Changing detection heuristics, grouping fields by form/card section, or fixing known false positives
- Consolidating capture, signup, password-change, captcha, or custom-fill scans
- Timing-based CI performance gates
