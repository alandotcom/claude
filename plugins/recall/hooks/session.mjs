// Runs on SessionStart and SessionEnd.
//
// Claude Code hands an MCP server the session id once, when it starts the
// server process, and keeps the same process across /clear and an in-session
// /resume. The id in the server's environment then points at a conversation
// the user has left. Every SessionStart hook run receives the live session id
// and transcript path, so this script writes them where the server can read
// them: one file per Claude Code process, keyed by that process's pid, which
// the server sees as its parent pid.
//
// After a compaction the script also prints a reminder. Claude Code adds the
// stdout of a hook that exits 0 to the model's context.

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REMINDER =
	"The conversation was just compacted. The summary replaced earlier messages, but the messages are still in the transcript. " +
	"Before re-reading files or re-deciding something, search for the detail you need with the tool mcp__plugin_recall_recall__recall " +
	"(load it with ToolSearch select:mcp__plugin_recall_recall__recall if it is not loaded). " +
	"An empty result means nothing in this session matched the query, so try other words before concluding the subject never came up.\n";

let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const hook = JSON.parse(raw);

const dataDir = process.env.CLAUDE_PLUGIN_DATA;
const pid = process.env.CLAUDE_PID ?? String(process.ppid);
if (dataDir) {
	const file = join(dataDir, "sessions", `${pid}.json`);
	if (hook.hook_event_name === "SessionEnd") {
		rmSync(file, { force: true });
	} else {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, JSON.stringify({ sessionId: hook.session_id, transcriptPath: hook.transcript_path }));
	}
}

if (hook.source === "compact") process.stdout.write(REMINDER);
