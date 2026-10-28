import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "sqlite",
	schema: "./src/core/schema.ts",
	out: "./drizzle",
});
