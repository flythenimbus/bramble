// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { looksLikeEmail } from "./detection";

// The alias suggestion is offered on email fields and nowhere else, so this predicate is the
// whole gate. A false positive types a generated address into a field that wanted a handle and
// breaks the signup; a false negative just means no offer. See docs/email-aliases.md.

function field(html: string): HTMLInputElement {
	document.body.innerHTML = html;
	const el = document.body.querySelector("input");
	if (!el) throw new Error("no input in fixture");
	return el;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("looksLikeEmail", () => {
	it.each([
		['<input type="email">', "the type says so outright"],
		['<input type="text" autocomplete="email">', "the autocomplete token says so"],
		['<input type="text" autocomplete="section-signup email">', "a token among others"],
		['<input type="text" inputmode="email">', "the keyboard hint says so"],
		['<input type="text" name="email">', "the name says so"],
		['<input type="text" id="user_email">', "the id says so"],
		['<input type="text" placeholder="E-mail address">', "the placeholder says so"],
		['<input type="text" aria-label="Correo electrónico">', "es"],
		['<input type="text" name="courriel">', "fr"],
		['<input type="text" placeholder="E-Mail-Adresse">', "de"],
		['<input type="text" name="posta_elettronica">', "it"],
		['<input type="text" placeholder="メールアドレス">', "ja"],
		['<input type="text" placeholder="이메일">', "ko"],
	])("accepts %s (%s)", (html) => {
		expect(looksLikeEmail(field(html))).toBe(true);
	});

	it("accepts a field whose label, not its attributes, names an email", () => {
		document.body.innerHTML = '<label for="x">Email address</label><input id="x" type="text">';
		const el = document.body.querySelector("input") as HTMLInputElement;
		expect(looksLikeEmail(el)).toBe(true);
	});

	// The point of the predicate: these are all fields detection would happily call a username.
	it.each([
		['<input type="password">', "a password field is nonsense here"],
		['<input type="text" name="username">', "a handle is not an email"],
		['<input type="text" autocomplete="username">', "the token a handle field carries"],
		['<input type="text" name="login">', "login is not an email"],
		['<input type="text" name="account">', "account could be either, so it is not assumed"],
		['<input type="text" name="benutzername">', "de handle"],
		['<input type="text" name="usuario">', "es handle"],
		['<input type="text" name="utente">', "it handle"],
		['<input type="text" name="full_name">', "an unrelated field"],
		['<input type="hidden" name="email">', "hidden fields are never offered to"],
	])("rejects %s (%s)", (html) => {
		expect(looksLikeEmail(field(html))).toBe(false);
	});

	// A search box named "mail" is still a search box, and the site header is full of them.
	it("rejects a search field even when it mentions mail", () => {
		expect(
			looksLikeEmail(field('<input type="text" name="mail_search" placeholder="Search">')),
		).toBe(false);
	});

	// `autocomplete="username"` does not veto: signup forms put it on email fields constantly.
	it("accepts an email field that also carries the username token", () => {
		expect(looksLikeEmail(field('<input type="email" autocomplete="username">'))).toBe(true);
		expect(
			looksLikeEmail(field('<input type="text" autocomplete="username" placeholder="Email">')),
		).toBe(true);
	});
});
