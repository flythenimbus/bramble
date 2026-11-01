// MessagePack, decode only, for Proton Pass passkeys (written by rmp_serde). Every length is
// checked against the bytes left before it is read, so a hostile file can't make us allocate.

export type MsgpackValue =
	| null
	| boolean
	| number
	| string
	| Uint8Array
	| MsgpackValue[]
	| Map<MsgpackValue, MsgpackValue>;

const MAX_DEPTH = 32;

/** Decode one value that spans all of `bytes`. Throws a fixed message, never the data. */
export function decodeMsgpack(bytes: Uint8Array): MsgpackValue {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const utf8 = new TextDecoder("utf-8", { fatal: true });
	let pos = 0;

	const take = (n: number): number => {
		if (n > bytes.length - pos) throw new Error("MessagePack value is truncated");
		pos += n;
		return pos - n;
	};
	const u8 = () => view.getUint8(take(1));
	const u16 = () => view.getUint16(take(2));
	const u32 = () => view.getUint32(take(4));
	const int64 = (signed: boolean): number => {
		const at = take(8);
		const n = Number(signed ? view.getBigInt64(at) : view.getBigUint64(at));
		if (!Number.isSafeInteger(n)) throw new Error("MessagePack integer is out of range");
		return n;
	};
	const str = (n: number) => {
		const at = take(n);
		return utf8.decode(bytes.subarray(at, at + n));
	};
	const bin = (n: number) => {
		const at = take(n);
		return bytes.slice(at, at + n);
	};
	// Pushed one by one, never preallocated: a claimed length costs nothing until its items exist.
	const array = (n: number, depth: number) => {
		const out: MsgpackValue[] = [];
		for (let i = 0; i < n; i++) out.push(value(depth));
		return out;
	};
	const map = (n: number, depth: number) => {
		const out = new Map<MsgpackValue, MsgpackValue>();
		for (let i = 0; i < n; i++) out.set(value(depth), value(depth));
		return out;
	};

	function value(depth: number): MsgpackValue {
		if (depth > MAX_DEPTH) throw new Error("MessagePack value is nested too deeply");
		const t = u8();
		if (t <= 0x7f) return t;
		if (t >= 0xe0) return t - 0x100;
		if (t >= 0xa0 && t <= 0xbf) return str(t & 0x1f);
		if (t >= 0x90 && t <= 0x9f) return array(t & 0x0f, depth + 1);
		if (t >= 0x80 && t <= 0x8f) return map(t & 0x0f, depth + 1);
		switch (t) {
			case 0xc0:
				return null;
			case 0xc2:
				return false;
			case 0xc3:
				return true;
			case 0xc4:
				return bin(u8());
			case 0xc5:
				return bin(u16());
			case 0xc6:
				return bin(u32());
			case 0xca:
				return view.getFloat32(take(4));
			case 0xcb:
				return view.getFloat64(take(8));
			case 0xcc:
				return u8();
			case 0xcd:
				return u16();
			case 0xce:
				return u32();
			case 0xcf:
				return int64(false);
			case 0xd0:
				return view.getInt8(take(1));
			case 0xd1:
				return view.getInt16(take(2));
			case 0xd2:
				return view.getInt32(take(4));
			case 0xd3:
				return int64(true);
			case 0xd9:
				return str(u8());
			case 0xda:
				return str(u16());
			case 0xdb:
				return str(u32());
			case 0xdc:
				return array(u16(), depth + 1);
			case 0xdd:
				return array(u32(), depth + 1);
			case 0xde:
				return map(u16(), depth + 1);
			case 0xdf:
				return map(u32(), depth + 1);
			default:
				throw new Error("MessagePack value uses an unsupported type");
		}
	}

	const out = value(0);
	if (pos !== bytes.length) throw new Error("MessagePack value has trailing bytes");
	return out;
}
