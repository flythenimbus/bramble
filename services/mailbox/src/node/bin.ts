import { ConfigError } from "./config.ts";
import { startServer } from "./server.ts";

try {
	const server = await startServer(process.env);
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			server.close().then(
				() => process.exit(0),
				() => process.exit(1),
			);
		});
	}
} catch (err) {
	if (!(err instanceof ConfigError)) throw err;
	console.error(err.message);
	process.exit(1);
}
