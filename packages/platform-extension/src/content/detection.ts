export interface LoginFields {
	username: HTMLInputElement | null;
	password: HTMLInputElement | null;
}

// --- Hint lexicons --------------------------------------------------------
// Alternation sources, one term per line so a term can be added or removed
// without touching its neighbours. Conventions, which the tests in
// detection.i18n.dom.test.ts and detection.otp.dom.test.ts enforce:
//
//   - Terms must stand alone. The "name" half of "nom d'utilisateur" / "nombre
//     de usuario" is deliberately absent: a bare "name" would claim every
//     cardholder and full-name field on the web.
//   - Short ASCII terms are \b-bounded, so pt "conta" cannot match "contact".
//     Non-Latin terms are not: \b is ASCII-only, and CJK has no word separators.
//   - Accented forms are alternated with their stripped spelling, because
//     name/id attributes usually drop the diacritic while the label keeps it.
//
// Android's StructureParser.kt holds its own English-only copy of these
// heuristics and is NOT generated from here. See docs/field-detection.md.

/** Builds a case-insensitive alternation from a term list. */
function alternation(terms: string[]): RegExp {
	return new RegExp(terms.join("|"), "i");
}

// Decides rungs 4 and 5 of detectLoginFields only, which run when the page has
// no password field, no autocomplete token and no email input: in practice,
// identifier-first pages.
export const USERNAME_HINT_RE = alternation([
	// en
	"email",
	"e-mail",
	"\\bmail\\b",
	"user",
	"login",
	"account",
	"signin",
	"sign-in",
	// de
	"benutzer",
	"nutzername",
	"anmeldename",
	"anmeld",
	"kundennummer",
	// nl
	"gebruiker",
	"inloggen",
	"aanmelden",
	// sv
	"anv(ä|a)ndare",
	"anv(ä|a)ndarnamn",
	"logga.?in",
	"inloggning",
	"\\be.?post\\b",
	"mejl",
	// da, no
	"brugernavn",
	"brukernavn",
	"logg.?inn",
	"log.?ind",
	// fi
	"k(ä|a)ytt(ä|a)j(ä|a)",
	"s(ä|a)hk(ö|o)posti",
	"kirjaudu",
	// fr
	"utilisateur",
	"identifiant",
	"courriel",
	"connexion",
	"se.?connecter",
	"\\bcompte\\b",
	// es
	"usuario",
	"correo",
	"iniciar.?sesi(ó|o)n",
	"\\bsesi(ó|o)n\\b",
	"\\bcuenta\\b",
	"\\bacceso\\b",
	// pt
	"utilizador",
	"usu(á|a)rio",
	"\\bconta\\b",
	"iniciar.?sess(ã|a)o",
	// it
	"utente",
	"\\baccedi\\b",
	"\\baccesso\\b",
	"credenziali",
	"posta.?elettronica",
	// pl
	"u(ż|z)ytkownik",
	"zaloguj",
	"logowanie",
	"\\bkonto\\b",
	// tr
	"kullan(ı|i)c(ı|i)",
	"\\be.?posta\\b",
	"giri(ş|s)",
	"hesap",
	// ru
	"логин",
	"пользовател",
	"почта",
	"вход",
	"уч(ё|е)тная",
	// ja, zh, ko
	"ユーザー",
	"メール",
	"ログイン",
	"用户",
	"邮箱",
	"登录",
	"登入",
	"帳號",
	"账号",
	"사용자",
	"이메일",
	"로그인",
]);

// Localized search terms matter more than they look: rung 1 picks the password's
// nearest preceding text input, so an untranslated search box in the header wins
// and the username gets typed into it.
const NEGATIVE_HINT_RE = alternation([
	"search",
	"captcha",
	"coupon",
	"otp",
	"code",
	// de, nl
	"suche",
	"suchen",
	"zoek",
	// fr, es, it, pt, sv
	"recherche",
	"buscar",
	"b(ú|u)squeda",
	"\\bbusca\\b",
	"\\bcerca\\b",
	"ricerca",
	"pesquisa",
	"\\bs(ö|o)k\\b",
]);

const USERNAME_TEXT_SELECTOR =
	'input[type="text"]:not([readonly]):not([disabled]), input[type="email"]:not([readonly]):not([disabled]), input[type="tel"]:not([readonly]):not([disabled]), input:not([type]):not([readonly]):not([disabled])';

