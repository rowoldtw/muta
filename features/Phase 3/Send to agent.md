---
status: done
native: false
area: Triage
parent: "[[Agent beam]]"
---

Send the note on show to a coding agent: it starts in Terminal, in the note's project, with the note as its first prompt.

> [!use] Using it
> Click the send button in the top bar (beside the notch, the first of the three on the right) and pick an agent: Claude Code, Codex, OpenCode, Cursor or Antigravity (those turned on in Settings › AI). Terminal opens a new window, in the git repository the note is in (through symlinks, so a roadmap feature goes to its project), with the agent started on "Work on <note>, from my notes (<file>):" and the note. Carry on with it there; its beam, its changes and its questions show in the window as it works.

> [!how] How it works
> `sendToAgent()` in `main.js` writes the prompt (`agentPrompt()`) to `~/.muta/prompts/`, finds the folder (`gitRoot()` of the note's real path, else the vault) and runs `cd <folder> && <agent> "$(cat <prompt>)"` in a new Terminal window through `osascript` (`AGENT_LAUNCH`: `claude`, `codex`, `opencode --prompt`, `cursor-agent`, `agy -i`).

> [!todo] Left to do
> A choice of terminal (iTerm, Ghostty, Warp). An instruction of your own to go with the note.
