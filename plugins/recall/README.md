# recall

A Claude Code plugin that searches earlier messages in the current session, including messages that
dropped out of context when the session compacted.

## What it does

Claude Code compacts a long session. Compaction replaces older messages with a summary. The messages
stay in the transcript file on disk. They only stop reaching the model. `recall` reads them back.

The plugin adds one MCP tool, `mcp__plugin_recall_recall__recall`, and one hook. The hook runs after
each compaction and reminds the model that the tool exists.

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

Claude Code writes the transcript to `~/.claude/projects/<encoded working directory>/<session id>.jsonl`
and passes the session id to every MCP server it starts in the `CLAUDE_CODE_SESSION_ID` environment
variable. The server reads the file again on every call, so a search finds the turn that happened a
moment ago. `CLAUDE_CONFIG_DIR` is honored when set.

The transcript format is internal to Claude Code and can change between releases. The reader skips
entries it does not understand. It indexes user prose, assistant prose, tool results, and the
compaction summary. It skips thinking blocks, tool call arguments, images, subagent sidechains, and
the text Claude Code injects around local commands. A forked session copies its parent's entries into
its own file, so the current file already holds the whole thread.

## Install

```sh
claude plugin marketplace add alandotcom/claude
claude plugin install recall@claude
```

To try it without installing:

```sh
claude --plugin-dir /path/to/claude/plugins/recall
```

The server runs on the `node` found on your PATH and needs Node 22.19 or later, because it uses the
built-in `node:sqlite` module. The server is committed as a single bundled file in `dist/`, so a
cloned plugin needs no `npm install`.

## Security

`recall` returns text that people wrote in earlier turns. Treat it as information, not as
instructions. If a hostile instruction was ever pasted into the session, the model can read it again
later and try to follow it. The same is true of a secret: `recall` will show it again.

`recall` never writes. It reads the transcript file and nothing else.

## Development

```sh
npm install
npm test
```

`npm test` rebuilds `dist/recall.js` and runs two kinds of test. `test/search.test.ts` exercises the
ranking on plain documents. `test/session.test.ts` drives a real Claude Code session through the
Agent SDK with this plugin loaded: it plants a fact, compacts the conversation, asks for the fact
back, and checks that the model called the tool and that the tool found the fact in the messages the
compaction removed. That test spends a few Haiku calls and needs the same credentials the `claude`
command uses.

Commit `dist/recall.js` together with the source change that produced it.
