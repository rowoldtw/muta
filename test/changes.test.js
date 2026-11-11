// See what changed (main.js's changedLines()): an edit's new text as the lines it shows as on the page.
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
