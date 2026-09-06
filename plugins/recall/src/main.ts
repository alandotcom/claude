// Entry point for the bundled server in dist/recall.js.
import { DatabaseSync } from "node:sqlite";
import { main } from "./server.ts";

// Some Node releases ship node:sqlite without the FTS5 extension. Without this
// check the tool would register and then fail on every call with an error the
// model cannot act on.
try {
	const probe = new DatabaseSync(":memory:");
	probe.exec("CREATE VIRTUAL TABLE probe USING fts5(body, tokenize = 'porter unicode61')");
	probe.close();
} catch (error) {
	console.error(`recall needs Node.js 22.19 or later with SQLite FTS5 support; this is ${process.version}: ${String(error)}`);
	process.exit(1);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
