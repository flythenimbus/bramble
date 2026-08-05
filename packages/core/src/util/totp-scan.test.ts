import { describe, expect, it } from "vitest";
import { classifyScannedQr } from "./totp";

// The Microsoft case is a verbatim decode of the QR that Microsoft shows by
// default on its 2FA setup page. It reads perfectly; it just isn't a setup code,
// which is why "no QR found" was the wrong thing to tell the user.
const MICROSOFT_ACTIVATION =
	"https://login.microsoftonline.com/authenticatorApp/activateAccount" +
	"?source=qrCode&accountType=msa&code=M.C548_SN1.2.U.MsaArtifacts.17ce745a-cbb2-2b54-26e6-52b622a4822d" +
	"&uaid=535e4fe5562d4d60bc185e1c67cb4543&expires=3995052724";

const OTPAUTH = "otpauth://totp/GitHub:jordanavery?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

describe("classifyScannedQr", () => {
	it("accepts an otpauth:// URI", () => {
		expect(classifyScannedQr(OTPAUTH)).toEqual({ uri: OTPAUTH });
	});

	it("accepts a bare base32 setup key", () => {
		expect(classifyScannedQr("JBSWY3DPEHPK3PXP")).toEqual({ uri: "JBSWY3DPEHPK3PXP" });
	});

	it("trims before storing", () => {
		expect(classifyScannedQr(`  ${OTPAUTH}\n`).uri).toBe(OTPAUTH);
	});

	it("reports nothing decoded", () => {
		expect(classifyScannedQr(null).failure).toBe("not-found");
		expect(classifyScannedQr("").failure).toBe("not-found");
		expect(classifyScannedQr("   ").failure).toBe("not-found");
	});

	it("names Microsoft Authenticator rather than claiming no QR was found", () => {
		expect(classifyScannedQr(MICROSOFT_ACTIVATION)).toEqual({
			failure: "vendor-app",
			vendor: "Microsoft Authenticator",
		});
	});

	it("reports an authenticator export blob", () => {
		expect(classifyScannedQr("otpauth-migration://offline?data=CjkKCkhlbGxv").failure).toBe(
			"migration",
		);
	});

	it("reports an unrelated QR as decoded-but-not-a-code", () => {
		expect(classifyScannedQr("https://example.com/").failure).toBe("not-totp");
		expect(classifyScannedQr("WIFI:S:home;T:WPA;P:hunter2;;").failure).toBe("not-totp");
	});

	it("rejects HOTP, which we can't generate", () => {
		expect(
			classifyScannedQr("otpauth://hotp/Acme:me?secret=JBSWY3DPEHPK3PXP&counter=0").failure,
		).toBe("not-totp");
	});
});
