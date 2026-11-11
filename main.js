/*
 * Picture-in-picture previews: hovering a link shows its page in a small
 * Obsidian window (default preview size) that floats above every app, in the
 * same place on every Space, instead of a popover. It changes the moment a
 * link is hovered, and the new page fades in.
 *
 * Look: the window is Liquid Glass (GLASS), added by a
 * small native module (glass.m), since Electron's own blur materials are too
 * heavy to see through. At rest the page sits in a thin frame;
 * with the cursor near the top, the frame's top grows into a bar with the
 * page's buttons (styles.css).
 *
 * Moving it works like macOS picture in picture, from the top bar only: drag
 * it, or swipe two fingers on it, in any direction, and let go; it carries on
 * with your momentum and springs to the nearest of five spots (the corners
 * and the top middle). Throw it past the left or right
 * edge and it tucks away there, leaving a thin handle; drag or swipe the handle
 * to slide it along its side, and click it or pull it away to bring it back.
 * Thrown to the top middle of a screen with a notch, it morphs into the notch
 * and grows back out while you hover the notch or a link. It keeps where you
 * put it, tucked or not. The movement runs
 * in Electron's main process (pip-main.js), with the trackpad's own swipe
 * events from a small native helper (pip-helper.swift). Build both:
 *   swiftc -O pip-helper.swift -o pip-helper
 *   clang -bundle -undefined dynamic_lookup -fobjc-arc -O2 -framework AppKit \
 *     -framework QuartzCore glass.m -o glass.node
 * "Toggle preview window" turns it off and back to Obsidian's own previews.
 *
 * Around the page: links to the previewed note are marked in Obsidian's
 * other windows. Like the top, the frame's bottom and right edges grow into
 * bars when the cursor comes near: the bottom steps to the previous or next
 * note in order (the order notes in Settings, or the note you hovered from),
 * and clicking its name pops out the whole list to pick from; the right is a
 * thin rail showing where you are on the page, with a mark per section, each
 * section's name popping out beside its mark as the cursor nears it.
 */
const { Menu, Notice, Plugin, PluginSettingTab, SettingGroup, TFile, requestUrl, setIcon } = require("obsidian")

const SIZE = { width: 450, height: 400 }
/** Switching pages: the new one rises this far (px) and sharpens from this blur, over these times (ms). */
const SWITCH = {
  in: 320,
  out: 200,
  shift: 10,
  blur: 4,
  ease: "cubic-bezier(0.2, 0, 0, 1)",
  /** Stepping through the roadmap: the pages slide side by side, a page's width (plus gap px) apart. */
  sideways: { duration: 460, gap: 24, ease: "cubic-bezier(0.32, 0.72, 0, 1)" },
}
/** A flick into a page's end carries on past it and eases back: peaking after this long (ms), at most this far (px). */
const BOUNCE_TAU_MS = 80
const BOUNCE_MAX = 40
/** Over its last this long (ms), a flick's bounce eases to rest. */
const BOUNCE_SETTLE_MS = 160
/** How much the page fades when pulled as far as it goes past its end. */
const OVERSCROLL_FADE = 0.7
/** How long after a bounce starts the trackpad's touch-down can still turn it into a pull (ms): it arrives late. */
const TOUCH_WAIT_MS = 60
/** See what changed: how long an agent's edit is kept to light when its note is shown (ms), how long the page takes to render it, and how long the glow lasts. */
const CHANGE_KEEP_MS = 2 * 60 * 1000
const CHANGE_RENDER_MS = 450
const CHANGE_GLOW_MS = 3600
/** How long a beam takes to go round the edge (styles.css's muta-beam-turn), and how many show at once. */
const BEAM_TURN_MS = 2600
const MAX_BEAMS = 4
/** The top bar drags the window; its buttons still click. */
const HANDLE = ".view-header"
const INTERACTIVE = "a, button, input, .clickable-icon"
/**
 * The glass behind the page (pip-main.js → glass.m): Liquid Glass, regular
 * style (clear: true is clearer but hard to read over busy windows), with
 * corners of this radius. tint (0–1) darkens it for legibility; alpha below
 * 1 lets the sharp desktop show through.
 */
const GLASS = { tint: 0.3, alpha: 1, radius: 16 }
/** Movement before a press becomes a drag, so clicks stay clicks. */
const DRAG_THRESHOLD = 4
/** A menu shown this soon (ms) after a press in the preview opens in the preview. */
const MENU_PRESS_MS = 1000
/** Docked at the notch, the top bar opens only after the cursor has been this far down (px). */
const DOCKED_ARM = 110
/**
 * The frame's edges grow into bars when the cursor comes this close to them
 * (px), and shrink back once it's this far: [opens, closes].
 */
const EDGES = { top: [28, 52], bottom: [24, 48], right: [22, 34] }
/** The page's sections, as the rail marks them. */
const SECTIONS = ".metadata-container, .callout, h1, h2, h3, h4"
/** The rail names the section whose mark is within this distance of the cursor (px); a press within the second jumps to it. */
const SECTION_REACH = 24
const SECTION_HIT = 7
/** Stepping through the roadmap, the switcher's name blurs this much (px) as it changes. */
const NAME_BLUR = 4
/** Properties opening or closing (ms). */
const PROPERTIES_MORPH_MS = 300
/** The furthest a page pulls past its end (px). */
const OVERSCROLL_MAX = 90
/** How quickly an overscrolled page glides to where the pull says (ms, time constant). */
const OVERSCROLL_FOLLOW_MS = 28
/** Scrolling that stops this long (ms) has ended its gesture. */
const HELD_GAP_MS = 160
/** The rail stays open this long after the page stops scrolling (ms). */
const RAIL_LINGER_MS = 900

/** How far a pull of d goes against a rubber band that stops at max (iOS's formula). */
const rubberBand = (d, max) => (1 - 1 / ((d * 0.55) / max + 1)) * max
/** A sideways swipe on the bottom bar steps once it has moved this far (px of scrolling); a pause this long (ms) ends it. */
const NAME_SWIPE_STEP = 45
const NAME_SWIPE_END_MS = 180
/** Settings, and their defaults. */
const DEFAULTS = {
  enabled: true,
  bounds: null,
  tucked: null,
  notched: false,
  /**
   * Notes whose lists of links set the order the switcher steps through
   * (glob patterns, one per line, like "Roadmap/*.md"). Empty:
   * the links on the note you hovered from.
   */
  orderNotes: "",
  /** Liquid Glass behind the window (macOS 26 on); off, the window is a plain tint. */
  glass: true,
  /** "regular" blurs what's behind; "clear" barely does. */
  glassStyle: "regular",
  /** How dark the layer over the glass is, 0–1. */
  darkness: 0.55,
  /** The window stays in place on every Space (and over full-screen apps). */
  allSpaces: true,
  /** Two-finger swipes on the top bar move the window (needs the trackpad helper). */
  swipeToMove: true,
  /** Pages pull past their ends and spring back. */
  overscroll: true,
  /** Links to the previewed note turn yellow in Obsidian's other windows. */
  markPreviewed: true,
  /** The key to hold while hovering a link to preview it ("meta", "alt", "ctrl", "shift"), or "none". */
  hoverKey: "meta",
  /** A glow runs round the window's inner edge while a local agent works in this vault. */
  agentIndicator: true,
  /** Which agents to watch for. */
  agentClaude: true,
  agentCodex: true,
  agentOpencode: true,
  agentAntigravity: true,
  agentCursor: true,
}

/**
 * The files BRAT doesn't install (it takes only main.js, manifest.json and
 * styles.css): the native parts and the code that runs in Electron's main
 * process. Their SHA-256s are written in by the release build (see
 * .github/workflows/release.yml); a release downloads them from its own
 * GitHub release and checks them against these. A build from source
 * (scripts/install.sh) has them already, and these stay unset.
 */
const RELEASE_FILES = {
  "pip-helper": "__PIP_HELPER_SHA256__",
  "glass.node": "__GLASS_NODE_SHA256__",
  "pip-main.js": "__PIP_MAIN_SHA256__",
  "pip-load.js": "__PIP_LOAD_SHA256__",
}
const REPO = "rowoldtw/muta"

/** A glob ("*" within a folder, "**" across folders) as a RegExp over vault paths. */
const globToRegExp = (glob) =>
  new RegExp(
    "^" +
      glob
        .trim()
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "\u0000")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/\u0000/g, ".*") +
      "$"
  )

const reduceMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const remote = () => require("@electron/remote")
const alive = (w) => !!(w && !w.isDestroyed())

// ── Agents: local coding agents at work in this vault ──────────────────
//
// Claude Code, Codex, OpenCode and Antigravity each keep a record of their
// sessions on disk: Claude Code a JSONL file per session under
// ~/.claude/projects (named after the folder it runs in), Codex one per
// session under ~/.codex/sessions (by date), OpenCode a SQLite database, and
// Antigravity a SQLite database of its conversations plus one per
// conversation under ~/.gemini/antigravity-cli. A session is working while its
// record says it's mid-turn (a prompt or tool result not yet answered with a
// final reply); the files it has edited (Claude Code's Edit and Write,
// Codex's patches, OpenCode's edit and write, the files Antigravity's steps write) say which notes. It's working
// in this vault when it runs from inside the vault or has just edited a note
// in it, including notes the vault links to from elsewhere (a symlinked
// folder, as the test vault's features/ is).

/** How often the agents' records are checked anyway (ms); changes to them are seen at once (watchers, and Claude Code's hooks). */
const AGENT_POLL_MS = 4000
/** Folder Muta keeps the Claude Code hook script and its events in (in the home folder). */
const MUTA_DIR = ".muta"
/** Marks Muta's hooks in Claude Code's settings, so they can be found and taken out again. */
const HOOK_MARK = "muta-claude-hook"
/** The Claude Code events Muta listens for, and the hook script that passes each on (to ~/.muta/claude-events.jsonl, one per line). */
const HOOK_EVENTS = ["UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"]
/**
 * Claude Code's questions (its AskUserQuestion tool, through the
 * PermissionRequest hook): the script passes the question on, then waits (up
 * to 10 minutes) for an answer from the window in ~/.muta/answers/<id> and
 * gives it to Claude Code. The terminal asks too meanwhile; whichever is
 * answered first counts, and Muta sends "skip" once the session carries on,
 * so the script stops waiting.
 */
const QUESTION_SCRIPT = `#!/bin/sh
# Muta: lets the questions Claude Code asks be answered from the Muta window too.
dir="$HOME/.muta"
mkdir -p "$dir/answers"
id="$$-$(date +%s)"
input=$(cat | tr -d '\\n')
printf '{"at":%s000,"ask":"%s","hook":%s}\\n' "$(date +%s)" "$id" "$input" >> "$dir/claude-events.jsonl"
i=0
while [ $i -lt 1200 ]; do
  if [ -f "$dir/answers/$id" ]; then
    answer=$(cat "$dir/answers/$id")
    rm -f "$dir/answers/$id"
    [ "$answer" != "skip" ] && printf '%s' "$answer"
    exit 0
  fi
  sleep 0.5
  i=$((i + 1))
done
exit 0
`
/** Cursor's hooks (~/.cursor/hooks.json): its events Muta listens for, and the script that passes each on (to ~/.muta/cursor-events.jsonl). */
const CURSOR_HOOK_EVENTS = ["beforeSubmitPrompt", "afterFileEdit", "afterShellExecution", "afterMCPExecution", "afterAgentResponse", "stop", "sessionEnd"]
const CURSOR_HOOK_MARK = "muta-cursor-hook"
const CURSOR_SCRIPT = `#!/bin/sh
# Muta: passes Cursor's agent hook events on to the Muta Obsidian plugin.
dir="$HOME/.muta"
mkdir -p "$dir"
input=$(cat | tr -d '\\n')
printf '{"at":%s000,"cursor":%s}\\n' "$(date +%s)" "$input" >> "$dir/cursor-events.jsonl"
# beforeSubmitPrompt must say whether to go on: always.
[ "$1" = "beforeSubmitPrompt" ] && printf '{"continue":true}'
exit 0
`
const HOOK_SCRIPT = `#!/bin/sh
# Muta: passes Claude Code's hook events on to the Muta Obsidian plugin.
dir="$HOME/${".muta"}"
mkdir -p "$dir"
input=$(cat | tr -d '\\n')
printf '{"at":%s000,"hook":%s}\\n' "$(date +%s)" "$input" >> "$dir/claude-events.jsonl"
exit 0
`
/** A Claude Code session heard from through its hooks counts as stopped after this long without a word (ms): a long tool run says nothing until it ends. */
const HOOK_STALE_MS = 30 * 60 * 1000
/** A session's record says whether it's mid-turn; one untouched this long is taken as stopped whatever it says (ms), as after a crash. */
const AGENT_STALE_MS = 600000
/** Without that (a turn begun before the part of the record read), one written to this recently is working (ms). */
const AGENT_ACTIVE_MS = 45000
/** An edit this recent says which note an agent is working on (ms). */
const AGENT_EDIT_MS = 300000
/** How much of the end of a session's record is read the first time it's seen (bytes); after that, only what's been added. Claude Code's hold whole requests, a megabyte or more a line. */
const AGENT_TAIL = 4 * 1024 * 1024
/** How many of a session's latest edits are kept. */
const AGENT_EDITS = 20
const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", cursor: "Cursor" }

class AgentWatch {
  /**
   * onChange({ kind, name, edit: { file, text, at } | null, all: [{ id, kind }] } | null):
   * the agent at work in the vault that edited last, with every one at work
   * (oldest first), or none.
   */
  constructor(plugin, onChange) {
    this.plugin = plugin
    this.onChange = onChange
    this.timer = null
    this.busy = false
    this.key = ""
    this.state = null
    this.roots = null
    // What each session file has said so far, and how far it's been read.
    this.records = new Map()
    // When each Antigravity edit was first seen (its records keep no time per step).
    this.seenAt = new Map()
    // Claude Code sessions, as its hooks report them (claudeHookEvent()).
    this.hookSessions = new Map()
    // Edits already reported to onEdit.
    this.editsSeen = new Map()
    this.watchers = []
  }

  /** The user's home folder, where the agents keep their records. */
  homeDir() {
    return require("os").homedir()
  }

  start() {
    if (this.timer) return
    this.timer = window.setInterval(() => this.poll(), AGENT_POLL_MS)
    this.watch()
    this.poll()
  }

  stop() {
    window.clearInterval(this.timer)
    this.timer = null
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.set(null)
  }

  /**
   * Checks again the moment any agent's records change: Claude Code's hook
   * events (~/.muta), Codex's sessions, OpenCode's and Antigravity's
   * databases. The timer stays, in case a watch misses something.
   */
  watch() {
    const fs = require("fs")
    const path = require("path")
    const home = this.homeDir()
    fs.mkdirSync(path.join(home, MUTA_DIR), { recursive: true })
    const soon = () => {
      window.clearTimeout(this.soon)
      this.soon = window.setTimeout(() => this.poll(), 60)
    }
    for (const [dir, recursive] of [
      [path.join(home, MUTA_DIR), false],
      [path.join(home, ".claude", "projects"), true],
      [path.join(home, ".codex", "sessions"), true],
      [path.join(home, ".local", "share", "opencode"), false],
      [path.join(home, ".gemini", "antigravity-cli"), false],
    ])
      try {
        this.watchers.push(fs.watch(dir, { recursive, persistent: false }, soon))
      } catch {} // not installed
  }

  // ── Claude Code's hooks ──────────────────────────────────────────────

  claudeSettingsPath() {
    return require("path").join(this.homeDir(), ".claude", "settings.json")
  }

