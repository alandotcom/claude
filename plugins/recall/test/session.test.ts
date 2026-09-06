/**
 * End-to-end test against a real Claude Code session.
 *
 * The Agent SDK runs the Claude Code binary with this plugin loaded. The test
 * plants a fact, compacts the conversation, then asks for the fact back and
 * checks that the model called the recall tool and that the tool found the
 * fact in the pre-compaction messages. It costs a few model calls and needs
 * the same credentials the claude CLI uses.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { locateTranscript, readTranscript } from "../src/transcript.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = "mcp__plugin_recall_recall__recall";

interface ToolCall {
	input: unknown;
	response?: unknown;
}

async function run(prompt: string, options: Options): Promise<SDKMessage[]> {
	const messages: SDKMessage[] = [];
	for await (const message of query({ prompt, options })) messages.push(message);
	return messages;
}

function resultText(messages: SDKMessage[]): string {
	const result = messages.find((message) => message.type === "result");
	assert.ok(result && result.type === "result", "the session produced a result message");
	assert.equal(result.subtype, "success", `session ended with ${result.subtype}`);
	return result.result;
}

test("recall finds a fact that compaction removed from context", { timeout: 300_000 }, async () => {
	const sessionId = randomUUID();
	const cwd = mkdtempSync(join(tmpdir(), "recall-session-"));
	const fact = `The deploy passphrase is quartz-${randomUUID().slice(0, 8)}.`;
	const calls: ToolCall[] = [];

	const shared: Options = {
		cwd,
		model: "haiku",
		// Load only this plugin. The user's own settings, plugins, and MCP
		// servers stay out of the session so the test is the same on any machine.
		settingSources: [],
		plugins: [{ type: "local", path: pluginRoot }],
		allowedTools: [TOOL],
		hooks: {
			PreToolUse: [{ matcher: TOOL, hooks: [async (input) => {
				if (input.hook_event_name === "PreToolUse") calls.push({ input: input.tool_input });
				return {};
			}] }],
			PostToolUse: [{ matcher: TOOL, hooks: [async (input) => {
				if (input.hook_event_name === "PostToolUse") calls[calls.length - 1]!.response = input.tool_response;
				return {};
			}] }],
		},
	};

	try {
		const first = await run(`Remember this for later and reply with the single word "noted": ${fact}`, {
			...shared,
			sessionId,
			maxTurns: 2,
		});
		const init = first.find((message) => message.type === "system" && message.subtype === "init");
		assert.ok(init && init.type === "system" && init.subtype === "init", "the session announced itself");
		assert.ok(init.tools.includes(TOOL), `the plugin's tool is registered; tools were ${init.tools.join(", ")}`);
		resultText(first);

		// Claude Code refuses to compact a conversation with only a couple of
		// messages, so a few short exchanges go in front of the compaction.
		for (const filler of ["Reply with one word: what colour is a ripe banana?", "Reply with one word: how many legs does a spider have?"]) {
			resultText(await run(filler, { ...shared, resume: sessionId, maxTurns: 2 }));
		}

		const compacted = await run("/compact", { ...shared, resume: sessionId, maxTurns: 1 });
		const compactStatus = compacted
			.filter((message) => message.type === "system" && message.subtype === "status")
			.map((message) => JSON.stringify(message))
			.join("\n");
		assert.ok(
			compacted.some((message) => message.type === "system" && message.subtype === "compact_boundary"),
			`the conversation compacted; status messages were:\n${compactStatus}`,
		);

		const answer = resultText(
			await run(
				"What is the deploy passphrase? Use the recall tool to look it up in this session's history before answering, and quote the passphrase exactly.",
				{ ...shared, resume: sessionId, maxTurns: 4 },
			),
		);

		assert.ok(calls.length > 0, "the model called the recall tool");
		const responses = calls.map((call) => JSON.stringify(call.response ?? "")).join("\n");
		assert.ok(responses.includes(fact), `the recall result contains the fact; results were:\n${responses}`);
		assert.ok(responses.includes("] user #"), "the hit came from a pre-compaction user message");
		assert.ok(answer.includes(fact.match(/quartz-[0-9a-f]+/)![0]), `the answer quotes the passphrase; answer was:\n${answer}`);

		// The transcript reader must understand the file the real session wrote.
		const transcript = locateTranscript({ ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: cwd }, cwd);
		const documents = readTranscript(transcript);
		assert.ok(documents.some((document) => document.role === "user" && document.body.includes(fact)));
		assert.ok(documents.some((document) => document.role === "compaction"));
		assert.ok(documents.some((document) => document.role === `tool:${TOOL}`), "tool results are indexed under the tool's name");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
