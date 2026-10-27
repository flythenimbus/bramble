import { describe, expect, it } from "vitest";
import { mimeFor } from "./mime";

describe("mimeFor", () => {
	it("names common types and falls back to octet-stream", () => {
		expect(mimeFor("scan.PDF")).toBe("application/pdf");
		expect(mimeFor("photo.jpeg")).toBe("image/jpeg");
		expect(mimeFor("README")).toBe("application/octet-stream");
		expect(mimeFor("archive.tar.gz")).toBe("application/octet-stream");
	});
});