  /** Whether Muta's hooks are in Claude Code's settings (checked every few seconds at most). */
  hooksInstalled(now = Date.now()) {
    if (this.hooksChecked && now - this.hooksChecked.at < 5000) return this.hooksChecked.on
    let on = false
    try {
      on = require("fs").readFileSync(this.claudeSettingsPath(), "utf8").includes(HOOK_MARK)
    } catch {}
    this.hooksChecked = { at: now, on }
    return on
  }

  /** Puts Muta's hooks into Claude Code's settings (and its scripts into ~/.muta), or takes them out. */
  setHooks(on) {
    const path = require("path")
    const dir = path.join(this.homeDir(), MUTA_DIR)
    const events = path.join(dir, "claude-hook.sh")
    const question = path.join(dir, "claude-question.sh")
    if (on) {
      writeScript(events, HOOK_SCRIPT)
      writeScript(question, QUESTION_SCRIPT)
    }
    // The permission script of an earlier version: gone.
    require("fs").rmSync(path.join(dir, "claude-permission.sh"), { force: true })
    editJson(this.claudeSettingsPath(), "Claude Code's settings.json", (settings) =>
      withHooks(settings, on ? `sh "${events}" # ${HOOK_MARK}` : null, on ? `sh "${question}" # ${HOOK_MARK}` : null)
    )
    this.hooksChecked = null
  }

  cursorHooksPath() {
    return require("path").join(this.homeDir(), ".cursor", "hooks.json")
  }

  /** Whether Muta's hooks are in Cursor's hooks.json. */
  cursorHooksInstalled() {
    try {
      return require("fs").readFileSync(this.cursorHooksPath(), "utf8").includes(CURSOR_HOOK_MARK)
    } catch {
      return false
    }
  }

  /** Puts Muta's hooks into Cursor's hooks.json (and its script into ~/.muta), or takes them out. */
  setCursorHooks(on) {
    const path = require("path")
    // The mark is in the script's name: Cursor may run the command without a shell, so no comment.
    const script = path.join(this.homeDir(), MUTA_DIR, `${CURSOR_HOOK_MARK}.sh`)
    if (on) writeScript(script, CURSOR_SCRIPT)
    editJson(this.cursorHooksPath(), "Cursor's hooks.json", (config) => withCursorHooks(config, on ? script : null))
  }

  /**
   * Answers a question from the window: answers maps each question's text to
   * the chosen label (or labels, or typed text); "skip" lets the script stop
   * waiting (answered in the terminal).
   */
  answer(ask, answers) {
    if (!/^[\w-]+$/.test(ask)) return
    const fs = require("fs")
    const path = require("path")
    let questions = []
    for (const session of this.hookSessions.values())
      if (session.attention && session.attention.ask === ask) questions = session.attention.questions
    const text = answers === "skip" ? "skip" : JSON.stringify(questionAnswer(questions, answers))
    const dir = path.join(this.homeDir(), MUTA_DIR, "answers")
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, ask), text)
    } catch {}
    // Answered: no longer waiting on the user (until the session says otherwise).
    for (const [id, session] of this.hookSessions)
      if (session.attention && session.attention.ask === ask) this.hookSessions.set(id, { ...session, attention: null })
    if (answers !== "skip") this.poll()
  }

  /** Reads the hook events (Claude Code's and Cursor's) written since last time. */
  readHookEvents() {
    for (const e of this.takeEvents("claude-events.jsonl")) {
      const id = e.hook && e.hook.session_id
      if (!id) continue
      const before = this.hookSessions.get(id)
      const after = claudeHookEvent(before, { ...e.hook, muta_ask: e.ask }, e.at || Date.now())
      this.hookSessions.set(id, after)
      // A question answered in the terminal: its hook script can stop waiting for the window.
      const was = before && before.attention && before.attention.ask
      if (was && (!after.attention || after.attention.ask !== was)) this.answer(was, "skip")
    }
    for (const e of this.takeEvents("cursor-events.jsonl")) {
      const id = e.cursor && e.cursor.conversation_id
      if (!id) continue
      const key = `cursor:${id}`
      this.hookSessions.set(key, cursorHookEvent(this.hookSessions.get(key), e.cursor, e.at || Date.now()))
    }
  }

  /** The lines of ~/.muta/<name> as JSON, taking the file away first, so none are read twice or lost. */
  takeEvents(name) {
    const fs = require("fs")
    const path = require("path")
    const file = path.join(this.homeDir(), MUTA_DIR, name)
    const taken = file + ".reading"
    try {
      fs.renameSync(file, taken)
    } catch {
      return []
    }
    let text = ""
    try {
      text = fs.readFileSync(taken, "utf8")
    } finally {
      fs.rmSync(taken, { force: true })
    }
    const out = []
    for (const line of text.split("\n"))
      try {
        if (line) out.push(JSON.parse(line))
      } catch {}
    return out
  }

  /**
   * Claude Code's sessions: from its hooks when they're in, and from its
   * session files for any the hooks haven't heard from (sessions started
   * before the hooks were added don't run them).
   */
  claudeSessions(now) {
    if (!this.hooksInstalled(now)) return this.claude(now)
    const hooked = this.fromHooks(now, "claude")
    const known = new Set(this.hookSessions.keys())
    const path = require("path")
    return [...hooked, ...this.claude(now).filter((x) => !known.has(path.basename(x.id, ".jsonl")))]
  }

  /** The sessions of agent kind heard from through hooks: those not over and heard from lately. */
  fromHooks(now, kind) {
    const out = []
    for (const [id, session] of this.hookSessions) {
      if (session.kind !== kind) continue
      if (session.ended || now - session.at > HOOK_STALE_MS) {
        if (now - session.at > AGENT_EDIT_MS) this.hookSessions.delete(id)
        continue
      }
      out.push(session)
    }
    return out
  }

  set(state) {
    const key = state ? state.all.map((a) => `${a.id}${a.attention ? "!" + a.attention.message : ""}`).join(",") : ""
    if (key === this.key) return
    this.key = key
    this.state = state
    this.onChange(state)
  }

  async poll() {
    if (this.busy) return
    this.busy = true
    try {
      const now = Date.now()
      if (!this.roots || now - this.roots.at > 30000) this.roots = this.vaultRoots()
      const s = this.plugin.settings
      this.readHookEvents()
      const sessions = [
        ...(s.agentClaude ? this.claudeSessions(now) : []),
        ...(s.agentCursor ? this.fromHooks(now, "cursor") : []),
        ...(s.agentCodex ? this.codex(now) : []),
        ...(s.agentOpencode ? await this.opencode(now) : []),
        ...(s.agentAntigravity ? await this.antigravity(now) : []),
      ]
      // Stopped while the databases were being read: it stays stopped.
      if (!this.timer) return
      let best = null
      const all = []
      for (const session of sessions) {
        this.reportEdits(session, now)
        if (!session.working) continue
        const edits = session.edits
          .filter((e) => now - e.at < AGENT_EDIT_MS)
          .map((e) => ({ ...e, file: this.toVault(e.path) }))
          .filter((e) => e.file)
          .sort((a, b) => b.at - a.at)
        if (!edits.length && !this.inVault(session.cwd)) continue
        const found = { kind: session.kind, name: AGENT_NAMES[session.kind], at: session.at, edit: edits[0] || null }
        all.push({ id: `${session.kind}:${session.id}`, kind: session.kind, attention: session.attention || null })
        const when = (x) => (x.edit ? x.edit.at : x.at)
        if (!best || when(found) > when(best)) best = found
      }
      // In the order each was first seen at work, so their beams keep their places.
      const seen = (this.firstSeen = this.firstSeen || new Map())
      for (const a of all) if (!seen.has(a.id)) seen.set(a.id, now)
      for (const id of seen.keys()) if (!all.some((a) => a.id === id)) seen.delete(id)
      all.sort((a, b) => seen.get(a.id) - seen.get(b.id))
      this.set(best && { ...best, all })
      this.prune(now)
    } catch (error) {
      console.error("Muta: checking for agents", error)
    } finally {
      this.busy = false
    }
  }

  /** Tells onEdit of each new edit to a note in the vault (for "see what changed"), once. */
  reportEdits(session, now) {
    for (const e of session.edits) {
      if (now - e.at > AGENT_EDIT_MS) continue
      const key = `${session.kind}|${e.path}|${e.at}|${(e.text || "").length}`
      if (this.editsSeen.has(key)) continue
      this.editsSeen.set(key, now)
      const file = this.toVault(e.path)
      if (file && this.onEdit) this.onEdit({ kind: session.kind, file, text: e.text || "", at: e.at })
    }
    for (const [key, at] of this.editsSeen) if (now - at > AGENT_EDIT_MS) this.editsSeen.delete(key)
  }

  /** The vault's folder, and the folders and files it links to from elsewhere (two levels deep). */
  vaultRoots() {
    const fs = require("fs")
    const path = require("path")
    const base = this.plugin.app.vault.adapter.getBasePath()
    const links = []
    const scan = (dir, rel, depth) => {
      let names = []
      try {
        names = fs.readdirSync(dir)
      } catch {}
      for (const name of names) {
        if (name.startsWith(".")) continue
        const full = path.join(dir, name)
        const at = rel ? `${rel}/${name}` : name
        try {
          const st = fs.lstatSync(full)
          if (st.isSymbolicLink()) links.push([at, fs.realpathSync(full)])
          else if (st.isDirectory() && depth < 1) scan(full, at, depth + 1)
        } catch {}
      }
    }
    scan(base, "", 0)
    let real = base
    try {
      real = fs.realpathSync(base)
    } catch {}
    return { at: Date.now(), real, links }
  }

  /** Whether folder cwd is inside the vault (or a folder it links to). */
  inVault(cwd) {
    if (!cwd) return false
    const real = this.realpath(cwd)
    const { roots } = this
    return within(real, roots.real) || roots.links.some(([, target]) => within(real, target))
  }

  /** The vault's Markdown note at file path p, or null. */
  toVault(p) {
    if (!p) return null
    const real = this.realpath(p)
    const { roots } = this
    let rel = null
    if (within(real, roots.real)) rel = real.slice(roots.real.length + 1)
    else
      for (const [at, target] of roots.links)
        if (within(real, target)) {
          rel = real === target ? at : `${at}/${real.slice(target.length + 1)}`
          break
        }
    const file = rel && this.plugin.app.vault.getAbstractFileByPath(rel)
    return file instanceof TFile && file.extension === "md" ? file : null
  }

  realpath(p) {
    try {
      return require("fs").realpathSync(p)
    } catch {
      return p
    }
  }

  /**
   * The session record file f keeps: { kind, cwd, edits, working }, made by
   * init and brought up to date by passing read(line, session) each line
   * written since the last poll (the first time, the last AGENT_TAIL bytes'),
   * so a long session isn't read again every poll.
   */
  session(f, at, init, read) {
    const fs = require("fs")
    let rec = this.records.get(f)
    const fd = fs.openSync(f, "r")
    try {
      const size = fs.fstatSync(fd).size
      if (!rec || size < rec.pos) {
        rec = { pos: Math.max(0, size - AGENT_TAIL), rest: null, session: init() }
        // Started mid-line: the first, cut off, is dropped.
        if (rec.pos > 0) rec.rest = false
        this.records.set(f, rec)
      }
      if (size > rec.pos) {
        const buf = Buffer.alloc(size - rec.pos)
        fs.readSync(fd, buf, 0, buf.length, rec.pos)
        rec.pos = size
        const text = buf.toString("utf8")
        const lines = ((rec.rest || "") + text).split("\n")
        const cut = rec.rest === false
        rec.rest = lines.pop()
        if (cut) lines.shift()
        for (const line of lines) if (line) read(line, rec.session)
        const { edits } = rec.session
        if (edits.length > AGENT_EDITS) edits.splice(0, edits.length - AGENT_EDITS)
      }
    } finally {
      fs.closeSync(fd)
    }
    rec.seen = Date.now()
    return { ...rec.session, id: f, at, edits: [...rec.session.edits] }
  }

  /** Forgets the files no session check has asked about for a while. */
  prune(now) {
    for (const [f, rec] of this.records) if (now - rec.seen > AGENT_STALE_MS) this.records.delete(f)
  }

  /** Session files under dir (and its folders, depth deep) written to in the last AGENT_STALE_MS. */
  recent(dir, now, test, depth = 0) {
    const fs = require("fs")
    const path = require("path")
    const out = []
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return out
    }
    // Only session files are looked at (a folder can hold thousands of others).
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          if (depth > 0) out.push(...this.recent(full, now, test, depth - 1))
        } else if (test(entry.name)) {
          const at = fs.statSync(full).mtimeMs
          if (now - at < AGENT_STALE_MS) out.push({ file: full, at })
        }
      } catch {}
    }
    return out
  }

  /** Claude Code: its project folders named after the vault, a folder in it or one around it. */
  claude(now) {
    const path = require("path")
    const fs = require("fs")
    const dir = path.join(this.homeDir(), ".claude", "projects")
    const name = (p) => p.replace(/[^a-zA-Z0-9]/g, "-")
    const roots = [this.roots.real, ...this.roots.links.map(([, target]) => target)].map(name)
    let folders = []
    try {
      folders = fs.readdirSync(dir).filter((f) => roots.some((r) => f.startsWith(r) || r.startsWith(f + "-")))
    } catch {
      return []
    }
    const sessions = []
    for (const folder of folders)
      for (const { file, at } of this.recent(path.join(dir, folder), now, (n) => n.endsWith(".jsonl"))) {
        const init = () => ({ kind: "claude", cwd: null, edits: [], working: null })
        const session = this.session(file, at, init, (line, session) => {
          if (!/"type":"(user|assistant|system)"/.test(line)) return
          let d
          try {
            d = JSON.parse(line)
          } catch {
            return
          }
          // Only the conversation's own lines (not the requests Claude Code also keeps there).
          if (!/^(user|assistant|system)$/.test(d.type)) return
          if (d.cwd) session.cwd = d.cwd
          if (!d.isSidechain) session.working = this.claudeWorking(d, session.working)
          const content = d.message && Array.isArray(d.message.content) ? d.message.content : []
          for (const c of content) {
            if (c.type !== "tool_use" || !c.input || !/^(Edit|MultiEdit|Write)$/.test(c.name)) continue
            const input = c.input
            const text = input.new_string || (input.edits && input.edits[0] && input.edits[0].new_string) || input.content || ""
            session.edits.push({ path: input.file_path, text, at: Date.parse(d.timestamp) || at })
          }
        })
        if (session.working === null) session.working = now - at < AGENT_ACTIVE_MS
        sessions.push(session)
      }
    return sessions
  }

  /**
   * Whether a Claude Code session is mid-turn after record d (was: before it).
   * A prompt or a tool's result starts or continues a turn; a reply that ends
   * the turn, the hooks that run when it stops, or an interruption end it.
   */
  claudeWorking(d, was) {
    const m = d.message || {}
    if (d.type === "system") return d.subtype === "stop_hook_summary" || d.subtype === "turn_duration" ? false : was
    if (d.type === "assistant") return m.stop_reason === "tool_use" || !m.stop_reason ? true : false
    if (d.type !== "user" || d.isMeta) return was
    const content = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? m.content.map((c) => c.text || "").join("") : ""
    // Interrupted, or a command Claude Code ran itself (/compact, /clear): no turn follows.
    return !/^(\[Request interrupted|<command-name>|<local-command)/.test(content.trim())
  }

  /** Codex: today's and yesterday's sessions, with the files their patches add or update. */
  codex(now) {
    const path = require("path")
    const base = path.join(this.homeDir(), ".codex", "sessions")
    const day = (t) => {
      const d = new Date(t)
      return path.join(base, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"))
    }
    const files = [...new Set([day(now), day(now - 86400000)])].flatMap((dir) =>
      this.recent(dir, now, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl"))
    )
    const sessions = []
    for (const { file, at } of files) {
      const init = () => ({ kind: "codex", cwd: this.codexCwd(file), edits: [], working: null })
      const session = this.session(file, at, init, (line, session) => {
        // A turn starts with task_started and ends with task_complete (or turn_aborted).
        const turn = line.match(/"payload":\{"type":"(task_started|task_complete|turn_aborted)"/)
        if (turn) session.working = turn[1] === "task_started"
        if (!line.includes("File: ")) return
        let d
        try {
          d = JSON.parse(line)
        } catch {
          return
        }
        const p = d.payload || {}
        const call = typeof p.input === "string" ? p.input : typeof p.arguments === "string" ? p.arguments : ""
        // The patch may be inside a script, still escaped: undo that first.
        const patch = call.includes("\\n") ? call.replace(/\\n/g, "\n").replace(/\\"/g, '"') : call
        const re = /\*\*\* (?:Update|Add) File: ([^\n]+)\n([\s\S]*?)(?=\n\*\*\* |$)/g
        let m
        while ((m = re.exec(patch))) {
          const added = m[2].split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))
          session.edits.push({ path: m[1].trim(), text: added.join("\n"), at: Date.parse(d.timestamp) || at })
        }
      })
      if (session.working === null) session.working = now - at < AGENT_ACTIVE_MS
      sessions.push(session)
    }
    return sessions
  }

  /** The folder a Codex session runs in, from its first line. */
  codexCwd(file) {
    const fs = require("fs")
    try {
      const fd = fs.openSync(file, "r")
      const buf = Buffer.alloc(16384)
      const n = fs.readSync(fd, buf, 0, buf.length, 0)
      fs.closeSync(fd)
      const m = buf.toString("utf8", 0, n).match(/"cwd":"((?:[^"\\]|\\.)*)"/)
      return m ? JSON.parse(`"${m[1]}"`) : null
    } catch {
      return null
    }
  }

  /** OpenCode: its database, through macOS's sqlite3 (OpenCode 2's tables, or the ones before them). */
  async opencode(now) {
    const path = require("path")
    const db = path.join(this.homeDir(), ".local", "share", "opencode", "opencode.db")
    if (!require("fs").existsSync(db)) return []
    const query = (sql) => this.sqlite(db, sql)
    const v2 = await query("select name from sqlite_master where type = 'table' and name = 'session_v2'")
    if (v2.length) return this.opencode2(now, query)
    const rows = await query(`select id, directory, time_updated from session where time_updated > ${Math.floor(now - AGENT_STALE_MS)}`)
    const sessions = []
    for (const row of rows) {
      if (!/^[\w-]+$/.test(row.id)) continue
      // Mid-turn while its latest message is the prompt, or a reply not yet finished or ending in tool calls.
      const [last] = await query(`select data from message where session_id = '${row.id}' order by time_created desc limit 1`)
      let working = false
      try {
        const m = JSON.parse(last.data)
        working = m.role === "user" || !(m.time && m.time.completed) || m.finish === "tool-calls"
      } catch {}
      const session = { id: row.id, kind: "opencode", cwd: row.directory, at: row.time_updated, edits: [], working }
      const parts = await query(
        `select data, time_updated from part where session_id = '${row.id}' and data like '%"filePath"%' order by time_updated desc limit 10`
      )
      for (const part of parts) {
        try {
          const d = JSON.parse(part.data)
          const input = d.state && d.state.input
          if (d.type === "tool" && /^(edit|write)$/.test(d.tool) && input && input.filePath)
            session.edits.push({ path: input.filePath, text: input.newString || input.content || "", at: part.time_updated })
        } catch {}
      }
      sessions.push(session)
    }
    return sessions
  }

  /**
   * OpenCode 2: its sessions mark when a turn started (time_busy) and ended
   * (time_idle); its messages hold the tool calls, edits among them.
   */
  async opencode2(now, query) {
    const rows = await query(
      `select id, directory, time_updated, time_busy, time_idle from session_v2 where time_updated > ${Math.floor(now - AGENT_STALE_MS)}`
    )
    const sessions = []
    for (const row of rows) {
      if (!/^[\w-]+$/.test(row.id)) continue
      const working = !!row.time_busy && !(row.time_idle >= row.time_busy)
      const session = { id: row.id, kind: "opencode", cwd: row.directory, at: row.time_updated, edits: [], working }
      const messages = await query(
        `select data, time_updated from session_message where session_id = '${row.id}' and type = 'assistant' ` +
          `and (data like '%"name":"edit"%' or data like '%"name":"write"%') order by seq desc limit 10`
      )
      for (const message of messages) {
        try {
          for (const c of JSON.parse(message.data).content || []) {
            const input = c.state && c.state.input
            const path = input && (input.path || input.filePath)
            if (c.type !== "tool" || !/^(edit|write)$/.test(c.name) || !path) continue
            const at = (c.time && (c.time.completed || c.time.created)) || message.time_updated
            session.edits.push({ path, text: input.newString || input.content || "", at })
          }
        } catch {}
      }
      sessions.push(session)
    }
    return sessions
  }

  /**
   * Antigravity: its conversations' summaries say which are running and in
   * which folder (CASCADE_RUN_STATUS_RUNNING, or not_fully_idle while tasks
   * it started in the background still run); each conversation's steps hold
   * the files it wrote, as {"Path": …, "Content": …} in their protobufs.
   * Its CLI keeps them in ~/.gemini/antigravity-cli; the app, if it keeps the
   * same, in ~/.gemini/antigravity.
   */
  async antigravity(now) {
    const path = require("path")
    const fs = require("fs")
    const sessions = []
    for (const name of ["antigravity-cli", "antigravity"]) {
      const dir = path.join(this.homeDir(), ".gemini", name)
      const db = path.join(dir, "conversation_summaries.db")
      if (!fs.existsSync(db)) continue
      const rows = await this.sqlite(
        db,
        "select conversation_id, workspace_uris, last_modified_time from conversation_summaries " +
          "where status = 'CASCADE_RUN_STATUS_RUNNING' or not_fully_idle"
      )
      for (const row of rows) {
        const id = row.conversation_id
        const at = Date.parse(String(row.last_modified_time).replace(" ", "T").replace(/(\.\d{3})\d*/, "$1"))
        if (!/^[\w-]+$/.test(id) || !(now - at < AGENT_STALE_MS)) continue
        let cwd = null
        try {
          const uri = JSON.parse(row.workspace_uris)[0]
          if (uri && uri.startsWith("file://")) cwd = decodeURIComponent(uri.slice(7))
        } catch {}
        const session = { id, kind: "antigravity", cwd, at, edits: [], working: true }
        const steps = await this.sqlite(
          path.join(dir, "conversations", `${id}.db`),
          "select idx, hex(step_payload) as hex from steps " +
            `where cast(step_payload as text) like '%"Path":"%' or cast(step_payload as text) like '%"TargetFile":"%' ` +
            "order by idx desc limit 10"
        )
        for (const step of steps) {
          const text = Buffer.from(step.hex || "", "hex").toString("utf8")
          const m = text.match(/\{[^{}]*"(?:Path|TargetFile)":"(?:[^"\\]|\\.)*"[^{}]*\}/)
          if (!m) continue
          let input
          try {
            input = JSON.parse(m[0])
          } catch {
            continue
          }
          const key = `${id}|${step.idx}`
          if (!this.seenAt.has(key)) this.seenAt.set(key, now)
          const content = input.Content || input.ReplacementContent || input.CodeContent || ""
          session.edits.push({ path: input.Path || input.TargetFile, text: content.replace(/^\n+/, ""), at: this.seenAt.get(key) })
        }
        sessions.push(session)
      }
    }
    return sessions
  }

  /** The rows sqlite3 (macOS's own) finds for query sql in database db, read-only; none on any error. */
  sqlite(db, sql) {
    return new Promise((resolve) =>
      require("child_process").execFile("/usr/bin/sqlite3", ["-readonly", "-json", db, sql], { timeout: 1000 }, (err, out) => {
        try {
          resolve(err || !out.trim() ? [] : JSON.parse(out))
        } catch {
          resolve([])
        }
      })
    )
  }
}

