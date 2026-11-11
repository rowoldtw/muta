// The agent watcher (main.js's AgentWatch) against agents' own records, made
// up in a temporary home folder: which agents are at work in the vault.
const { test, expect, beforeEach, afterEach } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { testing, TFile } = require("./setup.js")
const { AgentWatch, AGENT_STALE_MS } = testing

let home, vault, realHome
const now = () => Date.now()
const iso = (t = now()) => new Date(t).toISOString()

beforeEach(() => {
  realHome = process.env.HOME
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muta-home-")))
  process.env.HOME = home
  vault = path.join(home, "Vault")
  fs.mkdirSync(vault)
  fs.writeFileSync(path.join(vault, "Note.md"), "# Note\n")
})
afterEach(() => {
  process.env.HOME = realHome
  fs.rmSync(home, { recursive: true, force: true })
})

/** A watcher over the test vault, with every agent on; changes: what it reported. */
function watcher(settings = {}) {
  const plugin = {
    settings: { agentClaude: true, agentCodex: true, agentOpencode: true, agentAntigravity: true, ...settings },
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
  return { w, changes, kinds: () => (w.state ? w.state.all.map((a) => a.kind) : []) }
}

const sqlite = (db, sql) => execFileSync("/usr/bin/sqlite3", [db, sql])

// ── Claude Code ─────────────────────────────────────────────────────────

function claudeSession(lines, cwd = vault) {
  const dir = path.join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, "session.jsonl")
  fs.writeFileSync(file, lines.map((l) => JSON.stringify({ cwd, timestamp: iso(), ...l })).join("\n") + "\n")
  return file
}
const prompt = { type: "user", message: { role: "user", content: "fix the note" } }
const toolUse = {
  type: "assistant",
  message: { stop_reason: "tool_use", content: [{ type: "tool_use", name: "Edit", input: { file_path: "NOTE", new_string: "x" } }] },
}
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }
const reply = { type: "assistant", message: { stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } }

