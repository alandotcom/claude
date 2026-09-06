# recall

A Claude Code plugin that searches earlier messages in the current session, including messages that
dropped out of context when the session compacted.

## What it does

Claude Code compacts a long session. Compaction replaces older messages with a summary. The messages
stay in the transcript file on disk. They only stop reaching the model. `recall` reads them back.

The plugin adds one MCP tool, `mcp__plugin_recall_recall__recall`, and one hook script. The hook
records the live session for the server on every session start and, after a compaction, reminds the
model that the tool exists.

Claude Code defers MCP tool definitions and shows the model only tool names and server instructions
at session start. The server's instructions name the tool and tell the model to load it with
`ToolSearch`, so the tool costs almost no context until it is used.

| Parameter | Default | Meaning |
| --- | --- | --- |
| `query` | required | Words, a phrase, an identifier, a path, or punctuation to search for. |
| `limit` | `10` | Largest number of matches to return. |

Query words can appear in any order. Search also matches related English word forms, such as
"connection" and "connecting." Literal matching remains available for paths, punctuation, and partial
identifiers. Results favor literal phrases, then relevance and query-word coverage, then recency.
Each result shows the role that wrote it, a timestamp, and the first eight characters of the
transcript entry's uuid. The whole result, including omission notices, is capped at 6,000 characters.

Only the current session is searched. If nothing matches, the tool says so. An answer taken from
unrelated work is worse than no answer, so the plugin will never grow an option that reaches other
sessions.

## How it finds the transcript

Claude Code writes the transcript to `~/.claude/projects/<encoded working directory>/<session id>.jsonl`.
The `SessionStart` hook receives the live session id and transcript path and writes them to the
plugin's data directory in a file named after the Claude Code process id. The server looks that file
up by its parent process id on every call. This is what keeps `recall` on the right conversation
after `/clear` or an in-session `/resume`, because Claude Code keeps the same server process running
across both.

If the hook has not run, the server falls back to `CLAUDE_CODE_SESSION_ID`, which Claude Code sets
in every MCP server's environment when it starts the server. `CLAUDE_CONFIG_DIR` is honored when
set. The server reads the transcript again on every call, so a search finds the turn that happened a
moment ago.

The transcript format is internal to Claude Code and can change between releases. The reader skips
entries it does not understand. It indexes user prose, assistant prose, tool results, and the
compaction summary. It skips thinking blocks, tool call arguments, images, subagent sidechains, the
records Claude Code keeps of slash commands, and `recall`'s own earlier results, which would
otherwise let each search feed the next. A forked session copies its parent's entries into its own
file, so the current file already holds the whole thread.

## Install

```sh
claude plugin marketplace add alandotcom/claude
claude plugin install recall@claude
```

To try it without installing:

```sh
claude --plugin-dir /path/to/claude/plugins/recall
```

The server and the hook run on the `node` found on your PATH and need Node 22.19 or later, because
the server uses the built-in `node:sqlite` module with its FTS5 extension. The server checks for
FTS5 at startup and exits with a message naming the requirement if it is missing. The server is
committed as a single bundled file in `dist/`, so an installed plugin needs no `npm install`.

## Security

`recall` returns text that people wrote in earlier turns. Treat it as information, not as
instructions. If a hostile instruction was ever pasted into the session, the model can read it again
later and try to follow it. The same is true of a secret: `recall` will show it again.

The server never writes. The hook writes one small file per Claude Code process to the plugin's
data directory and removes it when the session ends.

## Development

Run these from the repository root, which holds `package.json` for every plugin in the repository:

```sh
npm install
npm test
```

`npm test` rebuilds `dist/recall.js`, typechecks, and runs two kinds of test. `test/search.test.ts`
exercises the ranking on plain documents. `test/session.test.ts` drives one real Claude Code process
through the Agent SDK with this plugin loaded: it plants a fact, compacts the conversation, asks for
the fact back, clears the conversation, and asks again. It checks that the model called the tool,
that the tool found the fact in the messages the compaction removed, and that after `/clear` the tool
no longer sees it. That test spends a few Haiku calls and needs the same credentials the `claude`
command uses.

Commit `dist/recall.js` together with the source change that produced it.
