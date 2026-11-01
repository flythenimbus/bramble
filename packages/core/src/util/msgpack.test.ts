import { describe, expect, it } from "vitest";
import { decodeMsgpack } from "./msgpack";

const bytes = (...b: number[]) => new Uint8Array(b);

describe("decodeMsgpack", () => {
	it("reads the scalar types", () => {
		expect(decodeMsgpack(bytes(0xc0))).toBeNull();
		expect(decodeMsgpack(bytes(0xc2))).toBe(false);
		expect(decodeMsgpack(bytes(0xc3))).toBe(true);
		expect(decodeMsgpack(bytes(0x7f))).toBe(127);
		expect(decodeMsgpack(bytes(0xe0))).toBe(-32);
		expect(decodeMsgpack(bytes(0xcc, 0x88))).toBe(136);
		expect(decodeMsgpack(bytes(0xcd, 0x01, 0xc2))).toBe(450);
		expect(decodeMsgpack(bytes(0xce, 0xff, 0xff, 0xff, 0xff))).toBe(0xffffffff);
		expect(decodeMsgpack(bytes(0xcf, 0, 0, 0, 1, 0, 0, 0, 0))).toBe(2 ** 32);
		expect(decodeMsgpack(bytes(0xd0, 0x80))).toBe(-128);
		expect(decodeMsgpack(bytes(0xd1, 0xff, 0x00))).toBe(-256);
		expect(decodeMsgpack(bytes(0xd2, 0xff, 0xff, 0xff, 0xff))).toBe(-1);
		expect(decodeMsgpack(bytes(0xd3, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xf9))).toBe(-7);
		expect(decodeMsgpack(bytes(0xcb, 0x3f, 0xf8, 0, 0, 0, 0, 0, 0))).toBe(1.5);
	});

	it("reads strings and binary", () => {
		expect(decodeMsgpack(bytes(0xa3, 0x6b, 0x65, 0x79))).toBe("key");
		expect(decodeMsgpack(bytes(0xd9, 0x02, 0xc3, 0xa9))).toBe("é");
		expect(decodeMsgpack(bytes(0xc4, 0x02, 0x01, 0x02))).toEqual(bytes(1, 2));
	});

	it("reads arrays, and maps as Map so a key can never land on a prototype", () => {
		expect(decodeMsgpack(bytes(0x92, 0x01, 0xa1, 0x61))).toEqual([1, "a"]);
		expect(decodeMsgpack(bytes(0xdc, 0x00, 0x02, 0x01, 0x02))).toEqual([1, 2]);
		const map = decodeMsgpack(bytes(0x82, 0xa1, 0x76, 0x01, 0xa1, 0x63, 0x90));
		expect(map).toEqual(
			new Map<unknown, unknown>([
				["v", 1],
				["c", []],
			]),
		);
		const proto = decodeMsgpack(bytes(0x81, 0xa9, ...new TextEncoder().encode("__proto__"), 0x01));
		expect(proto).toEqual(new Map([["__proto__", 1]]));
	});

	it("refuses a length that runs past the end", () => {
		expect(() => decodeMsgpack(bytes(0xa3, 0x61))).toThrow(/truncated/);
		expect(() => decodeMsgpack(bytes(0xc6, 0xff, 0xff, 0xff, 0xff, 0x00))).toThrow(/truncated/);
		expect(() => decodeMsgpack(bytes(0xdd, 0xff, 0xff, 0xff, 0xff))).toThrow(/truncated/);
		expect(() => decodeMsgpack(bytes())).toThrow(/truncated/);
	});

	it("refuses trailing bytes, extension types, deep nesting, bad UTF-8 and unsafe integers", () => {
		expect(() => decodeMsgpack(bytes(0x01, 0x02))).toThrow(/trailing/);
		expect(() => decodeMsgpack(bytes(0xd4, 0x01, 0x00))).toThrow(/unsupported/);
		expect(() => decodeMsgpack(bytes(0xc1))).toThrow(/unsupported/);
		expect(() => decodeMsgpack(new Uint8Array(100).fill(0x91))).toThrow(/nested/);
		expect(() => decodeMsgpack(bytes(0xa1, 0xff))).toThrow();
		expect(() => decodeMsgpack(bytes(0xcf, 0xff, 0, 0, 0, 0, 0, 0, 0))).toThrow(/range/);
	});
});
