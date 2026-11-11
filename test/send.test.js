// Send to agent (main.js): the prompt, the folder it starts in, and the quoting of the command Terminal runs.
const { test, expect } = require("bun:test")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { testing } = require("./setup.js")
const { agentPrompt, gitRoot, shellQuote, appleQuote, AGENT_LAUNCH } = testing

test("the prompt says what the note is and where, then gives it", () => {
  expect(agentPrompt("Agent beam", "/repo/features/Agent beam.md", "\n# Body\n\ntext\n")).toBe('Work on "Agent beam", from my notes (/repo/features/Agent beam.md):\n\n# Body\n\ntext\n')
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
