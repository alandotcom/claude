import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_CHARS, type SearchDocument, search, snippetAround, tokenize } from "../src/search.ts";

function doc(entry: string, body: string, minute = 0, role = "user"): SearchDocument {
	return { entry, role, when: Date.UTC(2026, 0, 1, 12, minute), body };
}

test("tokenize keeps identifiers together and lowercases", () => {
	assert.deepEqual(tokenize("Use CONNECTION_TIMEOUT in src/search.ts"), ["use", "connection_timeout", "in", "src", "search", "ts"]);
});

test("search matches related word forms and reports each hit with role and entry id", () => {
	const result = search([doc("a1", "We kept connecting to the wrong host.", 1), doc("b2", "Unrelated text.", 2)], "connection");
	assert.equal(result.matches, 1);
	assert.equal(result.shown, 1);
	assert.match(result.text, /^\[2026-01-01 12:01\] user #a1\n/);
	assert.match(result.text, /connecting/);
});

test("a literal phrase outranks scattered term matches, and recency breaks ties", () => {
	const documents = [
		doc("old", "porter stemmer chosen", 1),
		doc("scattered", "the stemmer we chose was named after porter", 2),
		doc("new", "porter stemmer chosen", 3),
	];
	const result = search(documents, "porter stemmer");
	const order = [...result.text.matchAll(/#(\w+)\n/g)].map((match) => match[1]);
	assert.deepEqual(order, ["new", "old", "scattered"]);
});

test("literal punctuation and paths match even when tokens alone would not", () => {
	const result = search([doc("p", "edit src/search.ts then run tests"), doc("q", "search the ts files")], "src/search.ts");
	assert.equal(result.matches, 2, "both documents share the tokens");
	assert.match(result.text, /^\[[^\]]+\] user #p\n/, "the literal path is ranked first");
});

test("an empty result says the session was searched and nothing matched", () => {
	const result = search([doc("a", "nothing relevant")], "zebra");
	assert.equal(result.matches, 0);
	assert.match(result.text, /No matches in this session/);
});

test("limit and the character cap bound the result", () => {
	const documents = Array.from({ length: 40 }, (_, index) => doc(`d${index}`, `needle ${"filler ".repeat(200)}`, index));
	const limited = search(documents, "needle", 3);
	assert.equal(limited.matches, 40);
	assert.equal(limited.shown, 3);
	assert.match(limited.text, /\(37 further matches not shown; narrow the query\)/);

	const capped = search(documents, "needle", 40);
	assert.ok(capped.text.length <= MAX_CHARS);
	assert.ok(capped.shown < 40);
	assert.match(capped.text, /further matches not shown/);
});

test("snippetAround centres on the phrase and marks trimmed ends", () => {
	const body = `${"a".repeat(1000)} target phrase here ${"b".repeat(1000)}`;
	const snippet = snippetAround(body, "target phrase", ["target", "phrase"]);
	assert.ok(snippet.startsWith("…"));
	assert.ok(snippet.endsWith("…"));
	assert.ok(snippet.includes("target phrase here"));
	assert.ok(snippet.length <= 402);
});
