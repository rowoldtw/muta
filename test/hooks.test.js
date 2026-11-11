// Claude Code's hooks (main.js): what a session's events mean, putting
// Muta's hooks into Claude Code's settings and taking them out, and reading
// the events the hook script writes.
const { test, expect, beforeEach, afterEach } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { testing, TFile } = require("./setup.js")
const { claudeHookEvent, withHooks, HOOK_MARK, AgentWatch } = testing

const run = (events) => events.reduce((s, [hook_event_name, extra = {}], i) => claudeHookEvent(s, { session_id: "s1", cwd: "/v", hook_event_name, ...extra }, 1000 + i), undefined)

test("a prompt starts a turn, tools continue it, Stop ends it, SessionEnd ends the session", () => {
  expect(run([["UserPromptSubmit"]]).working).toBe(true)
  expect(run([["UserPromptSubmit"], ["PreToolUse", { tool_name: "Bash" }], ["PostToolUse"]]).working).toBe(true)
  expect(run([["UserPromptSubmit"], ["Stop"]]).working).toBe(false)
  const ended = run([["UserPromptSubmit"], ["SessionEnd"]])
  expect([ended.working, ended.ended]).toEqual([false, true])
})

test("asking for permission mid-turn needs attention until it carries on", () => {
  const asking = run([["UserPromptSubmit"], ["Notification", { notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" }]])
  expect(asking.attention).toEqual({ message: "Claude needs your permission to use Bash" })
  expect(asking.working).toBe(true)
  const resumed = run([["UserPromptSubmit"], ["Notification", { notification_type: "permission_prompt", message: "x" }], ["PreToolUse", { tool_name: "Bash" }]])
  expect(resumed.attention).toBeNull()
})

test("the idle reminder after a turn isn't a question", () => {
  expect(run([["UserPromptSubmit"], ["Stop"], ["Notification", { notification_type: "idle_prompt", message: "Claude is waiting for your input" }]]).attention).toBeNull()
  // Older Claude Code, without notification_type: told apart by its message.
  expect(run([["UserPromptSubmit"], ["Notification", { message: "Claude is waiting for your input" }]]).attention).toBeNull()
  expect(run([["UserPromptSubmit"], ["Notification", { message: "Claude needs your permission to use Write" }]]).attention).not.toBeNull()
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
  send({ session_id: "abc", cwd: vault, hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" })
  await w.poll()
  expect(w.state.all[0].attention).toEqual({ message: "Claude needs your permission to use Bash" })
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
