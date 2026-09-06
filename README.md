# claude

Claude Code plugins by Alan Cohen. The repository is its own plugin marketplace.

| Plugin | What it does |
| --- | --- |
| [`recall`](plugins/recall) | Searches earlier messages in the current session, including messages that dropped out of context when the session compacted. |

## Install

Add the marketplace once, then install the plugins you want:

```sh
claude plugin marketplace add alandotcom/claude
claude plugin install recall@claude
```

To try a plugin from a local checkout without installing it:

```sh
claude --plugin-dir ./plugins/recall
```

## Layout

Each plugin lives under `plugins/<name>` with its own `.claude-plugin/plugin.json`, README, and
tests. `.claude-plugin/marketplace.json` at the repository root lists every plugin.

## License

MIT