// --- Shadow-DOM-aware traversal -------------------------------------------
// Detectors must see inputs that web components (e.g. Reddit's
// faceplate-text-input) render into an OPEN shadow root. querySelector(All)
// stops at shadow boundaries, so these helpers also walk el.shadowRoot. Closed
// roots report shadowRoot === null and are silently skipped (unreachable).

/** querySelectorAll that descends into open shadow roots, in DFS pre-order. */
export function deepQueryAll<E extends Element = HTMLElement>(
	selector: string,
	root: ParentNode = document,
): E[] {
	const out: E[] = [];
	const visit = (parent: ParentNode): void => {
		for (const el of Array.from(parent.children)) {
			if (el.matches(selector)) out.push(el as E);
			if (el.shadowRoot) visit(el.shadowRoot);
			visit(el);
		}
	};
	visit(root);
	return out;
}

/** First match of deepQueryAll, short-circuiting the walk. */
export function deepQuery<E extends Element = HTMLElement>(
	selector: string,
	root: ParentNode = document,
): E | null {
	const visit = (parent: ParentNode): E | null => {
		for (const el of Array.from(parent.children)) {
			if (el.matches(selector)) return el as E;
			const inShadow = el.shadowRoot ? visit(el.shadowRoot) : null;
			if (inShadow) return inShadow;
			const inLight = visit(el);
			if (inLight) return inLight;
		}
		return null;
	};
	return visit(root);
}

/** closest() that crosses shadow boundaries by hopping to each root's host. */
export function closestAcrossShadow(el: Element, selector: string): Element | null {
	let cur: Element | null = el;
	while (cur) {
		const found = cur.closest(selector);
		if (found) return found;
		const root = cur.getRootNode();
		cur = root instanceof ShadowRoot ? root.host : null;
	}
	return null;
}

/** The truly-focused element, descending through open shadow roots. */
export function deepActiveElement(doc: Document = document): Element | null {
	let active: Element | null = doc.activeElement;
	while (active?.shadowRoot?.activeElement) {
		active = active.shadowRoot.activeElement;
	}
	return active;
}

/**
 * The real event target, piercing open shadow boundaries. A document-level
 * listener sees `event.target` retargeted to the shadow host; composedPath()[0]
 * is the actual element (open roots only; closed roots stop at the host).
 */
export function composedTarget(e: Event): EventTarget | null {
	return e.composedPath()[0] ?? e.target;
}

/** First non-readonly, non-disabled `type=password` input, or null. */
export function findPasswordField(doc: Document = document): HTMLInputElement | null {
	return deepQuery<HTMLInputElement>('input[type="password"]:not([readonly]):not([disabled])', doc);
}

/** Concatenated attribute hint (name, id, placeholder, autocomplete, aria-label) for regex matching. */
export function attrHint(el: HTMLInputElement): string {
	return `${el.name} ${el.id} ${el.placeholder} ${el.autocomplete} ${el.getAttribute("aria-label") ?? ""}`;
}

/**
 * Visible text of the element's associated label(s): `<label for=id>`, a
 * wrapping `<label>`, or `aria-labelledby` targets. Low-priority hint fallback.
 * ID/label lookups resolve within the element's own tree (`getRootNode()`), so
 * they work inside a shadow root.
 */
export function labelText(el: HTMLInputElement, doc: Document = document): string {
	const parts: string[] = [];
	const root = el.getRootNode() as Document | ShadowRoot;
	if (el.id) {
		const sel = typeof CSS !== "undefined" && CSS.escape ? CSS.escape(el.id) : el.id;
		try {
			for (const lbl of root.querySelectorAll<HTMLLabelElement>(`label[for="${sel}"]`)) {
				parts.push(lbl.textContent ?? "");
			}
		} catch {
			// Unusable id even after escaping: skip the for= lookup.
		}
	}
	const wrapping = closestAcrossShadow(el, "label");
	if (wrapping) parts.push(wrapping.textContent ?? "");
	const labelledby = el.getAttribute("aria-labelledby");
	if (labelledby) {
		for (const id of labelledby.split(/\s+/)) {
			if (!id) continue;
			const ref = root.getElementById(id) ?? doc.getElementById(id);
			if (ref) parts.push(ref.textContent ?? "");
		}
	}
	return parts.join(" ");
}

function looksLikeUsername(el: HTMLInputElement): boolean {
	const hint = attrHint(el);
	if (NEGATIVE_HINT_RE.test(hint)) return false;
	if (el.type === "email") return true;
	const autocomplete = el.autocomplete?.toLowerCase() ?? "";
	if (autocomplete.includes("username") || autocomplete === "email") return true;
	return USERNAME_HINT_RE.test(hint);
}

