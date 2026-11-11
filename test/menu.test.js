// The bottom bar's menu: where it goes (pip-main.js's menuBounds()), and
// opening and closing it in quick succession (main.js).
const { test, expect } = require("bun:test")
const { Muta, pip } = require("./setup.js")
const { menuBounds, MENU } = pip

const screen = { x: 0, y: 25, width: 1800, height: 1144 }
const window = { x: 675, y: 100, width: 450, height: 400 }
const button = { x: 190, y: 370, width: 70, height: 24 } // the name, in the bottom bar

test("centred on its button, so it straddles the window's bottom edge", () => {
  const m = menuBounds(window, button, 1, screen)
  expect(m.x + m.width / 2).toBeCloseTo(window.x + button.x + button.width / 2, 0)
  expect(m.y + m.height / 2).toBeCloseTo(window.y + button.y + button.height / 2, 0)
  expect(m.y).toBeLessThan(window.y + window.height)
  expect(m.y + m.height).toBeGreaterThan(window.y + window.height)
  // It grows out of the button, which sits in the middle of it.
  expect(m.from).toMatchObject({ width: 70, height: 24 })
  expect(m.from.x).toBeCloseTo(m.width / 2 - 35, 0)
})

test("kept on the screen near its edges", () => {
  const low = menuBounds({ ...window, y: screen.y + screen.height - 300 }, button, 1, screen)
  expect(low.y + low.height).toBeLessThanOrEqual(screen.y + screen.height - MENU.screenMargin)
  const left = menuBounds({ ...window, x: -150 }, button, 1, screen)
  expect(left.x).toBeGreaterThanOrEqual(screen.x + MENU.screenMargin)
  // Still grows out of the button, wherever that leaves it in the menu.
  expect(low.from.y).toBeCloseTo(window.y + (screen.y + screen.height - 300 - window.y) + button.y - low.y, 0)
})

test("with Obsidian zoomed, it lines up with the button where it is on screen", () => {
  const z = 1.2
  const m = menuBounds(window, button, z, screen)
  expect(m.x + m.width / 2).toBeCloseTo(window.x + (button.x + button.width / 2) * z, 0)
  expect(m.from.width).toBeCloseTo(button.width * z, 5)
})

// ── Opening and closing (main.js) ────────────────────────────────────────

/** The plugin's menu code over a stand-in page and pip-main.js. */
function plugin({ slowList = false } = {}) {
  const classes = new Set()
  const body = { classList: { add: (c) => classes.add(c), remove: (...cs) => cs.forEach((c) => classes.delete(c)), contains: (c) => classes.has(c) } }
  const win = { clearTimeout, setTimeout, getComputedStyle: () => ({ fontFamily: "system-ui" }) }
  const calls = []
  let release
  const p = Object.create(Muta.prototype)
  Object.assign(p, {
    settings: { darkness: 0.55 },
    leaf: { view: { file: null } },
    ui: {
      switcher: {
        el: { ownerDocument: { body, defaultView: win } },
        title: { getBoundingClientRect: () => ({ left: 190, top: 370, width: 70, height: 24 }) },
        name: { getText: () => "Note" },
      },
    },
    roadmap: () => (slowList ? new Promise((r) => (release = () => r([]))) : Promise.resolve([])),
    pip: { openMenu: () => calls.push("open"), closeMenu: () => calls.push("close") },
  })
  return { p, calls, open: () => classes.has("is-switcher-open"), release: () => release() }
}

test("it opens, and closes through pip-main.js", async () => {
  const { p, calls, open } = plugin()
  await p.openMenu()
  expect(open()).toBe(true)
  expect(calls).toEqual(["open"])
  p.closeMenu()
  expect(calls).toEqual(["open", "close"])
})

test("closed before the list is read, it never opens", async () => {
  const { p, calls, open, release } = plugin({ slowList: true })
  const opening = p.openMenu()
  p.closeMenu() // a click elsewhere, or going into the notch
  release()
  await opening
  expect(calls).toEqual([])
  expect(open()).toBe(false)
})

test("closed and opened again quickly, only the last open counts", async () => {
  const { p, calls, open, release } = plugin({ slowList: true })
  const first = p.openMenu()
  p.closeMenu()
  release()
  await first
  const second = p.openMenu()
  release()
  await second
  expect(calls).toEqual(["open"])
  expect(open()).toBe(true)
})
