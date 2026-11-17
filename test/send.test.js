// Send to agent and Muta's menu (main.js): the prompt, the folder it starts in, the quoting of the command Terminal runs, and the menu's items.
const { test, expect } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { testing } = require("./setup.js")
const { agentPrompt, gitRoot, shellQuote, appleQuote, AGENT_LAUNCH } = testing

test("the prompt refers to the note with an @, quoted when its path has spaces, and asks the agent to wait", () => {
  expect(agentPrompt("features/Phase 3/Agent beam.md")).toBe('@"features/Phase 3/Agent beam.md"\n\nThis is the note I want to work on. Read it, then wait for what I ask.\n')
  expect(agentPrompt("notes/plan.md").split("\n")[0]).toBe("@notes/plan.md")
})

test("it starts in the git repository the note is in, or none", () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muta-git-")))
  fs.mkdirSync(path.join(root, ".git"))
  fs.mkdirSync(path.join(root, "features", "Phase 3"), { recursive: true })
  expect(gitRoot(path.join(root, "features", "Phase 3"))).toBe(root)
  const plain = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "muta-plain-")))
  expect(gitRoot(plain)).toBeNull()
  fs.rmSync(root, { recursive: true })
  fs.rmSync(plain, { recursive: true })
})

test("quoting survives quotes, spaces and $ in paths, through the shell", () => {
  const nasty = `/tmp/it's a "note" $HOME \\ path`
  expect(execFileSync("sh", ["-c", `printf '%s' ${shellQuote(nasty)}`]).toString()).toBe(nasty)
})

test("quoting survives the trip through AppleScript", () => {
  const command = `cd '/a b' && claude "$(cat '/x/it'\\''s.md')"`
  expect(execFileSync("/usr/bin/osascript", ["-e", `return ${appleQuote(command)}`]).toString().trim()).toBe(command)
})

test("every agent has a way to start with a prompt", () => {
  expect(Object.keys(AGENT_LAUNCH).sort()).toEqual(["antigravity", "claude", "codex", "cursor", "opencode"])
})

test("Muta's menu: sending to each agent watched, in order, then changing vault and Muta's settings", () => {
  const { menuItems } = testing
  const send = (agents) => menuItems(agents).find((i) => i.title.startsWith("Send to agent"))
  expect(send(["claude", "codex", "opencode", "cursor", "antigravity"]).submenu.map((i) => i.action.send)).toEqual(["claude", "codex", "opencode", "cursor", "antigravity"])
  expect(send(["claude", "opencode"]).submenu.map((i) => i.title)).toEqual(["Claude Code", "OpenCode"])
  expect(send([])).toMatchObject({ disabled: true })
  expect(menuItems([]).filter((i) => i.action).map((i) => i.action)).toEqual([{ settings: true }])
})

test("Muta's menu: Vaults lists the vaults by name, this one ticked, the others to switch to", () => {
  const { menuItems } = testing
  const vaults = [
    { name: "Personal Vault", path: "/d/Personal Vault", current: false },
    { name: "Muta Vault", path: "/d/Muta Vault", current: true },
    { name: "desktop", path: "/g/amarula-daw/desktop", current: false },
  ]
  const folder = menuItems([], vaults).find((i) => i.title === "Vaults")
  expect(folder.icon).toBe("folder")
  expect(folder.submenu.map((i) => (i.separator ? "—" : [i.title, i.checked || false, i.action || null]))).toEqual([
    ["desktop", false, { vault: "/g/amarula-daw/desktop" }],
    ["Muta Vault", true, null],
    ["Personal Vault", false, { vault: "/d/Personal Vault" }],
    "—",
    ["Manage vaults…", false, { command: "app:open-vault" }],
  ])
  // None known: just Manage vaults.
  expect(menuItems([], []).find((i) => i.title === "Vaults").submenu.map((i) => i.title)).toEqual(["Manage vaults…"])
})
