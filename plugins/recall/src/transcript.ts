/**
 * Reads the current Claude Code session transcript into search documents.
 *
 * Claude Code appends every message to
 * ~/.claude/projects/<encoded working directory>/<session id>.jsonl. When the
 * conversation compacts, the older messages stay in that file and a summary
 * entry is appended after them. This module reads the file back.
 *
 * The transcript format is internal to Claude Code and can change between
 * releases, so every reader below tolerates unknown entry shapes and skips
 * what it does not understand.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SearchDocument } from "./search.ts";

/** The environment variables the server reads to find its own transcript. */
export interface TranscriptEnv {
	CLAUDE_CODE_SESSION_ID?: string;
	CLAUDE_PROJECT_DIR?: string;
	CLAUDE_CONFIG_DIR?: string;
	HOME?: string;
}

export class TranscriptNotFound extends Error {}

/** Claude Code names the project directory by replacing every character outside [A-Za-z0-9] with "-". */
export function encodeProjectDir(projectDir: string): string {
	return projectDir.replace(/[^A-Za-z0-9]/g, "-");
}

/**
 * Finds the transcript for the session the server was started in. Claude Code
 * passes the session id to MCP server processes in CLAUDE_CODE_SESSION_ID.
 * The encoded project directory is tried first. Claude Code truncates and
 * hashes very long directory names, so a scan of every project directory is
 * the fallback.
 */
export function locateTranscript(env: TranscriptEnv, cwd: string): string {
	const sessionId = env.CLAUDE_CODE_SESSION_ID;
	if (!sessionId || !/^[A-Za-z0-9-]+$/.test(sessionId)) {
		throw new TranscriptNotFound(
			"recall cannot tell which session it belongs to: CLAUDE_CODE_SESSION_ID is not set for this server process.",
		);
	}
	const configDir = env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? homedir(), ".claude");
	const projectsDir = join(configDir, "projects");
	const fileName = `${sessionId}.jsonl`;

	const direct = join(projectsDir, encodeProjectDir(env.CLAUDE_PROJECT_DIR ?? cwd), fileName);
	if (existsSync(direct)) return direct;

	for (const dir of existsSync(projectsDir) ? readdirSync(projectsDir) : []) {
		const candidate = join(projectsDir, dir, fileName);
		if (existsSync(candidate)) return candidate;
	}
	throw new TranscriptNotFound(`recall cannot find a transcript for session ${sessionId} under ${projectsDir}.`);
}

/** Text a content part contributes to search. Thinking, tool calls, and images contribute nothing. */
function partText(part: any): string | undefined {
	if (typeof part === "string") return part;
	if (part?.type !== "text" || typeof part.text !== "string") return undefined;
	return part.text;
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const parts = content.map(partText).filter((text): text is string => typeof text === "string" && text.length > 0);
	return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Pulls the searchable text out of one transcript entry. Returns one document
 * per prose block, so a user turn that carries several tool results yields one
 * document per result, each labelled with the tool that produced it.
 */
export function entryDocuments(entry: any, toolNames: Map<string, string>): Omit<SearchDocument, "entry" | "when">[] {
	if (entry?.type !== "user" && entry?.type !== "assistant") return [];
	// A sidechain entry belongs to a subagent, and a meta entry is text Claude
	// Code injected around a local command. Neither is something a person or the
	// assistant said in this conversation.
	if (entry.isSidechain === true || entry.isMeta === true) return [];
	const message = entry.message;
	if (!message) return [];

	if (entry.isCompactSummary === true) {
		const text = contentText(message.content);
		return text ? [{ role: "compaction", body: text }] : [];
	}

	if (entry.type === "assistant") {
		if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part?.type === "tool_use" && typeof part.id === "string" && typeof part.name === "string") {
					toolNames.set(part.id, part.name);
				}
			}
		}
		const text = contentText(message.content);
		return text ? [{ role: "assistant", body: text }] : [];
	}

	if (!Array.isArray(message.content)) {
		const text = contentText(message.content);
		return text ? [{ role: "user", body: text }] : [];
	}

	const documents: Omit<SearchDocument, "entry" | "when">[] = [];
	const prose: string[] = [];
	for (const part of message.content) {
		if (part?.type === "tool_result") {
			const text = contentText(part.content);
			if (!text) continue;
			const toolName = typeof part.tool_use_id === "string" ? toolNames.get(part.tool_use_id) : undefined;
			documents.push({ role: `tool:${toolName ?? "?"}`, body: text });
			continue;
		}
		const text = partText(part);
		if (text) prose.push(text);
	}
	if (prose.length > 0) documents.unshift({ role: "user", body: prose.join("\n") });
	return documents;
}

/** Parses the transcript file into search documents in file order. */
export function readTranscript(file: string): SearchDocument[] {
	const documents: SearchDocument[] = [];
	const toolNames = new Map<string, string>();
	const seen = new Set<string>();
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (line.trim().length === 0) continue;
		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		// A forked session copies its parent's entries, so the same uuid can
		// appear more than once. The first copy wins.
		if (typeof entry?.uuid === "string") {
			if (seen.has(entry.uuid)) continue;
			seen.add(entry.uuid);
		}
		const when = Date.parse(entry?.timestamp ?? "");
		const id = typeof entry?.uuid === "string" ? entry.uuid.slice(0, 8) : "?";
		for (const document of entryDocuments(entry, toolNames)) {
			documents.push({ ...document, entry: id, when: Number.isFinite(when) ? when : Date.now() });
		}
	}
	return documents;
}
