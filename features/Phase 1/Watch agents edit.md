---
status: done
native: false
area: "Agents (experimental)"
parent: "[[Agent beam]]"
---

On the note in the window, you watch an agent's edit happen: the old text tinted, then the new typing in behind a cursor in its colour.

> [!use] Using it
> Experimental, on by default; Settings › AI › Watch agents edit turns it off. Read a note in the window while an agent (one turned on in Settings › AI) edits it. What it's about to replace is tinted in its colour and struck through, and the page scrolls to it; as the change lands, the new text types in word by word behind a thin cursor in the agent's colour (Claude Code's terracotta, Codex's blue, OpenCode's green, Antigravity's blue, Cursor's silver), which blinks twice at the end and goes. An edit waiting on you to allow it stays tinted until you do (a minute at most); a denied one never types in.

> [!how] How it works
> Each agent's edit event carries the text it replaces as well as the new (`AGENT_EVENTS` in `main.js`: Claude Code's `old_string`, Codex's patch's `-` lines, OpenCode's `oldString`, Antigravity's `Target`, Cursor's `old_string`; a whole file written has none), and is sent just before the file changes (Cursor's just after). The agent writes as soon as its hook returns, which on its own reaches the window about 100ms after the page has the change (measured on Claude Code). So while a window watches agents edit (its mark in `~/.muta/hold`, kept like the running mark), the hook scripts hold an edit (Claude Code's Edit, MultiEdit and Write, Codex's patches, Antigravity's `edit_file` and `write_file`; `HOOK_EDITS`) for a quarter of a second, and OpenCode's plugin holds its edit and write, so the window hears of it first: about 260ms before the page changes (measured). `AgentWatch.reportEdits()` passes each on once, numbered in its session. `onAgentEdit()` takes those for the note on show, heard of within 15 seconds: if the page already has the change (Cursor's; or without the hold), it plays it at once; otherwise it notes the page's blocks of text as they are (`editBlocks()`), tints the blocks holding the old text (`blocksWith()` on `changedLines()`), and watches the page (`watchPage()`, a `MutationObserver`): the moment its blocks change, before they're drawn, it plays the edit, so the new text never shows before it types in (the file's own change, after it renders, is the fallback). `playEdits()` finds the blocks the edit changed (new since it was heard of, or else those holding the lines it adds, not the ones it kept: `editLines()`; at most six) and scrolls to the first. What it took away shows at the start of the first, struck through, for 0.7s (`ghostOld()`, when it wasn't tinted in place), then each block types in, in turn: `typeIn()` wraps its words in spans fading in 45ms apart (900ms a block at most), and a cursor (`.muta-caret`), placed once typing starts, glides from word to word along them with the Web Animations API; one at a time, each taking over from the last. The words go back to plain text after. With Reduce motion, nothing types or scrolls smoothly; the cursor stands at the end a moment.

> [!todo] Left to do
> Following an agent to the note it's editing (its chip in the bottom bar), and a stack of pages when several agents edit different notes. Timing measured on Claude Code only; Cursor's edits always come after, so they show the old text struck through for a moment instead of tinting it in place.

> [!out] Left out
> The glow that lit changed text for a few seconds: watching the change type in replaced it. Edits to notes not on show, and removed text with nothing new in its place (nothing to type in).
