/*
 * The preview window's movement, run in Electron's main process, where the
 * window lives: moving it from there takes no round trip, so it follows a
 * drag or swipe every frame and its spring runs on its own clock, whatever
 * the page is doing.
 *
 * Drags follow the cursor itself. Swipes come from pip-helper, which sees
 * the trackpad's own events: the moment the fingers touch, every movement,
 * and the moment they lift. While a swipe carries the window, the cursor
 * rides along on the top bar, so the swipe keeps landing on it instead of
 * scrolling whatever the window has left behind.
 *
 * Let go and the window coasts on with your momentum (UIKit's projection)
 * and springs to the nearest of five spots: the corners and the top
 * middle. Thrown past the left or right edge, it tucks away
 * there, leaving a handle that slides up and down its side. Landed at the
 * top middle of a screen with a camera notch, it morphs up into the notch,
 * and grows back out while the cursor is on the notch or a link is hovered.
 */
const { BrowserWindow, screen, systemPreferences } = require("electron")
const { spawn } = require("child_process")
const readline = require("readline")
const fs = require("fs")
const os = require("os")
const path = require("path")

const MARGIN = 12
/**
 * The bottom bar's menu (openMenu()): its own small window over the preview,
 * centred on the bar's name button so it straddles the window's bottom edge.
 * Its size, corners, how far it keeps from the screen's edges, and how it
 * grows out of the button and shrinks back (ms, cubic-bezier points).
 */
const MENU = {
  width: 300,
  height: 280,
  radius: 12,
  screenMargin: 8,
  open: { ms: 380, curve: [0.32, 0.72, 0, 1] },
  close: { ms: 240, curve: [0.4, 0, 0.2, 1] },
  /** After the cursor leaves the menu, how long before it closes. */
  leaveMs: 250,
}
/**
 * The menu window's page: the list over macOS's own menu material
 * (glass.node's panel(), behind the page), tinted like the preview's frame,
 * its outline growing from the button's to its own.
 */
const MENU_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
:root { --ink: 255 255 255; --frame: 44 44 46; --darkness: 0.55; }
:root.light { --ink: 0 0 0; --frame: 242 242 245; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden;
  font: 12px -apple-system, system-ui, sans-serif; -webkit-font-smoothing: antialiased; cursor: default; user-select: none; }
#menu { position: absolute; inset: 0; border-radius: var(--radius); overflow: hidden; display: flex; }
#menu::before { content: ""; position: absolute; inset: 0; border-radius: inherit; pointer-events: none;
  background: rgb(var(--frame) / calc(var(--darkness) * 0.25));
  box-shadow: inset 0 0 0 0.5px rgb(var(--ink) / 0.1); }
#list { position: relative; flex: 1; overflow-y: auto; padding: 5px; scrollbar-width: none;
  -webkit-mask-image: linear-gradient(transparent, black 10px, black calc(100% - 10px), transparent); }
