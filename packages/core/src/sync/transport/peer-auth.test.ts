import { describe, expect, it, vi } from "vitest";
import { identityWasm, peerPipe, rosterOf } from "../../test/transport-fakes";
import { authenticatePeer } from "./peer-auth";

describe("authenticatePeer skipPeer", () => {
	it("closes a peer it is told to skip before any handshake", async () => {
		const { a, b, closed } = peerPipe();
		const wasm = identityWasm();
		const init = vi.spyOn(wasm, "handshake_start_initiator");
		const resp = vi.spyOn(wasm, "handshake_start_responder");
		const reports: string[] = [];
		b.channel.send("bbbb");

		const result = await authenticatePeer(
			{
				devicePrivB64: "priv-aaaa",
				devicePubB64: "aaaa",
				roster: rosterOf(["aaaa", "bbbb"]),
				wasm,
				report: (r) => reports.push(r),
				skipPeer: (pub) => pub === "bbbb",
			},
			a,
		);

		expect(result).toBeNull();
		expect(closed()).toBe(1);
		expect(init).not.toHaveBeenCalled();
		expect(resp).not.toHaveBeenCalled();
		expect(reports).toContain("bbbb is on the local link, not over the relay");
	});

	it("skips it for good where the transport can, so its next hello does not reconnect", async () => {
		const { a, b, closed } = peerPipe();
		const skip = vi.fn();
		b.channel.send("bbbb");

		await authenticatePeer(
			{
				devicePrivB64: "priv-aaaa",
				devicePubB64: "aaaa",
				roster: rosterOf(["aaaa", "bbbb"]),
				wasm: identityWasm(),
				report: () => {},
				skipPeer: (pub) => pub === "bbbb",
			},
			{ ...a, skip },
		);

		expect(skip).toHaveBeenCalledOnce();
		expect(closed()).toBe(0);
	});

	it("authenticates a peer skipPeer does not name", async () => {
		const { a, b } = peerPipe();
		const side = (pub: string, peer: typeof a) =>
			authenticatePeer(
				{
					devicePrivB64: `priv-${pub}`,
					devicePubB64: pub,
					roster: rosterOf(["aaaa", "bbbb"]),
					wasm: identityWasm(),
					report: () => {},
					skipPeer: (other) => other === "cccc",
				},
				peer,
			);
		const [fromA, fromB] = await Promise.all([side("aaaa", a), side("bbbb", b)]);
		expect(fromA?.peerPub).toBe("bbbb");
		expect(fromB?.peerPub).toBe("aaaa");
	});
});
