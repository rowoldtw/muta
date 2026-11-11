---
status: done
native: false
area: Triage
---

While a local agent works in the vault, the window glows, and a follow button shows each note it changes, at the change.

> [!use] Using it
> Run Claude Code, Codex or OpenCode on notes in the vault. While it's working, a beam of light in the agent's colours (Claude Code's terracotta, Codex's blues, OpenCode's greens) rides round the page's edge, inside the window's frame, fading out as soon as it finishes, and a follow button (an eye) appears in the top bar: press it and the window shows each note the agent changes, scrolled to the change; press it again to stop. Settings › AI turns the glow off, starts following on its own, and picks which agents to watch.

> [!how] How it works
> `main.js`'s `AgentWatch` checks the agents' own records every 1.5s: Claude Code's session files under `~/.claude/projects` (only the folders named after the vault, or folders in or around it), Codex's under `~/.codex/sessions` (today's and yesterday's), and OpenCode's database (`~/.local/share/opencode/opencode.db`, through macOS's `sqlite3`, read-only). A session is working while its record says it's mid-turn: Claude Code's last entry is a prompt, a tool's result or a reply calling a tool (not one ending the turn, its stop hooks or an interruption), Codex's last turn event is `task_started` (not `task_complete`), OpenCode's latest message is the prompt or a reply unfinished or calling tools. A record untouched for 10 minutes counts as stopped, whatever it says. Its edits (Claude Code's Edit and Write, Codex's patches, OpenCode's edit and write) say which files. It's working in the vault when it runs from inside the vault or edited one of its notes in the last five minutes, including notes the vault links to from elsewhere (symlinks, as the test vault's `features/` is). Following, the window shows the latest edited note and scrolls to the edit's first line. The beam follows [Beam](https://libraries.dev/beam) (`styles.css`): the agent's colours fixed round the edge (`data-muta-agent` on the page), shown through an arc that turns every 2.6s, as a 1.5px stroke round the page panel with a white head, a 16px band blurred 26px that spreads into the page (which clips it, so it only goes inward) and a blurred bloom. It fades in over 0.6s and out over 0.5s; with Reduce motion it holds still and comes and goes at once.

> [!todo] Left to do
> When several agents work at once, it follows whichever edited last; it could say which one in the top bar.

> [!out] Left out
> Agents only reading notes don't count: only edits say where it's working. Edits made outside these three agents (by hand, or by sync) don't either.
