---
status: done
native: false
area: "Agents (experimental)"
parent: "[[Agent beam]]"
---

When an agent finishes in the vault, the whole window's border glows green for a moment, or red if its turn failed.

> [!use] Using it
> Nothing to do: with an agent turned on in Settings › AI, the moment its turn ends in the vault, the border round the page, the window's outer edge and (docked) the buttons beside the notch light up green, or red for a failed turn (an API error, say), and fade. It takes over from any beams still running while it lasts, so it's never lost among them. Muta's own one-off actions do the same: Send to agent glows green once Terminal has it, red if Terminal couldn't open, and switching vault glows red if the vault couldn't open. Docked in the notch, the window stays in: a thin ring of the colour grows out round the notch and back.

> [!how] How it works
> Each agent's events say how its turn ended (`AGENT_EVENTS`' `outcome`): done for Claude Code's `Stop`, Codex's `Stop`, OpenCode's `session.execution.succeeded`, Cursor's `stop` with `status: "completed"` and Antigravity's `Stop`; failed for Claude Code's `StopFailure`, OpenCode's `session.execution.failed` and Cursor's `stop` with `status: "error"`. Interrupted turns, Claude Code's idle notice, a session quitting mid-turn, a process gone and the half hour of quiet say nothing. `agentEvent()` keeps the outcome and a count of them, so `AgentWatch` tells `onFinish` of each once, as it reads the event, even a turn so quick its beam never showed, for an agent at work in the vault as the beams count it, and only for events after the watcher began, so a reload reading the tail of the event files doesn't replay old ones. `flash()` in `main.js` adds `.muta-flash` layers (a 1.5px ring and a haze into the page, the outer rim, the notch buttons' lower outlines through `--muta-keys-mask`) and `is-flashing`, which fades the beams' layers (their own opacity belongs to their animations) until the flash starts to fade, 1.6s in all; masks, no filters. Docked, `pip-main.js` gives the page `--muta-shape-ring`, the notch's shape grown 3px (`NOTCH_RING`), and `html::after`, under the black notch shape, morphs out to it while `is-notched.is-flashing`. With Reduce motion it shows and goes without fading.

> [!out] Left out
> A wave over the page ([Distortion Waves](https://libraries.dev/waves)): it bends a picture of the page, which it takes over a solid colour, so the see-through page had to turn solid while it ran. Bringing the window out of the notch to show it: the ring round the notch says it without the window moving. A sound or a notification: the agents have their own.
