// Each agent's hooks (main.js): putting Muta's into the agent's settings and
// taking them out (leaving the user's own), bringing an earlier version's up
// to date, and the scripts and OpenCode plugin that pass events on only
// while Muta is running.
const { test, expect, beforeEach, afterEach } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { testing, TFile } = require("./setup.js")
const { AgentWatch, withHookGroups, withCursorHooks, withAntigravityHooks, CLAUDE_HOOKS, CODEX_HOOKS, HOOK_MARK, CURSOR_HOOK_MARK, RUNNING_MIN } = testing

let home
beforeEach(() => (home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muta-hooks-")))))
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function watcher() {
  const vault = path.join(home, "Vault")
  fs.mkdirSync(vault, { recursive: true })
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n")
  const plugin = {
    settings: {},
    app: { vault: { adapter: { getBasePath: () => vault }, getAbstractFileByPath: (rel) => (fs.existsSync(path.join(vault, rel)) ? new TFile(rel) : null) } },
  }
  const w = new AgentWatch(plugin, () => {})
  w.homeDir = () => home
  w.timer = 1
  return { w, vault }
}
const readJson = (...p) => JSON.parse(fs.readFileSync(path.join(home, ...p), "utf8"))
/** The events the scripts kept, by agent then in order. */
const events = () => {
  const dir = path.join(home, ".muta", "events")
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
}

test("Claude Code's and Codex's hooks go in beside the user's own, and come out leaving them", () => {
  const theirs = { model: "x", hooks: { Stop: [{ hooks: [{ type: "command", command: "say done" }] }] } }
  const command = `sh /h/.muta/claude-hook.sh # ${HOOK_MARK}`
  const added = withHookGroups(theirs, command, CLAUDE_HOOKS, HOOK_MARK)
  expect(added.model).toBe("x")
  expect(added.hooks.Stop.map((g) => g.hooks[0].command)).toEqual(["say done", command])
  expect(added.hooks.PreToolUse).toEqual([{ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }])
  expect(added.hooks.Notification[0].matcher).toBe("idle_prompt")
  expect(Object.keys(added.hooks).sort()).toEqual(Object.keys(CLAUDE_HOOKS).sort())
  // Adding again doesn't add twice; taking out leaves the user's.
  expect(withHookGroups(added, command, CLAUDE_HOOKS, HOOK_MARK).hooks.Stop).toHaveLength(2)
  expect(withHookGroups(added, null, CLAUDE_HOOKS, HOOK_MARK)).toEqual(theirs)
  expect(withHookGroups({}, null, CLAUDE_HOOKS, HOOK_MARK)).toEqual({})
  expect(theirs.hooks.Stop).toHaveLength(1) // not changed in place
  // An earlier version's (its question script, on questions only) give way to the current ones.
  const old = { hooks: { PermissionRequest: [{ matcher: "AskUserQuestion", hooks: [{ command: `sh q.sh # ${HOOK_MARK}`, timeout: 610 }] }] } }
  const now = withHookGroups(old, command, CLAUDE_HOOKS, HOOK_MARK)
  expect(now.hooks.PermissionRequest).toEqual([{ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }])
  // Codex's are the same shape, with its own events.
  expect(Object.keys(withHookGroups({}, "sh /h/.muta/muta-codex-hook.sh", CODEX_HOOKS, "muta-codex-hook").hooks).sort()).toEqual(Object.keys(CODEX_HOOKS).sort())
})

test("Cursor's hooks.json: Muta's hooks go in beside the user's own, and come out leaving them", () => {
  const theirs = { version: 1, hooks: { stop: [{ command: "./audit.sh" }] } }
  const added = withCursorHooks(theirs, `/h/.muta/${CURSOR_HOOK_MARK}.sh`)
  expect(added.hooks.stop.map((h) => h.command)).toEqual(["./audit.sh", `sh /h/.muta/${CURSOR_HOOK_MARK}.sh stop`])
  expect(withCursorHooks(added, null)).toEqual(theirs)
  expect(withCursorHooks({}, null)).toEqual({ version: 1 })
})

test("Antigravity's hooks.json: Muta's named hook goes in beside the user's own, and comes out leaving them", () => {
  const theirs = { lint: { PostToolUse: [{ matcher: "run_command", hooks: [{ command: "./lint.sh" }] }] } }
  const added = withAntigravityHooks(theirs, "sh /h/.muta/muta-antigravity-hook.sh")
  expect(added.lint).toEqual(theirs.lint)
  expect(Object.keys(added["muta-antigravity-hook"])).toEqual(["PreInvocation", "PreToolUse", "Stop"])
  expect(added["muta-antigravity-hook"].PreToolUse[0].matcher).toBe("*")
  expect(withAntigravityHooks(added, null)).toEqual(theirs)
})

test("each agent's toggle puts Muta's hooks into its own file and takes them out again", () => {
  const { w } = watcher()
  fs.mkdirSync(path.join(home, ".claude"))
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }))
  const all = ["claude", "codex", "opencode", "cursor", "antigravity"]
  for (const kind of all) {
    expect(w.installed(kind)).toBe(false)
    w.setHooks(kind, true)
    expect(w.installed(kind)).toBe(true)
  }
  expect(w.watched()).toEqual(all)
  expect(readJson(".claude", "settings.json").theme).toBe("dark")
  expect(Object.keys(readJson(".codex", "hooks.json").hooks).sort()).toEqual(Object.keys(CODEX_HOOKS).sort())
  expect(fs.readFileSync(path.join(home, ".config", "opencode", "plugins", "muta", "index.js"), "utf8")).toContain("ctx.event.subscribe")
  for (const kind of all) w.setHooks(kind, false)
  expect(w.watched()).toEqual([])
  expect(readJson(".claude", "settings.json")).toEqual({ theme: "dark" })
  expect(readJson(".codex", "hooks.json")).toEqual({})
  expect(readJson(".gemini", "config", "hooks.json")).toEqual({})
  expect(fs.existsSync(path.join(home, ".config", "opencode", "plugins", "muta"))).toBe(false)
})

