// Dev-only: runs code the e2e harness sends through the Vite dev server (see
// scripts/vite-e2e-bridge.mjs). Imported only under import.meta.env.DEV with VITE_E2E_BRIDGE set,
// and absent from release builds (e2e-bridge.test.ts).

if (import.meta.hot) {
	const hot = import.meta.hot;
	hot.on("bramble:e2e", async ({ id, code }: { id: string; code: string }) => {
		try {
			// biome-ignore lint/security/noGlobalEval: dev-only harness bridge, gated by a per-run token.
			const value = await globalThis.eval(`(async () => { ${code} })()`);
			hot.send("bramble:e2e-result", {
				id,
				ok: true,
				value: JSON.parse(JSON.stringify(value ?? null)),
			});
		} catch (e) {
			hot.send("bramble:e2e-result", { id, ok: false, error: String(e) });
		}
	});
}
