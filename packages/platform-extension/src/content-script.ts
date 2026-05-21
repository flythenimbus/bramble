/// <reference types="chrome" />

function findPasswordField(): HTMLInputElement | null {
	return document.querySelector<HTMLInputElement>('input[type="password"]');
}

function bootstrap(): void {
	const pw = findPasswordField();
	if (!pw) return;
	chrome.runtime.sendMessage({
		type: "AUTOFILL_QUERY",
		hostname: location.hostname,
	});
	// TODO: render inline dropdown, listen for AUTOFILL_FILL response, fill
	// username + password fields, null out references immediately after.
}

if (document.readyState === "loading") {
	document.addEventListener("DOMContentLoaded", bootstrap);
} else {
	bootstrap();
}