/** Latest text/email input appearing before `password` in DOM order, or null. */
function findUsernameNearPassword(password: HTMLInputElement): HTMLInputElement | null {
	const form = closestAcrossShadow(password, "form");
	const scope: ParentNode = form ?? password.ownerDocument;
	// Walk text-like inputs AND password inputs together in pre-order: the
	// username is the latest text-like input appearing before `password`. A
	// single ordered traversal works even when each field lives in its own
	// shadow host, where compareDocumentPosition would report DISCONNECTED.
	const ordered = deepQueryAll<HTMLInputElement>(
		`${USERNAME_TEXT_SELECTOR}, input[type="password"]`,
		scope,
	);
	let best: HTMLInputElement | null = null;
	for (const c of ordered) {
		if (c === password) return best;
		if (c.type === "password") continue;
		if (NEGATIVE_HINT_RE.test(attrHint(c))) continue;
		best = c; // c precedes password; keep the latest such candidate
	}
	return best;
}

export interface CardFields {
	number: HTMLInputElement | null;
	name: HTMLInputElement | null;
	// Combined MM/YY field; set only when no split month/year pair is present.
	expCombined: HTMLInputElement | null;
	expMonth: HTMLInputElement | null;
	expYear: HTMLInputElement | null;
	cvv: HTMLInputElement | null;
}

export const CC_NUMBER_RE = /card.?number|cardnum|ccnum|cc.?number/i;
// Ambiguous names for the card number, consulted only once the document has
// independent card context (see cardContextPresent). "pan" is the payment
// industry's Primary Account Number and is what PCI capture iframes call the
// field, but it is also India's Permanent Account Number, on every KYC form
// there, so it can never stand on its own.
const CC_NUMBER_WEAK_RE = /\bpan\b/i;
// Names that mark a document as a card-capture form, used only to unlock the weak
// number match. Deliberately not a targeting regex: nothing here is ever filled.
const CC_CONTEXT_RE =
	/card.?scheme|card.?type|cardholder|masked.?pan|expiry|expiration|\bcvv\b|\bcvc\b|\bcsc\b/i;
const CC_NAME_RE = /cardholder|name.?on.?card|cc.?name/i;
const CC_EXP_RE = /expir(y|ation)/i;
const CC_EXP_MONTH_RE = /exp.*month|cc.?month|card.*month/i;
const CC_EXP_YEAR_RE = /exp.*year|cc.?year|card.*year/i;
// "verification code/number" alone is far more often a 2FA/OTP label than a CVV
// (e.g. GitHub's 2FA field: label "Enter the verification code"), so the CVV
// match requires card context (card verification value/code/number, or cvn).
export const CC_CSC_RE = /\bcvv\b|\bcvc\b|\bcvn\b|\bcsc\b|security.?code|card.?code|card.?verif/i;

/** First non-readonly input whose `autocomplete` carries the given `cc-*` token. */
function ccByToken(token: string, doc: Document = document): HTMLInputElement | null {
	return deepQuery<HTMLInputElement>(
		`input[autocomplete~="${token}"]:not([readonly]):not([disabled])`,
		doc,
	);
}

/**
 * First visible input matching `re` (attributes first, then label text).
 * Password-typed inputs are skipped unless `allowPassword` (CVV may be type=password).
 */
function findByHint(
	re: RegExp,
	exclude?: RegExp,
	allowPassword = false,
	doc: Document = document,
): HTMLInputElement | null {
	const inputs: HTMLInputElement[] = [];
	for (const el of deepQueryAll<HTMLInputElement>("input:not([readonly]):not([disabled])", doc)) {
		if (el.type === "hidden" || el.type === "checkbox" || el.type === "radio") continue;
		if (el.type === "password" && !allowPassword) continue;
		inputs.push(el);
	}
	for (const el of inputs) {
		const hint = attrHint(el);
		if (exclude?.test(hint)) continue;
		if (re.test(hint)) return el;
	}
	// Label text is a fallback, checked only when no attribute matched.
	for (const el of inputs) {
		const lbl = labelText(el, doc);
		if (!lbl || exclude?.test(lbl)) continue;
		if (re.test(lbl)) return el;
	}
	return null;
}