test("an unreadable settings file is left alone", () => {
  const { w } = watcher()
  fs.mkdirSync(path.join(home, ".claude"))
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{ not json")
  expect(() => w.setHooks("claude", true)).toThrow()
  expect(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8")).toBe("{ not json")
})

test("an earlier version's hooks are brought up to date, and its files cleared away", () => {
  const { w } = watcher()
  const muta = path.join(home, ".muta")
  fs.mkdirSync(path.join(muta, "answers"), { recursive: true })
  fs.writeFileSync(path.join(muta, "claude-events.jsonl"), "{}\n")
  fs.writeFileSync(path.join(muta, "claude-question.sh"), "#!/bin/sh\nsleep 600\n")
  fs.mkdirSync(path.join(home, ".claude"))
  const question = `sh "${muta}/claude-question.sh" # ${HOOK_MARK}`
  fs.writeFileSync(
    path.join(home, ".claude", "settings.json"),
    JSON.stringify({ hooks: { PermissionRequest: [{ matcher: "AskUserQuestion", hooks: [{ type: "command", command: question, timeout: 610 }] }] } })
  )
  w.upgrade()
  const hooks = readJson(".claude", "settings.json").hooks
  expect(hooks.PermissionRequest.map((g) => [g.matcher, g.hooks[0].command.includes("claude-hook.sh")])).toEqual([["*", true]])
  expect(Object.keys(hooks).sort()).toEqual(Object.keys(CLAUDE_HOOKS).sort())
  expect(fs.existsSync(path.join(muta, "answers"))).toBe(false)
  expect(fs.existsSync(path.join(muta, "claude-events.jsonl"))).toBe(false)
  // Sessions already running still call the question script: it does nothing now.
  expect(execFileSync("sh", [path.join(muta, "claude-question.sh")], { input: "{}" }).toString()).toBe("")
  // Agents never turned on stay off.
  expect(w.installed("codex")).toBe(false)
})

test("the scripts pass events on only while Muta is running, and say nothing back (Cursor's prompts always go on)", () => {
  const { w, vault } = watcher()
  for (const kind of ["claude", "cursor"]) w.setHooks(kind, true)
  const env = { ...process.env, HOME: home }
  const claude = (event) => execFileSync("sh", [path.join(home, ".muta", "claude-hook.sh")], { input: JSON.stringify(event), env }).toString()
  const cursor = (event, name) =>
    execFileSync("sh", [path.join(home, ".muta", `${CURSOR_HOOK_MARK}.sh`), name], { input: JSON.stringify({ ...event, hook_event_name: name }), env }).toString()
  // Muta isn't running: nothing is kept.
  expect(claude({ session_id: "a", cwd: vault, hook_event_name: "UserPromptSubmit", prompt: "one\ntwo" })).toBe("")
  expect(JSON.parse(cursor({ conversation_id: "c" }, "beforeSubmitPrompt"))).toEqual({ continue: true })
  expect(events()).toEqual([])
  // Running: each event, a line.
  w.markRunning(true)
  expect(claude({ session_id: "a", cwd: vault, hook_event_name: "UserPromptSubmit", prompt: "one\ntwo" })).toBe("")
  expect(JSON.parse(cursor({ conversation_id: "c" }, "beforeSubmitPrompt"))).toEqual({ continue: true })
  expect(cursor({ conversation_id: "c" }, "stop")).toBe("")
  // Each with the agent's process: the first above the script that isn't a shell (here, the test's own).
  expect(events().map((e) => e.pid)).toEqual([process.pid, process.pid, process.pid])
  execFileSync("sh", ["-c", `sh "${path.join(home, ".muta", "claude-hook.sh")}"; true`], { input: JSON.stringify({ session_id: "b", hook_event_name: "Stop" }), env })
  expect(events().find((e) => e.event.session_id === "b").pid).toBe(process.pid)
  expect(events().filter((e) => e.event.session_id !== "b").map((e) => [e.agent, e.event.hook_event_name, e.event.prompt || null])).toEqual([
    ["claude", "UserPromptSubmit", "one\ntwo"],
    ["cursor", "beforeSubmitPrompt", null],
    ["cursor", "stop", null],
  ])
  // Its mark gone stale: Muta stopped, nothing more is kept.
  const marks = path.join(home, ".muta", "running")
  const long = new Date(Date.now() - (RUNNING_MIN + 2) * 60000)
  for (const f of fs.readdirSync(marks)) fs.utimesSync(path.join(marks, f), long, long)
  claude({ session_id: "a", cwd: vault, hook_event_name: "Stop" })
  expect(events()).toHaveLength(4)
  // Just unloaded (a reload): its mark lapses in a minute, and events are still kept meanwhile.
  w.markRunning(false)
  claude({ session_id: "a", cwd: vault, hook_event_name: "Stop" })
  expect(events()).toHaveLength(5)
})

test("OpenCode's plugin passes on turns and edits while Muta is running", async () => {
  const { w, vault } = watcher()
  w.setHooks("opencode", true)
  const file = path.join(home, ".config", "opencode", "plugins", "muta", "index.js")
  const realHome = process.env.HOME
  process.env.HOME = home
  try {
    const plugin = (await import(file)).default
    let tool
    const feed = [
      { type: "session.execution.started", data: { sessionID: "s1" } },
      { type: "session.step.started", data: { sessionID: "s1" } },
    ]
    const ctx = {
      location: { directory: vault },
      event: {
        subscribe: async function* () {
          for (const e of feed) yield e
        },
      },
      tool: { hook: async (name, fn) => name === "execute.before" && (tool = fn) },
    }
    w.markRunning(true)
    const stop = await plugin.setup(ctx)
    await new Promise((r) => setTimeout(r, 20))
    tool({ tool: "edit", sessionID: "s1", input: { path: path.join(vault, "Note.md"), oldString: "a", newString: "b" } })
    tool({ tool: "read", sessionID: "s1", input: { path: path.join(vault, "Note.md") } })
    stop()
    expect(events().every((e) => e.pid === process.pid)).toBe(true)
    expect(events().map((e) => [e.agent, e.event.type, e.event.tool || null, e.event.input ? e.event.input.newString : null])).toEqual([
      ["opencode", "session.execution.started", null, null],
      ["opencode", "tool", "edit", "b"],
      ["opencode", "tool", "read", null],
    ])
  } finally {
    process.env.HOME = realHome
  }
})

test("with a window watching agents edit, an edit is held a moment so the window hears of it first; nothing else is", () => {
  const { w, vault } = watcher()
  for (const kind of ["claude", "codex", "antigravity"]) w.setHooks(kind, true)
  const env = { ...process.env, HOME: home }
  const timed = (script, event) => {
    const t = performance.now()
    execFileSync("sh", [path.join(home, ".muta", script)], { input: JSON.stringify(event), env })
    return performance.now() - t
  }
  const edit = { session_id: "a", cwd: vault, hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: path.join(vault, "Note.md"), old_string: "a", new_string: "b" } }
  const read = { ...edit, tool_name: "Read" }
  const after = { ...edit, hook_event_name: "PostToolUse" }
  // Running, not watching edits: no hold.
  w.markRunning(true)
  expect(timed("claude-hook.sh", edit)).toBeLessThan(220)
  // Watching edits: edits wait a quarter second; reads, results and the rest don't.
  w.plugin.settings.agentEditView = true
  w.markRunning(true)
  expect(timed("claude-hook.sh", edit)).toBeGreaterThan(240)
  expect(timed("claude-hook.sh", read)).toBeLessThan(220)
  expect(timed("claude-hook.sh", after)).toBeLessThan(220)
  expect(timed("muta-codex-hook.sh", { ...edit, tool_name: "apply_patch", tool_input: { command: "*** Begin Patch" } })).toBeGreaterThan(240)
  expect(timed("muta-antigravity-hook.sh", { conversationId: "c", hookEventName: "PreToolUse", toolCall: { name: "edit_file", args: {} } })).toBeGreaterThan(240)
  // Turned off: the hold mark goes at once.
  w.plugin.settings.agentEditView = false
  w.markRunning(true)
  expect(timed("claude-hook.sh", edit)).toBeLessThan(220)
})

test("a tool's result is kept short: its session and that it's done, not the result itself; writers don't interleave", () => {
  const { w, vault } = watcher()
  w.setHooks("claude", true)
  w.markRunning(true)
  const env = { ...process.env, HOME: home }
  const script = path.join(home, ".muta", "claude-hook.sh")
  const big = "x".repeat(200000)
  execFileSync("sh", [script], { input: JSON.stringify({ session_id: "s", cwd: vault, hook_event_name: "PostToolUse", tool_name: "Read", tool_response: { content: `"cwd": "nope" ${big}` } }), env })
  expect(events().map((e) => e.event)).toEqual([{ session_id: "s", hook_event_name: "PostToolUse", cwd: vault, tool_name: "Read" }])
  // Several long events at once: each a whole line.
  const { spawn } = require("child_process")
  const runs = Array.from({ length: 6 }, (_, i) =>
    new Promise((resolve) => {
      const child = spawn("sh", [script], { env })
      child.on("close", resolve)
      child.stdin.end(JSON.stringify({ session_id: `p${i}`, cwd: vault, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/v/a.md", content: big } }))
    })
  )
  return Promise.all(runs).then(() => {
    const kept = events()
    expect(kept).toHaveLength(7)
    expect(kept.slice(1).every((e) => e.event.tool_input.content.length === big.length)).toBe(true)
    expect(fs.existsSync(path.join(home, ".muta", "events", ".lock"))).toBe(false)
  })
}, 20000)

test("~/.muta is readable by you alone", () => {
  const { w } = watcher()
  fs.mkdirSync(path.join(home, ".muta"), { mode: 0o755 })
  w.setHooks("claude", true)
  expect(fs.statSync(path.join(home, ".muta")).mode & 0o777).toBe(0o700)
})
