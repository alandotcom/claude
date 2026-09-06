/**
 * Ranking and rendering for recall.
 *
 * Each search builds two temporary SQLite full-text indexes in memory: one
 * that matches exact words and one that matches stemmed English forms. Exact
 * matches weigh more than stemmed matches. A literal substring match of the
 * whole query beats both, because a path or identifier is usually what the
 * caller wants back verbatim.
 */

import { DatabaseSync } from "node:sqlite";

export const DEFAULT_LIMIT = 10;
export const SNIPPET_CHARS = 400;
export const MAX_CHARS = 6000;

/** One searchable piece of the transcript. */
export interface SearchDocument {
	/** Short identifier the result shows, so the caller can refer to the entry. */
	entry: string;
	/** "user", "assistant", "compaction", or "tool:<name>". */
	role: string;
	/** Milliseconds since the epoch. */
	when: number;
	body: string;
}

export interface Hit {
	role: string;
	when: number;
	entry: string;
	snippet: string;
}

interface RankedDocument {
	document: SearchDocument;
	exactScore: number;
	stemmedScore: number;
	exactTerms: Set<string>;
	matchedTerms: Set<string>;
	literalPhrase: boolean;
}

export function tokenize(input: string): string[] {
	return input.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function ftsQuery(terms: string[]): string {
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

export function rankDocuments(documents: SearchDocument[], query: string, queryTerms: string[]): RankedDocument[] {
	if (documents.length === 0) return [];
	const queryLower = query.toLowerCase();
	const uniqueTerms = [...new Set(queryTerms)];
	const index = new DatabaseSync(":memory:");
	try {
		index.exec(`CREATE VIRTUAL TABLE exact_docs USING fts5(body, tokenize = "unicode61 tokenchars '_'")`);
		index.exec(`CREATE VIRTUAL TABLE stemmed_docs USING fts5(body, tokenize = "porter unicode61 tokenchars '_'")`);
		const insertExact = index.prepare("INSERT INTO exact_docs(rowid, body) VALUES (?, ?)");
		const insertStemmed = index.prepare("INSERT INTO stemmed_docs(rowid, body) VALUES (?, ?)");
		index.exec("BEGIN");
		try {
			documents.forEach((document, position) => {
				const rowId = position + 1;
				insertExact.run(rowId, document.body);
				insertStemmed.run(rowId, document.body);
			});
			index.exec("COMMIT");
		} catch (error) {
			try {
				index.exec("ROLLBACK");
			} catch {
				// The insertion error is the one worth reporting.
			}
			throw error;
		}

		const ranked = new Map<number, RankedDocument>();
		const getRanked = (rowId: number): RankedDocument => {
			const existing = ranked.get(rowId);
			if (existing) return existing;
			const created: RankedDocument = {
				document: documents[rowId - 1]!,
				exactScore: 0,
				stemmedScore: 0,
				exactTerms: new Set(),
				matchedTerms: new Set(),
				literalPhrase: false,
			};
			ranked.set(rowId, created);
			return created;
		};
		const exactMatches = index.prepare(
			"SELECT rowid AS rowId, -bm25(exact_docs) AS score FROM exact_docs WHERE exact_docs MATCH ?",
		);
		const stemmedMatches = index.prepare(
			"SELECT rowid AS rowId, -bm25(stemmed_docs) AS score FROM stemmed_docs WHERE stemmed_docs MATCH ?",
		);
		if (uniqueTerms.length > 0) {
			for (const row of exactMatches.all(ftsQuery(uniqueTerms)) as any[]) getRanked(row.rowId).exactScore = row.score;
			for (const row of stemmedMatches.all(ftsQuery(uniqueTerms)) as any[]) getRanked(row.rowId).stemmedScore = row.score;
			for (const term of uniqueTerms) {
				for (const row of exactMatches.all(ftsQuery([term])) as any[]) {
					const hit = getRanked(row.rowId);
					hit.exactTerms.add(term);
					hit.matchedTerms.add(term);
				}
				for (const row of stemmedMatches.all(ftsQuery([term])) as any[]) getRanked(row.rowId).matchedTerms.add(term);
			}
		}

		for (let position = 0; position < documents.length; position++) {
			const document = documents[position]!;
			const lower = document.body.toLowerCase();
			if (!lower.includes(queryLower)) continue;
			const hit = getRanked(position + 1);
			// A partial single-token identifier is a fallback candidate. Exact FTS
			// matches still get phrase preference and BM25 relevance.
			hit.literalPhrase = queryLower.length > 0 && (uniqueTerms.length !== 1 || hit.exactTerms.has(uniqueTerms[0]!));
		}

		const denominator = Math.max(1, new Set(uniqueTerms).size);
		return [...ranked.values()].sort((left, right) => {
			const relevance = (rankedDocument: RankedDocument) => {
				const coverage = rankedDocument.matchedTerms.size / denominator;
				return (2 * rankedDocument.exactScore + rankedDocument.stemmedScore) * coverage * coverage;
			};
			return (
				Number(right.literalPhrase) - Number(left.literalPhrase) ||
				relevance(right) - relevance(left) ||
				right.document.when - left.document.when
			);
		});
	} finally {
		index.close();
	}
}

export function snippetAround(body: string, query: string, terms: string[]): string {
	const lower = body.toLowerCase();
	const phraseAt = lower.indexOf(query.toLowerCase());
	const termPositions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
	const at = phraseAt >= 0 ? phraseAt : termPositions.length > 0 ? Math.min(...termPositions) : -1;
	if (at < 0) return body.slice(0, SNIPPET_CHARS);
	const start = Math.max(0, at - Math.floor(SNIPPET_CHARS / 3));
	const lead = start > 0 ? "…" : "";
	return `${lead}${body.slice(start, start + SNIPPET_CHARS).replace(/\s+/g, " ").trim()}…`;
}

export function recallLimit(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : DEFAULT_LIMIT;
}

/** Formats hits as text and keeps the whole result under MAX_CHARS. */
export function render(hits: Hit[], totalMatches: number): { text: string; shown: number } {
	if (hits.length === 0) {
		const text =
			"No matches in this session. recall only searches the current session, so this means the query did not match here, not that the subject never came up anywhere.";
		return { text: text.slice(0, MAX_CHARS), shown: 0 };
	}

	const blocks = hits.map((hit) => {
		const stamp = new Date(hit.when).toISOString().replace("T", " ").slice(0, 16);
		return `[${stamp}] ${hit.role} #${hit.entry}\n${hit.snippet}`;
	});
	const output: string[] = [];
	let used = 0;
	for (const block of blocks) {
		const separator = output.length > 0 ? 2 : 0;
		if (used + separator + block.length > MAX_CHARS) break;
		output.push(block);
		used += separator + block.length;
	}
	let shown = output.length;
	let omitted = totalMatches - shown;
	if (omitted > 0) {
		let notice = `(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`;
		while (output.length > 0 && used + 2 + notice.length > MAX_CHARS) {
			const removed = output.pop()!;
			used -= removed.length + (output.length > 0 ? 2 : 0);
			shown = output.length;
			omitted = totalMatches - shown;
			notice = `(${omitted} further match${omitted === 1 ? "" : "es"} not shown; narrow the query)`;
		}
		if (used + (output.length > 0 ? 2 : 0) + notice.length <= MAX_CHARS) output.push(notice);
		else if (output.length === 0) return { text: notice.slice(0, MAX_CHARS), shown: 0 };
	}
	return { text: output.join("\n\n").slice(0, MAX_CHARS), shown };
}

/** Runs a whole search over already-extracted documents and returns the text for the model. */
export function search(documents: SearchDocument[], query: string, limit?: number): { text: string; matches: number; shown: number } {
	const terms = tokenize(query);
	const ranked = rankDocuments(documents, query, terms);
	const chosen = ranked.slice(0, recallLimit(limit)).map((rankedHit) => ({
		role: rankedHit.document.role,
		when: rankedHit.document.when,
		entry: rankedHit.document.entry,
		snippet: snippetAround(rankedHit.document.body, query, terms),
	}));
	const rendered = render(chosen, ranked.length);
	return { text: rendered.text, matches: ranked.length, shown: rendered.shown };
}
