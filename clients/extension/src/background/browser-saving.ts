/// <reference types="chrome" />

// Applies the default-password-manager choice from the background (see ../browser-saving.ts):
// on the grant, for a worker that can see `privacy` already, and at every start, for one that
// could not.

import { PRIVACY, reconcileDefaultPasswordManager } from "../browser-saving";
import { api } from "../platform-api";

api.permissions?.onAdded.addListener((added) => {
	if (added.permissions?.some((p) => PRIVACY.permissions.includes(p))) {
		void reconcileDefaultPasswordManager();
	}
});

void reconcileDefaultPasswordManager();
