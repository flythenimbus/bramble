import { describe, expect, it } from "vitest";
import type { Entry, LoginEntryData, PasswordChange } from "../hooks/useVault";
import {
	MAX_PASSWORD_CHANGELOG,
	nextPasswordChangelog,
	withPasswordChangelog,
} from "./password-changelog";

const loginEntry = (over: Partial<Entry & LoginEntryData> = {}): Entry =>
	({
		id: "e1",
		type: "login",
		name: "acct",
		urls: [],
		username: "u",
		password: "p0",
		...over,
	}) as Entry;

const loginData = (over: Partial<LoginEntryData> = {}): LoginEntryData => ({
	type: "login",
	name: "acct",
	urls: [],
	username: "u",
	password: "p1",
	...over,
});

describe("nextPasswordChangelog", () => {
	it("records nothing for a create", () => {
		expect(nextPasswordChangelog(undefined, loginData(), 1000)).toBeUndefined();
	});

	it("records the superseded password when it changes", () => {
		const log = nextPasswordChangelog(
			loginEntry({ password: "old" }),
			loginData({ password: "new" }),
			5000,
		);
		expect(log).toEqual([{ value: "old", changedAt: 5000 }]);
	});

	it("records nothing when the password is unchanged", () => {
		// The breach-check write-back re-saves the entry with the same password.
		const prev = loginEntry({ password: "same" });
		expect(nextPasswordChangelog(prev, loginData({ password: "same" }), 5000)).toBeUndefined();
	});

	it("keeps an existing log across an edit that leaves the password alone", () => {
		const kept: PasswordChange[] = [{ value: "old", changedAt: 1000 }];
		const prev = loginEntry({ password: "same", passwordChangelog: kept });
		const log = nextPasswordChangelog(prev, loginData({ password: "same", name: "renamed" }), 5000);
		expect(log).toEqual(kept);
	});

	it("does not record a previously blank password", () => {
		const prev = loginEntry({ password: "" });
		expect(nextPasswordChangelog(prev, loginData({ password: "first" }), 5000)).toBeUndefined();
	});

	it("orders newest first", () => {
		const prev = loginEntry({
			password: "p2",
			passwordChangelog: [
				{ value: "p1", changedAt: 2000 },
				{ value: "p0", changedAt: 1000 },
			],
		});
		const log = nextPasswordChangelog(prev, loginData({ password: "p3" }), 3000);
		expect(log).toEqual([
			{ value: "p2", changedAt: 3000 },
			{ value: "p1", changedAt: 2000 },
			{ value: "p0", changedAt: 1000 },
		]);
	});

	it("caps the log, dropping the oldest", () => {
		const full: PasswordChange[] = Array.from({ length: MAX_PASSWORD_CHANGELOG }, (_, i) => ({
			value: `old-${i}`,
			changedAt: 1000 - i,
		}));
		const prev = loginEntry({ password: "current", passwordChangelog: full });
		const log = nextPasswordChangelog(prev, loginData({ password: "newest" }), 9000);
		expect(log).toHaveLength(MAX_PASSWORD_CHANGELOG);
		expect(log?.[0]).toEqual({ value: "current", changedAt: 9000 });
		// The oldest row fell off the end.
		expect(log?.map((c) => c.value)).not.toContain(`old-${MAX_PASSWORD_CHANGELOG - 1}`);
	});

	it("keeps rotations seconds apart distinguishable", () => {
		// The propagation-lag case: rotate, then rotate again 2s later.
		const first = nextPasswordChangelog(
			loginEntry({ password: "a" }),
			loginData({ password: "b" }),
			1_000_000,
		);
		const prev = loginEntry({ password: "b", passwordChangelog: first });
		const second = nextPasswordChangelog(prev, loginData({ password: "c" }), 1_002_000);
		expect(second).toEqual([
			{ value: "b", changedAt: 1_002_000 },
			{ value: "a", changedAt: 1_000_000 },
		]);
	});

	it("records nothing when a non-login becomes a login", () => {
		const prev = { id: "e1", type: "note", name: "n" } as Entry;
		expect(nextPasswordChangelog(prev, loginData(), 5000)).toBeUndefined();
	});
});

describe("withPasswordChangelog", () => {
	it("discards a caller-supplied log and derives from the stored entry", () => {
		const forged: PasswordChange[] = [{ value: "attacker-seeded", changedAt: 1 }];
		const next = loginEntry({ password: "new", passwordChangelog: forged });
		const out = withPasswordChangelog(next, loginEntry({ password: "old" }), 5000);
		expect(out.type === "login" && out.passwordChangelog).toEqual([
			{ value: "old", changedAt: 5000 },
		]);
	});

	it("strips a caller-supplied log on a create", () => {
		const next = loginEntry({ passwordChangelog: [{ value: "forged", changedAt: 1 }] });
		const out = withPasswordChangelog(next, undefined, 5000);
		expect(out.type === "login" && out.passwordChangelog).toBeUndefined();
	});

	it("leaves non-login entries untouched", () => {
		const note = { id: "e1", type: "note", name: "n" } as Entry;
		expect(withPasswordChangelog(note, undefined, 5000)).toBe(note);
	});

	it("drops the undefined key on the JSON round trip", () => {
		// buildPayload stringifies the entry; an absent log must not reach the blob as a key.
		const out = withPasswordChangelog(loginEntry(), undefined, 5000);
		expect(Object.keys(JSON.parse(JSON.stringify(out)))).not.toContain("passwordChangelog");
	});
});
