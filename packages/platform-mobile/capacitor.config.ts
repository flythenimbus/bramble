import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "app.bramble.mobile",
	appName: "Bramble",
	webDir: "dist",
	// Default schemes serve from a secure-context localhost origin (capacitor://localhost
	// on iOS, https://localhost on Android), so WebCrypto and WASM work.
};

export default config;
