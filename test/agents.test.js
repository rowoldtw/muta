// The agent watcher (main.js's AgentWatch) against agents' hook events, as
// Muta's scripts and OpenCode plugin write them into ~/.muta/events in a
// temporary home folder. Codex's, OpenCode's and Antigravity's are real
// events, logged from a run of each (test/fixtures, with {DIR} for the
// folder it ran in); Claude Code's and Cursor's are made up after their docs.
const { test, expect, beforeEach, afterEach } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { testing, TFile } = require("./setup.js")
const { AgentWatch, agentEvent, patchEdits, RUNNING_MIN } = testing

let home, vault, realHome
beforeEach(() => {
  realHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muta-home-")))
  process.env.HOME = home
  vault = path.join(home, "Vault")
  fs.mkdirSync(vault)
  fs.writeFileSync(path.join(vault, "note.md"), "hello\n")
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(home, { recursive: true, force: true })
})

/** A watcher over the test vault (the agents given turned on, as Settings › AI does); kinds(): the agents at work. */
function watcher(agents = ["claude", "codex", "opencode", "cursor", "antigravity"], settings = {}) {
  const plugin = {
    settings,
    app: {
      vault: {
        adapter: { getBasePath: () => vault },
        getAbstractFileByPath: (rel) => (fs.existsSync(path.join(vault, rel)) ? new TFile(rel) : null),
      },
    },
  }
  const changes = []
  const w = new AgentWatch(plugin, (state) => changes.push(state))
  w.homeDir = () => home
  w.timer = 1 // as if started (start() would poll on a real timer)
  for (const kind of agents) w.setHooks(kind, true)
  // Muta running, as when the events were written.
  w.markRunning(true)
  return { w, changes, kinds: () => (w.state ? w.state.all.map((a) => a.kind) : []) }
}

