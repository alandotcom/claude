/**
 * End-to-end tests against a real Claude Code session.
 *
 * The Agent SDK runs the Claude Code binary with this plugin loaded. One
 * streaming session plants a fact, compacts the conversation, asks for the
 * fact back, clears the conversation, and asks again. The assertions check
 * what the model actually called and what the tool actually returned. The
 * test spends a few model calls and needs the same credentials the claude CLI
 * uses.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { query, type Options, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { locateTranscript, readTranscript } from "../src/transcript.ts";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = "mcp__plugin_recall_recall__recall";

interface Turn {
	prompt: string;
	messages: SDKMessage[];
}

/**
 * Runs one Claude Code process and sends each prompt after the previous turn's
 * result message. A single process is the point: /clear keeps the process and
 * its MCP servers alive, which is the case the plugin has to get right.
 */
async function converse(prompts: string[], options: Options): Promise<Turn[]> {
	const turns: Turn[] = prompts.map((prompt) => ({ prompt, messages: [] }));
	let current = 0;
	let releaseNext: (() => void) | undefined;
	const waitForTurn = () => new Promise<void>((resolve) => (releaseNext = resolve));

	async function* input(): AsyncGenerator<SDKUserMessage> {
		for (const [index, prompt] of prompts.entries()) {
			if (index > 0) await waitForTurn();
			yield { type: "user", message: { role: "user", content: prompt }, parent_tool_use_id: null };
		}
	}

	for await (const message of query({ prompt: input(), options })) {
		turns[current]!.messages.push(message);
		if (message.type === "result") {
			current += 1;
			releaseNext?.();
		}
	}
	return turns;
}

function resultText(turn: Turn): string {
	const result = turn.messages.find((message) => message.type === "result");
	assert.ok(result && result.type === "result", `turn "${turn.prompt}" produced a result message`);
	assert.equal(result.subtype, "success", `turn "${turn.prompt}" ended with ${result.subtype}`);
	return result.result;
}

/** What the recall tool returned during a turn, read from the tool_result blocks that answer its tool_use blocks. */
function recallResults(turn: Turn): string[] {
	const ids = new Set<string>();
	const results: string[] = [];
	for (const message of turn.messages) {
		if (message.type !== "assistant" && message.type !== "user") continue;
		const content = message.message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (block.type === "tool_use" && block.name === TOOL) ids.add(block.id);
			if (block.type === "tool_result" && ids.has(block.tool_use_id)) results.push(JSON.stringify(block.content));
		}
	}
	return results;
}

function assistantText(turn: Turn): string {
	return turn.messages
		.filter((message) => message.type === "assistant")
		.map((message) => JSON.stringify(message.message.content).slice(0, 500))
		.join("\n");
}

test("recall reads past a compaction and forgets a cleared conversation", { timeout: 600_000 }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "recall-session-"));
	const code = `quartz-${Math.random().toString(16).slice(2, 10)}`;
	const fact = `The deploy passphrase is ${code}.`;
	const ask =
		"What is the deploy passphrase? Use the recall tool to look it up in this session's history before answering. Quote the passphrase exactly if recall finds it, and say so plainly if it does not.";
	const projectDirs = new Set<string>();

	try {
		const [planted, , , compacted, recalled, cleared, askedAgain] = await converse(
			[
				`Remember this for later and reply with the single word "noted": ${fact}`,
				// Claude Code refuses to compact a conversation with only a couple of messages.
				"Reply with one word: what colour is a ripe banana?",
				"Reply with one word: how many legs does a spider have?",
				"/compact",
				ask,
				"/clear",
				ask,
			],
			{
				cwd,
				model: "haiku",
				maxTurns: 30,
				// Load only this plugin. The user's own settings and plugins stay
				// out of the session so the test is the same on any machine.
				settingSources: [],
				plugins: [{ type: "local", path: pluginRoot }],
				allowedTools: [TOOL, "ToolSearch"],
			},
		);

		const init = planted!.messages.find((message) => message.type === "system" && message.subtype === "init");
		assert.ok(init && init.type === "system" && init.subtype === "init", "the session announced itself");
		assert.ok(init.tools.includes(TOOL), `the plugin's tool is registered; tools were ${init.tools.join(", ")}`);
		const sessionId = init.session_id;
		resultText(planted!);

		assert.ok(
			compacted!.messages.some((message) => message.type === "system" && message.subtype === "compact_boundary"),
			`the conversation compacted; messages were:\n${compacted!.messages.map((message) => JSON.stringify(message).slice(0, 300)).join("\n")}`,
		);

		const answer = resultText(recalled!);
		const found = recallResults(recalled!).join("\n");
		assert.ok(found.length > 0, `the model called the recall tool after the compaction; the turn was:\n${assistantText(recalled!)}`);
		assert.ok(found.includes(fact), `the recall result contains the fact; results were:\n${found}`);
		assert.ok(found.includes("] user #"), "the hit came from a pre-compaction user message");
		assert.ok(answer.includes(code), `the answer quotes the passphrase; answer was:\n${answer}`);

		const reset = cleared!.messages.find((message) => message.type === "conversation_reset");
		assert.ok(reset && reset.type === "conversation_reset", "/clear reset the conversation");

		resultText(askedAgain!);
		const afterClear = recallResults(askedAgain!).join("\n");
		assert.ok(afterClear.length > 0, `the model called the recall tool after /clear; the turn was:\n${assistantText(askedAgain!)}`);
		assert.ok(!afterClear.includes(code), `recall does not reach the cleared conversation; results were:\n${afterClear}`);

		// The transcript reader must understand the file the real session wrote.
		const transcript = locateTranscript({ ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, CLAUDE_PROJECT_DIR: cwd }, cwd, -1);
		projectDirs.add(dirname(transcript));
		const documents = readTranscript(transcript);
		assert.ok(documents.some((document) => document.role === "user" && document.body.includes(fact)));
		assert.ok(documents.some((document) => document.role === "compaction"));
		assert.ok(!documents.some((document) => document.role === `tool:${TOOL}`), "recall's own results are not indexed");
		assert.ok(!documents.some((document) => document.body.includes("<command-name>")), "slash command records are not indexed");

		// After /clear the transcript is filed under the session id the next init
		// message reports, which differs from the reset message's conversation id.
		const clearedInit = askedAgain!.messages.find((message) => message.type === "system" && message.subtype === "init");
		assert.ok(clearedInit && clearedInit.type === "system" && clearedInit.subtype === "init");
		projectDirs.add(
			dirname(locateTranscript({ ...process.env, CLAUDE_CODE_SESSION_ID: clearedInit.session_id, CLAUDE_PROJECT_DIR: cwd }, cwd, -1)),
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		// Claude Code wrote the session's transcripts under its projects
		// directory. They exist only because of this test.
		for (const dir of projectDirs) rmSync(dir, { recursive: true, force: true });
	}
});