/**
 * True if the document is recognisably a card-capture form on evidence other than
 * the number field itself. Unlike every targeting pass this reads hidden inputs
 * too: a PCI capture iframe carries its transport schema in them
 * (`sf.req.card.expiryMonth`, `cardScheme`), and naming the schema is exactly the
 * evidence wanted here, even though such a field would never be filled.
 */
function cardContextPresent(partial: Omit<CardFields, "number">, doc: Document): boolean {
	if (partial.cvv || partial.name || partial.expCombined || partial.expMonth || partial.expYear) {
		return true;
	}
	return deepQueryAll<HTMLInputElement>("input", doc).some((el) =>
		CC_CONTEXT_RE.test(attrHint(el)),
	);
}

/** Detect credit-card fields, preferring `cc-*` autocomplete tokens over hint regexes. */
export function detectCardFields(doc: Document = document): CardFields {
	const name = ccByToken("cc-name", doc) ?? findByHint(CC_NAME_RE, undefined, false, doc);
	const expMonth =
		ccByToken("cc-exp-month", doc) ?? findByHint(CC_EXP_MONTH_RE, undefined, false, doc);
	const expYear =
		ccByToken("cc-exp-year", doc) ?? findByHint(CC_EXP_YEAR_RE, undefined, false, doc);
	// Combined MM/YY only when there's no split month/year pair.
	const expCombined =
		!expMonth && !expYear
			? (ccByToken("cc-exp", doc) ?? findByHint(CC_EXP_RE, /month|year/i, false, doc))
			: null;
	const cvv = ccByToken("cc-csc", doc) ?? findByHint(CC_CSC_RE, undefined, true, doc);
	const rest = { name, expCombined, expMonth, expYear, cvv };
	// The weak pass runs last and only in card context, so an unlabelled `name="pan"`
	// resolves on a PCI capture page without claiming a tax-ID field anywhere else.
	const number =
		ccByToken("cc-number", doc) ??
		findByHint(CC_NUMBER_RE, undefined, false, doc) ??
		(cardContextPresent(rest, doc) ? findByHint(CC_NUMBER_WEAK_RE, undefined, false, doc) : null);
	return { number, ...rest };
}

/** True if a real card field (number/cvv/expiry) is present; a bare name field doesn't count. */
export function cardFieldsPresent(c: CardFields): boolean {
	return !!(c.number || c.cvv || c.expCombined || c.expMonth || c.expYear);
}

/** True if `el` is one of the detected card fields. */
export function isCardField(c: CardFields, el: HTMLInputElement): boolean {
	return (
		el === c.number ||
		el === c.name ||
		el === c.expCombined ||
		el === c.expMonth ||
		el === c.expYear ||
		el === c.cvv
	);
}

// A booster, not the primary signal: the structural rungs in otpInputs are what
// carry the non-English pages no word list reaches.
export const OTP_HINT_RE = alternation([
	// en. The abbreviations are bounded on letters rather than \b so they still
	// match inside `idTxtBx_SAOTCC_OTC`, where the underscore is a word character
	// and \b therefore fails.
	"(?<![a-z])(otp|otc|totp)(?![a-z])",
	"one.?time",
	"2fa",
	"mfa",
	"two.?factor",
	"authenticator",
	"auth.?code",
	"login.?code",
	"verif(y|ication).?code",
	"confirmation.?code",
	"passcode",
	"6.?digit",
	// de
	"einmal(code|passwort|kennwort)",
	"best(ä|ae)tigungscode",
	"sicherheitscode",
	"verifizierungscode",
	"pr(ü|ue)fcode",
	// fr
	"code de (v(é|e)rification|s(é|e)curit(é|e))",
	"code (à|a) usage unique",
	// es
	"c(ó|o)digo de (verificaci(ó|o)n|seguridad|confirmaci(ó|o)n)",
	// it
	"codice di (verifica|sicurezza)",
	// pt
	"c(ó|o)digo de verifica(ç|c)(ã|a)o",
	// nl
	"verificatiecode",
	"beveiligingscode",
	// sv
	"verifieringskod",
	"s(ä|a)kerhetskod",
	"eng(å|a)ngskod",
]);

// "Code" on its own is far too common (gift, referral, country, area, discount)
// to accept as a signal, so it only counts when the field is also code-shaped.
const WEAK_CODE_RE = alternation([
	"\\bcode\\b",
	"\\bkod\\b",
	"\\bkode\\b",
	"\\bc(ó|o)digo\\b",
	"\\bcodice\\b",
]);

