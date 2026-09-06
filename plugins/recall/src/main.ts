// Entry point for the bundled server in dist/recall.js.
import { main } from "./server.ts";

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