.group { padding: 7px 8px 3px 24px; color: rgb(var(--ink) / 0.42); font-size: 11px; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group:not(:first-child) { margin-top: 5px; border-top: 1px solid rgb(var(--ink) / 0.08); padding-top: 8px; }
.item { position: relative; padding: 4px 8px 4px 24px; border-radius: 7px; color: rgb(var(--ink) / 0.85);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.item.sub { padding-left: 38px; }
.item:hover { background: rgb(var(--ink) / 0.12); color: rgb(var(--ink)); }
.item.current { color: rgb(var(--ink)); font-weight: 600; }
.item.current::before { content: ""; position: absolute; left: 8px; top: 50%; width: 10px; height: 10px; translate: 0 -50%;
  background: currentColor; -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 10 10'%3E%3Cpath d='M1.5 5.2 4 7.6 8.6 2.4' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") center / contain no-repeat; }
#ghost { position: absolute; display: grid; place-items: center; padding: 0 8px; box-sizing: border-box; white-space: nowrap;
  overflow: hidden; color: rgb(var(--ink)); font-weight: 500; pointer-events: none; }
</style></head><body><div id="menu"><div id="list"></div><div id="ghost"></div></div><script>
const { ipcRenderer } = require("electron")
const send = (...a) => ipcRenderer.send("muta-menu", ...a)
const menu = document.getElementById("menu"), list = document.getElementById("list"), ghost = document.getElementById("ghost")
let d = null
const inset = (c) => "inset(" + c.y + "px " + (d.width - c.x - c.width) + "px " + (d.height - c.y - c.height) + "px " + c.x + "px round " + c.r + "px)"
const whole = () => inset({ x: 0, y: 0, width: d.width, height: d.height, r: d.radius })
const cancel = () => [menu, list, ghost].forEach((e) => e.getAnimations().forEach((a) => a.cancel()))
window.mutaMenu = {
  prepare(data) {
    d = data
    document.documentElement.className = d.dark ? "dark" : "light"
    document.documentElement.style.setProperty("--darkness", d.darkness)
    document.documentElement.style.setProperty("--radius", d.radius + "px")
    document.body.style.fontFamily = d.font
    list.textContent = ""
    let group = "", current = null
    d.items.forEach((it, i) => {
      if (it.group !== group) { group = it.group; const g = list.appendChild(document.createElement("div")); g.className = "group"; g.textContent = group }
      const row = list.appendChild(document.createElement("div"))
      row.className = "item" + (it.depth ? " sub" : "") + (it.current ? " current" : "")
      row.textContent = it.name
      row.addEventListener("click", () => send("pick", i))
      if (it.current) current = row
    })
    ghost.textContent = d.name
    Object.assign(ghost.style, { left: d.from.x + "px", top: d.from.y + "px", width: d.from.width + "px", height: d.from.height + "px" })
    cancel()
    menu.style.clipPath = inset(d.from)
    list.style.opacity = 0
    ghost.style.opacity = 1
    if (current) list.scrollTop = current.offsetTop - (list.clientHeight - current.offsetHeight) / 2
  },
  grow(ms, curve) {
    const easing = "cubic-bezier(" + curve.join(",") + ")"
    cancel()
    menu.style.clipPath = whole()
    list.style.opacity = 1
    ghost.style.opacity = 0
    menu.animate([{ clipPath: inset(d.from) }, { clipPath: whole() }], { duration: ms, easing })
    list.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.7, delay: ms * 0.3, easing: "ease-out", fill: "backwards" })
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.4, easing: "ease-out" })
  },
  shrink(ms, curve) {
    const easing = "cubic-bezier(" + curve.join(",") + ")"
    const now = getComputedStyle(menu).clipPath
    cancel()
    menu.style.clipPath = inset(d.from)
    list.style.opacity = 0
    ghost.style.opacity = 1
    menu.animate([{ clipPath: now }, { clipPath: inset(d.from) }], { duration: ms, easing })
    list.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms * 0.5, easing: "ease-out" })
    ghost.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms * 0.4, delay: ms * 0.6, easing: "ease-out", fill: "backwards" })
  },
}
document.documentElement.addEventListener("mouseleave", () => send("leave"))
document.documentElement.addEventListener("mouseenter", () => send("enter"))
document.addEventListener("mousemove", () => send("enter"), { passive: true })
</script></body></html>`
/** Pulling a tucked handle this far (px) away from its side brings the window back out. */
const PULL_OUT = 40
/** Taken off the notch, how far sideways (px) it can go before it's back below the menu bar. */
const CEILING_FALLOFF = 120
/** The most a window can be pulled past the bottom of the screen (px). */
const RUBBER_MAX = 120
const TUCK_VISIBLE = 12
/** Coast distance = velocity (px/s) × this (UIKit's normal deceleration, 0.998/ms). */
const PROJECTION_S = 0.998 / (1 - 0.998) / 1000
/** The landing spring: critically damped, this response (s). */
const SPRING_RESPONSE = 0.42
/** Velocity is measured over this much of the gesture's end (ms). */
const VELOCITY_WINDOW_MS = 80
/** A swipe starting this close to the window's top moves it. */
const BAR = 44
/** Docked at the notch, the window grows out for this long after a link is hovered (ms)... */
const PEEK_MS = 2000
/** ...and stays out this long after the cursor leaves it (ms). */
const LEAVE_MS = 200
/** Coming out of the notch takes this long, along this curve, and going in this long, along this one (styles.css). */
const EXPAND_MS = 340
const OUT_CURVE = [0.2, 0.9, 0.1, 1]
const SHRINK_MS = 260
const IN_CURVE = [0.5, 0, 0.7, 0.4]
/** The glass fades in or out over this (s). */
const GLASS_FADE_S = 0.12
/** How often a docked window checks where the cursor is (ms). */
const NOTCH_POLL_MS = 50
/**
 * Docked, the window is shaped like the notch: it starts this far above the
 * screen (px), so macOS's own rounded window corners are out of sight...
 */
const LIFT = 28
/** ...and curves out into the top of the screen with shoulders this round (px). */
const SHOULDER = 14
/** In the notch: its shoulders, and its bottom corners (px). */
const NOTCH_SHOULDER = 6
const NOTCH_RADIUS = 10
/** Docked, the blur: like Siri's, a macOS material blurred far more than usual (px), without its grey tint or glare. */
const DOCKED_MATERIAL = 13
const DOCKED_BLUR = 40
/** Frame interval for following a drag and running the spring (ms). */
const TICK_MS = 1000 / 120

// NSEvent.Phase
const BEGAN = 1
const CHANGED = 4
const ENDED = 8
const CANCELLED = 16

class Tracker {
  constructor() {
    this.samples = []
  }
  add(x, y, t) {
    this.samples.push({ x, y, t })
    while (this.samples.length > 2 && t - this.samples[0].t > VELOCITY_WINDOW_MS)
      this.samples.shift()
  }
  /** px/s */
  velocity() {
    const s = this.samples
    if (s.length < 2) return { x: 0, y: 0 }
    const a = s[0]
    const b = s[s.length - 1]
    // A last sample long after the motion stopped means it stopped.
    const dt = Math.max(b.t - a.t, 8) / 1000
    return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt }
  }
}

/**
 * glass.node, loaded from a copy named after its build: a native module stays
 * loaded for the life of the process, so a rebuild gets a new name.
 */
function loadGlass(dir) {
  try {
    const src = path.join(dir, "glass.node")
    const copy = path.join(os.tmpdir(), `muta-glass-${fs.statSync(src).mtimeMs}.node`)
    if (!fs.existsSync(copy)) fs.copyFileSync(src, copy)
    return require(copy)
  } catch {
    return null // not built or downloaded (yet): the window goes without glass
  }
}

const workArea = (b) => screen.getDisplayMatching(b).workArea

/** One of the resting spots for a window of b's size: col and row are 0, 0.5 or 1. */
function spot(col, row, b) {
  const a = workArea(b)
  return {
    x: Math.round(a.x + MARGIN + (a.width - b.width - 2 * MARGIN) * col),
    y: Math.round(a.y + MARGIN + (a.height - b.height - 2 * MARGIN) * row),
    width: b.width,
    height: b.height,
  }
}

/** The point, or the nearest point to it that's on a screen. */
function onScreen(p) {
  const on = (d) => inside(p, d.bounds)
  if (screen.getAllDisplays().some(on)) return p
  const b = screen.getDisplayNearestPoint(p).bounds
  return {
    x: Math.min(Math.max(p.x, b.x + 1), b.x + b.width - 2),
    y: Math.min(Math.max(p.y, b.y + 1), b.y + b.height - 2),
  }
}

/**
 * The notch's shape as an SVG path: from the top of the screen (LIFT down
 * the window; nothing is drawn above it, where another display may be),
 * concave shoulders of radius s into sides at left and right, down to
 * bottom, with corners of radius b.
 */
function hangingPath({ left, right, bottom, shoulder: s, radius: b }) {
  const k = 0.5523
  const n = (v) => Math.round(v * 100) / 100
  const pts = [
    ["M", left - s, LIFT],
    ["L", right + s, LIFT],
    ["C", right + s - s * k, LIFT, right, LIFT + s - s * k, right, LIFT + s],
    ["L", right, bottom - b],
    ["C", right, bottom - b + b * k, right - b + b * k, bottom, right - b, bottom],
    ["L", left + b, bottom],
    ["C", left + b - b * k, bottom, left, bottom - b + b * k, left, bottom - b],
    ["L", left, LIFT + s],
    ["C", left, LIFT + s - s * k, left - s + s * k, LIFT, left - s, LIFT],
  ]
  return pts.map(([c, ...v]) => `${c} ${v.map(n).join(" ")}`).join(" ") + " Z"
}

/** How far past a limit a rubber band lets you go (iOS's formula): less and less, never more than RUBBER_MAX. */
const rubber = (d) => (1 - 1 / ((d * 0.55) / RUBBER_MAX + 1)) * RUBBER_MAX

const reduceMotion = () => {
  try {
    return !!systemPreferences.getAnimationSettings().prefersReducedMotion
  } catch {
    return false
  }
}

const inside = (p, b, pad = 0) =>
  p.x >= b.x - pad && p.x < b.x + b.width + pad && p.y >= b.y - pad && p.y < b.y + b.height + pad

/** Off the side of the screen but its handle. */
function tuckedBounds(b, side) {
  const a = workArea(b)
  const x =
    side === "left" ? a.x - b.width + TUCK_VISIBLE : a.x + a.width - TUCK_VISIBLE
  return { ...b, x }
}

class Pip {
  /**
   * windowId: the preview window.
   * dir: this plugin's folder (pip-helper and glass.node).
   * glass: glass.node's options for the window's look, or null for none.
   * swipes: whether two-finger swipes on the top bar move the window.
   * state: { bounds, tucked, notched } where it was left.
   * onSettle({ bounds, tucked, notched }): where it was put, to keep.
   */
  constructor({ windowId, dir, glass, swipes, state, onSettle }) {
    this.window = BrowserWindow.fromId(windowId)
    this.dir = dir
    this.native = loadGlass(dir)
    this.setGlass(glass)
    // Clicks in it don't bring Obsidian forward over the app you're in.
    if (this.native) this.native.preventActivation(this.window.getNativeWindowHandle())
    this.state = {
      bounds: state.bounds || null,
      tucked: state.tucked || null,
      notched: !!state.notched,
    }
    this.notch = null
    this.onSettle = onSettle
    this.timer = null
    this.spring = null
    this.drag = null
    this.swipe = null
    this.helper = null
    this.setSwipes(swipes)
    // macOS pulls a window that's mostly off screen back on as it first
    // appears; a tucked one goes back where it belongs once it's shown.
    if (this.state.tucked) {
      const start = tuckedBounds(this.state.bounds || spot(1, 1, this.bounds()), this.state.tucked)
      setTimeout(() => {
        if (this.alive() && !this.drag && !this.spring && !this.swipe)
          this.window.setBounds(start)
      }, 400)
    }
    // Docked at the notch: shown for the hover that opened it, then into the notch.
    if (this.state.notched) {
      const rect = this.notchRect(this.bounds())
      if (rect) {
        this.state.bounds = this.dockedBounds(this.bounds(), rect)
        this.raise()
        this.window.setBounds(this.state.bounds)
        this.dock(PEEK_MS)
      } else {
        // No notch on this screen now (lid closed, displays rearranged): an
        // ordinary window at the top middle instead.
        this.state = { bounds: spot(0.5, 0, this.bounds()), tucked: null, notched: false }
        this.window.setBounds(this.state.bounds)
        this.settled()
      }
    }
  }

  alive() {
    return !!(this.window && !this.window.isDestroyed())
  }

  // ── Placement ─────────────────────────────────────────────────────────

  bounds() {
    return this.window.getBounds()
  }

  move(x, y) {
    this.window.setPosition(Math.round(x), Math.round(y))
  }

  /**
   * Where a window following a drag or swipe to (x, y) can actually be:
   * macOS stops windows at the menu bar, so it stops there, and past the
   * bottom of the screen it gives way less and less, like a rubber band.
   * (Sideways it goes freely, to be tucked away.) A window taken off the
   * notch (held.ceiling, from held.ceilingX) starts above the menu bar
   * rather than jumping down; that allowance eases away as it moves
   * sideways from the notch (CEILING_FALLOFF), so it's never left over the
   * menu bar anywhere else along the top.
   */
  limit(x, y, held = null) {
    const b = this.bounds()
    const a = workArea({ ...b, x, y })
    let top = a.y
    if (held && held.ceiling < a.y) {
      const away = Math.min(Math.abs(x - held.ceilingX) / CEILING_FALLOFF, 1)
      top = held.ceiling + (a.y - held.ceiling) * away
    }
    const bottom = a.y + a.height - b.height
    if (y < top) y = top
    else if (y > bottom) y = bottom + rubber(y - bottom)
    return { x, y }
  }

  // ── Throwing ──────────────────────────────────────────────────────────

  /** Coasts on with the velocity, then lands on the nearest spot or tucks away. */
  fling(velocity) {
    if (!this.alive()) return
    const b = this.bounds()
    const a = workArea(b)
    const cx = b.x + b.width / 2 + velocity.x * PROJECTION_S
    const cy = b.y + b.height / 2 + velocity.y * PROJECTION_S
    let target
    if (cx < a.x || cx > a.x + a.width) {
      const side = cx < a.x ? "left" : "right"
      const out = spot(side === "right" ? 1 : 0, 0, b)
      out.y = Math.round(
        Math.min(
          Math.max(cy - b.height / 2, a.y + MARGIN),
          a.y + a.height - b.height - MARGIN
        )
      )
      this.state = { bounds: out, tucked: side, notched: false }
      target = tuckedBounds(out, side)
    } else {
      const spots = []
      for (const col of [0, 0.5, 1])
        for (const row of [0, 0.5, 1])
          // The corners and the top middle.
          if (row !== 0.5 && (col !== 0.5 || row === 0)) spots.push(spot(col, row, b))
      const distance = (s) =>
        Math.hypot(s.x + s.width / 2 - cx, s.y + s.height / 2 - cy)
      target = spots.reduce((best, s) => (distance(s) < distance(best) ? s : best))
      // The top middle of a screen with a notch docks it there.
      const top = spot(0.5, 0, b)
      const rect = target.x === top.x && target.y === top.y && this.notchRect(target)
      if (rect) target = this.dockedBounds(target, rect)
      this.state = { bounds: target, tucked: null, notched: !!rect }
    }
    this.settled()
    if (!this.state.notched) return this.springTo(target, velocity)
    // It takes on the notch's look on its way up, so arriving is one motion;
    // it only decides whether to go into the notch once it has landed.
    this.landing = true
    this.dock(0)
    this.springTo(target, velocity, () => {
      this.landing = false
      this.ensureAt(target)
      this.pollNotch()
    })
  }

  /**
   * Makes sure a window landing at the notch got there: macOS can briefly
   * refuse to let a window above the menu bar, leaving it stopped where it
   * crossed the top of the screen. It's let up there again and put in place,
   * a few times if need be.
   */
  ensureAt(target, tries = 3) {
    if (!this.alive() || !this.state.notched) return
    const b = this.bounds()
    if (Math.abs(b.x - target.x) <= 1 && Math.abs(b.y - target.y) <= 1) return
    this.raise()
    this.window.setBounds({ ...b, x: target.x, y: target.y })
    if (tries > 1) setTimeout(() => this.ensureAt(target, tries - 1), 60)
  }

  /**
   * Docked, it stays at the notch: macOS can move a window that's partly
   * above the screen back onto it (as windows and Spaces change), leaving
   * it off to one side. It's put straight back.
   */
  holdAtNotch() {
    const at = this.state.bounds
    const b = this.bounds()
    if (!at || (Math.abs(b.x - at.x) <= 1 && Math.abs(b.y - at.y) <= 1)) return
    this.raise()
    this.window.setBounds({ ...b, x: at.x, y: at.y })
  }

  /** Out on its side, at the corner nearest where its handle was slid to. */
  untuck() {
    if (!this.alive() || !this.state.tucked) return
    const col = this.state.tucked === "right" ? 1 : 0
    const full = { ...this.bounds(), ...(this.state.bounds || {}), y: this.bounds().y }
    const out = [0, 1]
      .map((row) => spot(col, row, full))
      .reduce((best, s) => (Math.abs(s.y - full.y) < Math.abs(best.y - full.y) ? s : best))
    this.state = { bounds: out, tucked: null, notched: false }
    this.settled()
    this.springTo(this.state.bounds, { x: 0, y: 0 })
  }

  settled() {
    try {
      this.onSettle({ ...this.state })
    } catch {}
  }

  /** Critically damped spring from the current spot and velocity to target, then onDone. */
  springTo(target, velocity, onDone = null) {
    const b = this.bounds()
    if (reduceMotion()) {
      this.spring = null
      this.move(target.x, target.y)
      if (onDone) onDone()
      return
    }
    this.spring = { x: b.x, y: b.y, vx: velocity.x, vy: velocity.y, target, onDone }
    this.tick()
  }

  stepSpring(dtMs) {
    const s = this.spring
    const omega = (2 * Math.PI) / SPRING_RESPONSE
    let dt = Math.min(dtMs / 1000, 0.05)
    while (dt > 0) {
      const h = Math.min(dt, 1 / 480)
      for (const [k, v, t] of [
        ["x", "vx", s.target.x],
        ["y", "vy", s.target.y],
      ]) {
        const accel = -omega * omega * (s[k] - t) - 2 * omega * s[v]
        s[v] += accel * h
        s[k] += s[v] * h
      }
      dt -= h
    }
    const done =
      Math.abs(s.x - s.target.x) < 0.5 &&
      Math.abs(s.y - s.target.y) < 0.5 &&
      Math.hypot(s.vx, s.vy) < 20
    if (done) {
      this.move(s.target.x, s.target.y)
      this.spring = null
      if (s.onDone) s.onDone()
    } else this.move(s.x, s.y)
  }

  // ── Docked at the notch ───────────────────────────────────────────────
  //
  // Docked, the window hangs from the top of the screen around the notch,
  // shaped like it, over a heavy blur instead of its glass. Going in, its
  // shape (a CSS clip, styles.css, and the blur's mask, glass.node's shape())
  // turns black and shrinks to just the notch, where it can't be seen;
  // coming out, the reverse. The window itself never moves or resizes. In
  // the notch it's see-through and lets clicks through, so the cursor is
  // watched from here instead.

  /** The notch on b's screen, or null when it has none (or glass.node can't tell). */
  notchRect(b) {
    if (!this.native || !this.native.notches) return null
    const d = screen.getDisplayMatching(b).bounds
    try {
      return this.native.notches().find((n) => inside({ x: n.x, y: n.y }, d)) || null
    } catch {
      return null
    }
  }

  /** Where a window of b's size docks: centred on the notch, from just above the top of the screen. */
  dockedBounds(b, rect) {
    return { ...b, x: Math.round(rect.x + rect.width / 2 - b.width / 2), y: rect.y - LIFT }
  }

  /** Up into the menu bar, over it. */
  raise() {
    if (this.native && this.native.allowAboveMenuBar)
      this.native.allowAboveMenuBar(this.window.getNativeWindowHandle())
    this.window.setAlwaysOnTop(true, "status")
  }

  /**
   * Docks the window at the notch: out while the cursor is on it or on the
   * notch, or for peekMs, and otherwise morphed into the notch.
   */
  dock(peekMs) {
    if (!this.alive() || !this.state.notched) return
    const rect = this.notchRect(this.state.bounds)
    if (!rect) return this.undock()
    if (this.notch) this.clearNotch()
    this.raise()
    const now = Date.now()
    this.notch = {
      rect,
      open: true,
      until: now + peekMs,
      over: now,
      timer: null,
      poll: setInterval(() => this.pollNotch(), NOTCH_POLL_MS),
    }
    this.applyGlass()
    // The shape out (the window's size) and in (the notch's), with the same
    // segments so CSS can morph one into the other (styles.css).
    // The blur (glass.node's shape()) follows the same shapes, in step.
    const at = this.state.bounds
    const left = rect.x - at.x
    const shape = (l, r, bottom, s, b) => ({ left: l, right: r, bottom, shoulder: s, radius: b, lift: LIFT })
    this.notch.out = shape(SHOULDER, at.width - SHOULDER, at.height, SHOULDER, SHOULDER + 2)
    this.notch.into = shape(left, left + rect.width, LIFT + rect.height, NOTCH_SHOULDER, NOTCH_RADIUS)
    this.shapeGlass(this.notch.out, 0)
    const out = hangingPath(this.notch.out)
    const into = hangingPath(this.notch.into)
    this.renderNotch(`const h = document.documentElement.style
      h.setProperty("--muta-lift", "${LIFT}px")
      h.setProperty("--muta-shoulder", "${SHOULDER}px")
      h.setProperty("--muta-notch-width", "${rect.width}px")
      h.setProperty("--muta-notch-height", "${rect.height}px")
      h.setProperty("--muta-shape-out", ${JSON.stringify(`path("${out}")`)})
      h.setProperty("--muta-shape-in", ${JSON.stringify(`path("${into}")`)})
      // Dark in either theme: a light theme's page is shown dark while docked.
      if (b.classList.contains("theme-light")) {
        b.classList.replace("theme-light", "theme-dark")
        b.dataset.mutaLight = "true"
      }
      b.classList.add("is-docked")`)
    this.pollNotch()
  }

  clearNotch() {
    clearInterval(this.notch.poll)
    clearTimeout(this.notch.timer)
    this.notch = null
  }

  /** Leaves the notch: an ordinary window again. */
  undock() {
    this.landing = false
    const was = this.notch
    if (was) this.clearNotch()
    this.state.notched = false
    if (!was || !this.alive()) return
    this.window.setAlwaysOnTop(true, "floating")
    this.window.setIgnoreMouseEvents(false)
    this.window.setHasShadow(true)
    this.applyGlass()
    this.renderNotch(`b.classList.remove("is-docked", "is-notched")
      if (b.dataset.mutaLight) {
        b.classList.replace("theme-dark", "theme-light")
        delete b.dataset.mutaLight
      }`)
  }

  /** A link was hovered: a docked window comes out to show it. */
  peek() {
    if (!this.notch) return
    this.notch.until = Date.now() + PEEK_MS
    this.pollNotch()
  }

  pollNotch() {
    const n = this.notch
    if (!n || !this.alive() || this.drag || this.swipe || this.spring || this.landing) return
    this.holdAtNotch()
    const now = Date.now()
    const c = screen.getCursorScreenPoint()
    // Out, the whole window counts; in, the notch and a little around it.
    // A menu opened from it (More options, Muta's) holds it out until it closes.
    const over = n.open ? inside(c, this.bounds()) || this.overMenu(c) || nativeMenuOpen(this.window.id) : inside(c, n.rect, 4)
    if (over) n.over = now
    const open = over || now < n.until || (n.open && now - n.over < LEAVE_MS)
    if (open === n.open) return
    n.open = open
    clearTimeout(n.timer)
    const still = reduceMotion()
    if (open) {
      // Grows out of the notch, blurred from the start: the blur grows with
      // the shape (styles.css's timing), black turning to the Siri tint.
      this.window.setIgnoreMouseEvents(false)
      this.shapeGlass(n.out, still ? 0 : EXPAND_MS / 1000, OUT_CURVE)
      this.fadeGlass(1, still ? 0 : GLASS_FADE_S)
      this.renderNotch(`b.classList.remove("is-notched")`)
    } else {
      // Shrinks into the notch, the blur with it, turning black; the blur
      // goes once it's in.
      this.window.setIgnoreMouseEvents(true)
      this.shapeGlass(n.into, still ? 0 : SHRINK_MS / 1000, IN_CURVE)
      n.timer = setTimeout(() => {
        if (this.notch === n && !n.open) this.fadeGlass(0, 0)
      }, still ? 0 : SHRINK_MS)
      // It gets no mouseleave once it lets clicks through, so its bars close here.
      this.closeMenu(true)
      this.renderNotch(`b.classList.add("is-notched")
        b.classList.remove("is-armed", "is-near-top", "is-near-bottom", "is-near-right", "is-switcher-open", "is-rail-open")`)
    }
  }

  /** The glass to use: docked at the notch, a heavy pure blur in the notch's shape, like Siri's. */
  glassNow() {
    if (!this.notch) return this.glass
    // Docked, always blurred (even with Glass off), or the page can't be read.
    return {
      alpha: 1,
      ...(this.glass || {}),
      // It grows out of the black notch, so it's dark in either theme.
      dark: true,
      blur: true,
      material: DOCKED_MATERIAL,
      blurRadius: DOCKED_BLUR,
      pure: true,
      radius: SHOULDER + 2,
      shoulders: SHOULDER,
      lift: LIFT,
    }
  }

  /** Puts the glass back, fully shown, in the look for where the window is. */
  applyGlass() {
    if (!this.native || !this.alive()) return
    const handle = this.window.getNativeWindowHandle()
    const glass = this.glassNow()
    if (glass) this.native.apply(handle, glass)
    else this.native.remove(handle)
  }

  /** Fades the glass to alpha over seconds (glass.node), or takes it away and puts it back. */
  fadeGlass(alpha, seconds) {
    const glass = this.glassNow()
    if (!this.native || !glass) return
    const handle = this.window.getNativeWindowHandle()
    const full = glass.alpha == null ? 1 : glass.alpha
    // An older glass.node, or no glass to fade: taken away and put back.
    if (this.native.fade && this.native.fade(handle, alpha * full, seconds)) return
    if (alpha) this.applyGlass()
    else this.native.remove(handle)
  }

  /** Morphs the blur to a hanging shape over seconds, along curve (glass.node). */
  shapeGlass(shape, seconds, curve = OUT_CURVE) {
    if (!this.native || !this.native.shape || !this.alive()) return
    const [x1, y1, x2, y2] = curve
    try {
      this.native.shape(this.window.getNativeWindowHandle(), { ...shape, x1, y1, x2, y2 }, seconds)
    } catch {}
  }

  // ── The bottom bar's menu: its own small window, over the preview ─────

  /** The menu's window, made the first time it's needed: see-through, a child of the preview, never focused. */
  menuWindow() {
    if (this.menu && !this.menu.isDestroyed()) return this.menu
    const win = new BrowserWindow({
      parent: this.window,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      acceptFirstMouse: true,
      // Not macOS's own rounded window corners, which clipped the menu's border at its corners.
      roundedCorners: false,
      backgroundColor: "#00000000",
      webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
    })
    win.setAlwaysOnTop(true, "pop-up-menu")
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true })
    if (this.native) this.native.preventActivation(win.getNativeWindowHandle())
    this.menuLoaded = new Promise((resolve) => win.webContents.once("did-finish-load", resolve))
    win.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(MENU_PAGE))
    win.webContents.on("ipc-message", (event, channel, what, arg) => {
      if (channel === "muta-menu") this.onMenu(what, arg)
    })
    this.menu = win
    return win
  }

  /**
   * Opens the bottom bar's menu: it grows out of the bar's name button
   * (button: its box on the page) to its full size, centred on the button,
   * so it straddles the window's bottom edge (kept on the screen). data:
   * { items: [{ group, name, depth, current }], name, font, dark, darkness, reduceMotion }.
   */
  async openMenu(data) {
    if (!this.alive()) return
    // Each open or close is numbered: a close while this one is still loading cancels it.
    const ask = (this.menuAsks = (this.menuAsks || 0) + 1)
    this.menuPending = true
    const win = this.menuWindow()
    await this.menuLoaded
    if (ask !== this.menuAsks || !this.alive() || win.isDestroyed()) return
    clearTimeout(this.menuTimer)
    clearTimeout(this.menuLeave)
    const b = this.window.getBounds()
    const { x, y, width, height, from } = menuBounds(
      b,
      data.button,
      this.window.webContents.getZoomFactor() || 1,
      screen.getDisplayMatching(b).workArea
    )
    const ms = data.reduceMotion ? 0 : MENU.open.ms
    this.menuOpen = { from, dark: data.dark }
    win.setIgnoreMouseEvents(false)
    win.setBounds({ x, y, width, height })
    const page = { ...data, from, width, height, radius: MENU.radius }
    await win.webContents.executeJavaScript(`mutaMenu.prepare(${JSON.stringify(page)})`).catch(() => {})
    if (ask !== this.menuAsks || !this.menuOpen || win.isDestroyed()) return
    this.menuPending = false
    win.showInactive()
    this.menuPanel(true, { width, height }, from, ms, MENU.open.curve)
    win.webContents.executeJavaScript(`mutaMenu.grow(${ms}, ${JSON.stringify(MENU.open.curve)})`).catch(() => {})
  }

  /** Shrinks the menu back into its button (at once with now) and puts it away. */
  closeMenu(now = false) {
    clearTimeout(this.menuLeave)
    this.menuAsks = (this.menuAsks || 0) + 1
    const open = this.menuOpen
    const win = this.menu
    if (!open || !win || win.isDestroyed()) {
      // Still loading: it won't open now; the page lets its bottom bar go.
      if (this.menuPending) this.renderNotch(`if (window.mutaMenuClosed) window.mutaMenuClosed(0)`)
      this.menuPending = false
      return
    }
    this.menuOpen = null
    const ms = now || reduceMotion() ? 0 : MENU.close.ms
    win.setIgnoreMouseEvents(true)
    this.menuPanel(false, null, open.from, ms, MENU.close.curve, open.dark)
    win.webContents.executeJavaScript(`mutaMenu.shrink(${ms}, ${JSON.stringify(MENU.close.curve)})`).catch(() => {})
    clearTimeout(this.menuTimer)
    this.menuTimer = setTimeout(() => {
      if (!this.menuOpen && !win.isDestroyed()) win.hide()
    }, ms + 60)
    // The page keeps the bottom bar open until it's back in.
    this.renderNotch(`if (window.mutaMenuClosed) window.mutaMenuClosed(${ms})`)
  }

  /** The material behind the menu (glass.node's panel()), grown to size, or shrunk back into from. */
  menuPanel(show, size, from, ms, curve, dark = this.menuOpen && this.menuOpen.dark) {
    const win = this.menu
    if (!this.native || !this.native.panel || !win || win.isDestroyed()) return
    const [x1, y1, x2, y2] = curve
    try {
      this.native.panel(win.getNativeWindowHandle(), {
        show,
        x: 0,
        y: 0,
        width: size ? size.width : from.width,
        height: size ? size.height : from.height,
        radius: MENU.radius,
        fromX: from.x,
        fromY: from.y,
        fromWidth: from.width,
        fromHeight: from.height,
        fromRadius: from.r,
        seconds: ms / 1000,
        x1,
        y1,
        x2,
        y2,
        dark: dark !== false,
        // Liquid Glass, like the window's own, clear, lightly tinted; round corners like the page's border.
        glass: true,
        clear: true,
        tint: 0.18,
        circular: true,
      })
    } catch {}
  }

  /** What the menu's page says: a pick, or the cursor leaving it (it closes a moment later) or coming back. */
  onMenu(what, arg) {
    if (what === "pick") {
      this.closeMenu()
      this.renderNotch(`if (window.mutaMenuPick) window.mutaMenuPick(${Number(arg)})`)
    } else if (what === "leave") {
      clearTimeout(this.menuLeave)
      this.menuLeave = setTimeout(() => this.closeMenu(), MENU.leaveMs)
    } else if (what === "enter") clearTimeout(this.menuLeave)
  }

  /** Whether the menu is open with point c over it. */
  overMenu(c) {
    return !!(this.menuOpen && this.menu && !this.menu.isDestroyed() && inside(c, this.menu.getBounds()))
  }

  /** Runs a little script on the page's body, b (styles.css draws the rest). */
  renderNotch(script) {
    if (!this.alive()) return
    this.window.webContents
      .executeJavaScript(`(() => { const b = document.body; ${script} })()`)
      .catch(() => {})
  }

  // ── The clock: follows a drag and runs the spring ─────────────────────

  tick() {
    if (this.timer) return
    let last = performance.now()
    const run = () => {
      const now = performance.now()
      const dt = now - last
      last = now
      if (!this.alive()) return this.stopClock()
      try {
        if (this.drag) this.followDrag(now)
        else if (this.spring) this.stepSpring(dt)
      } catch (error) {
        // A failed step mustn't leave the clock looking alive but stopped,
        // or nothing would move again.
        console.error("Muta: a step of the window's movement failed", error)
        if (this.drag) this.setMoving(false)
        this.spring = null
        this.drag = null
        this.landing = false
      }
      if (this.drag || this.spring) this.timer = setTimeout(run, TICK_MS)
      else this.stopClock()
    }
    this.timer = setTimeout(run, TICK_MS)
  }

  stopClock() {
    clearTimeout(this.timer)
    this.timer = null
  }

  // ── Dragging: the page reports press and release, the cursor is followed here ──

  dragStart() {
    if (!this.alive()) return
    this.landing = false
    if (this.notch && !this.notch.open) return // the notch itself doesn't drag
    if (this.notch) this.undock()
    this.spring = null
    this.swipe = null
    const c = screen.getCursorScreenPoint()
    const b = this.bounds()
    // A tucked handle slides up and down its side; pulled away from it, the window comes out.
    this.drag = {
      ox: c.x - b.x,
      oy: c.y - b.y,
      ceiling: b.y,
      ceilingX: b.x,
      tracker: new Tracker(),
      tucked: this.state.tucked,
      startX: c.x,
    }
    this.drag.tracker.add(b.x, b.y, performance.now())
    this.setMoving(true)
    this.tick()
  }

  /** Slides a tucked handle to y along its side, kept on screen. */
  slideHandle(y) {
    const b = this.bounds()
    const a = workArea(b)
    this.move(b.x, Math.min(Math.max(y, a.y), a.y + a.height - b.height))
  }

  /** Keeps where a tucked handle was slid to. */
  keepHandle() {
    if (!this.state.tucked) return
    this.state = { ...this.state, bounds: { ...(this.state.bounds || this.bounds()), y: this.bounds().y } }
    this.settled()
  }

  followDrag(now) {
    const c = screen.getCursorScreenPoint()
    if (this.drag.tucked) {
      const pull = this.drag.tucked === "right" ? this.drag.startX - c.x : c.x - this.drag.startX
      if (pull > PULL_OUT) {
        this.drag = null
        this.setMoving(false)
        return this.untuck()
      }
      return this.slideHandle(c.y - this.drag.oy)
    }
    const raw = { x: c.x - this.drag.ox, y: c.y - this.drag.oy }
    this.drag.tracker.add(raw.x, raw.y, now)
    const { x, y } = this.limit(raw.x, raw.y, this.drag)
    if (y >= workArea(this.bounds()).y) this.drag.ceiling = Infinity
    const b = this.bounds()
    if (Math.round(x) !== b.x || Math.round(y) !== b.y) this.move(x, y)
  }

  dragEnd() {
    if (!this.drag) return
    if (this.drag.tucked) {
      this.drag = null
      this.setMoving(false)
      return this.keepHandle()
    }
    this.followDrag(performance.now())
    const v = this.drag.tracker.velocity()
    this.drag = null
    this.setMoving(false)
    this.fling(v)
  }

  // ── Swiping, from pip-helper's trackpad events ────────────────────────

  /** The next native menu pops up over this window (patchMenuPopup). */
  menuFromPreview() {
    if (!this.alive()) return
    global.__mutaMenuTarget = { windowId: this.window.id, at: Date.now() }
  }

  /** Liquid Glass behind the page (glass.node's options), or none (null). */
  setGlass(options) {
    this.glass = options
    if (!this.native || !this.alive()) return
    if (this.notch && !this.notch.open) return // faded back in as it comes out
    this.applyGlass()
  }

  /** Swipes move the window while the trackpad helper runs. */
  setSwipes(on) {
    if (on && !this.helper) this.startHelper(path.join(this.dir, "pip-helper"))
    if (!on && this.helper) {
      try {
        this.helper.stdin.end()
        this.helper.kill()
      } catch {}
      this.helper = null
      this.swipe = null
    }
  }

  startHelper(path) {
    if (!path) return
    try {
      this.helper = spawn(path, [], { stdio: ["pipe", "pipe", "ignore"] })
      this.helper.on("error", () => (this.helper = null))
      this.helper.on("exit", () => (this.helper = null))
      readline
        .createInterface({ input: this.helper.stdout })
        .on("line", (line) => this.onScroll(line))
    } catch {
      this.helper = null
    }
  }

  onScroll(line) {
    if (!this.alive()) return
    const [phase, momentum, x, y, dx, dy, natural, ms] = line.split(" ").map(Number)
    if (momentum) {
      // The page's own momentum starting: tell it, in case its lift was missed.
      if (momentum === BEGAN && this.touchedPage) this.sendPage("momentum")
      return // the window's throw has its own momentum
    }
    this.tellPage(phase, x, y)
    if (phase === BEGAN) return this.swipeBegan(x, y, ms)
    if (!this.swipe) return
    if (phase === CHANGED) this.swipeMoved(dx, dy, natural, ms)
    else if (phase === ENDED || phase === CANCELLED) this.swipeEnded(ms)
  }

  /**
   * Tells the page when fingers touch down on the window and lift again,
   * which its own wheel events can't tell it (the bottom bar's swipes go by
   * them).
   */
  tellPage(phase, x, y) {
    let event = null
    if (phase === BEGAN) {
      const b = this.bounds()
      this.touching = inside({ x, y }, b)
      this.touchedPage = this.touching
      if (this.touching) event = "began"
    } else if ((phase === ENDED || phase === CANCELLED) && this.touching) {
      this.touching = false
      event = "ended"
    }
    if (event) this.sendPage(event)
  }

  sendPage(event) {
    if (this.window.isDestroyed()) return
    this.window.webContents
      .executeJavaScript(`window.mutaGesture && window.mutaGesture("${event}")`)
      .catch(() => {})
  }

  swipeBegan(x, y, ms) {
    this.swipe = null
    if (this.drag) return
    const b = this.bounds()
    if (!inside({ x, y }, b)) return
    // A swipe on a tucked handle slides it along its side; away from the side, the window comes out.
    if (this.state.tucked) {
      this.spring = null
      this.swipe = { tucked: this.state.tucked, y: b.y, startY: b.y, cx: x, cy: y, pull: 0 }
      return
    }
    // Docked, the bar is the band beside the notch, below the part above the screen.
    const bar = this.notch ? LIFT + this.notch.rect.height : BAR
    if (y >= b.y + bar) return // over the page: it scrolls
    if (this.notch && !this.notch.open) return
    if (this.notch) this.undock()
    this.spring = null
    this.swipe = {
      x: b.x,
      y: b.y,
      ceiling: b.y,
      ceilingX: b.x,
      ox: x - b.x,
      oy: y - b.y,
      fingers: { x: 0, y: 0 },
      tracker: new Tracker(),
    }
    this.swipe.tracker.add(0, 0, ms)
    this.setMoving(true)
  }

  swipeMoved(dx, dy, natural, ms) {
    const s = this.swipe
    if (s.tucked) {
      const sign = natural ? 1 : -1
      s.pull += (s.tucked === "right" ? -dx : dx) * sign
      if (s.pull > PULL_OUT) {
        this.swipe = null
        return this.untuck()
      }
      s.y += dy * sign
      this.slideHandle(s.y)
      // Held at the screen's end, it turns straight back.
      s.y = this.bounds().y
      // The cursor rides along on the handle, so the swipe keeps landing on it.
      this.warp(s.cx, s.cy + (this.bounds().y - s.startY))
      return
    }
    // The window follows the fingers, whichever way scrolling goes.
    const sign = natural ? 1 : -1
    const fx = dx * sign
    const fy = dy * sign
    s.fingers.x += fx
    s.fingers.y += fy
    s.tracker.add(s.fingers.x, s.fingers.y, ms)
    s.x += fx
    s.y += fy
    // The cursor rides along where the window actually is, so a window held
    // at the menu bar doesn't lose it.
    let at = this.limit(s.x, s.y, s)
    if (at.y >= workArea(this.bounds()).y) s.ceiling = Infinity
    // The cursor can't leave the screens, so neither can the window it's
    // riding on: where the cursor would, both stop at the edge.
    const cursor = onScreen({ x: at.x + s.ox, y: at.y + s.oy })
    const held = { x: cursor.x - s.ox, y: cursor.y - s.oy }
    // Held at an edge (or the menu bar), it turns straight back: no
    // overshoot to undo. (Past the bottom it rubber-bands, so that stays.)
    if (held.x !== at.x) s.x = held.x
    if (held.y !== at.y || at.y > s.y) s.y = held.y
    at = held
    this.move(at.x, at.y)
    this.warp(cursor.x, cursor.y)
  }

  swipeEnded(ms) {
    if (this.swipe.tucked) {
      this.swipe = null
      return this.keepHandle()
    }
    // Fingers that rested before lifting throw nothing.
    this.swipe.tracker.add(this.swipe.fingers.x, this.swipe.fingers.y, ms)
    const v = this.swipe.tracker.velocity()
    this.swipe = null
    this.setMoving(false)
    this.fling(v)
  }

  warp(x, y) {
    if (this.helper) this.helper.stdin.write(`w ${Math.round(x)} ${Math.round(y)}\n`)
  }

  /** Keeps the preview's top bar open while it moves (styles.css). */
  setMoving(on) {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents
      .executeJavaScript(`document.body.classList.toggle("is-dragging", ${on})`)
      .catch(() => {})
  }

  dispose() {
    clearTimeout(this.menuTimer)
    clearTimeout(this.menuLeave)
    if (this.menu && !this.menu.isDestroyed()) this.menu.destroy()
    this.menu = null
    if (this.notch) this.clearNotch()
    this.stopClock()
    this.drag = null
    this.spring = null
    this.swipe = null
    if (this.helper) {
      try {
        this.helper.stdin.end()
        this.helper.kill()
      } catch {}
    }
    this.helper = null
  }
}

/** One preview at a time; a new one (or a plugin reload) replaces the old. */
/**
 * Where the bottom bar's menu goes (screen points): centred on its button
 * (pageButton: its box on the page, in the page's pixels, which are the
 * screen's points times zoom), so it straddles the window's bottom edge,
 * kept within the screen's work area. from: the button's box in the menu's
 * own coordinates, which it grows out of.
 */
function menuBounds(windowBounds, pageButton, zoom, area) {
  const button = {
    x: windowBounds.x + pageButton.x * zoom,
    y: windowBounds.y + pageButton.y * zoom,
    width: pageButton.width * zoom,
    height: pageButton.height * zoom,
  }
  const m = MENU.screenMargin
  const width = Math.min(MENU.width, area.width - 2 * m)
  const height = Math.min(MENU.height, area.height - 2 * m)
  const clamp = (v, lo, hi) => Math.round(Math.max(lo, Math.min(v, hi)))
  const x = clamp(button.x + button.width / 2 - width / 2, area.x + m, area.x + area.width - m - width)
  const y = clamp(button.y + button.height / 2 - height / 2, area.y + m, area.y + area.height - m - height)
  const from = { x: button.x - x, y: button.y - y, width: button.width, height: button.height, r: 6 }
  return { x, y, width, height, from }
}
exports.menuBounds = menuBounds
exports.holdForMenu = holdForMenu
exports.nativeMenuOpen = nativeMenuOpen
exports.MENU = MENU

exports.create = (options) => {
  if (global.__muta) global.__muta.dispose()
  global.__muta = new Pip(options)
  patchMenuPopup()
  return global.__muta
}

/** Where a new window starts: where it was left, or the bottom-right corner. */
exports.placement = ({ bounds, tucked, size }) => {
  const b = bounds || spot(1, 1, { ...screen.getCursorScreenPoint(), ...size })
  return tucked ? tuckedBounds(b, tucked) : b
}

exports.dispose = () => {
  if (global.__muta) global.__muta.dispose()
  global.__muta = null
  global.__mutaMenuPopup = null
}

/**
 * Obsidian's native menus pop up over its main window, wherever the click
 * was. A menu opened from the preview (it says so just before, through
 * menuFromPreview) pops up over the preview window instead, at the button.
 * Electron's Menu.popup is wrapped once per Obsidian run; the wrapper calls
 * whatever this file last set as global.__mutaMenuPopup, so a reloaded
 * version takes over and a disposed one (null) leaves menus alone.
 */
function patchMenuPopup() {
  global.__mutaMenuPopup = (options, menu) => {
    const target = global.__mutaMenuTarget
    global.__mutaMenuTarget = null
    if (!target || Date.now() - target.at > 500) return options
    const win = BrowserWindow.fromId(target.windowId)
    if (!win || win.isDestroyed()) return options
    if (menu) holdForMenu(target.windowId, menu)
    return { ...(options || {}), window: win }
  }
  // Version 2 passes on the menu, so the window can stay out while it's open.
  // (An earlier wrapper stays inside this one: it asks again, gets no target
  // and leaves the options as they are.)
  if (global.__mutaMenus === 2) return
  global.__mutaMenus = 2
  const { Menu } = require("electron")
  const popup = Menu.prototype.popup
  Menu.prototype.popup = function (options) {
    const redirect = global.__mutaMenuPopup
    return popup.call(this, redirect ? redirect(options, this) : options)
  }
}

/** Notes that menu is open over window windowId, until it closes (nativeMenuOpen()). */
function holdForMenu(windowId, menu) {
  const open = (global.__mutaMenusOpen = global.__mutaMenusOpen || new Map())
  open.set(windowId, (open.get(windowId) || 0) + 1)
  menu.once("menu-will-close", () => {
    const left = (open.get(windowId) || 1) - 1
    if (left > 0) open.set(windowId, left)
    else open.delete(windowId)
  })
}

/** Whether a menu opened from the window windowId is open (a docked window stays out of the notch meanwhile). */
function nativeMenuOpen(windowId) {
  return !!(global.__mutaMenusOpen && global.__mutaMenusOpen.get(windowId))
}
