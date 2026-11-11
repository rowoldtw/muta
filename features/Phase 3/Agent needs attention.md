---
status: done
native: false
area: Triage
parent: "[[Agent beam]]"
---

When an agent needs you, a wave in its colours breathes along the window's bottom, and you can allow or deny it from the window.

> [!use] Using it
> Turn on Settings › AI › Claude Code hooks. When Claude Code asks for a permission, or stops for a question, its beam leaves the edge to the agents still working, a wave of its colours breathes along the bottom of the window, and the bottom bar shows the request in place of the note's name ("Claude Code · Bash"). Click it: the request rises over the page out of the button, a band of the agent's colours running ahead of it, with what it wants (the command, the file) and Deny and Allow. The terminal still asks too; whichever you answer first counts. Click outside it or press Escape to put it back without answering. Questions, and the plan and question tools, are answered in Claude Code.

> [!how] How it works
> Claude Code's `PermissionRequest` hook (Muta's hooks, [[Agent beam]]) runs `~/.muta/claude-permission.sh`, which passes the request on with an id and waits up to 10 minutes for `~/.muta/answers/<id>`; the window writes `allow` or `deny` there (`AgentWatch.answer()`), and the script gives Claude Code the decision. When the session carries on without it (answered in the terminal), Muta writes `skip` so the script stops waiting. A `Notification` that isn't the idle reminder also marks the session as waiting, without the buttons. The wave and the reveal follow [Waves](https://libraries.dev/waves) (`showAsk()`, `openAsk()` in `main.js`; `.muta-ask-wave`, `.muta-ask-panel` in `styles.css`): the panel's clip grows as an ellipse from the button with a conic band of the agent's colours a little ahead of it. With Reduce motion nothing breathes and it opens at once.

> [!todo] Left to do
> "Always allow" (Claude Code's suggested permission rules). Answering questions from the window.

> [!out] Left out
> Codex, OpenCode, Antigravity and Cursor: their records or hooks don't say when they're waiting on the user, or can't wait for an answer without changing how they ask.
