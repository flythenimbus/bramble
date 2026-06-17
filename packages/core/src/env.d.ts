// Vite statically replaces import.meta.env.DEV at build: true under the dev build
// (`vite build --mode development`), false for the production `vite build`. Minimal
// ambient type so @core typechecks without depending on vite/client.
interface ImportMetaEnv {
	readonly DEV: boolean;
	readonly PROD: boolean;
	readonly MODE: string;
}
interface ImportMeta {
	readonly env: ImportMetaEnv;
}
