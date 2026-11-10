import { describe, expect, it } from "vitest";
import {
	addVault,
	displayLabel,
	EMPTY_REGISTRY,
	findVault,
	hideVault,
	listedVaults,
	parseRegistry,
	removeVault,
	renameVault,
	type VaultRegistry,
} from "./vault-registry";

const rec = (id: string, label = "", createdAt = 0) => ({ id, label, createdAt });

describe("addVault", () => {
	it("appends a vault record", () => {
		const reg = addVault(EMPTY_REGISTRY, rec("a"));
		expect(reg.vaults.map((v) => v.id)).toEqual(["a"]);
	});

	it("keeps existing vaults when adding later ones", () => {
		const reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		expect(reg.vaults.map((v) => v.id)).toEqual(["a", "b"]);
	});

	it("rejects a duplicate id", () => {
		const reg = addVault(EMPTY_REGISTRY, rec("a"));
		expect(() => addVault(reg, rec("a"))).toThrow(/already registered/);
	});
});

describe("removeVault", () => {
	it("removes the vault, leaving the rest", () => {
		let reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		reg = removeVault(reg, "a");
		expect(reg.vaults.map((v) => v.id)).toEqual(["b"]);
	});

	it("is empty once the last vault is removed", () => {
		let reg = addVault(EMPTY_REGISTRY, rec("a"));
		reg = removeVault(reg, "a");
		expect(reg).toEqual(EMPTY_REGISTRY);
	});
});

describe("renameVault", () => {
	it("renames only the target vault", () => {
		let reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		reg = renameVault(reg, "b", "Work");
		expect(findVault(reg, "b")?.label).toBe("Work");
		expect(findVault(reg, "a")?.label).toBe("");
	});
});

describe("displayLabel", () => {
	it("uses the label when set", () => {
		expect(displayLabel({ label: "Personal", number: 4 }, 0)).toBe("Personal");
	});

	it("falls back to Vault N when blank or whitespace", () => {
		expect(displayLabel({ label: "", number: 1 }, 0)).toBe("Vault 1");
		expect(displayLabel({ label: "   ", number: 3 }, 0)).toBe("Vault 3");
	});
});

describe("an unnamed vault's number", () => {
	const names = (reg: VaultRegistry) => listedVaults(reg).map((v, i) => displayLabel(v, i));
	const three = () => addVault(addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b")), rec("c"));

	it("counts up as vaults are added", () => {
		expect(names(three())).toEqual(["Vault 1", "Vault 2", "Vault 3"]);
	});

	// Numbered by place, deleting Vault 1 relabelled the rest Vault 1 and Vault 2: the deleted
	// name stayed on the list and the last one seemed to go.
	it("stays with its vault when another is deleted", () => {
		expect(names(removeVault(three(), "a"))).toEqual(["Vault 2", "Vault 3"]);
		expect(names(removeVault(three(), "b"))).toEqual(["Vault 1", "Vault 3"]);
	});

	it("is never one a vault still on the list has", () => {
		const reg = addVault(removeVault(three(), "a"), rec("d"));
		expect(names(reg)).toEqual(["Vault 2", "Vault 3", "Vault 4"]);
	});

	it("survives a round trip through storage", () => {
		const stored = JSON.parse(JSON.stringify(removeVault(three(), "a")));
		expect(names(parseRegistry(stored))).toEqual(["Vault 2", "Vault 3"]);
	});

	it("is fixed at what it shows for a registry from before numbers were kept", () => {
		const old = { vaults: [rec("a"), rec("b", "Work"), rec("c")] };
		const reg = parseRegistry(old);
		expect(names(reg)).toEqual(["Vault 1", "Work", "Vault 3"]);
		expect(names(removeVault(reg, "a"))).toEqual(["Work", "Vault 3"]);
	});

	it("goes after the listed ones for a hidden vault from before numbers were kept", () => {
		const copy = { at: 5, blobHash: "abc", into: "b" };
		const old = { vaults: [{ ...rec("old"), hidden: copy }, rec("b"), rec("c")] };
		const reg = parseRegistry(old);
		expect(names(reg)).toEqual(["Vault 1", "Vault 2"]);
		expect(names(removeVault(reg, "b"))).toEqual(["Vault 3", "Vault 2"]);
	});
});

describe("parseRegistry", () => {
	it("returns an empty registry for null/undefined", () => {
		expect(parseRegistry(null)).toEqual(EMPTY_REGISTRY);
		expect(parseRegistry(undefined)).toEqual(EMPTY_REGISTRY);
	});

	it("returns an empty registry for a malformed value rather than throwing", () => {
		expect(parseRegistry({ vaults: "nope" })).toEqual(EMPTY_REGISTRY);
	});

	it("round-trips a valid registry", () => {
		const reg: VaultRegistry = { vaults: [{ ...rec("a", "Personal", 1), number: 1 }] };
		expect(parseRegistry(reg)).toEqual(reg);
	});

	it("strips the retired primaryId / legacyBlobVaultId fields (no migration needed)", () => {
		const parsed = parseRegistry({
			vaults: [rec("a", "Personal", 1)],
			primaryId: "a",
			legacyBlobVaultId: "a",
		});
		expect(parsed).toEqual({ vaults: [{ ...rec("a", "Personal", 1), number: 1 }] });
		expect("primaryId" in parsed).toBe(false);
		expect("legacyBlobVaultId" in parsed).toBe(false);
	});
});

describe("a vault hidden after a combine", () => {
	const reg = {
		vaults: [rec("old", "Personal", 1), rec("new", "Home", 2), rec("other", "Work", 3)],
	};
	const copy = { at: 5, blobHash: "abc", into: "new" };

	it("parses a record from before the field existed, and one from the label it replaced", () => {
		expect(parseRegistry(reg).vaults[0]?.hidden).toBeUndefined();
		const labelled = { vaults: [{ ...rec("old"), setAsideAt: 5 }] };
		expect(listedVaults(parseRegistry(labelled)).map((v) => v.id)).toEqual(["old"]);
	});

	it("leaves the list, keeping its place in the registry, which storage depends on", () => {
		const hidden = hideVault(reg, "old", copy);
		expect(listedVaults(hidden).map((v) => v.id)).toEqual(["new", "other"]);
		expect(hidden.vaults.map((v) => v.id)).toEqual(["old", "new", "other"]);
		expect(parseRegistry(hidden).vaults[0]?.hidden).toEqual(copy);
	});

	it("is listed rather than stranded when no other vault is left", () => {
		const alone = { vaults: [{ ...rec("old"), hidden: copy }] };
		expect(listedVaults(alone).map((v) => v.id)).toEqual(["old"]);
	});

	it("becomes an ordinary vault for good when the vault holding its copy goes", () => {
		// Listing it only while nothing else is would hide it again at the next vault added, with
		// logins added since, which were never copied.
		const hidden = hideVault(reg, "old", copy);
		const gone = removeVault(hidden, "new");
		expect(gone.vaults[0]).not.toHaveProperty("hidden");
		expect(listedVaults(gone).map((v) => v.id)).toEqual(["old", "other"]);
		const added = addVault(gone, rec("later"));
		expect(listedVaults(added).map((v) => v.id)).toEqual(["old", "other", "later"]);
	});

	it("stays hidden when some other vault goes", () => {
		const gone = removeVault(hideVault(reg, "old", copy), "other");
		expect(listedVaults(gone).map((v) => v.id)).toEqual(["new"]);
	});

	it("touches no other vault", () => {
		expect(hideVault(reg, "old", copy).vaults[1]).toEqual(reg.vaults[1]);
	});
});