/** A logged run's events, with {DIR} as dir. */
const fixture = (name, dir) =>
  fs
    .readFileSync(path.join(__dirname, "fixtures", `${name}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l.replaceAll("{DIR}", dir).replaceAll("{HOME}", home)))

/** Writes agent kind's events as its hook script would (today's file, at: when, pid: the agent's process). */
function write(kind, events, at = Date.now(), pid = process.pid) {
  const dir = path.join(home, ".muta", "events")
  fs.mkdirSync(dir, { recursive: true })
  const d = new Date()
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  fs.appendFileSync(path.join(dir, `${kind}-${day}.jsonl`), events.map((event) => JSON.stringify({ at, agent: kind, pid, event }) + "\n").join(""))
}

const run = (kind, events) => events.reduce((s, e, i) => agentEvent(kind, s, e, 1000 + i), undefined)
const edits = (s) => s.edits.map((e) => [path.basename(e.path), e.text])

// ── What each agent's events say ────────────────────────────────────────

test("Codex (a real run): the prompt starts the turn, its patch edits both files, Stop ends it", () => {
  const events = fixture("codex", vault)
  expect(run("codex", events.slice(0, 2)).working).toBe(true)
  const done = run("codex", events)
  expect(edits(done)).toEqual([["note.md", "hello world"], ["todo.md", "buy milk"]])
  expect(run("codex", events.slice(0, -1)).working).toBe(false) // Stop
  expect([done.working, done.ended, done.cwd]).toEqual([false, true, vault]) // SessionEnd
})

test("Codex: an interrupted turn ends", () => {
  const events = fixture("codex", vault)
  expect(run("codex", [...events.slice(0, 2), { ...events[1], hook_event_name: "Interrupt" }]).working).toBe(false)
})

test("a Codex patch's edits: each file it adds or updates, with its added lines", () => {
  const patch = "*** Begin Patch\n*** Update File: /v/a.md\n@@\n-old\n+new\n context\n*** Add File: /v/b.md\n+one\n+two\n*** Delete File: /v/c.md\n*** End Patch"
  expect(patchEdits(patch)).toEqual([
    { path: "/v/a.md", text: "new", old: "old" },
    { path: "/v/b.md", text: "one\ntwo", old: "" },
  ])
})

test("OpenCode (a real run, as Muta's plugin writes it): started to succeeded, with its edit and write", () => {
  const events = fixture("opencode", vault)
  expect(run("opencode", events.slice(0, 1)).working).toBe(true)
  const done = run("opencode", events)
  expect(edits(done)).toEqual([["note.md", "hello world"], ["todo.md", "buy milk\n"]])
  expect([done.working, done.cwd]).toEqual([false, vault])
  // A path relative to the session's folder.
  const relative = run("opencode", [{ type: "tool", tool: "edit", sessionID: "s", directory: vault, input: { path: "note.md", newString: "x" } }])
  expect(relative.edits[0].path).toBe(path.join(vault, "note.md"))
})

test("Antigravity (a real run): each model call starts or continues the turn, its edit and write, Stop ends it", () => {
  const events = fixture("antigravity", vault)
  expect(run("antigravity", events.slice(0, 2)).working).toBe(true)
  const done = run("antigravity", events)
  expect(edits(done)).toEqual([["note.md", "hello world"], ["todo.md", "buy milk\n"]])
  expect([done.working, done.cwd]).toEqual([false, vault])
})

test("Claude Code: a prompt or tool starts the turn; Stop, an API error or sitting idle end it; SessionEnd ends the session", () => {
  const e = (hook_event_name, extra = {}) => ({ session_id: "s1", cwd: "/v", hook_event_name, ...extra })
  expect(run("claude", [e("UserPromptSubmit")]).working).toBe(true)
  expect(run("claude", [e("UserPromptSubmit"), e("PreToolUse", { tool_name: "Bash" })]).working).toBe(true)
  for (const end of [e("Stop"), e("StopFailure"), e("Notification", { notification_type: "idle_prompt" })])
    expect(run("claude", [e("UserPromptSubmit"), end]).working).toBe(false)
  expect(run("claude", [e("UserPromptSubmit"), e("Notification", { notification_type: "permission_prompt" })]).working).toBe(true)
  const over = run("claude", [e("UserPromptSubmit"), e("SessionEnd")])
  expect([over.working, over.ended]).toEqual([false, true])
  const s = run("claude", [
    e("PreToolUse", { tool_name: "Edit", tool_input: { file_path: "/v/a.md", old_string: "x", new_string: "new line" } }),
    e("PreToolUse", { tool_name: "MultiEdit", tool_input: { file_path: "/v/b.md", edits: [{ new_string: "one" }, { new_string: "two" }] } }),
    e("PreToolUse", { tool_name: "Write", tool_input: { file_path: "/v/c.md", content: "# Whole file" } }),
    e("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/v/d.md" } }),
  ])
  expect(edits(s)).toEqual([["a.md", "new line"], ["b.md", "one\ntwo"], ["c.md", "# Whole file"]])
})

test("Cursor: a prompt starts a turn, tools and edits continue it, stop ends it", () => {
  const e = (hook_event_name, extra = {}) => ({ conversation_id: "c1", workspace_roots: ["/v"], hook_event_name, ...extra })
  const working = run("cursor", [e("beforeSubmitPrompt", { prompt: "x" }), e("afterFileEdit", { file_path: "/v/a.md", edits: [{ new_string: "b" }, { new_string: "d" }] })])
  expect([working.kind, working.cwd, working.working]).toEqual(["cursor", "/v", true])
  expect(edits(working)).toEqual([["a.md", "b\nd"]])
  expect(run("cursor", [e("beforeSubmitPrompt"), e("stop", { status: "completed" })]).working).toBe(false)
  expect(run("cursor", [e("beforeSubmitPrompt"), e("sessionEnd")]).ended).toBe(true)
})

// ── Waiting on you, subagents, failures (real runs) ─────────────────────

/** Whether the session is waiting on you after each of the run's events, with the event's name. */
const waits = (kind, events) =>
  events.map((e, i) => [e.hook_event_name || e.type, run(kind, events.slice(0, i + 1)).waiting])

test("Claude Code: a permission request waits on you until the tool's result comes back (allowed)", () => {
  expect(waits("claude", fixture("claude-allowed", vault))).toEqual([
    ["UserPromptSubmit", false],
    ["PreToolUse", false],
    ["PermissionRequest", true],
    ["PostToolUse", false],
    ["PreToolUse", false],
    ["PostToolUse", false],
    ["Stop", false],
    ["SessionEnd", false],
  ])
})

test("Claude Code: denied (Esc), the turn just stops: it waits until the next event, here the session ending", () => {
  const events = fixture("claude-denied", vault)
  expect(run("claude", events.slice(0, 3))).toMatchObject({ working: true, waiting: true })
  expect(run("claude", events)).toMatchObject({ working: false, waiting: false, ended: true })
})

test("Codex: a permission request waits on you until the tool runs, or the turn's interrupted", () => {
  expect(waits("codex", fixture("codex-allowed", vault)).map(([, w]) => w)).toEqual([false, false, true, false, false, false])
  const interrupted = fixture("codex-interrupted", vault)
  expect(run("codex", interrupted.slice(0, 3)).waiting).toBe(true)
  expect(run("codex", interrupted.slice(0, 4))).toMatchObject({ working: false, waiting: false })
})

test("OpenCode: asked waits on you, replied doesn't, an interrupted turn ends", () => {
  expect(waits("opencode", fixture("opencode-permission", vault))).toEqual([
    ["session.execution.started", false],
    ["tool", false],
    ["permission.asked", true],
    ["permission.replied", false],
    ["session.execution.interrupted", false],
  ])
  expect(run("opencode", fixture("opencode-permission", vault)).working).toBe(false)
})

test("Cursor and Antigravity never wait on you: they don't say when they ask", () => {
  expect(fixture("antigravity", vault).some((e, i, all) => run("antigravity", all.slice(0, i + 1)).waiting)).toBe(false)
})

test("a subagent's work keeps its agent at work until the whole turn ends (Claude Code, Codex)", () => {
  for (const kind of ["claude", "codex"]) {
    const events = fixture(`${kind}-subagent`, vault)
    const start = events.findIndex((e) => e.hook_event_name === "SubagentStart")
    const stop = events.findIndex((e) => e.hook_event_name === "SubagentStop")
    for (let i = start; i <= stop; i++) expect(run(kind, events.slice(0, i + 1)).working).toBe(true)
    expect(run(kind, events).working).toBe(false)
  }
})

test("a failed turn ends (Claude Code's API error, OpenCode's failed turn)", () => {
  expect(run("claude", fixture("claude-failed", vault).slice(0, 2)).working).toBe(false)
  expect(run("opencode", fixture("opencode-failed", vault)).working).toBe(false)
})

test("how a turn ended: done or failed, from each agent's own word; an interrupted one, or the idle after it, is neither", () => {
  const outcome = (kind, events) => run(kind, events).outcome
  expect(outcome("codex", fixture("codex", vault).slice(0, -1))).toBe("done") // Stop
  expect(outcome("codex", fixture("codex-interrupted", vault).slice(0, 4))).toBe(null) // Interrupt
  expect(outcome("opencode", fixture("opencode", vault))).toBe("done")
  expect(outcome("opencode", fixture("opencode-failed", vault))).toBe("failed")
  expect(outcome("opencode", fixture("opencode-permission", vault))).toBe(null) // interrupted
  expect(outcome("antigravity", fixture("antigravity", vault))).toBe("done")
  expect(outcome("claude", fixture("claude-failed", vault))).toBe("failed") // StopFailure, then SessionEnd
  expect(outcome("claude", fixture("claude-denied", vault))).toBe(null) // Esc, then quit
  const c = (hook_event_name, extra = {}) => ({ session_id: "s1", cwd: "/v", hook_event_name, ...extra })
  const done = run("claude", [c("UserPromptSubmit"), c("Stop"), c("Notification", { notification_type: "idle_prompt" })])
  expect([done.outcome, done.outcomes]).toEqual(["done", 1])
  // A new turn starts clean.
  expect(run("claude", [c("UserPromptSubmit"), c("Stop"), c("UserPromptSubmit")]).outcome).toBe(null)
  const k = (hook_event_name, extra = {}) => ({ conversation_id: "c1", workspace_roots: ["/v"], hook_event_name, ...extra })
  for (const [status, said] of [["completed", "done"], ["error", "failed"], ["aborted", null]])
    expect(outcome("cursor", [k("beforeSubmitPrompt"), k("stop", { status })])).toBe(said)
})

test("a turn ending in the vault is told once, done or failed, even one too quick for its beam", async () => {
  const { w } = watcher()
  const told = []
  w.onFinish = (t) => told.push([t.kind, t.outcome])
  // Prompt, failure and the session's end all in one read: never at work when polled.
  write("claude", fixture("claude-failed", vault))
  await w.poll()
  write("codex", fixture("codex", vault).slice(0, 3))
  await w.poll()
  write("codex", fixture("codex", vault).slice(3))
  await w.poll()
  await w.poll()
  expect(told).toEqual([["claude", "failed"], ["codex", "done"]])
})

test("a turn ending elsewhere, interrupted, or before this watcher began (a reload reading it back) isn't told", async () => {
  const elsewhere = fs.mkdtempSync(path.join(home, "elsewhere-"))
  write("codex", fixture("codex", elsewhere))
  write("opencode", fixture("opencode-permission", vault))
  write("antigravity", fixture("antigravity", vault), Date.now() - 60000)
  const { w } = watcher()
  w.since = Date.now() - 1000
  const told = []
  w.onFinish = (t) => told.push(t.kind)
  await w.poll()
  expect(told).toEqual([])
  // Had it begun before, Antigravity's would have been told.
  const before = watcher()
  before.w.since = 0
  before.w.onFinish = (t) => told.push(t.kind)
  await before.w.poll()
  expect(told).toEqual(["antigravity"])
})

test("waiting reaches the window, and outlasts the half hour of quiet while its agent runs", async () => {
  const { w, changes } = watcher()
  write("claude", fixture("claude-allowed", vault).slice(0, 2), Date.now())
  await w.poll()
  write("claude", fixture("claude-allowed", vault).slice(2, 3), Date.now() - 40 * 60000)
  await w.poll()
  expect(changes.map((c) => c && c.all.map((a) => a.waiting))).toEqual([[false], [true]])
})

// ── Watching ─────────────────────────────────────────────────────────

test("an agent at work in the vault shows until its turn ends, and its edits are reported once", async () => {
  const events = fixture("codex", vault)
  const { w, kinds } = watcher()
  const reported = []
  w.onEdit = (e) => reported.push([e.kind, e.file.path, e.text])
  // Up to the patch, before todo.md exists.
  write("codex", events.slice(0, 5))
  await w.poll()
  expect(kinds()).toEqual(["codex"])
  expect(reported).toEqual([["codex", "note.md", "hello world"]])
  write("codex", events.slice(5))
  await w.poll()
  expect(kinds()).toEqual([])
  await w.poll()
  expect(reported).toHaveLength(1)
})

test("an agent not turned on isn't watched, whatever its events say", async () => {
  const { w, kinds } = watcher(["claude"])
  write("codex", fixture("codex", vault).slice(0, 2))
  await w.poll()
  expect(kinds()).toEqual([])
})

test("an agent at work elsewhere, on no note of the vault, doesn't count", async () => {
  const elsewhere = path.join(home, "elsewhere")
  fs.mkdirSync(elsewhere)
  const { w, kinds } = watcher()
  write("antigravity", fixture("antigravity", elsewhere).slice(0, 2))
  await w.poll()
  expect(kinds()).toEqual([])
})

test("several vaults read the same events: none takes them from the others", async () => {
  const a = watcher()
  const b = watcher()
  write("opencode", fixture("opencode", vault).slice(0, 3))
  await a.w.poll()
  await b.w.poll()
  expect([a.kinds(), b.kinds()]).toEqual([["opencode"], ["opencode"]])
})

test("reloaded while Muta kept running, it picks up the session where it is", async () => {
  const before = watcher()
  write("codex", fixture("codex", vault).slice(0, 3))
  before.w.markRunning(false) // unloaded: its mark lapses in a minute, not at once
  const after = watcher()
  await after.w.poll()
  expect(after.kinds()).toEqual(["codex"])
})

test("after a while without Muta, the sessions read back count as stopped (their end may have gone by)", async () => {
  const { w, kinds } = watcher()
  const mark = path.join(home, ".muta", "running", "old")
  fs.mkdirSync(path.dirname(mark), { recursive: true })
  fs.writeFileSync(mark, "")
  const long = new Date(Date.now() - (RUNNING_MIN + 2) * 60000)
  fs.utimesSync(mark, long, long)
  for (const f of fs.readdirSync(path.dirname(mark))) fs.utimesSync(path.join(path.dirname(mark), f), long, long)
  write("codex", fixture("codex", vault).slice(0, 3))
  await w.poll()
  expect(kinds()).toEqual([])
  // Its next event brings it back.
  write("codex", fixture("codex", vault).slice(4, 5))
  await w.poll()
  expect(kinds()).toEqual(["codex"])
})

test("an agent whose process has gone (crashed, killed, or quit mid-turn) stops at once", async () => {
  const gone = require("child_process").spawnSync("true").pid
  const { w, kinds } = watcher()
  // Antigravity's headless run, ended by a denied command: no Stop.
  write("antigravity", fixture("antigravity", vault).slice(0, 4), Date.now(), gone)
  await w.poll()
  expect(kinds()).toEqual([])
  // While it runs, it shows.
  write("codex", fixture("codex", vault).slice(0, 2), Date.now(), process.pid)
  await w.poll()
  expect(kinds()).toEqual(["codex"])
})

test("a session quiet for half an hour counts as stopped", async () => {
  const { w, kinds } = watcher()
  write("codex", fixture("codex", vault).slice(0, 2), Date.now() - 31 * 60000)
  await w.poll()
  expect(kinds()).toEqual([])
})

test("event files untouched for days are deleted", async () => {
  const { w } = watcher()
  const old = path.join(home, ".muta", "events", "codex-2020-01-01.jsonl")
  fs.mkdirSync(path.dirname(old), { recursive: true })
  fs.writeFileSync(old, "")
  const days = new Date(Date.now() - 3 * 86400000)
  fs.utimesSync(old, days, days)
  await w.poll()
  expect(fs.existsSync(old)).toBe(false)
})

test("several at once each get a place, in the order they started", async () => {
  const { w } = watcher()
  write("codex", fixture("codex", vault).slice(0, 2))
  await w.poll()
  write("opencode", fixture("opencode", vault).slice(0, 2))
  await w.poll()
  expect(w.state.all.map((a) => a.kind)).toEqual(["codex", "opencode"])
})

// ── Projects the vault links into (Settings › AI › Agents in linked projects) ──

/** A git repository in the home folder with a features folder the vault links to, and an unrelated one. */
function linkedProject() {
  const repo = path.join(home, "repo")
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true })
  fs.mkdirSync(path.join(repo, "features"))
  fs.mkdirSync(path.join(repo, "src"))
  fs.symlinkSync(path.join(repo, "features"), path.join(vault, "features"))
  const other = path.join(home, "other")
  fs.mkdirSync(path.join(other, ".git"), { recursive: true })
  return { repo, other }
}
const prompt = (cwd) => [{ session_id: "s1", cwd, hook_event_name: "UserPromptSubmit" }]

test("Linked projects: off, an agent elsewhere in the project doesn't count", async () => {
  const { repo } = linkedProject()
  const { w, kinds } = watcher()
  write("claude", prompt(repo))
  await w.poll()
  expect(kinds()).toEqual([])
})

test("Linked projects: on, an agent anywhere in the project counts, from its root or a folder in it", async () => {
  const { repo } = linkedProject()
  for (const cwd of [repo, path.join(repo, "src")]) {
    fs.rmSync(path.join(home, ".muta", "events"), { recursive: true, force: true })
    const { w, kinds } = watcher(["claude"], { agentLinkedProjects: true })
    write("claude", prompt(cwd))
    await w.poll()
    expect(kinds()).toEqual(["claude"])
  }
})

test("Linked projects: on, an agent in an unrelated project still doesn't count", async () => {
  const { other } = linkedProject()
  const { w, kinds } = watcher(["claude"], { agentLinkedProjects: true })
  write("claude", prompt(other))
  await w.poll()
  expect(kinds()).toEqual([])
})

test("Linked projects: a repository round the whole home folder isn't one", () => {
  fs.mkdirSync(path.join(home, ".git"))
  fs.mkdirSync(path.join(home, "notes"))
  fs.symlinkSync(path.join(home, "notes"), path.join(vault, "notes"))
  const { w } = watcher([], { agentLinkedProjects: true })
  w.roots = w.vaultRoots()
  expect(w.roots.projects).toEqual([])
})