/**
 * A Claude Code session after hook event hook (at: when, ms), from session
 * (or none yet). A prompt or a tool starts or continues a turn; Stop ends it;
 * SessionEnd ends the session. A question (AskUserQuestion, through the
 * PermissionRequest hook) needs the user until the next tool or prompt.
 * Edits (Edit, MultiEdit, Write) say which files, and what's new.
 */
function claudeHookEvent(session, hook, at) {
  const s = session
    ? { ...session, edits: [...session.edits] }
    : { id: hook.session_id, kind: "claude", cwd: null, working: false, attention: null, ended: false, edits: [], at }
  s.at = at
  if (hook.cwd) s.cwd = hook.cwd
  const event = hook.hook_event_name
  if (event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse") {
    s.working = true
    s.ended = false
    s.attention = null
  } else if (event === "Stop") {
    s.working = false
    s.attention = null
  } else if (event === "SessionEnd") {
    s.working = false
    s.attention = null
    s.ended = true
  } else if (event === "PermissionRequest" && hook.tool_name === "AskUserQuestion") {
    // A question: answerable from the window when it came through Muta's question script.
    s.working = true
    s.attention = { questions: (hook.tool_input && hook.tool_input.questions) || [], ask: hook.muta_ask || null }
  }
  if (event === "PreToolUse" && /^(Edit|MultiEdit|Write)$/.test(hook.tool_name || "")) {
    const input = hook.tool_input || {}
    const text = input.new_string || (input.edits || []).map((e) => e.new_string || "").join("\n") || input.content || ""
    if (input.file_path) s.edits.push({ path: input.file_path, text, at })
    if (s.edits.length > AGENT_EDITS) s.edits.splice(0, s.edits.length - AGENT_EDITS)
  }
  return s
}

/**
 * Claude Code's settings with Muta's hooks in (running command) or taken out
 * (command null), leaving every other hook as it is.
 */
function withHooks(settings, command, questionCommand = command) {
  const next = { ...settings, hooks: { ...(settings.hooks || {}) } }
  const ours = (group) => (group.hooks || []).some((h) => String(h.command || "").includes(HOOK_MARK))
  // Notification: an earlier version's, taken out.
  for (const event of [...HOOK_EVENTS, "Notification"]) {
    const groups = (next.hooks[event] || []).filter((g) => !ours(g))
    if (command && HOOK_EVENTS.includes(event)) {
      // Only questions go to the question script, which waits for an answer from the window (up to 10 minutes).
      const hook =
        event === "PermissionRequest"
          ? { type: "command", command: questionCommand, timeout: 610 }
          : { type: "command", command, timeout: 5 }
      const group = { hooks: [hook] }
      if (event === "PreToolUse" || event === "PostToolUse") group.matcher = "*"
      if (event === "PermissionRequest") group.matcher = "AskUserQuestion"
      groups.push(group)
    }
    if (groups.length) next.hooks[event] = groups
    else delete next.hooks[event]
  }
  if (!Object.keys(next.hooks).length) delete next.hooks
  return next
}

/** How each agent starts in a terminal with a first prompt (the prompt follows, quoted). */
const AGENT_LAUNCH = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode --prompt",
  cursor: "cursor-agent",
  antigravity: "agy -i",
}

/** The first prompt for an agent sent a note: what it is and where, and the note itself. */
function agentPrompt(title, file, content) {
  return `Work on "${title}", from my notes (${file}):\n\n${content.trim()}\n`
}

/** The git repository folder dir is in, or null. */
function gitRoot(dir) {
  const fs = require("fs")
  const path = require("path")
  for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, ".git"))) return d
  return null
}

/** s for a POSIX shell, in single quotes. */
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
/** s as an AppleScript string. */
const appleQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** What the question script gives Claude Code: the questions, answered (answers: question text → label(s) or typed text). */
function questionAnswer(questions, answers) {
  return {
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "allow", updatedInput: { questions, answers } },
    },
  }
}

/** Cursor's hooks.json with Muta's hooks in (running script) or taken out (script null), leaving every other hook. */
function withCursorHooks(config, script) {
  const next = { version: 1, ...config, hooks: { ...(config.hooks || {}) } }
  for (const event of CURSOR_HOOK_EVENTS) {
    const hooks = (next.hooks[event] || []).filter((h) => !String(h.command || "").includes(CURSOR_HOOK_MARK))
    if (script) hooks.push({ command: `sh ${script} ${event}` })
    if (hooks.length) next.hooks[event] = hooks
    else delete next.hooks[event]
  }
  if (!Object.keys(next.hooks).length) delete next.hooks
  return next
}

/**
 * A Cursor agent conversation after hook event hook (at: when, ms). A prompt
 * starts a turn, its tools and replies continue it, stop ends it, sessionEnd
 * ends the conversation. File edits say which files and what's new.
 */
function cursorHookEvent(session, hook, at) {
  const s = session
    ? { ...session, edits: [...session.edits] }
    : { id: hook.conversation_id, kind: "cursor", cwd: null, working: false, attention: null, ended: false, edits: [], at }
  s.at = at
  if (Array.isArray(hook.workspace_roots) && hook.workspace_roots[0]) s.cwd = hook.workspace_roots[0]
  const event = hook.hook_event_name
  if (event === "stop") s.working = false
  else if (event === "sessionEnd") {
    s.working = false
    s.ended = true
  } else {
    s.working = true
    s.ended = false
  }
  if (event === "afterFileEdit" && hook.file_path) {
    const text = (hook.edits || []).map((e) => e.new_string || "").join("\n")
    s.edits.push({ path: hook.file_path, text, at })
    if (s.edits.length > AGENT_EDITS) s.edits.splice(0, s.edits.length - AGENT_EDITS)
  }
  return s
}

/** Writes an executable script. */
function writeScript(file, text) {
  const fs = require("fs")
  fs.mkdirSync(require("path").dirname(file), { recursive: true })
  fs.writeFileSync(file, text, { mode: 0o755 })
}

/** Rewrites JSON file through change (from {} if it isn't there); one that can't be read is left alone (named what for the error). */
function editJson(file, what, change) {
  const fs = require("fs")
  let data = {}
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    if (fs.existsSync(file)) throw new Error(`${what} couldn't be read, so it was left as it is`)
  }
  fs.mkdirSync(require("path").dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(change(data), null, 2) + "\n")
}

/**
 * The lines of an edit's new text as they'd read on the rendered page:
 * Markdown's marks taken off (headings, lists, quotes, emphasis, links,
 * code), blank and very short lines left out.
 */
