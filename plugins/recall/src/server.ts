/**
 * The recall MCP server. Claude Code starts one per session over stdio and
 * exposes its single tool to the model as mcp__plugin_recall_recall__recall.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as z from "zod/v4";
import { DEFAULT_LIMIT, search } from "./search.ts";
import { TranscriptNotFound, locateTranscript, readTranscript } from "./transcript.ts";

export const TOOL_DESCRIPTION =
	"Search earlier messages in this session, including messages that dropped out of context when the session compacted. " +
	"Use it before re-reading files or deciding something this session may already have decided, and on the first turn after a compaction. " +
	"Only this session is searched, so an empty result means nothing matched here, not that the subject never came up. " +
	"Queries may contain multiple words; ranking favors a literal phrase, then relevant term coverage, then recency. " +
	"Literal identifiers, paths, and punctuation are also supported.";

export function createServer(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): McpServer {
	const server = new McpServer(
		{ name: "recall", version: "0.1.0" },
		{
			// Claude Code defers MCP tool definitions and shows only tool names and
			// these instructions at session start, so the instructions name the
			// tool exactly as the model must request it.
			instructions:
				"The tool mcp__plugin_recall_recall__recall searches this session's own transcript, including messages that compaction replaced with a summary. " +
				"Load it with ToolSearch (select:mcp__plugin_recall_recall__recall) and call it when an earlier turn may already hold the answer, " +
				"before re-reading files or re-deciding something, and on the first turn after a compaction.",
		},
	);
	server.registerTool(
		"recall",
		{
			description: TOOL_DESCRIPTION,
			inputSchema: {
				query: z.string().trim().min(1).describe("Words, a phrase, identifier, path, or punctuation to search for."),
				limit: z.number().optional().describe(`Maximum matches to return (default ${DEFAULT_LIMIT}).`),
			},
		},
		async ({ query, limit }) => {
			let file: string;
			try {
				file = locateTranscript(env, cwd);
			} catch (error) {
				if (error instanceof TranscriptNotFound) {
					return { content: [{ type: "text", text: error.message }], isError: true };
				}
				throw error;
			}
			// The transcript grows during the session, so every call reads it again.
			const result = search(readTranscript(file), query, limit);
			return { content: [{ type: "text", text: result.text }] };
		},
	);
	return server;
}

export async function main(): Promise<void> {
	const server = createServer();
	await server.connect(new StdioServerTransport());
}