test("Claude Code: mid-turn in the vault is at work", async () => {
  claudeSession([prompt, toolUse, toolResult])
  const { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual(["claude"])
})

test("Claude Code: a turn that ended isn't", async () => {
  claudeSession([prompt, toolUse, toolResult, reply, { type: "system", subtype: "stop_hook_summary" }])
  const { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual([])
})

test("Claude Code: an interrupted turn, or a command it ran itself, isn't", async () => {
  for (const content of ["[Request interrupted by user]", "<command-name>/compact</command-name>"]) {
    claudeSession([prompt, toolUse, { type: "user", message: { role: "user", content } }])
    const { w, kinds } = watcher()
    await w.poll()
    expect(kinds()).toEqual([])
  }
})

test("Claude Code: outside the vault, it counts only once it edits a note in it", async () => {
  const elsewhere = path.join(home, "Elsewhere")
  fs.mkdirSync(elsewhere)
  // Run from a folder around the vault (its project folder is named after that one).
  claudeSession([prompt], home)
  let { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual([])
  const edit = JSON.parse(JSON.stringify(toolUse))
  edit.message.content[0].input.file_path = path.join(vault, "Note.md")
  claudeSession([prompt, edit, toolResult], home)
  ;({ w, kinds } = watcher())
  await w.poll()
  expect(kinds()).toEqual(["claude"])
})

test("Claude Code: a session file untouched for 10 minutes counts as stopped", async () => {
  const file = claudeSession([prompt, toolUse, toolResult])
  const old = (now() - AGENT_STALE_MS - 1000) / 1000
  fs.utimesSync(file, old, old)
  const { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual([])
})

test("Claude Code: big lines in the record (whole requests) don't hide the turn", async () => {
  const blob = { type: "api-request-blob", body: "x".repeat(1_500_000) }
  claudeSession([prompt, toolUse, blob, toolResult])
  const { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual(["claude"])
})

// ── Codex ───────────────────────────────────────────────────────────────

function codexSession(events, cwd = vault) {
  const d = new Date()
  const dir = path.join(home, ".codex", "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"))
  fs.mkdirSync(dir, { recursive: true })
  const lines = [{ type: "session_meta", payload: { cwd } }, ...events.map((type) => ({ type: "event_msg", payload: { type } }))]
  fs.writeFileSync(path.join(dir, "rollout-test.jsonl"), lines.map((l) => JSON.stringify({ timestamp: iso(), ...l })).join("\n") + "\n")
}

test("Codex: between task_started and task_complete it's at work", async () => {
  codexSession(["task_started"])
  let { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual(["codex"])
  codexSession(["task_started", "task_complete"])
  ;({ w, kinds } = watcher())
  await w.poll()
  expect(kinds()).toEqual([])
})

// ── OpenCode 2 ──────────────────────────────────────────────────────────

function opencode({ busy, idle, directory = vault }) {
  const dir = path.join(home, ".local", "share", "opencode")
  fs.mkdirSync(dir, { recursive: true })
  const db = path.join(dir, "opencode.db")
  sqlite(
    db,
    "create table session_v2 (id text, directory text, time_updated integer, time_busy integer, time_idle integer);" +
      "create table session_message (session_id text, type text, seq integer, data text, time_updated integer);" +
      `insert into session_v2 values ('ses_1', '${directory}', ${now()}, ${busy ?? "null"}, ${idle ?? "null"});`
  )
}

test("OpenCode 2: busy since it last went idle is at work; idle after is not", async () => {
  opencode({ busy: now() - 1000, idle: now() - 5000 })
  let { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual(["opencode"])
  fs.rmSync(path.join(home, ".local"), { recursive: true })
  opencode({ busy: now() - 5000, idle: now() - 1000 })
  ;({ w, kinds } = watcher())
  await w.poll()
  expect(kinds()).toEqual([])
})

// ── Antigravity ─────────────────────────────────────────────────────────

function antigravity({ status, notFullyIdle = 0, workspace = vault, at = now() }) {
  const dir = path.join(home, ".gemini", "antigravity-cli")
  fs.mkdirSync(path.join(dir, "conversations"), { recursive: true })
  const stamp = new Date(at).toISOString().replace("T", " ").replace("Z", "+00:00")
  sqlite(
    path.join(dir, "conversation_summaries.db"),
    "create table conversation_summaries (conversation_id text, workspace_uris text, last_modified_time text, status text, not_fully_idle numeric);" +
      `insert into conversation_summaries values ('conv-1', '["file://${encodeURI(workspace)}"]', '${stamp}', '${status}', ${notFullyIdle});`
  )
  sqlite(path.join(dir, "conversations", "conv-1.db"), "create table steps (idx integer, step_payload blob);")
}

test("Antigravity: running, or with its background tasks still going, is at work", async () => {
  antigravity({ status: "CASCADE_RUN_STATUS_RUNNING" })
  let { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual(["antigravity"])
  fs.rmSync(path.join(home, ".gemini"), { recursive: true })
  antigravity({ status: "CASCADE_RUN_STATUS_IDLE", notFullyIdle: 1 })
  ;({ w, kinds } = watcher())
  await w.poll()
  expect(kinds()).toEqual(["antigravity"])
  fs.rmSync(path.join(home, ".gemini"), { recursive: true })
  antigravity({ status: "CASCADE_RUN_STATUS_IDLE" })
  ;({ w, kinds } = watcher())
  await w.poll()
  expect(kinds()).toEqual([])
})

test("Antigravity: its UTC timestamps are read as UTC (a running one isn't taken as stale)", async () => {
  antigravity({ status: "CASCADE_RUN_STATUS_RUNNING", at: now() - 60_000 })
  const { w, kinds } = watcher()
  await w.poll()
  expect(kinds()).toEqual(["antigravity"])
})

// ── Several at once, and settings ───────────────────────────────────────

test("several agents at once are all reported, in the order they were first seen", async () => {
  claudeSession([prompt, toolUse, toolResult])
  const { w, kinds } = watcher()
  await w.poll()
  codexSession(["task_started"])
  await w.poll()
  expect(kinds()).toEqual(["claude", "codex"])
})

test("an agent turned off in settings isn't watched", async () => {
  claudeSession([prompt, toolUse, toolResult])
  const { w, kinds } = watcher({ agentClaude: false })
  await w.poll()
  expect(kinds()).toEqual([])
})

test("stopped while a check is still reading the databases, it stays stopped", async () => {
  claudeSession([prompt, toolUse, toolResult])
  opencode({ busy: now(), idle: null })
  const { w, changes } = watcher()
  const checking = w.poll()
  w.stop() // clears the timer and reports none
  await checking
  // Nothing reported after the stop, and none at work.
  expect(changes.filter(Boolean)).toEqual([])
  expect(w.state).toBeNull()
})
