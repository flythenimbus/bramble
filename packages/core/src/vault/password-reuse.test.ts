import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { reusedPasswordIds } from "./password-reuse";

const login = (id: string, password: string, over: Partial<Entry> = {}): Entry =>
	({ id, type: "login", name: id, urls: [], username: "", password, ...over }) as Entry;

describe("reusedPasswordIds", () => {
	it("flags every login that shares a password with another", () => {
		const ids = reusedPasswordIds([
			login("a", "hunter2"),
			login("b", "hunter2"),
			login("c", "unique"),
		]);
		expect([...ids].sort()).toEqual(["a", "b"]);
	});

	it("ignores archived logins, which are out of use", () => {
		const ids = reusedPasswordIds([
			login("a", "hunter2"),
			login("b", "hunter2", { archivedAt: 1 }),
		]);
		expect(ids.size).toBe(0);
	});

	it("ignores empty passwords and other entry types", () => {
		const note = { id: "n", type: "note", name: "n", content: "hunter2" } as Entry;
		const ids = reusedPasswordIds([login("a", ""), login("b", ""), login("c", "hunter2"), note]);
		expect(ids.size).toBe(0);
	});

	it("matches passwords exactly, case included", () => {
		expect(reusedPasswordIds([login("a", "Hunter2"), login("b", "hunter2")]).size).toBe(0);
	});
});