// Keeps card/address/coupon fields out of OTP detection (CVV is also handled by
// isCardField). Redeemable-code fields are excluded here rather than left to the
// weak-code rung, which would otherwise claim "gift code" on a checkout page.
export const OTP_NEGATIVE_RE = alternation([
	// en
	"card",
	"coupon",
	"promo",
	"postal",
	"\\bzip\\b",
	"country",
	"address",
	"phone",
	"gift",
	"referral",
	"invite",
	"discount",
	"voucher",
	"redeem",
	// de
	"karte",
	"gutschein",
	"postleitzahl",
	"\\bplz\\b",
	"adresse",
	"telefon",
	// fr
	"carte",
	"pays",
	"t(é|e)l(é|e)phone",
	// es
	"tarjeta",
	"pa(í|i)s",
	"direcci(ó|o)n",
	"tel(é|e)fono",
	// it, sv
	"tessera",
	"postnummer",
	"adress",
]);

const SEGMENT_TYPES = new Set(["text", "tel", "number", ""]);
// A run this long of single-character boxes is a code widget and nothing else;
// split date and product-key inputs use wider fields. Deliberately structural,
// so it works on pages whose prose we can't read.
const SEGMENTED_MIN_BOXES = 4;
// A pattern admitting exactly one character: `\d{1}`, `[0-9]`, `.` and friends,
// with optional anchors. Some widgets declare a box's width this way and never
// set maxlength (Cloudflare's 2FA form even puts maxlength=6 on the FIRST box,
// so an OS code autofill can drop the whole code into it).
const ONE_CHAR_PATTERN_RE = /^\^?(\\d|\\w|\[[^\]]+\]|\.)(\{1\})?\$?$/;
// Bounds for a code typed into one field. Below 4 is a CVV or a PIN, above 8 is
// prose; both ends are also covered by OTP_NEGATIVE_RE and the card scan.
const CODE_MIN_LEN = 4;
const CODE_MAX_LEN = 8;
const DIGIT_PATTERN_RE = /\\d|\[0-9\]|\[\\d\]/;

/** True for input types that could hold a one-time code. */
function isOtpCandidateType(el: HTMLInputElement): boolean {
	return !["password", "hidden", "checkbox", "radio", "submit", "button"].includes(el.type);
}

/** True if the field is length-bounded like a typed code. */
function isCodeLength(el: HTMLInputElement): boolean {
	return el.maxLength >= CODE_MIN_LEN && el.maxLength <= CODE_MAX_LEN;
}

/** True if the field declares digits-only entry, via inputmode, type, or pattern. */
function isNumericEntry(el: HTMLInputElement): boolean {
	const mode = el.getAttribute("inputmode")?.toLowerCase() ?? "";
	if (mode === "numeric" || mode === "tel" || mode === "decimal") return true;
	if (el.type === "tel" || el.type === "number") return true;
	return DIGIT_PATTERN_RE.test(el.getAttribute("pattern") ?? "");
}

/**
 * True for one box of a segmented widget: a text-like input that takes a single
 * character, said with `maxlength` or with a one-character `pattern`.
 */
export function isSingleCharBox(el: HTMLInputElement): boolean {
	if (!SEGMENT_TYPES.has(el.type)) return false;
	if (el.maxLength === 1) return true;
	return ONE_CHAR_PATTERN_RE.test(el.getAttribute("pattern") ?? "");
}

/**
 * A segmented code widget found purely by shape: SEGMENTED_MIN_BOXES or more
 * single-character inputs sharing a parent. Language-independent, and the only
 * thing that finds these widgets when the site tags no box with a hint or an
 * autocomplete token.
 */
function segmentedRun(doc: Document): HTMLInputElement[] {
	const byParent = new Map<Element, HTMLInputElement[]>();
	for (const el of deepQueryAll<HTMLInputElement>("input:not([readonly]):not([disabled])", doc)) {
		if (!isSingleCharBox(el)) continue;
		if (OTP_NEGATIVE_RE.test(attrHint(el))) continue;
		const parent = el.parentElement;
		if (!parent) continue;
		const run = byParent.get(parent);
		if (run) run.push(el);
		else byParent.set(parent, [el]);
	}
	for (const run of byParent.values()) {
		if (run.length >= SEGMENTED_MIN_BOXES) return run;
	}
	return [];
}

/**
 * A lone digits-only field of code length. The weakest rung, so it only fires
 * when exactly one field on the page qualifies: more than one means we can't
 * tell which is the code, and guessing would fill the wrong box.
 */
