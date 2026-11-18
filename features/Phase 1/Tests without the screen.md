---
status: in-progress
priority: high
native: false
area: "Any vault"
---

Tests that check the plugin without opening its window or touching the screen.

> [!use] Using it
> `bun test`; CI runs them on every pull request.

> [!how] How it works
> `test/` loads `main.js` and `pip-main.js` outside Obsidian and Electron (`test/setup.js` stands in for their modules) and tests the parts that don't need a window: agent detection against hook events in a temporary home folder, real ones logged from a run of Codex, OpenCode and Antigravity (`test/fixtures`) and Claude Code's and Cursor's after their docs (who's at work, mid-turn or not, in the vault or not, stale, several at once, several vaults reading the same events, a reload picking up where it was), putting each agent's hooks in and out leaving the user's own, the hook scripts and OpenCode plugin passing events on only while Muta runs, a native menu holding the notch window out, the overscroll bounce's curve (`bouncePath()`: it enters at the page's speed, stays within its limit, takes the same time whatever the speed and eases to rest), and the bottom bar menu's placement (`menuBounds()`: centred on its button, on screen, with Obsidian zoomed) and its opening and closing in quick succession.

> [!todo] Left to do
> How things look (the glass, the beams, the notch) is checked on the developer's own Mac, when needed. A virtual display (BetterDisplay) was tried and taken out: macOS still treats it as a real screen, so the test Obsidian took focus and the cursor could wander onto it.
