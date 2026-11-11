---
status: done
native: false
area: Triage
parent: "[[Agent beam]]"
---

When an agent stops to ask for a permission or a question, its beam holds still and pulses, and the window says what it's asking.

> [!use] Using it
> Turn on Settings › AI › Claude Code hooks. When Claude Code stops mid-turn for a permission or a question, its beam stops turning and pulses where it stopped, and a pill at the top of the page, in its colour, says "Claude Code needs you" and what it's asking. Both go as soon as it carries on.

> [!how] How it works
> Claude Code's `Notification` hook (through Muta's hooks, [[Agent beam]]) during a turn marks the session as waiting, unless it's the idle reminder after a turn has ended (`notification_type` `idle_prompt`, or on older Claude Code its "waiting for your input" message); the next prompt or tool clears it (`claudeHookEvent()` in `main.js`). Its beam gets `is-waiting` (its turn paused, a pulse on its layers) and `showAsk()` puts up the pill (`.muta-agent-ask`, `styles.css`). With Reduce motion they don't pulse.

> [!todo] Left to do
> Answering from the window: Claude Code's permission prompts through a hook that waits for Muta, OpenCode through its local server.

> [!out] Left out
> Codex, OpenCode and Antigravity: their records don't say when they're waiting on the user.