function loneNumericCode(doc: Document, card: CardFields): HTMLInputElement[] {
	const found: HTMLInputElement[] = [];
	for (const el of deepQueryAll<HTMLInputElement>("input:not([readonly]):not([disabled])", doc)) {
		if (!isOtpCandidateType(el)) continue;
		if (isCardField(card, el)) continue;
		if (!isCodeLength(el) || !isNumericEntry(el)) continue;
		if (OTP_NEGATIVE_RE.test(attrHint(el)) || OTP_NEGATIVE_RE.test(labelText(el, doc))) continue;
		found.push(el);
	}
	return found.length === 1 ? found : [];
}

/** Contiguous DOM run of single-char text-like inputs that `seed` belongs to (segmented OTP widget). */
export function segmentedSiblings(seed: HTMLInputElement): HTMLInputElement[] {
	const parent = seed.parentElement;
	if (!parent) return [seed];
	const siblings = Array.from(parent.querySelectorAll<HTMLInputElement>("input")).filter(
		(el) => !el.readOnly && !el.disabled && isSingleCharBox(el),
	);
	return siblings.length >= 2 ? siblings : [seed];
}

/** How the detected OTP inputs divide up: per-character boxes, and a whole-code field. */
export interface OtpTargets {
	/** Single-character boxes in DOM order. Empty when the code goes in one field. */
	boxes: HTMLInputElement[];
	/** The field that takes the entire code: a lone OTP input, or a widget's mirror. */
	whole: HTMLInputElement | null;
}

/**
 * Split the detected OTP inputs into the boxes a code is typed across and the
 * one field that holds it whole.
 *
 * Segmented widgets increasingly ship both: N visible boxes plus a
 * visually-hidden input carrying the assembled code for the form and for the
 * OS-level code autofill (Cloudflare's 2FA form, `detection.otp.dom.test.ts`).
 * That mirror answers the same `one-time-code` query as the boxes, so without
 * this split it gets a single character of the code, or the empty string past
 * the end of it. That is how a fill which wrote all six digits correctly still
 * left the widget blank.
 */
export function splitOtpFields(fields: HTMLInputElement[]): OtpTargets {
	const boxes = fields.filter(isSingleCharBox);
	// One box is not a widget: that's a lone field we happened to detect.
	if (boxes.length < 2) return { boxes: [], whole: fields[0] ?? null };
	const whole =
		fields.find(
			(el) => !boxes.includes(el) && (el.maxLength <= 0 || el.maxLength >= boxes.length),
		) ?? null;
	return { boxes, whole };
}

/**
 * Inputs making up the one-time-code entry, in DOM order. Usually one field;
 * some sites split it into N single-char boxes. Empty array when none found.
 *
 * Four rungs, strongest first. The two structural ones exist because the hint
 * list only covers languages someone thought to add: a run of single-character
 * boxes and a digits-only field of code length are the same shape in every
 * language. See docs/field-detection.md.
 */
export function otpInputs(
	doc: Document = document,
	precomputedCard?: CardFields,
): HTMLInputElement[] {
	// 1. Multiple `one-time-code` tokens means a segmented widget tagging every box.
	const tokened = deepQueryAll<HTMLInputElement>(
		'input[autocomplete~="one-time-code"]:not([readonly]):not([disabled])',
		doc,
	);
	if (tokened.length >= 1) return tokened;

	// Reuse a card scan from parsePageFields when given; otherwise compute it lazily.
	const card = precomputedCard ?? detectCardFields(doc);
	// 2. Attribute and label hints.
	let hinted: HTMLInputElement | null = null;
	for (const el of deepQueryAll<HTMLInputElement>("input:not([readonly]):not([disabled])", doc)) {
		if (!isOtpCandidateType(el)) continue;
		if (isCardField(card, el)) continue;
		const hint = attrHint(el);
		if (OTP_NEGATIVE_RE.test(hint)) continue;
		if (OTP_HINT_RE.test(hint) || (WEAK_CODE_RE.test(hint) && isCodeLength(el))) {
			hinted = el;
			break;
		}
		const lbl = labelText(el, doc);
		if (!lbl || OTP_NEGATIVE_RE.test(lbl)) continue;
		if (OTP_HINT_RE.test(lbl) || (WEAK_CODE_RE.test(lbl) && isCodeLength(el))) {
			hinted = el;
			break;
		}
	}
	if (hinted) {
		// A single-char field is one box of a segmented widget; gather the whole run.
		if (hinted.maxLength === 1) {
			const group = segmentedSiblings(hinted);
			if (group.length >= 2) return group;
		}
		return [hinted];
	}

	// 3. Structural: an untagged run of single-character boxes.
	const run = segmentedRun(doc);
	if (run.length > 0) return run;

	// 4. Structural: a lone digits-only field of code length.
	return loneNumericCode(doc, card);
}

