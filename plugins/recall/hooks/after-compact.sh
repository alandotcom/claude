#!/usr/bin/env bash
# Runs on SessionStart with source "compact". Claude Code adds the stdout of a
# hook that exits 0 to the model's context, so the text below reaches the model
# as the first thing it reads after the summary.
cat <<'TEXT'
The conversation was just compacted. The summary replaced earlier messages, but the messages are still in the transcript. Before re-reading files or re-deciding something, search for the detail you need with the tool mcp__plugin_recall_recall__recall (load it with ToolSearch select:mcp__plugin_recall_recall__recall if it is not loaded). An empty result means the subject was never discussed in this session.
TEXT