function changedLines(text) {
  return String(text || "")
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*>+\s?/, "")
        .replace(/^\s*(#{1,6}\s+|[-*+]\s+(\[.\]\s+)?|\d+[.)]\s+)/, "")
        .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/(\*\*|__|==|~~|`)/g, "")
        .replace(/(^|\W)[*_](\S.*?\S|\S)[*_](?=\W|$)/g, "$1$2")
        .replace(/^\[!\w+\][+-]?\s*/, "")
        .replace(/\s+/g, " ")
        .trim()
    )
    .filter((line) => line.length >= 4 && !/^[-|:\s]+$/.test(line))
}

/**
 * A flick's bounce past a page's end, starting at the page's own speed v
 * (px/ms) so it never stalls or jumps as it hits the end: a critically
 * damped spring, x(t) = v·t·e^(−t/τ), always the same pace, its distance
 * eased off towards BOUNCE_MAX (tanh keeps the speed it starts at; stiffening
 * the spring instead made fast flicks snap back). Points a frame (8ms)
 * apart, ending back at 0.
 */
function bouncePath(v) {
  const tau = BOUNCE_TAU_MS
  const duration = tau * 9
  const points = []
  for (let t = 0; t <= duration; t += 8) {
    const free = v * t * Math.exp(-t / tau)
    // Over its last moments it eases to exactly 0, so even a hard flick doesn't pop into place at the end.
    const settle = Math.min(1, (duration - t) / BOUNCE_SETTLE_MS)
    points.push({ t, x: BOUNCE_MAX * Math.tanh(free / BOUNCE_MAX) * settle * settle * (3 - 2 * settle), offset: t / duration })
  }
  points.push({ t: duration, x: 0, offset: 1 })
  return { points, duration }
}

/** Whether path p is folder dir or inside it. */
const within = (p, dir) => p === dir || p.startsWith(dir + "/")

module.exports = class extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, (await this.loadData()) || (await this.fromFloatingPreview()))
    this.addSettingTab(new MutaSettings(this.app, this))
    this.patchMenus()
    // Local agents at work in this vault: a beam for each (agents).
    this.agent = null
    this.agents = new AgentWatch(this, (state) => this.onAgent(state))
    this.agents.onEdit = (edit) => this.onAgentEdit(edit)
    this.recentEdits = []
    if (this.settings.agentIndicator) this.agents.start()
    // An agent's edit to the note on show: it re-renders, then the change is lit.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.leaf && this.leaf.view.file === file) window.setTimeout(() => this.lightChanges(file), CHANGE_RENDER_MS)
      })
    )
    this.leaf = null
    this.win = null
    this.next = null
    this.busy = false
    this.pip = null
    this.updateFades = null
    this.items = null
    this.itemsFor = null
    this.sourcePath = null
    this.ui = null

    // The order changes when a note it comes from does.
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        if (this.isOrderNote(file.path) || file.path === this.sourcePath) this.items = null
      })
    )

    const preview = this.app.internalPlugins.getPluginById("page-preview")
    const instance = preview && preview.instance
    if (!instance) return
    const original = instance.onLinkHover
    const plugin = this
    instance.onLinkHover = function (parent, targetEl, linktext, sourcePath) {
      if (!plugin.settings.enabled) return original.apply(this, arguments)
      const file = plugin.app.metadataCache.getFirstLinkpathDest(
        linktext.split("#")[0],
        sourcePath
      )
      if (!(file instanceof TFile) || file.extension !== "md")
        return original.apply(this, arguments)
      // Links inside the preview itself don't switch it on hover (clicking one
      // goes there), so reading it never jumps away under the cursor.
      if (targetEl && targetEl.ownerDocument.body.classList.contains("muta-window")) return
      // Only with the hover key held, so it doesn't open by accident; pressed
      // while still over the link, it opens then (watchHoverKey).
      if (!plugin.hoverKeyHeld()) {
        plugin.pendingHover = { file, targetEl, sourcePath }
        return
      }
      plugin.previewLink(file, targetEl, sourcePath)
    }
    this.register(() => {
      instance.onLinkHover = original
    })
    this.watchHoverKey(window)
    // And Obsidian's other windows: open now, and opened later.
    this.app.workspace.onLayoutReady(() =>
      this.app.workspace.iterateAllLeaves((leaf) => {
        const win = leaf.view && leaf.view.containerEl.win
        if (win && win !== window) this.watchHoverKey(win)
      })
    )
    this.registerEvent(this.app.workspace.on("window-open", (w) => this.watchHoverKey(w.win)))

    // Switching Obsidian between light and dark switches the window's glass too.
    this.registerEvent(this.app.workspace.on("css-change", () => this.applySettings()))

    this.addCommand({
      id: "toggle-preview-window",
      name: "Toggle preview window",
      callback: async () => {
        this.settings.enabled = !this.settings.enabled
        if (!this.settings.enabled) this.closeWindow()
        await this.saveData(this.settings)
      },
    })
  }

  /** Shows a hovered link's note. */
  previewLink(file, targetEl, sourcePath) {
    this.pendingHover = null
    // The note you hovered from gives the switcher its order when no order notes are set.
    if (sourcePath) this.sourcePath = sourcePath
    this.schedule(file, this.direction(targetEl))
  }

  /** Whether the hover key is held (from the last mouse or key event in any of Obsidian's windows). */
  hoverKeyHeld() {
    const key = this.settings.hoverKey
    return key === "none" || !!(this.mods && this.mods[key])
  }

  /**
   * Keeps track of the modifier keys in a window: mouse events carry them, so
   * they're right as a link is hovered; pressing the hover key while still over
   * a link previews it.
   */
  watchHoverKey(win) {
    this.hoverKeyWins = this.hoverKeyWins || new WeakSet()
    if (!win || this.hoverKeyWins.has(win)) return
    this.hoverKeyWins.add(win)
    const track = (e) => {
      this.mods = { meta: e.metaKey, alt: e.altKey, ctrl: e.ctrlKey, shift: e.shiftKey }
    }
    this.registerDomEvent(win, "mouseover", track, true)
    this.registerDomEvent(win, "mousemove", track, true)
    this.registerDomEvent(win, "keyup", track, true)
    this.registerDomEvent(win, "blur", () => (this.mods = null))
    this.registerDomEvent(win, "keydown", (e) => {
      track(e)
      const pending = this.pendingHover
      if (!pending || !this.hoverKeyHeld()) return
      const el = pending.targetEl
      if (el && el.isConnected && el.matches(":hover")) this.previewLink(pending.file, el, pending.sourcePath)
      else this.pendingHover = null
    }, true)
  }

  onunload() {
    this.agents.stop()
    this.closeWindow()
  }

  // ── Agents: a beam for each one at work in the vault ────────────────

  /** Agents started or stopped working in the vault. */
  onAgent(state) {
    this.agent = state
    this.showAgent()
  }

  /** The window's beams, for the agents at work (styles.css). */
  showAgent() {
    const doc = this.leaf && this.leaf.view.containerEl.ownerDocument
    if (!doc || doc === document) return
    const { agent } = this
    doc.body.classList.toggle("has-agent", !!agent)
    // One asking you something leaves the beams to those still working.
    this.showBeams(doc, agent ? agent.all.filter((a) => !a.attention) : [])
    this.showAsk(doc, agent ? agent.all.find((a) => a.attention) : null)
  }

  /**
   * An agent asking you a question: it leaves the beams to the agents still
   * working, and the bottom bar shows that it's asking, in the name's place.
   * Clicking that opens the question (openAsk()).
   */
  showAsk(doc, asking) {
    const body = doc.body
    const sw = this.ui && this.ui.switcher
    const before = this.asking && this.asking.attention.ask
    this.asking = asking || null
    body.classList.toggle("has-ask", !!asking)
    if (asking && sw) {
      sw.ask.dataset.agent = asking.kind
      const q = asking.attention.questions[0]
      sw.askText.setText(`${AGENT_NAMES[asking.kind]} asks${q && q.header ? ` · ${q.header}` : ""}`)
      sw.ask.setAttribute("aria-label", `${AGENT_NAMES[asking.kind]} asks: ${q ? q.question : ""}`)
    }
    // Answered (here or in the terminal), or a new question: the open one goes.
    if (body.classList.contains("is-ask-open") && (!asking || asking.attention.ask !== before)) this.closeAsk()
  }

  /**
   * The question, over the page above the bottom bar, grown out of its
   * button: each question with its options (one, or several when it allows
   * that) and a field to type an answer of your own, and Send.
   */
  openAsk() {
    const sw = this.ui && this.ui.switcher
    const asking = this.asking
    if (!sw || !asking) return
    const doc = sw.el.ownerDocument
    if (doc.body.classList.contains("is-ask-open")) return this.closeAsk()
    let panel = this.askPanel
    if (!panel || !panel.isConnected) {
      panel = this.askPanel = doc.body.createDiv({ cls: "muta-ask-panel" })
      doc.addEventListener("pointerdown", (e) => {
        if (doc.body.classList.contains("is-ask-open") && !panel.contains(e.target) && !sw.ask.contains(e.target)) this.closeAsk()
      }, true)
      doc.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && doc.body.classList.contains("is-ask-open")) this.closeAsk()
      })
    }
    panel.empty()
    panel.dataset.agent = asking.kind
    const who = panel.createDiv({ cls: "muta-ask-agent" })
    who.createSpan({ cls: "muta-ask-dot" })
    who.createSpan({ text: `${AGENT_NAMES[asking.kind]} asks` })
    const { questions, ask } = asking.attention
    const chosen = new Map(questions.map((q) => [q.question, new Set()]))
    const typed = new Map()
    const send = panel.createEl("button", { cls: "muta-ask-send", text: "Send" })
    const ready = () => questions.every((q) => chosen.get(q.question).size || (typed.get(q.question) || "").trim())
    const refresh = () => (send.disabled = !ready())
    for (const q of questions) {
      const block = panel.createDiv({ cls: "muta-ask-question" })
      block.createDiv({ cls: "muta-ask-text", text: q.question })
      const options = block.createDiv({ cls: "muta-ask-options" })
      for (const o of q.options || []) {
        const b = options.createEl("button", { cls: "muta-ask-option" })
        b.createSpan({ cls: "muta-ask-label", text: o.label })
        if (o.description) b.createSpan({ cls: "muta-ask-description", text: o.description })
        b.addEventListener("click", () => {
          const set = chosen.get(q.question)
          if (q.multiSelect) set.has(o.label) ? set.delete(o.label) : set.add(o.label)
          else {
            set.clear()
            set.add(o.label)
            options.querySelectorAll(".is-chosen").forEach((x) => x.removeClass("is-chosen"))
          }
          b.toggleClass("is-chosen", set.has(o.label))
          refresh()
        })
      }
      const other = block.createEl("input", { cls: "muta-ask-other", attr: { type: "text", placeholder: "Or type an answer…" } })
      other.addEventListener("input", () => {
        typed.set(q.question, other.value)
        refresh()
      })
      other.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && ready()) send.click()
      })
    }
    panel.appendChild(send)
    refresh()
    send.addEventListener("click", () => {
      const answers = {}
      for (const q of questions) {
        const own = (typed.get(q.question) || "").trim()
        const picked = [...chosen.get(q.question)]
        answers[q.question] = own || (q.multiSelect ? picked : picked[0])
      }
      this.agents.answer(ask, answers)
      this.closeAsk()
    })
    // It grows out of the button.
    const b = sw.ask.getBoundingClientRect()
    doc.body.classList.add("is-ask-open")
    const p = panel.getBoundingClientRect()
    const inset = (r) => `inset(${r.top - p.top}px ${p.right - r.right}px ${p.bottom - r.bottom}px ${r.left - p.left}px round 12px)`
    if (!reduceMotion())
      panel.animate([{ clipPath: inset(b), opacity: 0.6 }, { clipPath: "inset(0 round 12px)", opacity: 1 }], {
        duration: 340,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      })
  }

  closeAsk() {
    const doc = this.askPanel && this.askPanel.ownerDocument
    if (doc) doc.body.classList.remove("is-ask-open")
  }

  /** An agent changed a note in the vault: kept a while, and lit at once if it's the note on show. */
  onAgentEdit(edit) {
    const now = Date.now()
    this.recentEdits = [...this.recentEdits.filter((e) => now - e.seen < CHANGE_KEEP_MS), { ...edit, seen: now }]
    if (this.leaf && this.leaf.view.file === edit.file) window.setTimeout(() => this.lightChanges(edit.file), CHANGE_RENDER_MS)
  }

  /**
   * See what changed: the lines agents changed on the page on show, lately,
   * glow for a moment in the agent's colour (styles.css). Each change lights
   * once.
   */
  lightChanges(file) {
    const page = this.page()
    if (!page || !this.leaf || this.leaf.view.file !== file) return
    const now = Date.now()
    const edits = this.recentEdits.filter((e) => e.file === file && now - e.seen < CHANGE_KEEP_MS && !e.lit)
    if (!edits.length) return
    const blocks = [...page.querySelectorAll(".markdown-preview-sizer :is(p, li, h1, h2, h3, h4, h5, h6, td, th, .callout-title-inner, pre)")]
    const textOf = new Map(blocks.map((el) => [el, el.textContent.replace(/\s+/g, " ").trim()]))
    for (const edit of edits) {
      edit.lit = true
      for (const line of changedLines(edit.text)) {
        // The innermost block that holds the line (a list item's own text, not its whole list).
        const holders = blocks.filter((el) => textOf.get(el).includes(line) || (line.includes(textOf.get(el)) && textOf.get(el).length >= 12))
        const el = holders.find((h) => !holders.some((o) => o !== h && h.contains(o))) || holders[0]
        if (!el) continue
        el.dataset.mutaChanged = edit.kind
        el.classList.remove("muta-changed")
        void el.offsetWidth // restart the glow if it's lit again
        el.classList.add("muta-changed")
        window.setTimeout(() => el.classList.remove("muta-changed"), CHANGE_GLOW_MS)
      }
    }
  }

  /**
   * A beam for each agent at work (styles.css): round the page's edge, and
   * its light on the window's outer edge, in the agent's colours. Several are
   * spread evenly round the edge, each shortened to its share, and slide
   * apart or together as agents come and go; one that's stopped fades out.
   * They all turn together: each starts at the same point of the turn.
   */
  showBeams(doc, agents) {
    const page = this.leaf.view.contentEl
    const beams = (this.beams = this.beams || new Map())
    const shown = agents.slice(0, MAX_BEAMS)
    // The window was opened again, or the page replaced: its beams are new.
    for (const [id, beam] of beams)
      if (!beam.glow.isConnected || beam.glow.parentElement !== page) {
        beam.glow.remove()
        beam.rim.remove()
        beams.delete(id)
      }
    const sync = `${-(performance.now() % BEAM_TURN_MS)}ms, 0ms`
    for (const a of shown) {
      let beam = beams.get(a.id)
      if (beam && beam.leaving) {
        window.clearTimeout(beam.leaving)
        beam.leaving = 0
        for (const el of [beam.glow, beam.rim]) el.removeClass("is-leaving")
      }
      if (!beam) {
        const glow = page.createDiv({ cls: "muta-agent-glow" })
        glow.createDiv({ cls: "muta-agent-haze" })
        glow.createDiv({ cls: "muta-agent-bloom" })
        const rim = doc.body.createDiv({ cls: "muta-agent-rim" })
        beam = { glow, rim, leaving: 0 }
        beams.set(a.id, beam)
        for (const el of [glow, rim]) {
          el.dataset.agent = a.kind
          el.style.animationDelay = sync
        }
      }
    }
    // Spread round the edge: each its share of the turn, new ones starting where the last left off.
    shown.forEach((a, i) => {
      const beam = beams.get(a.id)
      for (const el of [beam.glow, beam.rim]) {
        el.style.setProperty("--muta-beam-offset", `${(360 / shown.length) * i}deg`)
        el.style.setProperty("--muta-beam-span", `${360 / shown.length}deg`)
      }
    })
    for (const [id, beam] of beams)
      if (!shown.some((a) => a.id === id) && !beam.leaving) {
        for (const el of [beam.glow, beam.rim]) el.addClass("is-leaving")
        beam.leaving = window.setTimeout(() => {
          beam.glow.remove()
          beam.rim.remove()
          beams.delete(id)
        }, 500)
      }
  }

  /** Shows the hovered file at once; while one is loading, only the latest hover is kept. */
  schedule(file, direction = 1, axis = "y") {
    this.next = file
    this.nextDirection = direction
    this.nextAxis = axis
    if (!this.busy) this.drain()
  }

  async drain() {
    this.busy = true
    try {
      while (this.next) {
        const file = this.next
        const direction = this.nextDirection || 1
        const axis = this.nextAxis || "y"
        this.next = null
        await this.show(file, direction, axis)
      }
    } finally {
      this.busy = false
    }
  }

  isOpen() {
    return !!(
      this.leaf &&
      this.leaf.view &&
      this.leaf.view.containerEl.isConnected &&
      alive(this.win)
    )
  }

  async show(file, direction = 1, axis = "y") {
    if (!this.isOpen()) {
      this.closeWindow()
      await this.openWindow()
    }
    // Docked at the notch, it grows out to show the hovered page.
    if (this.pip) this.pip.peek()
    const { leaf } = this
    if (!leaf || (leaf.view.file && leaf.view.file.path === file.path)) return
    const old = this.snapshot()
    await leaf.openFile(file, { active: false, state: { mode: "preview" } })
    this.attach()
    this.addCloseButton()
    this.addSendButton()
    this.showAgent()
    const raf = leaf.view.containerEl.win || window
    if (this.updateFades) raf.setTimeout(this.updateFades, 50)
    this.collapsePending = true
    this.collapseProperties()
    this.crossfade(old, direction, axis)
    this.markCurrent(file)
    // Changed by an agent lately: lit once the page is in.
    window.setTimeout(() => this.lightChanges(file), CHANGE_RENDER_MS)
    this.updateSwitcher(file)
    // The page renders over a few frames; place the rail's marks once it has.
    for (const ms of [30, 60, 150, 400])
      raf.setTimeout(() => {
        this.collapseProperties()
        this.updateRail()
      }, ms)
  }

  /** Properties start collapsed to their heading; clicking it opens them (Obsidian's own toggle). */
  collapseProperties() {
    if (!this.collapsePending) return
    const page = this.page()
    const container = page && page.querySelector(".metadata-container")
    const heading = container && container.querySelector(".metadata-properties-heading")
    if (!heading) return // not rendered yet: tried again shortly (show)
    // Once per page shown, so opening them yourself sticks.
    this.collapsePending = false
    this.toggleProperties(container, true, false)
  }

  // ── The roadmap ───────────────────────────────────────────────────────

  orderPatterns() {
    return this.settings.orderNotes
      .split(/[\n,]/)
      .map((g) => g.trim())
      .filter(Boolean)
      .map(globToRegExp)
  }

  isOrderNote(path) {
    return this.orderPatterns().some((re) => re.test(path))
  }

  /**
   * The notes the switcher steps through, in order: { file, group, depth }.
   * They come from the lists of links in the order notes (Settings), taken
   * in path order, or without those, from the note you hovered from. Each
   * is grouped under the note's name (its frontmatter "name" too, if it has
   * one) and the heading or callout it's under; a link nested under another
   * is a sub-item (depth 1).
   */
  async roadmap() {
    const patterns = this.orderPatterns()
    const key = patterns.length ? "order" : this.sourcePath
    if (this.items && this.itemsFor === key) return this.items
    const { vault, metadataCache } = this.app
    let notes
    if (patterns.length)
      notes = vault
        .getMarkdownFiles()
        .filter((f) => patterns.some((re) => re.test(f.path)))
        .sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))
    else {
      const source = this.sourcePath && vault.getAbstractFileByPath(this.sourcePath)
      notes = source instanceof TFile ? [source] : []
    }
    const items = []
    const seen = new Set()
    for (const note of notes) {
      const fm = (metadataCache.getFileCache(note) || {}).frontmatter || {}
      const name = fm.name ? `${note.basename}: ${fm.name}` : note.basename
      let section = ""
      for (const line of (await vault.cachedRead(note)).split("\n")) {
        const callout = line.match(/^>\s*\[![^\]]+\][+-]?\s*(.*)$/)
        const heading = line.match(/^(?:>\s*)?#{1,6}\s+(.+)$/)
        if (callout || heading) {
          section = (callout ? callout[1] : heading[1]).trim()
          continue
        }
        // A list item that starts with a link: "- [[Note]]" or "- [Note](Note.md)", in a callout or not.
        const item = line.match(
          /^(?:>\s?)?([ \t]*)[-*+]\s+(?:\[.\]\s+)?(?:\[\[([^\]|#]+)|\[[^\]]*\]\(([^)#]+)\))/
        )
        if (!item) continue
        const target = item[2] || decodeURI(item[3])
        const file = metadataCache.getFirstLinkpathDest(target, note.path)
        if (!file || file.extension !== "md" || seen.has(file)) continue
        seen.add(file)
        const indent = item[1].replace(/\t/g, "    ").length
        items.push({ file, group: section ? `${name} · ${section}` : name, depth: indent >= 2 ? 1 : 0 })
      }
    }
    this.items = items
    this.itemsFor = key
    return items
  }

  /**
   * Marks the previewed feature wherever it's linked in Obsidian's other
   * windows (ROADMAP.md, outlines, the file list), and keeps it in view.
   */
  markCurrent(file) {
    const docs = new Set()
    this.app.workspace.iterateAllLeaves((leaf) => {
      const doc = leaf.view.containerEl.ownerDocument
      if (!doc.body.classList.contains("muta-window")) docs.add(doc)
    })
    docs.add(document)
    let css = ""
    if (file && this.settings.markPreviewed) {
      const hrefs = [file.path, file.path.replace(/\.md$/, ""), file.basename]
        .map((h) => `a.internal-link[data-href=${JSON.stringify(h)}]`)
        .join(", ")
      // Its own colour, unlike any other link's, with a soft highlight behind
      // it: colour and background only, so nothing moves.
      const mark = `color: var(--color-yellow) !important;
        background: color-mix(in srgb, var(--color-yellow) 16%, transparent);
        border-radius: 3px; box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-yellow) 16%, transparent);
        text-decoration-color: currentColor !important;`
      css = `
        :is(${hrefs}) { ${mark} }
        .nav-file-title[data-path=${JSON.stringify(file.path)}] .nav-file-title-content { ${mark} }`
    }
    for (const doc of docs) {
      let style = doc.getElementById("muta-current")
      if (!css) {
        if (style) style.remove()
        continue
      }
      if (!style) {
        style = doc.createElement("style")
        style.id = "muta-current"
        doc.head.appendChild(style)
      }
      style.textContent = css
      const link = doc.querySelector(
        `.markdown-preview-view a.internal-link[data-href=${JSON.stringify(file.path)}]`
      )
      if (link) link.scrollIntoView({ block: "nearest", behavior: "smooth" })
    }
  }

  // ── The switcher: a pill at the bottom that opens into the roadmap ────

  buildSwitcher(doc) {
    const el = doc.body.createDiv({ cls: "muta-switcher" })
    const bar = el.createDiv({ cls: "muta-switcher-bar" })
    const prev = bar.createEl("button", { cls: "muta-switcher-step", attr: { "aria-label": "Previous feature", "data-tooltip-position": "top" } })
    setIcon(prev, "chevron-left")
    const title = bar.createEl("button", {
      cls: "muta-switcher-title",
      attr: { "aria-haspopup": "listbox" },
    })
    // The text slides as you step through the roadmap; the button stays put.
    const label = title.createSpan({ cls: "muta-switcher-label" })
    const name = label.createSpan({ cls: "muta-switcher-name" })
    const next = bar.createEl("button", { cls: "muta-switcher-step", attr: { "aria-label": "Next feature", "data-tooltip-position": "top" } })
    setIcon(next, "chevron-right")
    // An agent waiting on you takes the name's place (showAsk()); click it to answer.
    const ask = bar.createEl("button", { cls: "muta-switcher-ask" })
    ask.createSpan({ cls: "muta-ask-dot" })
    const askText = ask.createSpan({ cls: "muta-switcher-ask-text" })
    bar.insertBefore(ask, next)
    ask.addEventListener("click", () => this.openAsk())
    prev.addEventListener("click", () => this.step(-1))
    next.addEventListener("click", () => this.step(1))
    this.attachNameSwipe(el, label)


    // The name opens the list; picking a feature or clicking elsewhere closes it.
    const body = doc.body
    title.addEventListener("click", () => {
      if (body.classList.contains("is-switcher-open")) this.closeMenu()
      else this.openMenu()
    })
    doc.addEventListener(
      "pointerdown",
      (event) => {
        if (!title.contains(event.target)) this.closeMenu()
      },
      true
    )
    // The menu is its own window (pip-main.js): a pick goes there, and closing
    // keeps the bottom bar open until the menu is back in its button.
    const win = doc.defaultView
    win.mutaMenuPick = (index) => this.go(index)
    win.mutaMenuClosed = (ms) => {
      body.classList.remove("is-switcher-open")
      body.classList.add("is-menu-closing")
      win.clearTimeout(this.menuClosing)
      this.menuClosing = win.setTimeout(() => body.classList.remove("is-menu-closing"), ms)
    }
    return { el, title, label, name, ask, askText }
  }

  /**
   * The bottom bar's menu: the name's button grows into it, a small window of
   * its own over the preview (pip-main.js's openMenu()), centred on the
   * button so it straddles the window's bottom edge, over macOS's menu
   * material. It closes when the cursor leaves it, on a click elsewhere, or
   * on a pick.
   */
  async openMenu() {
    const sw = this.ui && this.ui.switcher
    if (!sw || !this.pip) return
    const doc = sw.el.ownerDocument
    const body = doc.body
    const win = doc.defaultView
    win.clearTimeout(this.menuClosing)
    body.classList.remove("is-menu-closing")
    body.classList.add("is-switcher-open")
    const ask = (this.menuAsk = (this.menuAsk || 0) + 1)
    const items = await this.roadmap()
    // Closed again while the list was being read.
    if (ask !== this.menuAsk || !this.pip) {
      if (ask !== this.menuAsk && !this.menuShown) body.classList.remove("is-switcher-open")
      return
    }
    this.menuShown = true
    const current = this.leaf && this.leaf.view.file
    const b = sw.title.getBoundingClientRect()
    this.pip.openMenu({
      button: { x: b.left, y: b.top, width: b.width, height: b.height },
      items: items.map((item) => ({ group: item.group, name: item.file.basename, depth: item.depth || 0, current: item.file === current })),
      name: sw.name.getText(),
      font: win.getComputedStyle(sw.title).fontFamily,
      dark: !body.classList.contains("theme-light") || body.classList.contains("is-docked"),
      darkness: this.settings.darkness,
      reduceMotion: reduceMotion(),
    })
  }

  /** Shrinks the menu back into its button (at once with now). */
  closeMenu(now = false) {
    const body = this.ui && this.ui.switcher.el.ownerDocument.body
    if (!body || !body.classList.contains("is-switcher-open")) return
    this.menuAsk = (this.menuAsk || 0) + 1
    const shown = this.menuShown
    this.menuShown = false
    // Not asked of pip-main.js yet (the list still being read): it just doesn't open.
    if (!shown || !this.pip) body.classList.remove("is-switcher-open")
    else this.pip.closeMenu(now)
  }

  async updateSwitcher(file) {
    if (!this.ui) return
    const items = await this.roadmap()
    const index = items.findIndex((i) => i.file === file)
    const item = items[index]
    this.ui.switcher.name.setText(file.basename)
    this.ui.switcher.el.toggleClass("is-orphan", !item)
  }

  /** The previous (-1) or next (1) feature in roadmap order; its name and page slide in from that side. */
  async step(delta) {
    const items = await this.roadmap()
    const current = this.leaf && this.leaf.view.file
    const index = items.findIndex((i) => i.file === current)
    if (index < 0) return items.length && this.go(0)
    const target = (index + delta + items.length) % items.length
    this.slideName(delta, () => this.setName(items[target].file))
    this.go(target, delta, "x")
  }

  async go(index, direction, axis = "y") {
    const items = await this.roadmap()
    const current = this.leaf && this.leaf.view.file
    const from = items.findIndex((i) => i.file === current)
    this.schedule(items[index].file, direction || (index >= from ? 1 : -1), axis)
  }

  setName(file) {
    if (!this.ui) return
    this.ui.switcher.name.setText(file.basename)
  }

  /**
   * The switcher's text changes in place: the old name blurs and fades out,
   * the new one fades in sharp, straight away (the page follows as soon as
   * it has loaded).
   */
  slideName(direction, change) {
    const label = this.ui && this.ui.switcher.label
    if (!label || reduceMotion()) return change()
    const opacity = label.style.opacity || "1"
    const filter = label.style.filter || "blur(0px)"
    label.getAnimations().forEach((a) => a.cancel())
    label.style.opacity = ""
    label.style.filter = ""
    const out = label.animate(
      [
        { opacity, filter },
        { opacity: 0, filter: `blur(${NAME_BLUR}px)` },
      ],
      { duration: 90, easing: "ease-in", fill: "forwards" }
    )
    out.finished.then(() => {
      change()
      label.animate(
        [
          { opacity: 0, filter: `blur(${NAME_BLUR}px)` },
          { opacity: 1, filter: "blur(0px)" },
        ],
        { duration: 220, easing: SWITCH.ease }
      )
      out.cancel()
    }, () => {})
  }

  /**
   * Swiping two fingers sideways on the bottom bar steps through the
   * roadmap: the name fades as your fingers move, and once they've gone far enough
   * it moves on to the previous or next feature (one per swipe). Let go
   * short of that and it springs back.
   */
  attachNameSwipe(bar, title) {
    const win = bar.ownerDocument.defaultView
    let swipe = null
    // Touch-down and lift, from the trackpad itself (pip-main.js): a new
    // swipe starts fresh even while the last one's momentum is still
    // coming in, and lifting short of a step springs back at once.
    this.onGesture((phase) => {
      if (phase === "began") {
        if (swipe) win.clearTimeout(swipe.timer)
        if (swipe && !swipe.done) settle()
        swipe = null
      } else if (phase === "ended" && swipe && !swipe.done) {
        settle()
        swipe.done = true // ignore the momentum that follows
      }
    })
    const settle = () => {
      if (reduceMotion()) {
        title.style.opacity = ""
        title.style.filter = ""
        return
      }
      const opacity = title.style.opacity || "1"
      const filter = title.style.filter || "blur(0px)"
      title.style.opacity = ""
      title.style.filter = ""
      title.animate([{ opacity, filter }, { opacity: 1, filter: "blur(0px)" }], {
        duration: 220,
        easing: SWITCH.ease,
      })
    }
    bar.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey) return
        event.preventDefault()
        if (!swipe && Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return
        if (!swipe) swipe = { dx: 0, done: false, timer: 0 }
        win.clearTimeout(swipe.timer)
        swipe.timer = win.setTimeout(() => {
          if (!swipe.done) settle()
          swipe = null
        }, NAME_SWIPE_END_MS)
        if (swipe.done) return // the rest of this swipe, and its momentum
        swipe.dx += event.deltaX
        const progress = Math.min(Math.abs(swipe.dx) / NAME_SWIPE_STEP, 1)
        title.getAnimations().forEach((a) => a.cancel())
        // Fingers to the left (content scrolls right) go forward, as in a browser.
        // The name stays put and fades as the swipe builds.
        title.style.opacity = `${1 - progress * 0.6}`
        title.style.filter = `blur(${progress * NAME_BLUR * 0.5}px)`
        if (progress >= 1) {
          swipe.done = true
          this.step(Math.sign(swipe.dx))
        }
      },
      { passive: false }
    )
  }

  // ── The rail: where you are on the page, and its sections ─────────────

  buildRail(doc) {
    const el = doc.body.createDiv({ cls: "muta-rail" })
    const track = el.createDiv({ cls: "muta-rail-track" })
    const thumb = track.createDiv({ cls: "muta-rail-thumb" })
    const ticks = track.createDiv({ cls: "muta-rail-ticks" })
    // Section names pop out beside the rail, over the page, while it's hovered.
    const labels = doc.body.createDiv({ cls: "muta-rail-labels" })
    this.hoverOpen([el, labels], "is-rail-open", () => this.updateRail())
    // Scrolling over the rail (or a section name) scrolls the page.
    for (const target of [el, labels])
      target.addEventListener(
        "wheel",
        (event) => {
          const page = this.page()
          if (!page || event.ctrlKey) return
          event.preventDefault()
          page.scrollTop += event.deltaY
        },
        { passive: false }
      )
    // Only the section nearest the cursor names itself.
    const nearest = (y) => {
      const r = track.getBoundingClientRect()
      let best = null
      let bestDistance = SECTION_REACH
      for (const s of this.ui.rail.sections) {
        const d = Math.abs(r.top + (parseFloat(s.tick.style.top) / 100) * r.height - y)
        if (d < bestDistance) {
          best = s
          bestDistance = d
        }
      }
      return best
    }
    const showLabel = (section) => {
      for (const s of this.ui.rail.sections) s.label.toggleClass("is-shown", s === section)
    }
    el.addEventListener("mousemove", (event) => showLabel(nearest(event.clientY)))
    el.addEventListener("mouseleave", (event) => {
      if (!labels.contains(event.relatedTarget)) showLabel(null)
    })
    labels.addEventListener("mouseleave", () => showLabel(null))
    // Dragging along the track scrolls the page there.
    el.addEventListener("pointerdown", (event) => {
      const page = this.page()
      if (!page) return
      event.preventDefault()
      // A press on a section's mark jumps to it; anywhere else scrubs.
      const section = nearest(event.clientY)
      if (section && section.label.classList.contains("is-shown")) {
        const r = track.getBoundingClientRect()
        const y = r.top + (parseFloat(section.tick.style.top) / 100) * r.height
        if (Math.abs(y - event.clientY) <= SECTION_HIT) return section.label.click()
      }
      el.setPointerCapture(event.pointerId)
      el.classList.add("is-scrubbing")
      const scrub = (e) => {
        const r = track.getBoundingClientRect()
        const f = Math.min(Math.max((e.clientY - r.top) / r.height, 0), 1)
        page.scrollTop = f * page.scrollHeight - page.clientHeight / 2
      }
      scrub(event)
      const up = () => {
        el.classList.remove("is-scrubbing")
        el.removeEventListener("pointermove", scrub)
        el.removeEventListener("pointerup", up)
        el.removeEventListener("pointercancel", up)
      }
      el.addEventListener("pointermove", scrub)
      el.addEventListener("pointerup", up)
      el.addEventListener("pointercancel", up)
    })
    let frame = 0
    let scrollTimer = 0
    doc.addEventListener(
      "scroll",
      (event) => {
        if (event.target !== this.page()) return
        // The rail opens while the page scrolls, and closes a moment after.
        doc.body.classList.add("is-scrolling")
        doc.defaultView.clearTimeout(scrollTimer)
        scrollTimer = doc.defaultView.setTimeout(
          () => doc.body.classList.remove("is-scrolling"),
          RAIL_LINGER_MS
        )
        if (frame) return
        frame = doc.defaultView.requestAnimationFrame(() => {
          frame = 0
          this.updateRail(true)
        })
      },
      { capture: true, passive: true }
    )
    doc.defaultView.addEventListener("resize", () => this.updateRail())
    return { el, track, thumb, ticks, labels, sections: [] }
  }

  page() {
    return (
      this.leaf &&
      this.leaf.view.containerEl.querySelector(
        ".view-content .markdown-preview-view:not(.muta-old)"
      )
    )
  }

  /** Places the rail's marks and labels (or, scrolling, only the thumb and current section). */
  updateRail(scrollOnly = false) {
    const rail = this.ui && this.ui.rail
    const page = this.page()
    if (!rail || !page) return
    const height = rail.track.clientHeight
    const total = page.scrollHeight
    const scrolls = total > page.clientHeight + 4
    rail.el.toggleClass("is-hidden", !scrolls)
    // A page that doesn't scroll has no rail to open.
    rail.el.ownerDocument.body.classList.toggle("has-scroll", scrolls)
    if (!scrolls) {
      rail.labels.empty()
      rail.sections = []
    }
    if (!scrolls || !height) return

    if (!scrollOnly) {
      const origin = page.getBoundingClientRect().top - page.scrollTop
      const found = [...page.querySelectorAll(SECTIONS)].filter(
        (s) => !s.parentElement.closest(".callout, .metadata-container")
      )
      rail.sections = found.map((s) => {
        const top = s.getBoundingClientRect().top - origin
        const name = s.classList.contains("metadata-container")
          ? "Properties"
          : s.classList.contains("callout")
            ? (s.querySelector(".callout-title-inner") || s).textContent.trim()
            : s.textContent.trim()
        return { el: s, top, name }
      })
      rail.ticks.empty()
      rail.labels.empty()
      rail.sections.forEach((section) => {
        section.tick = rail.ticks.createDiv({ cls: "muta-rail-tick" })
        // Marks and thumb in %, so they stay put as the rail's height follows the top bar.
        section.tick.style.top = `${(section.top / total) * 100}%`
        section.label = rail.labels.createDiv({ cls: "muta-rail-label", text: section.name })
        section.label.style.top = `${(section.top / total) * 100}%`
        section.label.addEventListener("click", () =>
          page.scrollTo({
            top: Math.max(section.top - 8, 0),
            behavior: reduceMotion() ? "auto" : "smooth",
          })
        )
      })
    }

    rail.thumb.style.top = `${(page.scrollTop / total) * 100}%`
    rail.thumb.style.height = `${(page.clientHeight / total) * 100}%`
    // The current section: the last one starting above the top quarter of the view.
    const line = page.scrollTop + page.clientHeight / 4
    const atEnd = page.scrollTop + page.clientHeight >= total - 2
    let current = -1
    rail.sections.forEach((s, i) => {
      if (s.top <= line) current = i
    })
    if (atEnd) current = rail.sections.length - 1
    rail.sections.forEach((s, i) => {
      s.tick.toggleClass("is-current", i === current)
      s.label.toggleClass("is-current", i === current)
    })
  }

  /**
   * Which way the pages move: hovering a link lower on screen than the last
   * one (1) brings the new page up from below, a higher one (-1) down from
   * above, like scrolling through them.
   */
  direction(targetEl) {
    const y =
      targetEl && targetEl.getBoundingClientRect
        ? targetEl.getBoundingClientRect().top
        : null
    if (y === null) return 1
    const last = this.lastHoverY
    this.lastHoverY = y
    return last === undefined || y >= last ? 1 : -1
  }

  /**
   * A still copy of the page on screen, laid over it, so the old page can
   * fade out while the new one comes in under it.
   */
  snapshot() {
    const content = this.leaf && this.leaf.view.containerEl.querySelector(".view-content")
    const page = content && content.querySelector(".markdown-preview-view:not(.muta-old)")
    if (!page || reduceMotion()) return null
    content.querySelectorAll(".muta-old").forEach((el) => el.remove())
    const copy = page.cloneNode(true)
    copy.classList.add("muta-old")
    copy.setAttribute("aria-hidden", "true")
    // Hidden until the new page is in: on top of the old page it's a copy of,
    // its see-through backgrounds (callouts, properties) would double up and
    // flash brighter while the new page loads.
    copy.style.visibility = "hidden"
    content.appendChild(copy)
    copy.scrollTop = page.scrollTop
    return copy
  }

  /**
   * Switching pages. Hovering: the old one drifts away and fades out with a
   * slight blur while the new one slides into place and sharpens, upward for
   * a link below the last one and downward for one above. Stepping through
   * the roadmap (arrows, swipes): the pages slide side by side, solid all the
   * way, like turning a page, so neither ever shows through the other (a
   * crossfade there doubled the text and dimmed it, which read as a blink).
   * Transform, opacity and filter only, on the compositor; started before the
   * new page is first drawn, so it never shows in place for a frame first.
   */
  crossfade(old, direction = 1, axis = "y") {
    const page = this.leaf && this.leaf.view.containerEl.querySelector(
      ".view-content .markdown-preview-view:not(.muta-old)"
    )
    if (!page || reduceMotion()) {
      if (old) old.remove()
      return
    }
    page.getAnimations().forEach((a) => a.cancel())
    if (old) old.style.visibility = ""
    const done = () => old && old.remove()
    if (axis === "x") {
      const t = SWITCH.sideways
      const width = page.getBoundingClientRect().width + t.gap
      const options = { duration: t.duration, easing: t.ease }
      page.animate([{ transform: `translateX(${direction * width}px)` }, { transform: "none" }], {
        ...options,
        fill: "backwards",
      })
      if (old)
        old
          .animate([{ transform: "none" }, { transform: `translateX(${-direction * width}px)` }], { ...options, fill: "forwards" })
          .finished.then(done, done)
      return
    }
    const shift = SWITCH.shift * direction
    page.animate(
      [
        { opacity: 0, transform: `translateY(${shift}px)`, filter: `blur(${SWITCH.blur}px)` },
        { opacity: 1, transform: "none", filter: "blur(0px)" },
      ],
      { duration: SWITCH.in, easing: SWITCH.ease, fill: "backwards" }
    )
    if (old)
      old
        .animate(
          [
            { opacity: 1, transform: "none", filter: "blur(0px)" },
            { opacity: 0, transform: `translateY(${-shift}px)`, filter: `blur(${SWITCH.blur}px)` },
          ],
          { duration: SWITCH.out, easing: SWITCH.ease, fill: "forwards" }
        )
        .finished.then(done, done)
  }

  async openWindow() {
    const { BrowserWindow, getCurrentWindow } = remote()
    const main = getCurrentWindow()
    const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
    this.leaf = this.app.workspace.openPopoutLeaf({ size: SIZE })
    let win = null
    for (let i = 0; i < 20 && !win; i++) {
      win = BrowserWindow.getAllWindows().find((w) => !before.has(w.id))
      if (!win) await sleep(25)
    }
    if (!win) return
    const dir = this.pluginDir()
    await this.ensureNatives()
    const pipMain = remote().require(`${dir}/pip-load.js`).load(`${dir}/pip-main.js`)

    const start = pipMain.placement({
      bounds: this.settings.bounds,
      tucked: this.settings.tucked,
      size: SIZE,
    })
    win.setAlwaysOnTop(true, "floating")
    win.setVisibleOnAllWorkspaces(this.settings.allSpaces, {
      visibleOnFullScreen: this.settings.allSpaces,
      skipTransformProcessType: true,
    })
    win.setBackgroundColor("#00000000")
    // No close, minimise and zoom buttons: it's closed from its own bar.
    win.setWindowButtonVisibility(false)
    // Clicking it never makes it the focused window: glass looks different
    // on the focused window, and the preview would flip between the two.
    win.setFocusable(false)
    win.setBounds(start)
    this.pip = pipMain.create({
      windowId: win.id,
      dir,
      glass: this.glassOptions(),
      swipes: this.settings.swipeToMove,
      state: {
        bounds: this.settings.bounds,
        tucked: this.settings.tucked,
        notched: this.settings.notched,
      },
      // Where it was put: keep it, and show the handle if it's tucked.
      onSettle: (state) => {
        this.settings.bounds = state.bounds
        this.settings.tucked = state.tucked
        this.settings.notched = state.notched
        this.showTucked()
        this.saveData(this.settings)
      },
    })
    win.once("closed", () => {
      pipMain.dispose()
      if (this.win === win) this.pip = null
    })
    this.win = win
    // Keep working where you were: the new windows don't take focus.
    main.focus()
  }

  pluginDir() {
    return `${this.app.vault.adapter.getBasePath()}/${this.manifest.dir}`
  }

  /** The glass's options: its look follows Obsidian's light or dark theme. */
  glassOptions() {
    if (!this.settings.glass) return null
    const dark = !document.body.classList.contains("theme-light")
    return { ...GLASS, dark, clear: this.settings.glassStyle === "clear" }
  }

  /** Puts changed settings into effect on an open window. */
  applySettings() {
    const doc = this.leaf && this.leaf.view.containerEl.ownerDocument
    if (doc && doc !== document) {
      doc.body.style.setProperty("--muta-darkness", String(this.settings.darkness))
      // Docked at the notch it stays dark (pip-main.js), whatever the theme
      // says; it notes whether Obsidian is light, to go back to when it leaves.
      const body = doc.body
      if (body.classList.contains("is-docked")) {
        if (document.body.classList.contains("theme-light")) {
          body.classList.replace("theme-light", "theme-dark")
          body.dataset.mutaLight = "true"
        } else delete body.dataset.mutaLight
      }
    }
    if (this.isOpen()) {
      this.win.setVisibleOnAllWorkspaces(this.settings.allSpaces, {
        visibleOnFullScreen: this.settings.allSpaces,
        skipTransformProcessType: true,
      })
      if (this.pip) {
        this.pip.setGlass(this.glassOptions())
        this.pip.setSwipes(this.settings.swipeToMove)
      }
    }
    if (this.settings.agentIndicator) this.agents.start()
    else this.agents.stop()
    this.markCurrent(this.isOpen() ? this.leaf.view.file : null)
  }

  /**
   * A release installed by BRAT comes without its native parts (the
   * trackpad helper and the glass module) and its main-process code:
   * they're downloaded once per version from the same GitHub release and
   * checked against the SHA-256s this file was built with.
   */
  async ensureNatives() {
    const pending = Object.entries(RELEASE_FILES).filter(([, sha]) => !sha.startsWith("__"))
    if (!pending.length) return // built from source
    const fs = require("fs")
    const crypto = require("crypto")
    const dir = this.pluginDir()
    const marker = `${dir}/natives-version`
    const version = this.manifest.version
    const ready = () => {
      try {
        return fs.readFileSync(marker, "utf8").trim() === version
      } catch {
        return false
      }
    }
    if (ready()) return
    if (this.downloading) return this.downloading
    this.downloading = (async () => {
      try {
        for (const [name, sha] of pending) {
          const res = await requestUrl({
            url: `https://github.com/${REPO}/releases/download/${version}/${name}`,
          })
          const data = Buffer.from(res.arrayBuffer)
          const got = crypto.createHash("sha256").update(data).digest("hex")
          if (got !== sha) throw new Error(`${name} didn't match its checksum`)
          fs.writeFileSync(`${dir}/${name}`, data)
          fs.chmodSync(`${dir}/${name}`, 0o755)
        }
        fs.writeFileSync(marker, version)
      } catch (error) {
        console.error("Muta: couldn't get its native parts", error)
        new Notice("Muta couldn't download the rest of itself from GitHub. Check your connection and hover a link again.")
      } finally {
        this.downloading = null
      }
    })()
    return this.downloading
  }

  /**
   * Muta was Floating Preview (plugin ID floating-preview). Its settings and
   * window position come over the first time, and it's turned off: both
   * would take over hover previews and open two windows.
   */
  async fromFloatingPreview() {
    const old = "floating-preview"
    let saved = null
    try {
      saved = JSON.parse(await this.app.vault.adapter.read(`${this.app.vault.configDir}/plugins/${old}/data.json`))
      await this.saveData(saved)
    } catch {}
    const plugins = this.app.plugins
    if (plugins && plugins.enabledPlugins && plugins.enabledPlugins.has(old)) {
      await plugins.disablePluginAndSave(old)
      new Notice("Floating Preview is now Muta, so it's been turned off. You can uninstall it in Community plugins.")
    }
    return saved
  }

  /**
   * Menus opened from the preview window ("More options", a right-click)
   * open at what was clicked. Otherwise Obsidian pops its native macOS
   * menus up over its main window, nowhere near the button.
   * The preview never takes focus, so Obsidian doesn't know a click came
   * from it (it passes the main window's document): when a menu doesn't
   * say where it's from, the last press, if it was in the preview just
   * before, tells.
   */
  patchMenus() {
    const proto = Menu.prototype
    if (!proto.setUseNativeMenu) return
    const plugin = this
    const previewDoc = () => {
      const doc = plugin.leaf && plugin.leaf.view.containerEl.ownerDocument
      return doc && doc !== document ? doc : null
    }
    const fromPreview = (event, doc) => {
      const pip = previewDoc()
      if (!pip) return null
      const from = event && event.target && event.target.ownerDocument
      if (from) return from === pip ? pip : null
      if (doc === pip) return pip
      const press = plugin.lastPress
      return press && press.doc === pip && performance.now() - press.at < MENU_PRESS_MS ? pip : null
    }
    // Presses in the main window count too, so a menu opened there right
    // after a press in the preview stays there.
    this.registerDomEvent(document, "pointerdown", () => (this.lastPress = { doc: document, at: performance.now() }), true)
    // Native menus (Obsidian's default on macOS) pop up over the preview window
    // at the button (pip-main.js); otherwise the menu is drawn inside the preview.
    const native = (menu) =>
      menu.useNativeMenu !== undefined ? !!menu.useNativeMenu : plugin.app.vault.getConfig("nativeMenus") !== false
    const showAtPosition = proto.showAtPosition
    const show = (menu, position, pip) => {
      if (native(menu) && plugin.pip) plugin.pip.menuFromPreview()
      else menu.setUseNativeMenu(false)
      return showAtPosition.call(menu, position, pip)
    }
    const atPosition = function (position, doc) {
      const pip = fromPreview(null, doc)
      return pip ? show(this, position, pip) : showAtPosition.apply(this, arguments)
    }
    const showAtMouseEvent = proto.showAtMouseEvent
    const atMouseEvent = function (event) {
      const pip = fromPreview(event)
      return pip ? show(this, { x: event.clientX, y: event.clientY }, pip) : showAtMouseEvent.apply(this, arguments)
    }
    proto.showAtPosition = atPosition
    proto.showAtMouseEvent = atMouseEvent
    // Put back only if nothing else has wrapped them since.
    this.register(() => {
      if (proto.showAtPosition === atPosition) proto.showAtPosition = showAtPosition
      if (proto.showAtMouseEvent === atMouseEvent) proto.showAtMouseEvent = showAtMouseEvent
    })
  }

  /**
   * A close button in the top bar's right corner (the next hovered link opens
   * the window again), and the page's menu moved to its left corner.
   */
  /** Send to agent: the note on show as the start of a new agent session (sendMenu()). */
  addSendButton() {
    const view = this.leaf && this.leaf.view
    if (!view || !view.addAction || view.mutaSend) return
    view.mutaSend = view.addAction("send", "Send to agent", (event) => this.sendMenu(event, view.mutaSend))
    view.mutaSend.addClass("muta-send")
  }

  /** The agents to send the note to: those turned on in Settings › AI. */
  sendMenu(event, button) {
    const s = this.settings
    const on = { claude: s.agentClaude, codex: s.agentCodex, opencode: s.agentOpencode, cursor: s.agentCursor, antigravity: s.agentAntigravity }
    const menu = new Menu()
    for (const kind of Object.keys(AGENT_LAUNCH))
      if (on[kind])
        menu.addItem((item) => item.setTitle(`Send to ${AGENT_NAMES[kind]}`).setIcon("bot").onClick(() => this.sendToAgent(kind)))
    const r = button.getBoundingClientRect()
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 }, button.ownerDocument)
  }

  /**
   * Starts agent kind on the note on show, in a new Terminal window, in the
   * note's project (the git repository its file is in, through any symlinks,
   * else the vault): the note, with where it is, as the first prompt. The
   * session is the agent's own, to carry on in the terminal.
   */
  async sendToAgent(kind) {
    const file = this.leaf && this.leaf.view.file
    if (!file) return
    const fs = require("fs")
    const path = require("path")
    const base = this.app.vault.adapter.getBasePath()
    let real = path.join(base, file.path)
    try {
      real = fs.realpathSync(real)
    } catch {}
    const dir = gitRoot(path.dirname(real)) || base
    const content = await this.app.vault.read(file)
    const prompt = agentPrompt(file.basename, real, content)
    const prompts = path.join(require("os").homedir(), MUTA_DIR, "prompts")
    fs.mkdirSync(prompts, { recursive: true })
    const promptFile = path.join(prompts, `${Date.now()}-${kind}.md`)
    fs.writeFileSync(promptFile, prompt)
    const command = `cd ${shellQuote(dir)} && ${AGENT_LAUNCH[kind]} "$(cat ${shellQuote(promptFile)})"`
    const script = `tell application "Terminal"\nactivate\ndo script ${appleQuote(command)}\nend tell`
    require("child_process").execFile("/usr/bin/osascript", ["-e", script], (error) => {
      if (error) new Notice(`Muta: couldn't open Terminal (${error.message})`)
    })
    new Notice(`Muta: sent "${file.basename}" to ${AGENT_NAMES[kind]}`)
  }

  addCloseButton() {
    const view = this.leaf && this.leaf.view
    if (!view || !view.addAction || view.mutaClose) return
    const more = view.moreOptionsButtonEl
    view.mutaClose = view.addAction("x", "Close preview", () => this.closeWindow())
    view.mutaClose.addClass("muta-close")
    if (view.actionsEl) view.actionsEl.appendChild(view.mutaClose)
    const left = view.headerEl && view.headerEl.querySelector(".view-header-left")
    if (more && left) {
      more.addClass("muta-more")
      left.prepend(more)
    }
  }

  /** Wires up the window, once per window. */
  attach() {
    const doc = this.leaf && this.leaf.view.containerEl.ownerDocument
    if (!doc || doc === document || doc.body.classList.contains("muta-window"))
      return
    doc.body.classList.add("muta-window")
    doc.body.style.setProperty("--muta-darkness", String(this.settings.darkness))
    doc.documentElement.classList.add("muta-root")
    this.showTucked()
    // Touch-down and lift on the trackpad, from pip-main.js, for whatever needs them.
    const gestures = new Set()
    this.onGesture = (handler) => gestures.add(handler)
    doc.defaultView.mutaGesture = (phase) => gestures.forEach((handler) => handler(phase))
    this.attachEdges(doc)
    this.attachOverscroll(doc)
    this.attachDrag(doc)
    this.attachSwipe(doc)
    this.attachScrollFades(doc)
    // Which press opened a menu (patchMenus).
    doc.addEventListener("pointerdown", () => (this.lastPress = { doc, at: performance.now() }), true)
    this.attachPropertiesMorph(doc)
    this.ui = { switcher: this.buildSwitcher(doc), rail: this.buildRail(doc) }
  }

  /**
   * Scrolling past the top or bottom of a page pulls it a little further,
   * harder the further you go, and it springs back when you let go; a flick
   * that runs into the end carries a little past it and springs back, as
   * macOS pages do.
   *
   * The page doesn't jump with each scroll event (they come less often than
   * frames, and unevenly): every frame it glides toward where the pull
   * says, so it moves smoothly.
   */
  attachOverscroll(doc) {
    const win = doc.defaultView
    let raw = 0 // how far you've scrolled past the end (+ above the top, - below the bottom)
    let shown = 0 // where the page is drawn, gliding toward the pull
    let lifted = false // fingers up: what's still coming is a flick's momentum
    let phases = false // the trackpad helper reports touch-down and lift
    let settled = false // let go of a pull: the momentum that follows mustn't pull again
    let held = false // this gesture was cancelled for a pull, so it can't scroll the page natively
    let lastWheel = 0
    let speed = 0 // how fast the page is scrolling (px/ms, smoothed), for a flick's bounce
    let bouncing = null // a flick's bounce off the end, and when it started
    let bouncedAt = 0
    let timer = 0
    let frame = 0
    let last = 0
    let el = null
    const sizer = () => {
      const page = this.page()
      return page && page.querySelector(".markdown-preview-sizer")
    }
    const target = () => Math.sign(raw) * rubberBand(Math.abs(raw), OVERSCROLL_MAX)
    // The page fades a little the further it's pulled, as if pulled away from you.
    // Eased (fast at first, then gentler), so it reads as a gradual fade.
    const fade = (px) => {
      const t = Math.min(Math.abs(px) / OVERSCROLL_MAX, 1)
      return `${1 - OVERSCROLL_FADE * (1 - (1 - t) * (1 - t))}`
    }
    const draw = () => {
      if (!el) return
      const out = Math.abs(shown) > 0.05
      el.style.transform = out ? `translateY(${shown}px)` : ""
      el.style.opacity = out ? fade(shown) : ""
    }
    const glide = (now) => {
      frame = 0
      const dt = Math.min(now - (last || now - 8), 50)
      last = now
      const goal = target()
      shown += (goal - shown) * (1 - Math.exp(-dt / OVERSCROLL_FOLLOW_MS))
      draw()
      if (raw || Math.abs(shown - goal) > 0.1) frame = win.requestAnimationFrame(glide)
      else last = 0
    }
    const pull = () => {
      if (!frame) frame = win.requestAnimationFrame(glide)
    }
    // Springs the page back from the pull; turning back mid-gesture (quick) it just lets go.
    const release = (quick = false) => {
      win.clearTimeout(timer)
      if (!raw && !shown) return
      raw = 0
      if (frame) win.cancelAnimationFrame(frame)
      frame = 0
      last = 0
      const from = shown
      shown = 0
      draw()
      if (!el || !from || reduceMotion() || (quick && Math.abs(from) < 2)) return
      el.animate([{ transform: `translateY(${from}px)`, opacity: fade(from) }, { transform: "none", opacity: 1 }], {
        duration: 520,
        easing: "cubic-bezier(0.32, 0.72, 0, 1)",
      })
    }
    // A flick's bounce off the end (bouncePath()), drawn as keyframes, fading as it goes out.
    const overshoot = (v) => {
      const { points, duration } = bouncePath(v)
      const frames = points.map(({ x, offset }) => ({ transform: `translateY(${x.toFixed(2)}px)`, opacity: fade(x), offset }))
      frames[frames.length - 1] = { transform: "none", opacity: 1, offset: 1 }
      bouncing = el.animate(frames, { duration, easing: "linear" })
      bouncedAt = performance.now()
    }
    this.onGesture((phase) => {
      phases = true
      lifted = phase === "ended" || phase === "momentum"
      if (phase === "momentum") return
      if (phase === "began") {
        settled = false
        win.clearTimeout(timer)
        // A new swipe's touch-down arriving just after its first scrolls set
        // off a bounce (it comes the long way, through the main process): not
        // momentum after all, so the bounce becomes a pull from where it's got to.
        if (bouncing && performance.now() - bouncedAt < TOUCH_WAIT_MS && el) {
          const x = new DOMMatrix(win.getComputedStyle(el).transform).m42
          bouncing.cancel()
          shown = raw = x
          draw()
        }
        bouncing = null
      }
      if (lifted) {
        // macOS keeps sending the swipe's momentum after the fingers lift;
        // pulling again with it is what made the page stutter on release.
        settled = !!(raw || shown)
        release()
      }
    })
    doc.addEventListener(
      "wheel",
      (event) => {
        const page = this.page()
        if (!page || event.ctrlKey || !page.contains(event.target) || !this.settings.overscroll) return
        const atTop = page.scrollTop <= 0
        const atBottom = page.scrollTop + page.clientHeight >= page.scrollHeight - 1
        const dy = event.deltaY
        // Chromium decides whether a whole gesture scrolls the page at its first event: once a
        // pull has cancelled one, the rest of that gesture can't scroll it natively, so going
        // back the other way, the page is scrolled here instead. This lasts until a gesture
        // shows it scrolls natively again (its events can't be cancelled) or the scrolling
        // stops for a moment. (The trackpad helper's touch-down can arrive after a gesture's
        // first events, so it can't be what ends this: a gesture cancelled at its start but
        // left to scroll natively would be stuck.)
        const now = performance.now()
        if (!event.cancelable || now - lastWheel > HELD_GAP_MS) held = false
        // The scroll's speed, from the time since the last one (wheel events come once a frame).
        const gap = Math.min(Math.max(now - lastWheel, 4), 40)
        speed = now - lastWheel > HELD_GAP_MS ? dy / 16 : speed * 0.4 + (dy / gap) * 0.6
        lastWheel = now
        if (!raw && !((atTop && dy < 0) || (atBottom && dy > 0))) {
          // A flick's momentum about to reach the end with this scroll: the
          // bounce starts now, as the page gets there, not a frame after it
          // has stopped (that frame standing still was the delay).
          const reaching = dy < 0 ? page.scrollTop + dy <= 0 : page.scrollTop + page.clientHeight + dy >= page.scrollHeight - 1
          if (reaching && lifted && phases && !settled && !held) {
            settled = true
            el = sizer()
            if (el && !reduceMotion()) {
              el.getAnimations().forEach((x) => x.cancel())
              overshoot(-speed)
            }
            return
          }
          if (held) {
            event.preventDefault()
            page.scrollTop += dy
          }
          return
        }
        event.preventDefault()
        held = true
        if (settled) return
        if (!raw) {
          el = sizer()
          if (el) el.getAnimations().forEach((a) => a.cancel())
        }
        if (lifted && !raw) {
          // A flick's momentum running into the end: the page carries on past
          // it at once, at the speed it had, and eases back (overshoot()); the
          // rest of the momentum is ignored. If this turns out to be a new
          // swipe whose touch-down is late, the bounce becomes a pull (above).
          settled = true
          if (el && !reduceMotion()) overshoot(-speed)
          return
        }
        const next = raw - dy
        // Scrolling back in past the end lets the page scroll normally again.
        if (raw && Math.sign(next) !== Math.sign(raw)) {
          release(true)
          page.scrollTop += -next // the rest of this scroll goes into the page
          return
        }
        raw = next
        pull()
        // Momentum (or, without the helper, any scroll) ends with a pause.
        win.clearTimeout(timer)
        if (lifted || !phases)
          timer = win.setTimeout(release, 110)
      },
      { passive: false }
    )
  }

  /**
   * Opening or closing the properties morphs the panel from its heading:
   * closed, it's a small pill around "› Properties"; it grows out of that
   * into the full panel (or shrinks back into it) while the rows fade. The
   * preview toggles them itself, since Obsidian's own toggle runs its own
   * animation that would fight this one.
   */
  attachPropertiesMorph(doc) {
    const win = doc.defaultView
    win.addEventListener(
      "click",
      (event) => {
        const heading = event.target.closest && event.target.closest(".metadata-properties-heading")
        const panel = heading && heading.closest(".metadata-container")
        if (!panel) return
        event.stopImmediatePropagation()
        event.preventDefault()
        this.toggleProperties(panel, !panel.classList.contains("is-collapsed"))
      },
      true
    )
  }

  toggleProperties(panel, close, animate = true) {
    const win = panel.ownerDocument.defaultView
    const heading = panel.querySelector(".metadata-properties-heading")
    const content = panel.querySelector(".metadata-content")
    const from = panel.getBoundingClientRect()
    panel.getAnimations().forEach((a) => a.cancel())
    if (content) content.getAnimations().forEach((a) => a.cancel())
    panel.classList.remove("is-morphing")
    for (const el of [panel, heading, heading && heading.querySelector(".collapse-indicator")])
      if (el) el.classList.toggle("is-collapsed", close)
    if (content) {
      content.style.removeProperty("--pip-props-width")
      content.style.removeProperty("min-height")
      content.style.removeProperty("overflow-y")
      content.style.display = close ? "none" : ""
    }
    const to = panel.getBoundingClientRect()
    if (!animate || reduceMotion()) return this.updateRail()
    panel.classList.add("is-morphing")
    // The rows keep the open panel's width while it grows or shrinks, so they don't rewrap.
    const open = close ? from : to
    const style = win.getComputedStyle(panel)
    if (content) {
      content.style.display = ""
      content.style.setProperty(
        "--pip-props-width",
        `${open.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)}px`
      )
      content.animate(close ? [{ opacity: 1 }, { opacity: 0 }] : [{ opacity: 0 }, { opacity: 1 }], {
        duration: PROPERTIES_MORPH_MS * 0.7,
        easing: "ease-out",
        fill: "both",
      })
    }
    const morph = panel.animate(
      [
        { width: `${from.width}px`, height: `${from.height}px` },
        { width: `${to.width}px`, height: `${to.height}px` },
      ],
      { duration: PROPERTIES_MORPH_MS, easing: SWITCH.ease }
    )
    morph.finished.then(() => {
      panel.classList.remove("is-morphing")
      if (content) {
        content.getAnimations().forEach((a) => a.cancel())
        content.style.removeProperty("--pip-props-width")
        content.style.display = panel.classList.contains("is-collapsed") ? "none" : ""
      }
      this.updateRail()
    }, () => {})
  }

  /**
   * The frame's edges grow into bars while the cursor is near them
   * (styles.css): the top into the page's buttons, the bottom into the
   * switcher, the right into the section rail. Each opens when the cursor
   * comes within the first distance of its edge and closes once it's past
   * the second.
   */
  attachEdges(doc) {
    const body = doc.body
    const win = doc.defaultView
    const edge = (cls, near, opens, openUntil) =>
      body.classList.toggle(cls, near < (body.classList.contains(cls) ? openUntil : opens))
    doc.addEventListener("mousemove", (event) => {
      // Measured from the page's own edges: docked at the notch, it sits inside
      // the window, below the part above the screen and in from the shoulders.
      const r = body.getBoundingClientRect()
      const top = event.clientY - r.top
      // Docked, the top bar only opens once the cursor has been into the
      // window, not on its way down from the notch.
      if (body.classList.contains("is-docked")) {
        if (top > DOCKED_ARM) body.classList.add("is-armed")
        if (!body.classList.contains("is-armed")) body.classList.remove("is-near-top")
        else edge("is-near-top", top, EDGES.top[0], EDGES.top[1])
      } else edge("is-near-top", top, EDGES.top[0], EDGES.top[1])
      edge("is-near-bottom", r.bottom - event.clientY, EDGES.bottom[0], EDGES.bottom[1])
      edge("is-near-right", r.right - event.clientX, EDGES.right[0], EDGES.right[1])
    })
    doc.documentElement.addEventListener("mouseleave", () => {
      body.classList.remove(
        "is-armed",
        "is-near-top",
        "is-near-bottom",
        "is-near-right",
        "is-rail-open"
      )
      // Not the menu: it's its own window, so going into it leaves this one.
    })
  }

  /**
   * Opens a part (the rail's labels) while any of its elements is hovered,
   * closing a moment after the cursor leaves them all.
   */
  hoverOpen(els, cls, onOpen) {
    const body = els[0].ownerDocument.body
    const win = els[0].ownerDocument.defaultView
    let timer = 0
    for (const el of els) {
      el.addEventListener("mouseenter", () => {
        win.clearTimeout(timer)
        if (body.classList.contains(cls)) return
        body.classList.add(cls)
        if (onOpen) onOpen()
      })
      el.addEventListener("mouseleave", () => {
        timer = win.setTimeout(() => body.classList.remove(cls), 220)
      })
    }
  }

  /**
   * Pointer drags (mouse, trackpad click-drag or three-finger drag) on the
   * top bar move the window; the window follows the cursor from Electron's
   * main process (pip-main.js), and letting go throws it.
   */
  attachDrag(doc) {
    let press = null
    doc.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || !this.pip) return
      const tucked = !!this.settings.tucked
      if (!tucked) {
        const target = event.target.closest ? event.target : null
        if (!target || !target.closest(HANDLE) || target.closest(INTERACTIVE))
          return
      }
      press = { id: event.pointerId, x: event.screenX, y: event.screenY, tucked }
    })
    doc.addEventListener("pointermove", (event) => {
      if (!press || press.dragging || event.pointerId !== press.id) return
      if (
        Math.hypot(event.screenX - press.x, event.screenY - press.y) <
        DRAG_THRESHOLD
      )
        return
      press.dragging = true
      if (event.target.setPointerCapture)
        event.target.setPointerCapture(event.pointerId)
      this.pip.dragStart()
    })
    const end = (event) => {
      if (!press || event.pointerId !== press.id) return
      const { dragging, tucked } = press
      press = null
      if (!this.pip) return
      if (dragging) this.pip.dragEnd()
      // A click on a tucked window's handle brings it back.
      else if (tucked && event.type === "pointerup") this.pip.untuck()
    }
    doc.addEventListener("pointerup", end)
    doc.addEventListener("pointercancel", end)
    doc.addEventListener(
      "click",
      (event) => {
        if (!this.settings.tucked) return
        event.preventDefault()
        event.stopPropagation()
      },
      true
    )
  }

  /**
   * Two-finger swipes on the top bar (or a tucked window's handle) move the
   * window: pip-main.js handles them from the trackpad's own events, so here
   * they only mustn't scroll anything. Swipes over the page scroll it.
   */
  attachSwipe(doc) {
    let blocking = false
    let timer = 0
    doc.addEventListener(
      "wheel",
      (event) => {
        if (event.ctrlKey) return
        // A gesture keeps whatever it started as, even once the bar moves out from under it.
        if (!timer)
          blocking =
            !!this.settings.tucked ||
            event.clientY <= doc.querySelector(HANDLE).getBoundingClientRect().bottom
        window.clearTimeout(timer)
        timer = window.setTimeout(() => (timer = 0), 120)
        if (blocking) event.preventDefault()
      },
      { passive: false }
    )
  }

  /** The page fades out at its top and bottom while there's more to scroll that way (styles.css). */
  attachScrollFades(doc) {
    const update = (el) => {
      el.classList.toggle("has-above", el.scrollTop > 1)
      el.classList.toggle(
        "has-below",
        el.scrollTop + el.clientHeight < el.scrollHeight - 1
      )
    }
    doc.addEventListener(
      "scroll",
      (event) => {
        const el = event.target
        if (el.classList && el.classList.contains("markdown-preview-view"))
          update(el)
      },
      { capture: true, passive: true }
    )
    this.updateFades = () => {
      const el =
        this.leaf &&
        this.leaf.view.containerEl.querySelector(".markdown-preview-view")
      if (el) update(el)
    }
  }

  /** A tucked window shows only its handle (styles.css). */
  showTucked() {
    const doc = this.leaf && this.leaf.view.containerEl.ownerDocument
    if (!doc || doc === document) return
    doc.body.classList.toggle("is-tucked-left", this.settings.tucked === "left")
    doc.body.classList.toggle("is-tucked-right", this.settings.tucked === "right")
  }

  closeWindow() {
    if (this.pip) this.pip.dispose()
    this.pip = null
    if (this.leaf && this.leaf.view && this.leaf.view.containerEl.isConnected)
      this.leaf.detach()
    this.leaf = null
    this.win = null
    this.updateFades = null
    this.ui = null
    this.markCurrent(null)
  }
}