// Match only interactive captchas; v3/invisible variants run transparently and
// don't block submit, so they're excluded here and by the isRendered check.
const CAPTCHA_SELECTORS = [
	".g-recaptcha:not([data-size='invisible'])",
	".h-captcha",
	".cf-turnstile",
	'iframe[src*="recaptcha/api2/anchor"]',
	'iframe[src*="recaptcha/api2/bframe"]',
	'iframe[src*="hcaptcha.com"]',
	'iframe[src*="challenges.cloudflare.com"]',
	'iframe[src*="arkoselabs.com"]',
	'iframe[src*="funcaptcha.com"]',
	'iframe[title*="captcha" i]',
];

/** True if `el` is large enough and not hidden via display/visibility/opacity. */
export function isRendered(el: Element): boolean {
	const rect = el.getBoundingClientRect();
	if (rect.width < 10 || rect.height < 10) return false;
	const view = el.ownerDocument?.defaultView;
	const style = view?.getComputedStyle?.(el);
	if (!style) return true;
	return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/** True if a rendered interactive captcha is present; used to gate auto-submit. */
export function hasInteractiveCaptcha(doc: Document = document): boolean {
	for (const sel of CAPTCHA_SELECTORS) {
		for (const el of doc.querySelectorAll(sel)) {
			if (isRendered(el)) return true;
		}
	}
	return false;
}

export interface FieldMatcher {
	// "postalcode": normalized concatenation for exact/substring matching.
	canonical: string;
	// "postal-code": the HTML autocomplete-token form.
	hyphen: string;
}

/** Derive canonical + hyphen token variants from a user-chosen field name, or null if empty. */
export function deriveMatcher(key: string): FieldMatcher | null {
	const words = key.toLowerCase().match(/[a-z0-9]+/g);
	if (!words || words.length === 0) return null;
	return { canonical: words.join(""), hyphen: words.join("-") };
}

// Text-like only; password/email excluded so a stray match can't leak a custom
// value into a credential or email field.
export const CUSTOM_FILLABLE_TYPES = new Set(["text", "tel", "number", "search", "url", ""]);

/** All non-readonly inputs of a custom-fillable type. */
export function getFillableInputs(doc: Document = document): HTMLInputElement[] {
	const out: HTMLInputElement[] = [];
	for (const el of deepQueryAll<HTMLInputElement>("input", doc)) {
		if (el.readOnly || el.disabled) continue;
		if (!CUSTOM_FILLABLE_TYPES.has(el.type)) continue;
		out.push(el);
	}
	return out;
}

/** True if `el` matches the custom field via autocomplete token, attributes, or label text. */
export function matchesField(el: HTMLInputElement, m: FieldMatcher): boolean {
	const ac = el.autocomplete?.toLowerCase().trim();
	if (ac) {
		for (const token of ac.split(/\s+/)) {
			if (token === m.hyphen) return true;
			if (token.replace(/[^a-z0-9]/g, "") === m.canonical) return true;
		}
	}
	// Attributes first, then label text as a lower-priority fallback.
	for (const raw of [
		el.name,
		el.id,
		el.getAttribute("aria-label") ?? "",
		el.placeholder,
		labelText(el),
	]) {
		const a = raw.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (!a) continue;
		// Substring match only for keys >= 5 chars, so "name"/"city" can't match
		// "username"/"velocity"; exact normalized match works at any length.
		if (a === m.canonical) return true;
		if (m.canonical.length >= 5 && a.includes(m.canonical)) return true;
	}
	return false;
}

/** The page's fillable fields, parsed once: login, card, and one-time-code inputs. */
export interface PageFieldModel {
	login: LoginFields;
	card: CardFields;
	otp: HTMLInputElement[];
}

/**
 * Parse the page's fillable fields in a single pass. The content cluster reads
 * this model (cached in field-model.ts) instead of each call site re-scanning
 * the DOM. The card scan is shared with the OTP detection.
 */
export function parsePageFields(doc: Document = document): PageFieldModel {
	const card = detectCardFields(doc);
	const login = detectLoginFields(doc);
	const otp = otpInputs(doc, card);
	return { login, card, otp };
}

/**
 * Classify `el` against an already-parsed model: login / card / otp, or null.
 * Login wins over card except for CVV-as-password (e.g. BMO's login id is a
 * debit card number, which login must still claim).
 */
export function kindOf(
	model: PageFieldModel,
	el: EventTarget | null,
): "login" | "card" | "otp" | null {
	if (!(el instanceof HTMLInputElement)) return null;
	if (el.readOnly || el.disabled) return null;
	const isCard = cardFieldsPresent(model.card) && isCardField(model.card, el);
	if (isCard && el === model.card.cvv && el.type === "password") return "card";
	if (el === model.login.username || el === model.login.password) return "login";
	if (el.type === "password") return "login";
	if (isCard) return "card";
	if (model.otp.includes(el)) return "otp";
	return null;
}

/** True if `el` is any autofill candidate in the parsed model. */
export function isCandidate(model: PageFieldModel, el: EventTarget | null): el is HTMLInputElement {
	return kindOf(model, el) !== null;
}

/** Classify a focused field by parsing the live DOM. Prefer `kindOf(model, el)` on a cached model. */
export function candidateKind(
	el: EventTarget | null,
	doc: Document = document,
): "login" | "card" | "otp" | null {
	return kindOf(parsePageFields(doc), el);
}

/** True if `el` is any autofill candidate (login, card, or otp). Parses the live DOM. */
export function isAutofillCandidate(
	el: EventTarget | null,
	doc: Document = document,
): el is HTMLInputElement {
	return candidateKind(el, doc) !== null;
}

/**
 * Detect username/password via a priority ladder: password-adjacent text input,
 * explicit autocomplete tokens, lone email input, attribute hints, label text.
 * Either field may be null.
 */
export function detectLoginFields(doc: Document = document): LoginFields {
	const password = findPasswordField(doc);

	// 1. Password's nearest preceding text input: the most reliable pairing.
	if (password) {
		const near = findUsernameNearPassword(password);
		if (near) return { username: near, password };
	}

	// 2. Explicit autocomplete tokens.
	const explicit = deepQuery<HTMLInputElement>(
		'input[autocomplete~="username"]:not([readonly]):not([disabled]), input[autocomplete="email"]:not([readonly]):not([disabled])',
		doc,
	);
	if (explicit) return { username: explicit, password };

	// 3. A single visible email input.
	const email = deepQuery<HTMLInputElement>(
		'input[type="email"]:not([readonly]):not([disabled])',
		doc,
	);
	if (email) return { username: email, password };

	// 4. Attribute heuristics on text inputs.
	const candidates = deepQueryAll<HTMLInputElement>(USERNAME_TEXT_SELECTOR, doc);
	for (const c of candidates) {
		if (looksLikeUsername(c)) return { username: c, password };
	}
	// 5. Last resort: label text.
	for (const c of candidates) {
		const lbl = labelText(c, doc);
		if (!lbl || NEGATIVE_HINT_RE.test(lbl)) continue;
		if (USERNAME_HINT_RE.test(lbl)) return { username: c, password };
	}

	return { username: null, password };
}

/**
 * On a password-change form, return the new-password field once it's confirmed
 * (a matching second field). Returns null when ambiguous or mid-edit.
 */
export function findNewPasswordOnChangeForm(doc: Document = document): HTMLInputElement | null {
	const fields = deepQueryAll<HTMLInputElement>(
		'input[type="password"]:not([readonly]):not([disabled])',
		doc,
	);
	if (fields.length < 2) return null;
	const NEW_RE = /new|set/i;
	const OLD_OR_CONFIRM_RE = /old|current|confirm|verify|repeat|re.?type|again/i;
	let candidate: HTMLInputElement | null = null;
	for (const el of fields) {
		const hint = `${el.autocomplete ?? ""} ${attrHint(el)} ${labelText(el, doc) ?? ""}`;
		if (OLD_OR_CONFIRM_RE.test(hint)) continue;
		if (el.autocomplete?.toLowerCase().includes("new-password") || NEW_RE.test(hint)) {
			candidate = el;
			break;
		}
	}
	if (!candidate?.value) return null;
	for (const el of fields) {
		if (el === candidate) continue;
		if (el.value === candidate.value) return candidate;
	}
	return null;
}
