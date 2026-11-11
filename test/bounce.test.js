// A flick's bounce off a page's end (main.js's bouncePath()).
const { test, expect } = require("bun:test")
const { testing } = require("./setup.js")
const { bouncePath, BOUNCE_MAX } = testing

const speeds = [0.2, 0.8, 2, 5, 12] // px/ms: a slow drift to a hard flick

test("it carries on at the page's own speed as it hits the end (no stall, no jump)", () => {
  // For flicks that stay well inside the limit in their first frame (a harder one is held back by it at once).
  for (const v of speeds.filter((v) => v * 8 < BOUNCE_MAX / 2)) {
    const [a, b] = bouncePath(v).points
    expect(a.x).toBe(0)
    // Its first frame's speed is within 15% of the page's (the spring starts slowing it at once).
    expect((b.x - a.x) / (b.t - a.t)).toBeGreaterThan(v * 0.85)
  }
})

test("however fast the flick, it goes no further than its limit", () => {
  for (const v of speeds) for (const p of bouncePath(v).points) expect(Math.abs(p.x)).toBeLessThanOrEqual(BOUNCE_MAX)
})

test("it takes the same time whatever the speed, so a fast flick doesn't snap back", () => {
  const durations = new Set(speeds.map((v) => bouncePath(v).duration))
  expect(durations.size).toBe(1)
  expect([...durations][0]).toBeGreaterThanOrEqual(500)
})

test("it goes out once and comes back smoothly to rest", () => {
  for (const v of speeds) {
    const xs = bouncePath(v).points.map((p) => p.x)
    const peak = xs.indexOf(Math.max(...xs))
    for (let i = 1; i <= peak; i++) expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1])
    for (let i = peak + 1; i < xs.length; i++) expect(xs[i]).toBeLessThanOrEqual(xs[i - 1] + 1e-9)
    // No visible step at the end: the frame before rest is a fraction of a pixel out.
    expect(Math.abs(xs.at(-2))).toBeLessThan(0.25)
    expect(xs.at(-1)).toBe(0)
  }
})

test("it bounces the way the flick was going", () => {
  expect(Math.max(...bouncePath(-3).points.map((p) => p.x))).toBeLessThanOrEqual(0)
})
