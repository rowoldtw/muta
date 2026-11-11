// Claude Code's hooks (main.js): what a session's events mean, putting
// Muta's hooks into Claude Code's settings and taking them out, and reading
// the events the hook script writes.
const { test, expect, beforeEach, afterEach } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { testing, TFile } = require("./setup.js")
const { claudeHookEvent, cursorHookEvent, withHooks, withCursorHooks, questionAnswer, HOOK_MARK, CURSOR_HOOK_MARK, AgentWatch } = testing

const run = (events) => events.reduce((s, [hook_event_name, extra = {}], i) => claudeHookEvent(s, { session_id: "s1", cwd: "/v", hook_event_name, ...extra }, 1000 + i), undefined)

test("a prompt starts a turn, tools continue it, Stop ends it, SessionEnd ends the session", () => {
  expect(run([["UserPromptSubmit"]]).working).toBe(true)
  expect(run([["UserPromptSubmit"], ["PreToolUse", { tool_name: "Bash" }], ["PostToolUse"]]).working).toBe(true)
  expect(run([["UserPromptSubmit"], ["Stop"]]).working).toBe(false)
  const ended = run([["UserPromptSubmit"], ["SessionEnd"]])
  expect([ended.working, ended.ended]).toEqual([false, true])
})

test("edits record the file and the new text", () => {
  const s = run([
    ["UserPromptSubmit"],
    ["PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/v/a.md", old_string: "x", new_string: "new line" } }],
    ["PreToolUse", { tool_name: "MultiEdit", tool_input: { file_path: "/v/b.md", edits: [{ new_string: "one" }, { new_string: "two" }] } }],
    ["PreToolUse", { tool_name: "Write", tool_input: { file_path: "/v/c.md", content: "# Whole file" } }],
    ["PreToolUse", { tool_name: "Read", tool_input: { file_path: "/v/d.md" } }],
  ])
  expect(s.edits.map((e) => [e.path, e.text])).toEqual([
    ["/v/a.md", "new line"],
    ["/v/b.md", "one\ntwo"],
    ["/v/c.md", "# Whole file"],
  ])
})

test("Muta's hooks go in beside the user's own, and come out leaving them", () => {
  const theirs = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }
  const command = `sh /h/.muta/claude-hook.sh # ${HOOK_MARK}`
  const added = withHooks(theirs, command)
  expect(added.model).toBe("x")
  expect(added.hooks.Stop).toHaveLength(2)
  expect(added.hooks.Stop[0].hooks[0].command).toBe("say done")
  expect(added.hooks.PreToolUse[0]).toEqual({ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] })
  // Only questions go to the question script, which waits for an answer, so it gets a long timeout.
  expect(added.hooks.PermissionRequest[0].matcher).toBe("AskUserQuestion")
  expect(added.hooks.PermissionRequest[0].hooks[0].timeout).toBe(610)
  // An earlier version's Notification hook comes out.
  const old = { hooks: { Notification: [{ hooks: [{ type: "command", command: command }] }] } }
  expect(withHooks(old, command).hooks.Notification).toBeUndefined()
  // Adding again doesn't add twice.
  expect(withHooks(added, command).hooks.Stop).toHaveLength(2)
  const removed = withHooks(added, null)
  expect(removed).toEqual(theirs)
  expect(withHooks({}, null)).toEqual({})
  expect(theirs.hooks.Stop).toHaveLength(1) // not changed in place
})

// ── The hook script and reading its events ──────────────────────────────

let home
beforeEach(() => (home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muta-hooks-")))))
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function watcher() {
  const vault = path.join(home, "Vault")
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n")
  const plugin = {
    settings: { agentClaude: true },
    app: { vault: { adapter: { getBasePath: () => vault }, getAbstractFileByPath: (rel) => (fs.existsSync(path.join(vault, rel)) ? new TFile(rel) : null) } },
  }
  const w = new AgentWatch(plugin, () => {})
  w.homeDir = () => home
  w.timer = 1
  return { w, vault }
}

test("installing writes the script and the hooks; the script's events are read back", async () => {
  const { w, vault } = watcher()
  fs.mkdirSync(path.join(home, ".claude"))
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }))
  w.setHooks(true)
  expect(w.hooksInstalled()).toBe(true)
  const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"))
  expect(settings.theme).toBe("dark")
  const script = path.join(home, ".muta", "claude-hook.sh")
  // Run the script as Claude Code would, with an event on stdin (HOME pointed at the test folder).
  const send = (event) => execFileSync("sh", [script], { input: JSON.stringify(event), env: { ...process.env, HOME: home } })
  send({ session_id: "abc", cwd: vault, hook_event_name: "UserPromptSubmit", prompt: "line one\nline two" })
  send({ session_id: "abc", cwd: vault, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(vault, "Note.md"), new_string: "Added" } })
  const edits = []
  w.onEdit = (e) => edits.push(e)
  await w.poll()
  expect(w.state.all.map((a) => a.kind)).toEqual(["claude"])
  expect(edits.map((e) => [e.file.path, e.text])).toEqual([["Note.md", "Added"]])
  // Read once: the events file is gone.
  expect(fs.existsSync(path.join(home, ".muta", "claude-events.jsonl"))).toBe(false)
  send({ session_id: "abc", cwd: vault, hook_event_name: "Stop" })
  await w.poll()
  expect(w.state).toBeNull()
  w.setHooks(false)
  expect(w.hooksInstalled()).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"))).toEqual({ theme: "dark" })
})

