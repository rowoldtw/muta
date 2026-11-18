---
status: done
native: false
area: "Agents (experimental)"
parent: "[[Agent beam]]"
---

Send the note on show to a coding agent: it starts in Terminal, in the note's project, with an @ reference to the note.

> [!use] Using it
> Open Muta's menu (the sliders button in the top bar's right corner) › Send to agent and pick one: Claude Code, Codex, OpenCode, Cursor or Antigravity (those turned on in Settings › AI). Terminal opens a new window, in the git repository the note is in (through symlinks, so a roadmap feature goes to its project), with the agent started on an @ reference to the note (its path from there) and an ask to read it and wait for what you want. Tell it what to do there; its beam and its edits show in the window as it works.

> [!how] How it works
> `menuItems()` lists the agents turned on, in Send to agent's submenu; `sendToAgent()` in `main.js` writes the prompt (`agentPrompt()`: `@path`, quoted when it has spaces, then the ask to wait) to `~/.muta/prompts/`, finds the folder (`gitRoot()` of the note's real path, else the vault) and runs `cd <folder> && <agent> "$(cat <prompt>)"` in a new Terminal window through `osascript` (`AGENT_LAUNCH`: `claude`, `codex`, `opencode --prompt`, `cursor-agent`, `agy -i`). It had its own button beside the notch at first, which crowded the top bar.

> [!todo] Left to do
> A choice of terminal (iTerm, Ghostty, Warp). An instruction of your own to go with the note. Putting the reference in the agent's input without sending it: none of the agents' command lines can pre-fill it, so it goes as a first turn. Only Claude Code takes an @ reference in with the prompt (tested); the others read the file with their own tools.
