---
status: done
native: false
area: Triage
parent: "[[Agent beam]]"
---

The lines an agent just changed on the page you're reading glow for a moment in its colour.

> [!use] Using it
> Read a note in the window while an agent edits it, or open one it changed in the last two minutes: each changed line lights up in the agent's colour (Claude Code's terracotta, Codex's blue, OpenCode's green, Antigravity's blue) with a bar at its left, and fades out over a few seconds.

> [!how] How it works
> `AgentWatch` reports each new edit to a note in the vault, with its new text (Claude Code's Edit, MultiEdit and Write, Codex's added patch lines, OpenCode's edit and write, Antigravity's file writes), to `onAgentEdit()`, which keeps it two minutes. Once the page has rendered (after the note changes on disk, or when it's shown), `lightChanges()` turns the text into the lines as they read on the page (`changedLines()`: Markdown's marks off, short lines left out), finds the innermost block holding each (paragraphs, list items, headings, table cells, callout titles, code), and gives it `muta-changed`, a tint and a bar in the agent's colour fading over 3.6s. Each edit lights once.

> [!out] Left out
> Removed text: there's nothing left on the page to light. Lines changed by hand or by sync.
