---
status: done
native: false
area: Triage
---

While a local agent works in the vault, the window glows, and a follow button shows each note it changes, at the change.

> [!use] Using it
> Run Claude Code, Codex or OpenCode on notes in the vault. While it's working, Siri's colours glow round the window's inner edge and a follow button (an eye) appears in the top bar: press it and the window shows each note the agent changes, scrolled to the change; press it again to stop. Settings › AI turns the glow off, starts following on its own, and picks which agents to watch.

> [!how] How it works
> `main.js`'s `AgentWatch` checks the agents' own records every 1.5s: Claude Code's session files under `~/.claude/projects` (only the folders named after the vault, or folders in or around it), Codex's under `~/.codex/sessions` (today's and yesterday's), and OpenCode's database (`~/.local/share/opencode/opencode.db`, through macOS's `sqlite3`, read-only). A session written to in the last 45s is working (agents write between steps, so a long step goes quiet a while); its edits (Claude Code's Edit and Write, Codex's patches, OpenCode's edit and write) say which files. It's working in the vault when it runs from inside the vault or edited one of its notes in the last five minutes, including notes the vault links to from elsewhere (symlinks, as the test vault's `features/` is). Following, the window shows the latest edited note and scrolls to the edit's first line. The glow is a turning conic gradient masked to the edge (`styles.css`), still with Reduce motion.

> [!todo] Left to do
> When several agents work at once, it follows whichever edited last; it could say which one in the top bar.

> [!out] Left out
> Agents only reading notes don't count: only edits say where it's working. Edits made outside these three agents (by hand, or by sync) don't either.
