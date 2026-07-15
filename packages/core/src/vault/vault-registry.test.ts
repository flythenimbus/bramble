import { describe, expect, it } from "vitest";
import {
	addVault,
	displayLabel,
	EMPTY_REGISTRY,
	findVault,
	parseRegistry,
	removeVault,
	renameVault,
	setPrimary,
	type VaultRegistry,
} from "./vault-registry";

const rec = (id: string, label = "", createdAt = 0) => ({ id, label, createdAt });

describe("addVault", () => {
	it("makes the first vault primary and gives it the legacy blob slot", () => {
		const reg = addVault(EMPTY_REGISTRY, rec("a"));
		expect(reg.vaults.map((v) => v.id)).toEqual(["a"]);
		expect(reg.primaryId).toBe("a");
		expect(reg.legacyBlobVaultId).toBe("a");
	});

	it("does not move the primary or legacy slot when adding later vaults", () => {
		const reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		expect(reg.vaults.map((v) => v.id)).toEqual(["a", "b"]);
		expect(reg.primaryId).toBe("a");
		expect(reg.legacyBlobVaultId).toBe("a");
	});

	it("rejects a duplicate id", () => {
		const reg = addVault(EMPTY_REGISTRY, rec("a"));
		expect(() => addVault(reg, rec("a"))).toThrow(/already registered/);
	});
});

describe("removeVault", () => {
	it("reassigns the primary to the first remaining vault when the primary is removed", () => {
		let reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		reg = removeVault(reg, "a");
		expect(reg.vaults.map((v) => v.id)).toEqual(["b"]);
		expect(reg.primaryId).toBe("b");
	});

	it("leaves the primary alone when a non-primary vault is removed", () => {
		let reg = setPrimary(addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b")), "b");
		reg = removeVault(reg, "a");
		expect(reg.primaryId).toBe("b");
	});

	it("clears primary and legacy slot when the last vault is removed", () => {
		let reg = addVault(EMPTY_REGISTRY, rec("a"));
		reg = removeVault(reg, "a");
		expect(reg).toEqual(EMPTY_REGISTRY);
	});

	it("clears legacyBlobVaultId when that vault is removed", () => {
		let reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		reg = removeVault(reg, "a");
		expect(reg.legacyBlobVaultId).toBeNull();
	});
});

describe("renameVault / setPrimary", () => {
	it("renames only the target vault", () => {
		let reg = addVault(addVault(EMPTY_REGISTRY, rec("a")), rec("b"));
		reg = renameVault(reg, "b", "Work");
		expect(findVault(reg, "b")?.label).toBe("Work");
		expect(findVault(reg, "a")?.label).toBe("");
	});

	it("setPrimary throws on an unknown id", () => {
		const reg = addVault(EMPTY_REGISTRY, rec("a"));
		expect(() => setPrimary(reg, "nope")).toThrow(/unknown vault id/);
	});
});

describe("displayLabel", () => {
	it("uses the label when set", () => {
		expect(displayLabel("Personal", 0)).toBe("Personal");
	});

	it("falls back to Vault N (1-based) when blank or whitespace", () => {
		expect(displayLabel("", 0)).toBe("Vault 1");
		expect(displayLabel("   ", 2)).toBe("Vault 3");
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
		const reg: VaultRegistry = {
			vaults: [rec("a", "Personal", 1)],
			primaryId: "a",
			legacyBlobVaultId: "a",
		};
		expect(parseRegistry(reg)).toEqual(reg);
	});
});
