import syntaxJsx from "@babel/plugin-syntax-jsx";
import presetTypescript from "@babel/preset-typescript";
import linguiMacro from "@lingui/babel-plugin-lingui-macro";
import babel from "vite-plugin-babel";

// Transforms Lingui <Trans>/t`` macros via Babel. Needed because the project's
// @vitejs/plugin-react is the oxc-based v6 (no `babel` option), so the macro must
// run in a separate, bundler-agnostic transform hook. `enforce: "pre"` runs it
// before oxc handles JSX; preset-typescript + syntax-jsx let Babel parse TSX
// while leaving the JSX for oxc. Plugins are passed by reference so they resolve
// from the repo root regardless of the consuming package. Shared by both platform
// vite configs and core's vitest config.
export function linguiMacroPlugin() {
	return babel({
		enforce: "pre",
		include: /\.tsx$/,
		exclude: /node_modules/,
		babelConfig: {
			babelrc: false,
			configFile: false,
			presets: [presetTypescript],
			plugins: [syntaxJsx, linguiMacro],
		},
	});
}
