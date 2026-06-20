// Prints the UDID of the "newest" available iPhone simulator, so `cap run ios`
// can be given --target and skip its interactive picker (which can't receive
// arrow keys when wrapped in concurrently). Ranks by model number, then variant
// (Pro Max > Pro > Plus > base > e), then runtime version, then booted-ness.
import { execSync } from "node:child_process";

const data = JSON.parse(
	execSync("xcrun simctl list devices available --json", { encoding: "utf8" }),
);

const iphones = [];
for (const [runtime, list] of Object.entries(data.devices)) {
	const m = runtime.match(/iOS-(\d+)-(\d+)/);
	if (!m) continue;
	const runtimeVer = Number(m[1]) * 1000 + Number(m[2]);
	for (const d of list) {
		if (d.isAvailable && /^iPhone/.test(d.name)) iphones.push({ ...d, runtimeVer });
	}
}

if (iphones.length === 0) {
	console.error(
		"No available iPhone simulator. Create one in Xcode, or:\n" +
			'  xcrun simctl create "iPhone 17" com.apple.CoreSimulator.SimDeviceType.iPhone-17 <runtime>',
	);
	process.exit(1);
}

const variant = (name) =>
	/Pro Max/.test(name) ? 4 : /Pro/.test(name) ? 3 : /Plus/.test(name) ? 2 : /\de\b/.test(name) ? 0 : 1;
const rank = (d) => [
	Number((d.name.match(/iPhone (\d+)/) || [])[1] || 0),
	variant(d.name),
	d.runtimeVer,
	d.state === "Booted" ? 1 : 0,
];

iphones.sort((a, b) => {
	const ra = rank(a);
	const rb = rank(b);
	for (let i = 0; i < ra.length; i++) if (rb[i] !== ra[i]) return rb[i] - ra[i];
	return 0;
});

process.stdout.write(iphones[0].udid);
