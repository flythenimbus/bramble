/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it } from "vitest";
import { detectLoginFields } from "./detection";

// The localized half of issue #46. Rung 1 (the password's nearest preceding text
// input) is language-free and rescues ordinary login forms, so these tests use
// the shape it cannot help with: an **identifier-first** page, where the password
// lives on a later step. There rungs 4 and 5 are the only thing left, and they
// read prose, so an English-only list resolves no username at all.
//
// Two directions matter equally here. Missing a username means no autofill;
// claiming the wrong field means typing the user's login into a search box or a
// cardholder-name field, which is worse. The rejection cases below are not
// padding.

beforeEach(() => {
	document.body.innerHTML = "";
});

/** Identifier-first step: one text input, no password anywhere. */
function twoStep(attrs: string, label = ""): HTMLInputElement | null {
	document.body.innerHTML = `<form>
		${label ? `<label for="a">${label}</label>` : ""}
		<input id="a" type="text" ${attrs}>
		<button type="submit">→</button>
	</form>`;
	return detectLoginFields().username;
}

describe("identifier-first page, matched on attributes", () => {
	it.each([
		["en", 'name="username"'],
		["en bare mail", 'name="mail"'],
		["de", 'name="benutzername"'],
		["de Kundennummer", 'name="kundennummer"'],
		["nl", 'name="gebruikersnaam"'],
		["sv", 'name="anvandarnamn"'],
		["da", 'name="brugernavn"'],
		["no", 'name="brukernavn"'],
		["fi", 'name="kayttajatunnus"'],
		["fr", 'name="identifiant"'],
		["fr utilisateur", 'name="utilisateur"'],
		["es", 'name="usuario"'],
		["pt", 'name="utilizador"'],
		["it", 'name="utente"'],
		["pl", 'name="uzytkownik"'],
		["tr", 'name="kullanici"'],
	])("resolves the %s identifier field", (_lang, attrs) => {
		expect(twoStep(attrs)?.id).toBe("a");
	});
});

describe("identifier-first page, matched on the label only", () => {
	// The field carries a meaningless name, so rung 5 (label text) is all there is.
	it.each([
		["de", "Benutzername"],
		["de E-Mail-Adresse", "E-Mail-Adresse"],
		["fr", "Identifiant"],
		["fr Courriel", "Courriel"],
		["es", "Usuario"],
		["es Correo electrónico", "Correo electrónico"],
		["pt", "Utilizador"],
		["it", "Nome utente"],
		["nl", "Gebruikersnaam"],
		["sv", "Användarnamn"],
		["sv Mejladress", "Mejladress"],
		["fi", "Käyttäjätunnus"],
		["pl", "Nazwa użytkownika"],
		["tr", "Kullanıcı adı"],
		["ru", "Логин"],
		["ja", "ユーザー名"],
		["zh", "用户名"],
		["ko", "사용자 이름"],
	])("resolves a field labelled in %s", (_lang, label) => {
		expect(twoStep('name="f1"', label)?.id).toBe("a");
	});

	it("accepts the accent-stripped spelling too", () => {
		// Attributes usually drop the diacritic even when the label keeps it.
		expect(twoStep('name="sesion"')?.id).toBe("a");
		expect(twoStep('name="usuario"', "Usuário")?.id).toBe("a");
	});
});

describe("does not claim look-alike fields", () => {
	it.each([
		["contact form", 'name="contact"', "Contact"],
		["full name", 'name="fullname"', "Full name"],
		["German surname", 'name="nachname"', "Nachname"],
		["Spanish name", 'name="nombre"', "Nombre"],
		["cardholder", 'name="ccname" autocomplete="cc-name"', "Name on card"],
		["postal code", 'name="postcode"', "Post code"],
		["company", 'name="company"', "Company"],
	])("leaves the %s field alone", (_what, attrs, label) => {
		expect(twoStep(attrs, label)).toBeNull();
	});

	it("does not let 'conta' match 'contact'", () => {
		// \b-bounded on purpose: pt "conta" is a real identifier word.
		expect(twoStep('name="contact-form-email-field-x"')).not.toBeNull(); // has "email"
		expect(twoStep('name="contactus"')).toBeNull();
	});
});

describe("localized search boxes never win rung 1", () => {
	it.each([
		["sv", "sok", "Sök"],
		["de", "suche", "Suche"],
		["fr", "recherche", "Recherche"],
		["es", "buscar", "Buscar"],
		["it", "ricerca", "Ricerca"],
		["nl", "zoeken", "Zoeken"],
		["pt", "pesquisa", "Pesquisa"],
	])("does not type the username into the %s search box", (_lang, name, label) => {
		document.body.innerHTML = `<form>
			<label for="s">${label}</label><input id="s" name="${name}" type="text">
			<input id="p" name="losenord" type="password">
		</form>`;
		const { username, password } = detectLoginFields();
		expect(password?.id).toBe("p");
		expect(username).toBeNull();
	});
});

describe("English behaviour is unchanged", () => {
	it("still prefers the password's neighbour over a hint match elsewhere", () => {
		document.body.innerHTML = `<form>
			<input id="acct" name="account" type="text">
			<input id="u" name="whatever" type="text">
			<input id="p" type="password">
		</form>`;
		// Rung 1 wins: nearest preceding text input, regardless of hints.
		expect(detectLoginFields().username?.id).toBe("u");
	});

	it("still resolves a plain username field", () => {
		expect(twoStep('name="login"')?.id).toBe("a");
	});
});