class MutaSettings extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin)
    this.plugin = plugin
  }

  display() {
    const { containerEl } = this
    const plugin = this.plugin
    const save = async (key, value) => {
      plugin.settings[key] = value
      await plugin.saveData(plugin.settings)
      plugin.applySettings()
    }
    containerEl.empty()

    new SettingGroup(containerEl)
      .setHeading("Look")
      .addSetting((s) =>
        s
          .setName("Liquid Glass")
          .setDesc("The desktop shows through the window, blurred (macOS 26 or later). Off, the window is a plain tint.")
          .addToggle((t) => t.setValue(plugin.settings.glass).onChange((v) => save("glass", v)))
      )
      .addSetting((s) =>
        s
          .setName("Glass style")
          .setDesc("Regular blurs what's behind the window; clear barely does.")
          .addDropdown((d) =>
            d
              .addOptions({ regular: "Regular", clear: "Clear" })
              .setValue(plugin.settings.glassStyle)
              .onChange((v) => save("glassStyle", v))
          )
      )
      .addSetting((s) =>
        s
          .setName("Darkness")
          .setDesc("How dark the window is over the glass, so the page stays readable.")
          .addSlider((sl) =>
            sl
              .setLimits(0, 100, 5)
              .setValue(Math.round(plugin.settings.darkness * 100))
              .setDynamicTooltip()
              .onChange((v) => save("darkness", v / 100))
          )
      )
      .addSetting((s) =>
        s
          .setName("Mark the previewed note")
          .setDesc("Links to the note in the window turn yellow in Obsidian's other windows and the file list.")
          .addToggle((t) => t.setValue(plugin.settings.markPreviewed).onChange((v) => save("markPreviewed", v)))
      )

    new SettingGroup(containerEl)
      .setHeading("Behaviour")
      .addSetting((s) =>
        s
          .setName("Hold a key to preview")
          .setDesc("Hovering a link opens the window only while this key is held, so it doesn't open by accident. Pressed while over a link, it opens then.")
          .addDropdown((d) =>
            d
              .addOptions({ meta: "⌘ Command", alt: "⌥ Option", ctrl: "⌃ Control", shift: "⇧ Shift", none: "None: any hover" })
              .setValue(plugin.settings.hoverKey)
              .onChange((v) => save("hoverKey", v))
          )
      )
      .addSetting((s) =>
        s
          .setName("Show on every Space")
          .setDesc("The window stays in the same place on every Space and over full-screen apps.")
          .addToggle((t) => t.setValue(plugin.settings.allSpaces).onChange((v) => save("allSpaces", v)))
      )
      .addSetting((s) =>
        s
          .setName("Swipe to move")
          .setDesc("Two-finger swipes on the top bar move the window, like dragging it.")
          .addToggle((t) => t.setValue(plugin.settings.swipeToMove).onChange((v) => save("swipeToMove", v)))
      )
      .addSetting((s) =>
        s
          .setName("Overscroll")
          .setDesc("Pages pull past their top and bottom and spring back.")
          .addToggle((t) => t.setValue(plugin.settings.overscroll).onChange((v) => save("overscroll", v)))
      )

    new SettingGroup(containerEl)
      .setHeading("AI")
      .addSetting((s) =>
        s
          .setName("Show when an agent is working")
          .setDesc(
            "A beam runs round the page's edge while a local agent (Claude Code, Codex, OpenCode or Antigravity) " +
              "is working in this vault."
          )
          .addToggle((t) => t.setValue(plugin.settings.agentIndicator).onChange((v) => save("agentIndicator", v)))
      )
      .addSetting((s) =>
        s
          .setName("Claude Code")
          .setDesc("Watch Claude Code's sessions (~/.claude/projects).")
          .addToggle((t) => t.setValue(plugin.settings.agentClaude).onChange((v) => save("agentClaude", v)))
      )
      .addSetting((s) =>
        s
          .setName("Claude Code hooks")
          .setDesc(
            "Adds hooks to Claude Code's settings (~/.claude/settings.json) that tell Muta the moment a session " +
              "starts, edits a note or stops, and let you answer the questions it asks from the window (the terminal " +
              "still asks too; whichever you answer first counts). The events go to ~/.muta and are deleted once read."
          )
          .addToggle((t) =>
            t.setValue(plugin.agents.hooksInstalled()).onChange((v) => {
              try {
                plugin.agents.setHooks(v)
                new Notice(v ? "Muta: Claude Code hooks added. New Claude Code sessions use them." : "Muta: Claude Code hooks taken out.")
              } catch (error) {
                new Notice(`Muta: ${error.message}`)
                t.setValue(!v)
              }
            })
          )
      )
      .addSetting((s) =>
        s
          .setName("Codex")
          .setDesc("Watch Codex's sessions (~/.codex/sessions).")
          .addToggle((t) => t.setValue(plugin.settings.agentCodex).onChange((v) => save("agentCodex", v)))
      )
      .addSetting((s) =>
        s
          .setName("OpenCode")
          .setDesc("Watch OpenCode's sessions (~/.local/share/opencode).")
          .addToggle((t) => t.setValue(plugin.settings.agentOpencode).onChange((v) => save("agentOpencode", v)))
      )
      .addSetting((s) =>
        s
          .setName("Antigravity")
          .setDesc("Watch Antigravity's conversations (~/.gemini/antigravity-cli).")
          .addToggle((t) => t.setValue(plugin.settings.agentAntigravity).onChange((v) => save("agentAntigravity", v)))
      )
      .addSetting((s) =>
        s
          .setName("Cursor")
          .setDesc("Watch Cursor's agent, in the app and the cursor-agent CLI (through its hooks, below).")
          .addToggle((t) => t.setValue(plugin.settings.agentCursor).onChange((v) => save("agentCursor", v)))
      )
      .addSetting((s) =>
        s
          .setName("Cursor hooks")
          .setDesc(
            "Adds hooks to Cursor (~/.cursor/hooks.json) that tell Muta when its agent starts, edits a note and " +
              "stops. Cursor keeps no records Muta can read otherwise. Takes effect in new Cursor chats."
          )
          .addToggle((t) =>
            t.setValue(plugin.agents.cursorHooksInstalled()).onChange((v) => {
              try {
                plugin.agents.setCursorHooks(v)
                new Notice(v ? "Muta: Cursor hooks added." : "Muta: Cursor hooks taken out.")
              } catch (error) {
                new Notice(`Muta: ${error.message}`)
                t.setValue(!v)
              }
            })
          )
      )

    new SettingGroup(containerEl)
      .setHeading("Order")
      .addSetting((s) =>
        s
          .setName("Order notes")
          .setDesc(
            "Notes whose lists of links set the order the bottom bar steps through, " +
              "grouped by their headings and callouts. Glob patterns, one per line " +
              "(like Roadmap/*.md). Empty: the links on the note you hovered from."
          )
          .addTextArea((text) =>
            text
              .setPlaceholder("Roadmap/*.md")
              .setValue(plugin.settings.orderNotes)
              .onChange(async (value) => {
                plugin.items = null
                await save("orderNotes", value)
              })
          )
      )
  }
}

// For the tests (test/): the parts that don't need a window.
module.exports.testing = { AgentWatch, bouncePath, rubberBand, within, BOUNCE_MAX, AGENT_STALE_MS, claudeHookEvent, cursorHookEvent, withHooks, withCursorHooks, changedLines, questionAnswer, agentPrompt, gitRoot, shellQuote, appleQuote, AGENT_LAUNCH, HOOK_MARK, CURSOR_HOOK_MARK }
