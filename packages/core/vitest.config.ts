import { defineConfig } from "vitest/config";
import { linguiMacroPlugin } from "../../scripts/vite-lingui.mjs";

// Tests transitively import components that use Lingui macros; transform them the
// same way the platform builds do (shared helper).
export default defineConfig({
	plugins: [linguiMacroPlugin()],
});
