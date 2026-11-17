// See where an agent edits (main.js): its new text as the lines it shows as on the page (changedLines()), finding them there, and its edits as they come in.
const { test, expect } = require("bun:test")
const { testing } = require("./setup.js")
const { changedLines } = testing

test("Markdown's marks come off", () => {
  expect(changedLines("## A heading here\n- [x] **Done** task\n> [!note] Callout title\n> quoted `code` line\n1. First [[Note|alias]] and [[Other]]\nA [link](http://x) ==marked==")).toEqual([
    "A heading here",
    "Done task",
    "Callout title",
    "quoted code line",
    "First alias and Other",
    "A link marked",
  ])
})

test("blank, very short and table-rule lines are left out", () => {
  expect(changedLines("\n\nok\n|---|:--:|\nReal text")).toEqual(["Real text"])
})

test("nothing in, nothing out", () => {
  expect(changedLines("")).toEqual([])
  expect(changedLines(undefined)).toEqual([])
})

// Watching agents edit (main.js): finding where on the page an edit lands.
const { blocksWith, innermost, agentEvent, AgentWatch } = testing

/** A stand-in for a rendered block: its text, and the blocks inside it. */
const block = (text, ...inside) => ({ textContent: text, inside, contains: (o) => inside.includes(o) || inside.some((i) => i.contains(o)) })

test("the innermost block holding each line: a list item's own text, not its whole list", () => {
  const item = block("Third step")
  const list = block("First step Second step Third step", item)
  const para = block("Claude is writing here now.")
  expect(blocksWith([list, item, para], ["Third step", "Claude is writing here now."])).toEqual([item, para])
  expect(innermost([list, item, para])).toEqual([item, para])
  // A line the block's text sits inside of counts when the block's text isn't tiny.
  expect(blocksWith([para], ["Claude is writing here now. And more."])).toEqual([para])
  expect(blocksWith([block("ok")], ["ok then, more words"])).toEqual([])
})

test("each agent's edits carry the text they replace", () => {
  const last = (kind, e) => agentEvent(kind, undefined, e, 1000).edits.map((x) => [x.text, x.old, x.after])
  expect(last("claude", { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/v/a.md", old_string: "hello", new_string: "hello world" } })).toEqual([["hello world", "hello", false]])
  expect(last("claude", { session_id: "s", hook_event_name: "PreToolUse", tool_name: "Write", tool_input: { file_path: "/v/a.md", content: "# All" } })).toEqual([["# All", "", false]])
  expect(last("codex", { session_id: "s", hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: /v/a.md\n@@\n-hello\n+hello world\n*** End Patch" } })).toEqual([["hello world", "hello", false]])
  expect(last("opencode", { type: "tool", tool: "edit", sessionID: "s", directory: "/v", input: { path: "a.md", oldString: "hello", newString: "hello world" } })).toEqual([["hello world", "hello", false]])
  expect(last("antigravity", { conversationId: "s", hookEventName: "PreToolUse", toolCall: { name: "edit_file", args: { Path: "/v/a.md", Target: "hello", Replacement: "hello world" } } })).toEqual([["hello world", "hello", false]])
  // Cursor's comes once the file has changed.
  expect(last("cursor", { conversation_id: "s", hook_event_name: "afterFileEdit", file_path: "/v/a.md", edits: [{ old_string: "hello", new_string: "hello world" }] })).toEqual([["hello world", "hello", true]])
})

test("two edits in the same second are both reported", () => {
  const e = (old_string, new_string) => ({ session_id: "s", cwd: "/v", hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/v/a.md", old_string, new_string } })
  let s = agentEvent("claude", undefined, e("a", "abc"), 1000)
  s = agentEvent("claude", s, e("x", "xyz"), 1000)
  const w = new AgentWatch({ settings: {}, app: { vault: { adapter: { getBasePath: () => "/v" } } } }, () => {})
  w.toVault = (p) => ({ path: p })
  const seen = []
  w.onEdit = (edit) => seen.push(edit.text)
  w.reportEdits(s, 1000)
  w.reportEdits(s, 1000)
  expect(seen).toEqual(["abc", "xyz"])
})

test("an edit's lines: what it adds, and what it takes away", () => {
  const { editLines } = testing
  expect(editLines("Nothing here yet.", "Claude is writing here now.")).toEqual({ added: ["Claude is writing here now."], removed: ["Nothing here yet."] })
  // Lines it kept (its anchor) aren't new: only the section it added is.
  expect(editLines("Claude is writing here now.", "Claude is writing here now.\n\n## Result\n\nEach change types in.")).toEqual({ added: ["Result", "Each change types in."], removed: [] })
  // A whole file written: everything is new.
  expect(editLines("", "# Title\n\nBody text here.").added).toEqual(["Title", "Body text here."])
})

test("an edit has landed when its new lines are on the page (or, removing only, its old ones are gone)", () => {
  const { landed } = testing
  const page = [block("Claude is writing here now."), block("Second step")]
  expect(landed(page, { old: "Nothing here yet.", text: "Claude is writing here now." })).toBe(true)
  // Denied, or still waiting on you: not there, so nothing on the page is taken for it.
  expect(landed(page, { old: "Second step", text: "Second step, done properly" })).toBe(false)
  expect(landed(page, { old: "An old line to remove", text: "" })).toBe(true)
  expect(landed(page, { old: "Second step", text: "" })).toBe(false)
})

test("a Codex patch's paths are taken from the folder it runs in", () => {
  const patch = "*** Begin Patch\n*** Update File: notes/todo.md\n@@\n-a\n+b\n*** End Patch"
  const s = agentEvent("codex", undefined, { session_id: "s", cwd: "/v", hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command: patch } }, 1000)
  expect(s.edits[0].path).toBe("/v/notes/todo.md")
})
