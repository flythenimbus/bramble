import { describe, expect, it } from "vitest";
import type { Entry } from "../hooks/useVault";
import { loginHosts, toAutofillIndex } from "./autofill-index";

describe("loginHosts", () => {
	it("lines each URL's port up with its hostname", () => {
		expect(
			loginHosts([
				"http://nas.local:5000/webman",
				"androidapp://com.synology.dsfile",
				"",
				"https://nas.local",
				"http://[fe80::1]:8080/",
			]),
		).toEqual({
			hostnames: ["nas.local", "nas.local", "[fe80::1]"],
			ports: ["5000", "", "8080"],
		});
	});

	it("leaves ports out when no URL names one", () => {
		expect(loginHosts(["https://example.com/login", "example.org"])).toEqual({
			hostnames: ["example.com", "example.org"],
		});
	});

	it("reads a bare host with a port as https", () => {
		expect(loginHosts(["example.com:1234", "localhost:8080/admin", "192.168.1.10:5000"])).toEqual({
			hostnames: ["example.com", "localhost", "192.168.1.10"],
			ports: ["1234", "8080", "5000"],
		});
	});

	it("reads a scheme's own default port as none", () => {
		expect(loginHosts(["https://nas.local:443", "http://nas.local:80"])).toEqual({
			hostnames: ["nas.local", "nas.local"],
		});
		expect(loginHosts(["http://nas.local:443"]).ports).toEqual(["443"]);
	});
});

describe("toAutofillIndex", () => {
	it("carries a login's ports into its index entry", () => {
		const login = {
			type: "login",
			id: "dsm",
			name: "DSM",
			urls: ["http://192.168.1.10:5000"],
			username: "admin",
			password: "pw",
			subdomainMatch: "exact",
		} as unknown as Entry;
		expect(toAutofillIndex([login])[0]).toMatchObject({
			hostnames: ["192.168.1.10"],
			ports: ["5000"],
			subdomainMatch: "exact",
		});
	});
});
