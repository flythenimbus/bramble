import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
	appId: "app.bramble.mobile",
	appName: "Bramble",
	webDir: "dist",
	// Default schemes serve from a secure-context localhost origin (capacitor://localhost
	// on iOS, https://localhost on Android), so WebCrypto and WASM work.
	plugins: {
		// Boot is async (storage -> version -> locale before the first render), so let the
		// native splash stay up until main.tsx calls SplashScreen.hide() after first paint.
		// Without this, the launch screen vanishes the instant the WebView attaches and a
		// blank white WebView shows during boot (the "white flash"). Background is the
		// splash image's black so the fade is seamless.
		SplashScreen: {
			launchAutoHide: false,
			backgroundColor: "#000000",
			androidScaleType: "CENTER_CROP",
			splashFullScreen: true,
			splashImmersive: true,
		},
	},
};

export default config;
