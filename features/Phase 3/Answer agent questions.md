---
status: done
native: false
area: Triage
parent: "[[Agent beam]]"
---

When Claude Code asks you a question, answer it from the window: pick an option, or type your own.

> [!use] Using it
> Turn on Settings › AI › Claude Code hooks. When Claude Code asks a question (its multiple-choice questions), its beam leaves the edge to the agents still working, and the bottom bar shows "Claude Code asks" with a pulsing dot in place of the note's name. Click it: the question opens over the page, grown out of the button, with its options (pick one, or several when it allows that) and a field for an answer of your own. Send gives Claude Code the answer. The terminal asks too; whichever you answer first counts. Click outside it or press Escape to put it away without answering.

> [!how] How it works
> Claude Code's `PermissionRequest` hook, for its `AskUserQuestion` tool only, runs `~/.muta/claude-question.sh` (Muta's hooks, [[Agent beam]]), which passes the question on with an id and waits up to 10 minutes for `~/.muta/answers/<id>`. The window writes Claude Code's answer there (`AgentWatch.answer()`: the questions, with `answers` mapping each question to the chosen label, labels or typed text, `questionAnswer()`), and the script hands it over; Claude Code takes it as the user's answer. When the session carries on without it (answered in the terminal), Muta writes `skip` so the script stops waiting. The terminal's own question stays up meanwhile: Claude Code runs the hook alongside it.

> [!out] Left out
> Permission prompts (allow or deny): answered in the agent. Replying to an agent that ended its turn with a question in its text: there's no way into a running session for that. Codex, OpenCode, Antigravity and Cursor: no hook that can wait for an answer.