test("an unreadable settings.json is left alone", () => {
  const { w } = watcher()
  fs.mkdirSync(path.join(home, ".claude"))
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json")
  expect(() => w.setHooks(true)).toThrow()
  expect(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json")
})

test("Cursor: a prompt starts a turn, tools and edits continue it, stop ends it", () => {
  const go = (events) => events.reduce((s, [hook_event_name, extra = {}], i) => cursorHookEvent(s, { conversation_id: "c1", workspace_roots: ["/v"], hook_event_name, ...extra }, 1000 + i), undefined)
  const working = go([["beforeSubmitPrompt", { prompt: "x" }], ["afterFileEdit", { file_path: "/v/a.md", edits: [{ old_string: "a", new_string: "b" }, { old_string: "c", new_string: "d" }] }]])
  expect([working.kind, working.cwd, working.working]).toEqual(["cursor", "/v", true])
  expect(working.edits.map((e) => [e.path, e.text])).toEqual([["/v/a.md", "b\nd"]])
  expect(go([["beforeSubmitPrompt"], ["stop", { status: "completed" }]]).working).toBe(false)
  expect(go([["beforeSubmitPrompt"], ["sessionEnd"]]).ended).toBe(true)
})

test("Cursor's hooks.json: Muta's hooks go in beside the user's own, and come out leaving them", () => {
  const theirs = { version: 1, hooks: { stop: [{ command: "./audit.sh" }] } }
  const added = withCursorHooks(theirs, `/h/.muta/${CURSOR_HOOK_MARK}.sh`)
  expect(added.hooks.stop.map((h) => h.command)).toEqual(["./audit.sh", `sh /h/.muta/${CURSOR_HOOK_MARK}.sh stop`])
  expect(added.hooks.beforeSubmitPrompt).toEqual([{ command: `sh /h/.muta/${CURSOR_HOOK_MARK}.sh beforeSubmitPrompt` }])
  expect(withCursorHooks(added, null)).toEqual(theirs)
  expect(withCursorHooks({}, null)).toEqual({ version: 1 })
})

test("Cursor's hook script passes events on, and lets prompts through", async () => {
  const { w, vault } = watcher()
  w.plugin.settings.agentCursor = true
  w.setCursorHooks(true)
  expect(w.cursorHooksInstalled()).toBe(true)
  const script = path.join(home, ".muta", `${CURSOR_HOOK_MARK}.sh`)
  const send = (event, name) => execFileSync("sh", [script, name], { input: JSON.stringify({ ...event, hook_event_name: name }), env: { ...process.env, HOME: home } }).toString()
  // beforeSubmitPrompt has to answer Cursor; the others say nothing.
  expect(JSON.parse(send({ conversation_id: "c1", workspace_roots: [vault], prompt: "go" }, "beforeSubmitPrompt"))).toEqual({ continue: true })
  expect(send({ conversation_id: "c1", workspace_roots: [vault], file_path: path.join(vault, "Note.md"), edits: [{ new_string: "Hi" }] }, "afterFileEdit")).toBe("")
  await w.poll()
  expect(w.state.all.map((a) => a.kind)).toEqual(["cursor"])
  send({ conversation_id: "c1", workspace_roots: [vault] }, "stop")
  await w.poll()
  expect(w.state).toBeNull()
})

test("a question needs the user until the session carries on; other permission requests don't", () => {
  const questions = [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }]
  const asked = run([["UserPromptSubmit"], ["PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions }, muta_ask: "1-2" }]])
  expect(asked.attention).toEqual({ questions, ask: "1-2" })
  expect(run([["UserPromptSubmit"], ["PermissionRequest", { tool_name: "AskUserQuestion", tool_input: { questions }, muta_ask: "1" }], ["PostToolUse"]]).attention).toBeNull()
  expect(run([["UserPromptSubmit"], ["PermissionRequest", { tool_name: "Bash", tool_input: { command: "ls" } }]]).attention).toBeNull()
})

test("an answer is the questions, answered, as Claude Code takes it", () => {
  const questions = [{ question: "Which colour?", header: "Colour", options: [], multiSelect: false }]
  expect(questionAnswer(questions, { "Which colour?": "Blue" })).toEqual({
    hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: { questions, answers: { "Which colour?": "Blue" } } } },
  })
})

test("the question script waits for the window's answer and gives it to Claude Code", async () => {
  const { w, vault } = watcher()
  fs.mkdirSync(path.join(home, ".claude"))
  w.setHooks(true)
  const script = path.join(home, ".muta", "claude-question.sh")
  const questions = [{ question: "Which colour?", header: "Colour", options: [{ label: "Red" }, { label: "Blue" }], multiSelect: false }]
  const { spawn } = require("child_process")
  const ask = (answers) =>
    new Promise((resolve) => {
      const child = spawn("sh", [script], { env: { ...process.env, HOME: home } })
      let out = ""
      child.stdout.on("data", (d) => (out += d))
      child.on("close", () => resolve(out))
      child.stdin.end(JSON.stringify({ session_id: "q1", cwd: vault, hook_event_name: "PermissionRequest", tool_name: "AskUserQuestion", tool_input: { questions } }))
      // Muta sees the question, then answers it.
      const tick = setInterval(async () => {
        await w.poll()
        const a = w.state && w.state.all[0] && w.state.all[0].attention
        if (a && a.ask) {
          clearInterval(tick)
          expect(a.questions).toEqual(questions)
          w.answer(a.ask, answers)
        }
      }, 100)
    })
  expect(JSON.parse(await ask({ "Which colour?": "Blue" }))).toEqual(questionAnswer(questions, { "Which colour?": "Blue" }))
  // "skip" (answered in the terminal): the script stops waiting and says nothing.
  expect(await ask("skip")).toBe("")
}, 20000)
