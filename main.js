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
/**
 * Watching agents edit: an edit heard of later than this after it was made
 * is left alone (read back after a reload, say); one not on the page by this
 * long after is dropped (denied, say), its tint before that (ms). The page
 * takes this long to render a change; each word types in this fast, a block
 * of text in this long at most, and only so many blocks type in per edit;
 * the cursor takes this long to get to the next block.
 */
const EDIT_FRESH_MS = 15000
const EDIT_KEEP_MS = 5 * 60 * 1000
const EDIT_TINT_MS = 60000
const EDIT_RENDER_MS = 450
const EDIT_WORD_MS = 45
const EDIT_TYPE_MAX_MS = 900
const EDIT_MAX_BLOCKS = 6
/** How long the cursor takes to glide over to the next place to type (ms). */
const EDIT_CARET_TRAVEL_MS = 260
/** How long the cursor stays, blinking, after an edit, for the next to glide on from (ms). */
const EDIT_CARET_LINGER_MS = 8000
/** How long a beam takes to go round the edge (styles.css's muta-beam-turn), and how many show at once. */
const BEAM_TURN_MS = 2600
const MAX_BEAMS = 4
/** How long to wait for a new window to appear (ms): a cold start can be slow. */
const WINDOW_WAIT_MS = 4000
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
  /** A beam runs round the window's edge while a local agent works in this vault (the agents with Muta's hooks in). */
  agentIndicator: true,
  /** Watching agents edit: the change typed in on the note on show. */
  agentEditView: true,
  /** Agents working anywhere in a project the vault links into (a git repository holding a linked folder) count too. */
  agentLinkedProjects: false,
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
// Each agent tells Muta what it's doing through its own hooks, which Muta
// puts in when it's turned on in Settings › AI: Claude Code's, Codex's,
// Cursor's and Antigravity's hooks run a small script, and OpenCode loads a
// plugin. Each event goes, a JSON line, into
// ~/.muta/events/<agent>-<date>.jsonl, but only while Muta is running (a
// vault's mark in ~/.muta/running is fresh), so nothing piles up while it
// isn't. Every vault reads the files, each keeping its own place in them,
// so several vaults can watch at once and a reload picks up the sessions
// where they are. A session is working from a prompt (or any tool call)
// until its turn ends; its edits say which notes. It's working in this vault
// when it runs from inside the vault or has just edited a note in it,
// including notes the vault links to from elsewhere (a symlinked folder, as
// the test vault's features/ is), or, with Agents in linked projects on,
// anywhere in a project the vault links into.

/** How often the events are checked anyway (ms); new ones are seen at once (a watch on the folder). */
const AGENT_POLL_MS = 4000
/** Folder Muta keeps its hook scripts, events and running marks in (in the home folder). */
const MUTA_DIR = ".muta"
/**
 * A vault's mark in ~/.muta/running counts as Muta running for this long
 * after it was last touched (minutes): timers in a hidden Obsidian can slow
 * to about once a minute.
 */
const RUNNING_MIN = 5
/** Event files untouched this many days are deleted. */
const EVENT_KEEP_DAYS = 2
/** How much of the end of an event file is read the first time (bytes). */
const EVENT_TAIL = 8 * 1024 * 1024
/** A session heard nothing from for this long counts as stopped (ms): a long tool run says nothing until it ends, and an interrupted Claude Code turn says nothing at all. */
const HOOK_STALE_MS = 30 * 60 * 1000
/** An edit this recent says which note an agent is working on (ms). */
const AGENT_EDIT_MS = 300000
/** How many of a session's latest edits are kept. */
const AGENT_EDITS = 20
/** The agents Muta can watch, in the order they're listed. */
const AGENTS = ["claude", "codex", "opencode", "cursor", "antigravity"]
const AGENT_NAMES = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", antigravity: "Antigravity", cursor: "Cursor" }
/** Marks Muta's hooks in Claude Code's settings, so they can be found and taken out again. */
const HOOK_MARK = "muta-claude-hook"
/** Claude Code's events Muta listens for, with their matchers. A tool call keeps a long turn alive; edits say which files. */
const CLAUDE_HOOKS = { UserPromptSubmit: null, PreToolUse: "*", PermissionRequest: "*", PostToolUse: "*", Stop: null, StopFailure: null, SessionEnd: null, Notification: "idle_prompt" }
/** Codex's (~/.codex/hooks.json, the same shape): its patches say which files. */
const CODEX_HOOKS = { UserPromptSubmit: null, PreToolUse: "*", PermissionRequest: "*", PostToolUse: "*", Stop: null, Interrupt: null, SessionEnd: null }
const CODEX_HOOK_MARK = "muta-codex-hook"
/** Cursor's hooks (~/.cursor/hooks.json). */
const CURSOR_HOOK_EVENTS = ["beforeSubmitPrompt", "afterFileEdit", "afterShellExecution", "afterMCPExecution", "afterAgentResponse", "stop", "sessionEnd"]
const CURSOR_HOOK_MARK = "muta-cursor-hook"
/** Antigravity's (~/.gemini/config/hooks.json): Muta's named hook. */
const ANTIGRAVITY_HOOK_MARK = "muta-antigravity-hook"
/**
 * How a hook script knows an edit is about to land (the event, then the
 * tool), to hold it HOLD_EDIT_S (seconds) while a window watches agents
 * edit, so the window hears of it before the page changes. Cursor's comes
 * after; OpenCode's plugin holds its own.
 */
const HOOK_EDITS = {
  claude: ['"hook_event_name" *: *"PreToolUse"', '"tool_name" *: *"(Edit|MultiEdit|Write)"'],
  codex: ['"hook_event_name" *: *"PreToolUse"', '"tool_name" *: *"apply_patch"'],
  antigravity: ['"hookEventName" *: *"PreToolUse"', '"name" *: *"(edit_file|write_file)"'],
}
const HOLD_EDIT_S = 0.25
/** OpenCode 2's plugin, in its global plugins folder. */
const OPENCODE_PLUGIN_MARK = "muta-opencode-plugin"

/**
 * The script agent's hooks run: it passes the event on its stdin to
 * ~/.muta/events while Muta is running, and says nothing back (except that
 * Cursor's beforeSubmitPrompt must always be told to go on). With each
 * event goes the agent's process, so a session ends when it exits however
 * it went (a crash, killed, an error with no end-of-turn hook). find rounds a
 * mark's age up to whole minutes, so it allows one more than RUNNING_MIN:
 * the scripts keep events at least as long as the watcher counts a mark.
 */
function hookScript(agent) {
  const proceed = agent === "cursor" ? `[ "$1" = "beforeSubmitPrompt" ] && printf '{"continue":true}'\n` : ""
  const edit = HOOK_EDITS[agent]
  const hold = edit
    ? `# An edit about to land, with a window watching agents edit: a moment for it to show where first.
if [ -n "$(find "$dir/hold" -type f -mmin -${RUNNING_MIN + 1} 2>/dev/null | head -n 1)" ] &&
  printf '%s' "$input" | grep -qE '${edit[0]}' && printf '%s' "$input" | grep -qE '${edit[1]}'; then
  sleep ${HOLD_EDIT_S}
fi
`
    : ""
  return `#!/bin/sh
# Muta: passes ${AGENT_NAMES[agent]}'s hook events on to the Muta Obsidian plugin while it's running.
dir="$HOME/${MUTA_DIR}"
input=$(cat | tr -d '\\n')
${proceed}[ -n "$(find "$dir/running" -type f -mmin -${RUNNING_MIN + 1} 2>/dev/null | head -n 1)" ] || exit 0
[ -n "$input" ] || exit 0
# The agent's own process: the first above this script that isn't a shell.
pid=$PPID
while [ "\${pid:-0}" -gt 1 ]; do
  case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
    sh | */sh | bash | */bash | zsh | */zsh | dash | */dash | -*) pid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ') ;;
    *) break ;;
  esac
done
mkdir -p "$dir/events"
printf '{"at":%s000,"agent":"${agent}","pid":%s,"event":%s}\\n' "$(date +%s)" "\${pid:-0}" "$input" >> "$dir/events/${agent}-$(date +%Y-%m-%d).jsonl"
${hold}exit 0
`
}

/** OpenCode 2's plugin: its turns starting and ending, its permission requests, and its edits and writes, into ~/.muta/events while Muta is running. */
const OPENCODE_PLUGIN = `// Muta: passes OpenCode's turns and edits on to the Muta Obsidian plugin while it's running. (${OPENCODE_PLUGIN_MARK})
import { appendFileSync, mkdirSync, readdirSync, statSync } from "fs"
import { homedir } from "os"
import { join } from "path"

const dir = join(process.env.HOME || homedir(), "${MUTA_DIR}")
const running = () => {
  try {
    const marks = join(dir, "running")
    return readdirSync(marks).some((f) => Date.now() - statSync(join(marks, f)).mtimeMs < ${RUNNING_MIN} * 60000)
  } catch {
    return false
  }
}
const holding = () => {
  try {
    const marks = join(dir, "hold")
    return readdirSync(marks).some((f) => Date.now() - statSync(join(marks, f)).mtimeMs < ${RUNNING_MIN} * 60000)
  } catch {
    return false
  }
}
const pad = (n) => String(n).padStart(2, "0")
const put = (event) => {
  if (!running()) return
  try {
    const d = new Date()
    mkdirSync(join(dir, "events"), { recursive: true })
    const file = join(dir, "events", \`opencode-\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}.jsonl\`)
    appendFileSync(file, JSON.stringify({ at: Date.now(), agent: "opencode", pid: process.pid, event }) + "\\n")
  } catch {}
}

export default {
  id: "muta",
  async setup(ctx) {
    const home = ctx.location && ctx.location.directory
    const controller = new AbortController()
    void (async () => {
      try {
        for await (const e of ctx.event.subscribe({ signal: controller.signal })) {
          if (!/^(session\\.(execution\\.|deleted)|permission\\.(asked|replied))/.test(e.type)) continue
          const data = e.data || {}
          const sessionID = data.sessionID || (e.durable && e.durable.aggregateID)
          put({ type: e.type, sessionID, directory: (e.location && e.location.directory) || home })
        }
      } catch {}
    })()
    await ctx.tool.hook("execute.before", async (e) => {
      const edit = /^(edit|write)$/.test(e.tool)
      put({ type: "tool", tool: e.tool, sessionID: e.sessionID, directory: home, input: edit ? e.input : undefined })
      // An edit, with a window watching agents edit: a moment for it to show where first.
      if (edit && holding()) await new Promise((r) => setTimeout(r, ${HOLD_EDIT_S * 1000}))
    })
    return () => controller.abort()
  },
}
`

/** The session an agent's event is about. */
function sessionId(kind, e) {
  const id = kind === "cursor" ? e.conversation_id : kind === "opencode" ? e.sessionID : kind === "antigravity" ? e.conversationId : e.session_id
  return typeof id === "string" && id ? id : null
}

/** The edits in a Codex patch (apply_patch's text): each file it adds or updates, with its added lines (text) and removed ones (old). */
function patchEdits(patch) {
  const out = []
  const re = /\*\*\* (?:Update|Add) File: ([^\n]+)\n([\s\S]*?)(?=\n\*\*\* |$)/g
  let m
  while ((m = re.exec(String(patch || "")))) {
    const lines = m[2].split("\n")
    const added = lines.filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1))
    const removed = lines.filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1))
    out.push({ path: m[1].trim(), text: added.join("\n"), old: removed.join("\n") })
  }
  return out
}

/**
 * What one of each agent's events says: { cwd, turn, waiting, edits }. turn
 * is "start" (a prompt, or a tool call: still at work), "end" (the turn's
 * over), "over" (the session is) or null; waiting, that it's waiting on you
 * to allow something (Claude Code's, Codex's and OpenCode's permission
 * requests; the next tool, prompt or reply ends it); edits are
 * [{ path, text, old, after }]: the file, its new text, the text it
 * replaces (none for a whole file written), and after: the event comes once
 * the file has changed (Cursor's), not just before.
 */
const AGENT_EVENTS = {
  claude(e) {
    const event = e.hook_event_name
    const input = e.tool_input || {}
    const edit = event === "PreToolUse" && /^(Edit|MultiEdit|Write)$/.test(e.tool_name || "")
    return {
      cwd: e.cwd,
      waiting: event === "PermissionRequest",
      turn:
        event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest"
          ? "start"
          : event === "Stop" || event === "StopFailure" || (event === "Notification" && e.notification_type === "idle_prompt")
            ? "end"
            : event === "SessionEnd"
              ? "over"
              : null,
      edits: edit
        ? [
            {
              path: input.file_path,
              text: input.new_string || (input.edits || []).map((x) => x.new_string || "").join("\n") || input.content || "",
              old: input.old_string || (input.edits || []).map((x) => x.old_string || "").join("\n"),
            },
          ]
        : [],
    }
  },
  codex(e) {
    const event = e.hook_event_name
    return {
      cwd: e.cwd,
      waiting: event === "PermissionRequest",
      turn:
        event === "UserPromptSubmit" || event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest"
          ? "start"
          : event === "Stop" || event === "Interrupt"
            ? "end"
            : event === "SessionEnd"
              ? "over"
              : null,
      edits: event === "PreToolUse" && e.tool_name === "apply_patch" ? patchEdits(e.tool_input && e.tool_input.command) : [],
    }
  },
  opencode(e) {
    const path = require("path")
    const input = e.input || {}
    const file = input.path && (path.isAbsolute(input.path) ? input.path : path.join(e.directory || "", input.path))
    return {
      cwd: e.directory,
      waiting: e.type === "permission.asked",
      turn:
        e.type === "session.execution.started" || e.type === "tool" || /^permission\./.test(e.type || "")
          ? "start"
          : e.type === "session.deleted"
            ? "over"
            : /^session\.execution\./.test(e.type || "")
              ? "end"
              : null,
      edits:
        e.type === "tool" && /^(edit|write)$/.test(e.tool) && file ? [{ path: file, text: input.newString || input.content || "", old: input.oldString || "" }] : [],
    }
  },
  cursor(e) {
    const event = e.hook_event_name
    return {
      cwd: Array.isArray(e.workspace_roots) ? e.workspace_roots[0] : null,
      turn: event === "stop" ? "end" : event === "sessionEnd" ? "over" : "start",
      edits:
        event === "afterFileEdit" && e.file_path
          ? [
              {
                path: e.file_path,
                text: (e.edits || []).map((x) => x.new_string || "").join("\n"),
                old: (e.edits || []).map((x) => x.old_string || "").join("\n"),
                after: true,
              },
            ]
          : [],
    }
  },
  antigravity(e) {
    const event = e.hookEventName
    const call = e.toolCall || {}
    const args = call.args || {}
    const edit = event === "PreToolUse" && /^(edit_file|write_file)$/.test(call.name || "") && args.Path
    return {
      cwd: e.cwd || (Array.isArray(e.workspacePaths) ? e.workspacePaths[0] : null),
      turn: event === "PreInvocation" || event === "PreToolUse" ? "start" : event === "Stop" ? "end" : null,
      edits: edit ? [{ path: args.Path, text: args.Replacement || args.Content || "", old: args.Target || "" }] : [],
    }
  },
}

/**
 * An agent's session after its event e (at: when, ms; pid: the agent's
 * process, when known), from session (or none yet):
 * { id, kind, cwd, pid, working, waiting, ended, edits, at }.
 */
function agentEvent(kind, session, e, at, pid) {
  const s = session
    ? { ...session, edits: [...session.edits] }
    : { id: sessionId(kind, e), kind, cwd: null, working: false, waiting: false, ended: false, edits: [], at }
  s.at = at
  if (pid > 1) s.pid = pid
  const said = AGENT_EVENTS[kind](e)
  if (said.cwd) s.cwd = said.cwd
  if (said.turn) s.waiting = !!said.waiting
  if (said.turn === "start") {
    s.working = true
    s.ended = false
  } else if (said.turn === "end") s.working = false
  else if (said.turn === "over") {
    s.working = false
    s.ended = true
  }
  // Each edit numbered in its session, so two in the same second stay two.
  for (const edit of said.edits)
    if (edit.path) s.edits.push({ path: edit.path, text: edit.text || "", old: edit.old || "", after: !!edit.after, at, n: (s.n = (s.n || 0) + 1) })
  if (s.edits.length > AGENT_EDITS) s.edits.splice(0, s.edits.length - AGENT_EDITS)
  return s
}

/**
 * Hook settings in Claude Code's shape (Claude Code's settings.json, Codex's
 * hooks.json) with Muta's hooks in, running command for each of events
 * (event → matcher, or null), or taken out (command null), found by mark.
 * Every other hook stays as it is.
 */
function withHookGroups(config, command, events, mark) {
  const next = { ...config, hooks: { ...(config.hooks || {}) } }
  const ours = (group) => (group.hooks || []).some((h) => String(h.command || "").includes(mark))
  // Every event, so an earlier version's (PostToolUse, PermissionRequest) go too.
  for (const event of new Set([...Object.keys(next.hooks), ...Object.keys(events)])) {
    const groups = (next.hooks[event] || []).filter((g) => !ours(g))
    if (command && event in events) {
      const group = { hooks: [{ type: "command", command, timeout: 5 }] }
      if (events[event]) group.matcher = events[event]
      groups.push(group)
    }
    if (groups.length) next.hooks[event] = groups
    else delete next.hooks[event]
  }
  if (!Object.keys(next.hooks).length) delete next.hooks
  return next
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

/** Antigravity's hooks.json with Muta's named hook in (running command) or taken out (command null). */
function withAntigravityHooks(config, command) {
  const next = { ...config }
  delete next[ANTIGRAVITY_HOOK_MARK]
  if (command) {
    const handler = { type: "command", command, timeout: 5 }
    next[ANTIGRAVITY_HOOK_MARK] = { PreInvocation: [handler], PreToolUse: [{ matcher: "*", hooks: [handler] }], Stop: [handler] }
  }
  return next
}

/** What turning each agent on in Settings › AI does, and where. */
const AGENT_HOOKS_SAY = {
  claude: "Adds Muta's hooks to Claude Code's settings (~/.claude/settings.json), for every project. New sessions use them.",
  codex: "Adds Muta's hooks to Codex (~/.codex/hooks.json), for every project. Codex runs them once you approve them in its /hooks screen.",
  opencode: "Adds Muta's plugin to OpenCode 2 (~/.config/opencode/plugins/muta). It loads when OpenCode's background service restarts (opencode service restart).",
  cursor: "Adds Muta's hooks to Cursor (~/.cursor/hooks.json), for the app and the cursor-agent CLI. New chats use them.",
  antigravity: "Adds Muta's hooks to Antigravity (~/.gemini/config/hooks.json), for every project. Its CLI runs them.",
}

class AgentWatch {
  /**
   * onChange({ all: [{ id, kind, waiting }] } | null): every agent at work
   * in the vault (oldest first), and whether it's waiting on you, or none.
   */
  constructor(plugin, onChange) {
    this.plugin = plugin
    this.onChange = onChange
    this.timer = null
    this.busy = false
    this.key = ""
    this.state = null
    this.roots = null
    // Every session heard from, by "<agent>:<id>" (agentEvent()).
    this.sessions = new Map()
    // How far each event file has been read: { pos, rest }.
    this.files = new Map()
    // Edits already reported to onEdit.
    this.editsSeen = new Map()
    this.checked = new Map()
    this.watchers = []
  }

  /** The user's home folder, where the agents keep their settings and Muta its events. */
  homeDir() {
    return require("os").homedir()
  }

  /** A path in ~/.muta. */
  dir(...parts) {
    return require("path").join(this.homeDir(), MUTA_DIR, ...parts)
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
    this.markRunning(false)
    this.set(null)
  }

  /**
   * Touches this vault's mark in ~/.muta/running (on) or takes it away: the
   * hook scripts pass events on only while a mark is fresh. Says whether
   * none was, before.
   */
  markRunning(on) {
    const fs = require("fs")
    const path = require("path")
    const dir = this.dir("running")
    const base = this.plugin.app.vault.adapter.getBasePath()
    const id = require("crypto").createHash("sha1").update(base).digest("hex").slice(0, 12)
    const mine = path.join(dir, id)
    // Watching agents edit: a mark of its own, so the scripts hold an edit a moment for it.
    const hold = this.dir("hold", id)
    if (!on || !this.plugin.settings.agentEditView) fs.rmSync(hold, { force: true })
    if (!on) {
      // Lapses in a minute rather than at once, so a reload carries on where it was.
      const soon = new Date(Date.now() - (RUNNING_MIN - 1) * 60000)
      try {
        fs.utimesSync(mine, soon, soon)
      } catch {}
      return false
    }
    let fresh = false
    try {
      for (const f of fs.readdirSync(dir)) if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs < RUNNING_MIN * 60000) fresh = true
    } catch {}
    try {
      fs.mkdirSync(dir, { recursive: true })
      const now = new Date()
      for (const mark of this.plugin.settings.agentEditView ? [mine, hold] : [mine]) {
        fs.mkdirSync(path.dirname(mark), { recursive: true })
        if (fs.existsSync(mark)) fs.utimesSync(mark, now, now)
        else fs.writeFileSync(mark, base)
      }
    } catch {}
    return !fresh
  }

  /** Checks again the moment an event comes in; the timer stays, in case the watch misses one. */
  watch() {
    const fs = require("fs")
    const dir = this.dir("events")
    try {
      fs.mkdirSync(dir, { recursive: true })
      this.watchers.push(
        fs.watch(dir, { persistent: false }, () => {
          window.clearTimeout(this.soon)
          this.soon = window.setTimeout(() => this.poll(), 15)
        })
      )
    } catch {}
  }

  // ── Each agent's hooks ──────────────────────────────────────────────

  /** The file Muta's hooks (or plugin) for agent kind go in. */
  hookFile(kind) {
    const path = require("path")
    const home = this.homeDir()
    return {
      claude: path.join(home, ".claude", "settings.json"),
      codex: path.join(home, ".codex", "hooks.json"),
      opencode: path.join(home, ".config", "opencode", "plugins", "muta", "index.js"),
      cursor: path.join(home, ".cursor", "hooks.json"),
      antigravity: path.join(home, ".gemini", "config", "hooks.json"),
    }[kind]
  }

  /** Whether Muta's hooks for agent kind are in (checked every few seconds at most). */
  installed(kind, now = Date.now()) {
    const was = this.checked.get(kind)
    if (was && now - was.at < 5000) return was.on
    const mark = { claude: HOOK_MARK, codex: CODEX_HOOK_MARK, opencode: OPENCODE_PLUGIN_MARK, cursor: CURSOR_HOOK_MARK, antigravity: ANTIGRAVITY_HOOK_MARK }[kind]
    let on = false
    try {
      on = require("fs").readFileSync(this.hookFile(kind), "utf8").includes(mark)
    } catch {}
    this.checked.set(kind, { at: now, on })
    return on
  }

  /** The agents whose hooks are in. */
  watched() {
    return AGENTS.filter((kind) => this.installed(kind))
  }

  /** Puts Muta's hooks for agent kind in (and its script into ~/.muta), or takes them out. */
  setHooks(kind, on) {
    const fs = require("fs")
    const path = require("path")
    const file = this.hookFile(kind)
    // Claude Code's script keeps its name: sessions already running call it.
    const script = this.dir(kind === "claude" ? "claude-hook.sh" : `muta-${kind}-hook.sh`)
    if (on && kind !== "opencode") writeScript(script, hookScript(kind))
    if (kind === "claude")
      editJson(file, "Claude Code's settings.json", (c) => withHookGroups(c, on ? `sh "${script}" # ${HOOK_MARK}` : null, CLAUDE_HOOKS, HOOK_MARK))
    else if (kind === "codex") editJson(file, "Codex's hooks.json", (c) => withHookGroups(c, on ? `sh "${script}"` : null, CODEX_HOOKS, CODEX_HOOK_MARK))
    // Cursor may run the command without a shell: the mark is in the script's name.
    else if (kind === "cursor") editJson(file, "Cursor's hooks.json", (c) => withCursorHooks(c, on ? script : null))
    else if (kind === "antigravity") editJson(file, "Antigravity's hooks.json", (c) => withAntigravityHooks(c, on ? `sh "${script}"` : null))
    else if (on) writeScript(file, OPENCODE_PLUGIN)
    else fs.rmSync(path.dirname(file), { recursive: true, force: true })
    this.checked.delete(kind)
  }

  /**
   * Brings Muta's hooks up to date for every agent they're in, and clears
   * away an earlier version's: its event files, the question script (made
   * to do nothing, as sessions already running still call it) and answers.
   */
  upgrade() {
    const fs = require("fs")
    for (const kind of AGENTS)
      try {
        this.checked.delete(kind)
        if (this.installed(kind)) this.setHooks(kind, true)
      } catch (error) {
        console.error(`Muta: updating ${AGENT_NAMES[kind]}'s hooks`, error)
      }
    for (const old of ["claude-events.jsonl", "cursor-events.jsonl", "claude-events.jsonl.reading", "cursor-events.jsonl.reading", "answers", "claude-permission.sh"])
      fs.rmSync(this.dir(old), { recursive: true, force: true })
    if (fs.existsSync(this.dir("claude-question.sh"))) writeScript(this.dir("claude-question.sh"), "#!/bin/sh\nexit 0\n")
  }

  // ── Reading the events ──────────────────────────────────────────────

  /** Reads the events written since last time into the sessions, deleting old event files. */
  readEvents(now) {
    const fs = require("fs")
    const path = require("path")
    const dir = this.dir("events")
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      return
    }
    const on = new Set(this.watched())
    // In order, so a session's events across midnight are read in turn.
    for (const name of names.sort((a, b) => a.slice(a.indexOf("-")).localeCompare(b.slice(b.indexOf("-"))) || a.localeCompare(b))) {
      const m = name.match(/^([a-z]+)-\d{4}-\d{2}-\d{2}\.jsonl$/)
      if (!m || !AGENT_EVENTS[m[1]]) continue
      const kind = m[1]
      const file = path.join(dir, name)
      let size
      try {
        const st = fs.statSync(file)
        if (now - st.mtimeMs > EVENT_KEEP_DAYS * 86400000) {
          fs.rmSync(file, { force: true })
          this.files.delete(file)
          continue
        }
        size = st.size
      } catch {
        continue
      }
      const lines = this.newLines(file, size)
      if (!on.has(kind)) continue
      for (const line of lines) {
        let d
        try {
          d = JSON.parse(line)
        } catch {
          continue
        }
        const e = d && d.event
        const id = e && sessionId(kind, e)
        if (!id) continue
        const key = `${kind}:${id}`
        this.sessions.set(key, agentEvent(kind, this.sessions.get(key), e, d.at || now, d.pid))
      }
    }
  }

  /** The lines added to event file (size bytes now) since it was last read; the first time, the last EVENT_TAIL bytes'. */
  newLines(file, size) {
    const fs = require("fs")
    let rec = this.files.get(file)
    if (!rec || size < rec.pos) {
      rec = { pos: Math.max(0, size - EVENT_TAIL), rest: "" }
      // Started mid-line: the first, cut off, is dropped.
      if (rec.pos > 0) rec.rest = false
      this.files.set(file, rec)
    }
    if (size <= rec.pos) return []
    const fd = fs.openSync(file, "r")
    let text = ""
    try {
      const buf = Buffer.alloc(size - rec.pos)
      fs.readSync(fd, buf, 0, buf.length, rec.pos)
      text = buf.toString("utf8")
    } finally {
      fs.closeSync(fd)
    }
    rec.pos = size
    const lines = ((rec.rest || "") + text).split("\n")
    const cut = rec.rest === false
    rec.rest = lines.pop()
    if (cut) lines.shift()
    return lines.filter(Boolean)
  }

  /** Whether process pid is still running. */
  alive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return error.code === "EPERM"
    }
  }

  set(state) {
    const key = state ? state.all.map((a) => `${a.id}${a.waiting ? "?" : ""}`).join(",") : ""
    if (key === this.key) return
    this.key = key
    this.state = state
    this.onChange(state)
  }

  poll() {
    if (this.busy) return
    this.busy = true
    try {
      const now = Date.now()
      if (!this.roots || now - this.roots.at > 30000) this.roots = this.vaultRoots()
      // No Muta was running for a while (not started, or this one's timer
      // held back): the scripts let events by, a turn's end among them, so
      // the sessions read so far are taken as stopped until they're heard from.
      const missed = this.markRunning(true)
      this.readEvents(now)
      if (missed) for (const [key, s] of this.sessions) this.sessions.set(key, { ...s, working: false, waiting: false })
      const on = new Set(this.watched())
      const all = []
      for (const [key, session] of this.sessions) {
        if (!on.has(session.kind)) continue
        this.reportEdits(session, now)
        // Its process is gone (crashed, killed, or quit without ending the turn): over.
        if (session.working && session.pid && !this.alive(session.pid)) {
          this.sessions.set(key, { ...session, working: false, waiting: false, ended: true })
          continue
        }
        // Quiet a long while: stopped, unless it's waiting on you (it says nothing until you answer).
        const quiet = now - session.at > HOOK_STALE_MS && !(session.waiting && session.pid)
        if (session.ended || quiet) {
          if (session.ended || now - session.at > AGENT_EDIT_MS) this.sessions.delete(key)
          continue
        }
        if (!session.working) continue
        const edited = session.edits.some((e) => now - e.at < AGENT_EDIT_MS && this.toVault(e.path))
        if (!edited && !this.inVault(session.cwd)) continue
        all.push({ id: key, kind: session.kind, waiting: !!session.waiting })
      }
      // In the order each was first seen at work, so their beams keep their places.
      const seen = (this.firstSeen = this.firstSeen || new Map())
      for (const a of all) if (!seen.has(a.id)) seen.set(a.id, now)
      for (const id of seen.keys()) if (!all.some((a) => a.id === id)) seen.delete(id)
      all.sort((a, b) => seen.get(a.id) - seen.get(b.id))
      this.set(all.length ? { all } : null)
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
      const key = `${session.kind}:${session.id}:${e.n}`
      if (this.editsSeen.has(key)) continue
      this.editsSeen.set(key, now)
      const file = this.toVault(e.path)
      if (file && this.onEdit) this.onEdit({ kind: session.kind, file, text: e.text, old: e.old, after: e.after, at: e.at })
    }
    for (const [key, at] of this.editsSeen) if (now - at > AGENT_EDIT_MS) this.editsSeen.delete(key)
  }

  /**
   * The vault's folder, the folders and files it links to from elsewhere (two
   * levels deep), and the projects those are in (the git repositories holding
   * them, once each).
   */
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
    // Not a repository round the whole home folder (dotfiles kept in git): every agent would count.
    const home = this.realpath(this.homeDir())
    const projects = [...new Set(links.map(([, target]) => gitRoot(target)).filter((p) => p && !within(home, p)))]
    return { at: Date.now(), real, links, projects }
  }

  /** The projects the vault links into, when agents working in them count (Settings › AI). */
  projects() {
    return this.plugin.settings.agentLinkedProjects ? this.roots.projects : []
  }

  /** Whether folder cwd is inside the vault (or a folder it links to, or with the setting on, a project it links into). */
  inVault(cwd) {
    if (!cwd) return false
    const real = this.realpath(cwd)
    const { roots } = this
    return (
      within(real, roots.real) ||
      roots.links.some(([, target]) => within(real, target)) ||
      this.projects().some((p) => within(real, p))
    )
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
}

/** How each agent starts in a terminal with a first prompt (the prompt follows, quoted). */
const AGENT_LAUNCH = {
  claude: "claude",
  codex: "codex",
  opencode: "opencode --prompt",
  cursor: "cursor-agent",
  antigravity: "agy -i",
}

/**
 * The first prompt for an agent sent a note: the note as an @ reference
 * (file: its path from where the agent starts, quoted when it has spaces),
 * so the agent reads it itself rather than being handed its text, and an ask
 * to wait for what you want done with it. Claude Code takes the file in with
 * the prompt; the others read it with their own tools.
 */
function agentPrompt(file) {
  const ref = /\s/.test(file) ? `@"${file}"` : `@${file}`
  return `${ref}\n\nThis is the note I want to work on. Read it, then wait for what I ask.\n`
}

/** The git repository folder dir is in, or null. */
function gitRoot(dir) {
  const fs = require("fs")
  const path = require("path")
  for (let d = dir; d && d !== path.dirname(d); d = path.dirname(d)) if (fs.existsSync(path.join(d, ".git"))) return d
  return null
}

/**
 * The lower half of each pill's outline (pills: { x, y, w, h } in a box
 * width by height), as an SVG: down its sides from half way, round its lower
 * corners and along its bottom, fading in from the middle, for the beams'
 * light on the buttons beside the notch to show through.
 */
function keysOutline(pills, width, height) {
  const r = 7.5
  const paths = pills
    .map((p) => {
      const x0 = p.x + 0.5
      const x1 = p.x + p.w - 0.5
      const y1 = p.y + p.h - 0.5
      const mid = p.y + p.h / 2
      return `<path d="M${x0},${mid} L${x0},${y1 - r} A${r},${r} 0 0 0 ${x0 + r},${y1} L${x1 - r},${y1} A${r},${r} 0 0 0 ${x1},${y1 - r} L${x1},${mid}" fill="none" stroke="url(#fade)" stroke-width="1"/>`
    })
    .join("")
  const fade = `<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#fff"/></linearGradient>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs>${fade}</defs>${paths}</svg>`
}

/** The keys to hold while hovering a link to preview it (settings.hoverKey). */
const HOVER_KEYS = { meta: "⌘ Command", alt: "⌥ Option", ctrl: "⌃ Control", shift: "⇧ Shift", none: "None: any hover" }

/**
 * Muta's menu (the top bar's sliders button), from the agents watched
 * (Settings › AI) and Obsidian's vaults ([{ name, path, current }]): items of
 * { title, icon, checked, action } (action: { send: agent }, { vault: path },
 * { command: id } or { settings: true }), { submenu } in place of an action,
 * and { separator: true } between groups.
 */
function menuItems(agents, vaults = []) {
  return [
    agents.length
      ? { title: "Send to agent", icon: "bot", submenu: agents.map((kind) => ({ title: AGENT_NAMES[kind], action: { send: kind } })) }
      : { title: "Send to agent (none turned on in Settings › AI)", icon: "bot", disabled: true },
    { separator: true },
    {
      title: "Vaults",
      icon: "folder",
      submenu: [
        // The others to switch to, by name; this one ticked.
        ...[...vaults]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((v) => (v.current ? { title: v.name, checked: true, disabled: true } : { title: v.name, action: { vault: v.path } })),
        ...(vaults.length ? [{ separator: true }] : []),
        { title: "Manage vaults…", action: { command: "app:open-vault" } },
      ],
    },
    { title: "Muta settings…", icon: "settings", action: { settings: true } },
  ]
}

/** s for a POSIX shell, in single quotes. */
const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
/** s as an AppleScript string. */
const appleQuote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

/** Writes an executable script. */
function writeScript(file, text) {
  const fs = require("fs")
  try {
    if (fs.readFileSync(file, "utf8") === text) return
  } catch {}
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
  const text = JSON.stringify(change(data), null, 2) + "\n"
  // Unchanged (hooks brought up to date on every load): left alone.
  if (fs.existsSync(file) && JSON.stringify(data, null, 2) + "\n" === text) return
  fs.mkdirSync(require("path").dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

/** An edit's lines as they read on the page: those it adds (all its new ones when it only rearranges) and those it takes away. */
function editLines(old, text) {
  const was = changedLines(old)
  const now = changedLines(text)
  const added = now.filter((l) => !was.includes(l))
  return { added: added.length ? added : now, removed: was.filter((l) => !now.includes(l)) }
}

/** The page's blocks of text an edit can land in: paragraphs, list items, headings, table cells, callout titles, code. */
function editBlocks(page) {
  return [...page.querySelectorAll(".markdown-preview-sizer :is(p, li, h1, h2, h3, h4, h5, h6, td, th, .callout-title-inner, pre)")]
}

/** A block's text, its spaces evened out. */
const blockText = (el) => el.textContent.replace(/\s+/g, " ").trim()

/** Of blocks, those not holding another of them: a list item's own text, not its whole list. */
function innermost(blocks) {
  return blocks.filter((el) => !blocks.some((o) => o !== el && el.contains(o)))
}

/** The innermost block holding each of lines (as changedLines() gives them), once each. */
function blocksWith(blocks, lines) {
  const out = []
  for (const line of lines) {
    const holders = blocks.filter((el) => {
      const t = blockText(el)
      return t.includes(line) || (line.includes(t) && t.length >= 12)
    })
    const el = innermost(holders)[0]
    if (el && !out.includes(el)) out.push(el)
  }
  return out
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
    // Settings an earlier version kept: following along, and which agents to watch (now, those with hooks in).
    for (const key of ["agentAutoFollow", "agentClaude", "agentCodex", "agentOpencode", "agentAntigravity", "agentCursor"]) delete this.settings[key]
    this.addSettingTab(new MutaSettings(this.app, this))
    this.patchMenus()
    // Local agents at work in this vault: a beam for each (agents).
    this.agent = null
    this.agents = new AgentWatch(this, (state) => this.onAgent(state))
    this.agents.onEdit = (edit) => this.onAgentEdit(edit)
    this.agents.upgrade()
    this.pendingEdits = []
    if (this.settings.agentIndicator) this.agents.start()
    // An agent's edit to the note on show: it re-renders, then the change types in.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (this.leaf && this.leaf.view.file === file) window.setTimeout(() => this.playEdits(file), EDIT_RENDER_MS)
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
    this.schedule(file, this.direction(targetEl), "y", true)
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
    this.showBeams(doc, agent ? agent.all : [])
  }

  // ── Watching agents edit (experimental) ────────────────────────────

  /**
   * An agent is about to change the note on show (Cursor: just has): the
   * text it replaces is tinted in its colour and scrolled to; once the page
   * has the change, the new text types in behind a cursor in its colour
   * (playEdits()). Edits from a while ago (read back after a reload) and to
   * other notes are left alone.
   */
  onAgentEdit(edit) {
    if (!this.settings.agentEditView || Date.now() - edit.at > EDIT_FRESH_MS) return
    const page = this.page()
    if (!page || !this.leaf || this.leaf.view.file !== edit.file) return
    const blocks = editBlocks(page)
    const pending = { ...edit, seen: Date.now(), before: new Set(blocks.map(blockText)), tinted: [] }
    // Its change is on the page already (Cursor's, or it came in first): it types in now.
    const { added } = editLines(edit.old, edit.text)
    const there = added.length && added.every((line) => blocks.some((el) => blockText(el).includes(line)))
    if (edit.after || there) {
      pending.before = null
      this.pendingEdits.push(pending)
      return this.playEdits(edit.file)
    }
    if (edit.old) {
      pending.tinted = blocksWith(blocks, changedLines(edit.old))
      for (const el of pending.tinted) {
        el.dataset.mutaAgent = edit.kind
        el.addClass("muta-edit-old")
      }
      if (pending.tinted[0]) this.scrollToEdit(pending.tinted[0])
    }
    this.pendingEdits.push(pending)
    this.watchPage(page, edit.file)
    // Waiting on you to allow it, or denied: the tint goes after a while.
    window.setTimeout(() => pending.tinted.forEach((el) => el.removeClass("muta-edit-old")), EDIT_TINT_MS)
  }

  /**
   * Plays the edits waiting on the note on show the moment its page changes,
   * before the change is drawn, so the new text never shows before it types
   * in. Stops once none are waiting.
   */
  watchPage(page, file) {
    if (this.editObserver && this.editObserver.page === page) return
    if (this.editObserver) this.editObserver.disconnect()
    const observer = new page.ownerDocument.defaultView.MutationObserver(() => {
      if (!page.isConnected || !this.pendingEdits.some((p) => p.file === file && p.before)) {
        observer.disconnect()
        if (this.editObserver === observer) this.editObserver = null
        return
      }
      this.playEdits(file, true)
    })
    observer.page = page
    observer.observe(page, { childList: true, subtree: true, characterData: true })
    this.editObserver = observer
  }

  /**
   * The note on show changed: each edit waiting for it types in, in turn,
   * where the page changed. early: as the page changes (watchPage()), when
   * an edit whose change isn't on the page yet keeps waiting.
   */
  playEdits(file, early = false) {
    const page = this.page()
    if (!page || !this.leaf || this.leaf.view.file !== file) return
    const now = Date.now()
    this.pendingEdits = this.pendingEdits.filter((p) => now - p.seen < EDIT_KEEP_MS)
    const blocks = editBlocks(page)
    const isNew = (p) => innermost(blocks.filter((el) => !p.before.has(blockText(el))))
    const due = this.pendingEdits.filter((p) => p.file === file && (!early || (p.before && isNew(p).length)))
    if (!due.length) return
    this.pendingEdits = this.pendingEdits.filter((p) => !due.includes(p))
    let first = null
    let delay = 0
    for (const p of due) {
      p.tinted.forEach((el) => el.removeClass("muta-edit-old"))
      const { added, removed } = editLines(p.old, p.text)
      // What's new on the page since the edit was heard of; else where its new lines are.
      let changed = p.before ? isNew(p) : []
      if (!changed.length) changed = blocksWith(blocks, added)
      changed = changed.slice(0, EDIT_MAX_BLOCKS)
      // Heard of only once the page had it (the usual case: the agent writes as
      // soon as its hook returns), what it replaced shows a moment, struck
      // through, before the new text types in.
      if (removed.length && !p.tinted.length && changed[0] && !reduceMotion())
        delay = this.ghostOld(changed[0], p.kind, removed.join(" "), delay)
      for (const el of changed) {
        first = first || el
        delay = this.typeIn(page, el, p.kind, delay)
      }
    }
    if (first) this.scrollToEdit(first)
  }

  /** What edit replaced, shown at the start of block el from start (ms), struck through in the agent's colour, then gone; returns when the new text can start. */
  ghostOld(el, kind, text, start) {
    const ghost = el.ownerDocument.createElement("span")
    ghost.className = "muta-edit-ghost"
    ghost.dataset.mutaAgent = kind
    ghost.textContent = text
    ghost.style.animationDelay = `${start}ms, ${start + 450}ms`
    el.prepend(ghost)
    window.setTimeout(() => ghost.remove(), start + 720)
    return start + 760
  }

  /** Scrolls the page to el when it isn't in view (at once with Reduce motion). */
  scrollToEdit(el) {
    const page = this.page()
    if (!page) return
    const r = el.getBoundingClientRect()
    const p = page.getBoundingClientRect()
    if (r.top >= p.top + 24 && r.bottom <= p.bottom - 24) return
    el.scrollIntoView({ block: "center", behavior: reduceMotion() ? "auto" : "smooth" })
  }

  /**
   * Types block el in, word by word from start (ms), behind a cursor in the
   * agent's colour that moves along the words; returns when it ends. Its
   * words go back to plain text after. With Reduce motion, the cursor just
   * stands at its end a moment.
   */
  typeIn(page, el, kind, start) {
    const doc = el.ownerDocument
    const words = []
    const walker = doc.createTreeWalker(el, 4) // text nodes
    const nodes = []
    while (walker.nextNode()) {
      const node = walker.currentNode
      if (node.nodeValue.trim() && !node.parentElement.closest(".muta-edit-ghost")) nodes.push(node)
    }
    if (!reduceMotion())
      for (const node of nodes) {
        const parts = doc.createDocumentFragment()
        for (const part of node.nodeValue.split(/(\s+)/)) {
          if (!part) continue
          if (/^\s+$/.test(part)) parts.append(part)
          else {
            const w = doc.createElement("span")
            w.className = "muta-typed"
            w.textContent = part
            parts.append(w)
            words.push(w)
          }
        }
        node.replaceWith(parts)
      }
    // The page's one cursor: one already showing (an earlier block or edit)
    // first glides over to this block, and typing waits for it.
    const shown = page.mutaCaret && page.mutaCaret.isConnected ? page.mutaCaret : null
    const travel = (shown || start > 0) && !reduceMotion() ? EDIT_CARET_TRAVEL_MS : 0
    const from = start
    start += travel
    const step = words.length ? Math.min(EDIT_WORD_MS, EDIT_TYPE_MAX_MS / words.length) : 0
    words.forEach((w, i) => (w.style.animationDelay = `${start + i * step}ms`))
    const end = start + words.length * step
    const caret = shown || page.createDiv({ cls: "muta-caret" })
    if (!shown) caret.style.visibility = "hidden"
    page.mutaCaret = caret
    // Measured as it sets off, once what's before it (the old text shown
    // struck through, an earlier block typing in) has settled: from where it
    // is, it eases over to this block's first word, then glides along the
    // words' ends as they type in.
    window.setTimeout(() => {
      if (!caret.isConnected || page.mutaCaret !== caret) return
      caret.mutaUntil = end
      caret.dataset.mutaAgent = kind
      caret.removeClass("is-done", "is-leaving")
      const pageBox = page.getBoundingClientRect()
      const at = (r) => [r.right - pageBox.left + 1, r.top - pageBox.top + page.scrollTop, r.height]
      const stops = (words.length ? words : [el]).map((w) => at(w.getBoundingClientRect()))
      const place = ([x, y]) => `translate(${x}px, ${y}px)`
      // Where it is right now, mid-glide or not.
      const here = caret.style.visibility === "hidden" ? null : caret.ownerDocument.defaultView.getComputedStyle(caret).transform
      caret.getAnimations().forEach((a) => a.cancel())
      caret.style.height = `${stops[0][2]}px`
      caret.style.visibility = ""
      if (reduceMotion()) return (caret.style.transform = place(stops[stops.length - 1]))
      const glide = end - from
      const frames = stops.map((s, i) => ({
        transform: place(s),
        offset: (start - from + (stops.length > 1 ? (i / (stops.length - 1)) * (end - start) : 0)) / glide,
        easing: "linear",
      }))
      if (here && here !== "none") frames.unshift({ transform: here, offset: 0, easing: "cubic-bezier(0.32, 0.72, 0, 1)" })
      else frames[0].offset = 0
      caret.style.transform = frames[frames.length - 1].transform
      caret.animate(frames, { duration: Math.max(glide, 1), easing: "linear" })
    }, from)
    // Done typing: it blinks where it stopped, for the agent's next edit to
    // glide on from, and fades once none has come for a while.
    window.setTimeout(() => caret.mutaUntil === end && caret.addClass("is-done"), end)
    window.setTimeout(() => {
      if (caret.mutaUntil !== end) return
      caret.addClass("is-leaving")
      window.setTimeout(() => {
        if (caret.mutaUntil !== end) return caret.removeClass("is-leaving")
        caret.remove()
        if (page.mutaCaret === caret) page.mutaCaret = null
      }, 300)
    }, end + EDIT_CARET_LINGER_MS)
    window.setTimeout(() => {
      for (const w of words) if (w.isConnected) w.replaceWith(w.textContent)
      if (el.isConnected) el.normalize()
    }, end + 400)
    return end + 120
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
    const header = this.leaf.view.headerEl
    // The window was opened again, or the page replaced: its beams are new.
    for (const [id, beam] of beams)
      if (!beam.glow.isConnected || beam.glow.parentElement !== page || beam.keys.parentElement !== header) {
        for (const el of [beam.glow, beam.rim, beam.keys]) el.remove()
        beams.delete(id)
      }
    const sync = `${-(performance.now() % BEAM_TURN_MS)}ms, 0ms`
    for (const a of shown) {
      let beam = beams.get(a.id)
      if (beam && beam.leaving) {
        window.clearTimeout(beam.leaving)
        beam.leaving = 0
        for (const el of [beam.glow, beam.rim, beam.keys]) el.removeClass("is-leaving")
      }
      if (!beam) {
        const glow = page.createDiv({ cls: "muta-agent-glow" })
        glow.createDiv({ cls: "muta-agent-haze" })
        glow.createDiv({ cls: "muta-agent-bloom" })
        const rim = doc.body.createDiv({ cls: "muta-agent-rim" })
        // The edges of the buttons beside the notch catch its light too.
        const keys = header.createDiv({ cls: "muta-agent-rim muta-agent-keys" })
        beam = { glow, rim, keys, leaving: 0 }
        beams.set(a.id, beam)
        for (const el of [glow, rim, keys]) {
          el.dataset.agent = a.kind
          el.style.animationDelay = sync
        }
      }
    }
    // Spread round the edge: each its share of the turn, new ones starting where the last left off.
    // One waiting on you pulses (styles.css).
    shown.forEach((a, i) => {
      const beam = beams.get(a.id)
      for (const el of [beam.glow, beam.rim, beam.keys]) {
        el.toggleClass("is-waiting", !!a.waiting)
        el.style.setProperty("--muta-beam-offset", `${(360 / shown.length) * i}deg`)
        el.style.setProperty("--muta-beam-span", `${360 / shown.length}deg`)
      }
    })
    for (const [id, beam] of beams)
      if (!shown.some((a) => a.id === id) && !beam.leaving) {
        for (const el of [beam.glow, beam.rim, beam.keys]) el.addClass("is-leaving")
        beam.leaving = window.setTimeout(() => {
          for (const el of [beam.glow, beam.rim, beam.keys]) el.remove()
          beams.delete(id)
        }, 500)
      }
    if (shown.length) this.watchKeys(doc)
  }

  /**
   * Keeps the lower outline of the buttons beside the notch (two pills: back
   * and forward; edit, Muta's menu and More options) as the mask the beams'
   * light on them shows through (styles.css's .muta-agent-keys), as the
   * window docks, undocks or changes size.
   */
  watchKeys(doc) {
    const win = doc.defaultView
    if (this.keysWatched !== doc) {
      this.keysWatched = doc
      const update = () => this.beams && this.beams.size && this.updateKeys()
      new win.MutationObserver(update).observe(doc.body, { attributes: true, attributeFilter: ["class"] })
      win.addEventListener("resize", update)
    }
    this.updateKeys()
  }

  updateKeys() {
    const view = this.leaf && this.leaf.view
    const header = view && view.headerEl
    if (!header) return
    const h = header.getBoundingClientRect()
    if (!h.width || !h.height) return
    const box = (els) => {
      const rs = els.filter(Boolean).map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height)
      if (!rs.length) return null
      return {
        left: Math.min(...rs.map((r) => r.left)),
        top: Math.min(...rs.map((r) => r.top)),
        right: Math.max(...rs.map((r) => r.right)),
        bottom: Math.max(...rs.map((r) => r.bottom)),
      }
    }
    const pills = [
      box([header.querySelector(".view-header-nav-buttons")]),
      box([...header.querySelectorAll(".view-actions > .view-action:not(.muta-close)"), view.moreOptionsButtonEl]),
    ].filter(Boolean)
    const svg = keysOutline(pills.map((r) => ({ x: r.left - h.left, y: r.top - h.top, w: r.right - r.left, h: r.bottom - r.top })), h.width, h.height)
    header.style.setProperty("--muta-keys-mask", `url("data:image/svg+xml,${encodeURIComponent(svg)}")`)
  }

  /**
   * Shows the hovered file at once; while one is loading, only the latest
   * hover is kept. peek: it came from a link hovered in Obsidian, so a window
   * docked at the notch comes out to show it.
   */
  schedule(file, direction = 1, axis = "y", peek = false) {
    this.next = file
    this.nextDirection = direction
    this.nextAxis = axis
    this.nextPeek = peek
    if (!this.busy) this.drain()
  }

  async drain() {
    this.busy = true
    try {
      while (this.next) {
        const file = this.next
        const direction = this.nextDirection || 1
        const axis = this.nextAxis || "y"
        const peek = this.nextPeek
        this.next = null
        await this.show(file, direction, axis, peek)
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

  async show(file, direction = 1, axis = "y", peek = false) {
    if (!this.isOpen()) {
      this.closeWindow()
      if (!(await this.openWindow())) return
    }
    // Docked at the notch, it grows out to show a page hovered in Obsidian (and
    // stays out a moment); a step from inside the window doesn't hold it out.
    if (this.pip && peek) this.pip.peek()
    const { leaf } = this
    if (!leaf || (leaf.view.file && leaf.view.file.path === file.path)) return this.reveal()
    const old = this.snapshot()
    await leaf.openFile(file, { active: false, state: { mode: "preview" } })
    this.attach()
    this.addCloseButton()
    this.addMenuButton()
    this.showAgent()
    const raf = leaf.view.containerEl.win || window
    if (this.updateFades) raf.setTimeout(this.updateFades, 50)
    this.collapsePending = true
    this.collapseProperties()
    this.crossfade(old, direction, axis)
    this.reveal()
    this.markCurrent(file)
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
    return { el, title, label, name }
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

  /**
   * Opens the window: an Obsidian popout, kept invisible until it's been
   * made Muta's (placed, glass, its page in; reveal()), so it never shows as
   * a plain Obsidian window. Says whether it opened.
   */
  async openWindow() {
    const { BrowserWindow, getCurrentWindow } = remote()
    const main = getCurrentWindow()
    const dir = this.pluginDir()
    // Before the window exists: a BRAT install may still be fetching them.
    await this.ensureNatives()
    const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
    this.leaf = this.app.workspace.openPopoutLeaf({ size: SIZE })
    // Its window can take a while on a cold start.
    let win = null
    for (let i = 0; i < WINDOW_WAIT_MS / 25 && !win; i++) {
      win = BrowserWindow.getAllWindows().find((w) => !before.has(w.id))
      if (!win) await sleep(25)
    }
    if (!win) {
      // Never came: the leaf goes too, rather than a plain popout left behind.
      this.closeWindow()
      return false
    }
    win.setOpacity(0)
    this.hidden = win
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
    return true
  }

  /** The window, once its first page is in and drawn, shows (openWindow()). */
  reveal() {
    const win = this.hidden
    if (!win || win !== this.win) return
    this.hidden = null
    const raf = (this.leaf && this.leaf.view.containerEl.win) || window
    raf.requestAnimationFrame(() => raf.requestAnimationFrame(() => alive(win) && win.setOpacity(1)))
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
   * Muta's own menu, in the top bar's right corner (beside edit and More
   * options, docked at the notch): sending the note to an agent, changing
   * vault and Muta's settings (menuItems()).
   */
  addMenuButton() {
    const view = this.leaf && this.leaf.view
    if (!view || !view.addAction || view.mutaMenu) return
    view.mutaMenu = view.addAction("sliders-horizontal", "Muta", () => this.openMutaMenu(view.mutaMenu))
    view.mutaMenu.addClass("muta-menu")
    // In the corner, after close.
    if (view.actionsEl) view.actionsEl.appendChild(view.mutaMenu)
  }

  /** Opens Muta's menu at its button. */
  openMutaMenu(button) {
    const menu = new Menu()
    const fill = (menu, items) => {
      for (const item of items) {
        if (item.separator) {
          menu.addSeparator()
          continue
        }
        menu.addItem((i) => {
          i.setTitle(item.title)
          if (item.icon) i.setIcon(item.icon)
          if (item.checked) i.setChecked(true)
          if (item.disabled) i.setDisabled(true)
          if (item.submenu) fill(i.setSubmenu(), item.submenu)
          else if (item.action) i.onClick(() => this.runMenuAction(item.action))
        })
      }
    }
    fill(menu, menuItems(this.agents.watched(), this.vaults()))
    const r = button.getBoundingClientRect()
    menu.showAtPosition({ x: r.left, y: r.bottom + 4 }, button.ownerDocument)
  }

  /** Obsidian's vaults, as its own vault switcher lists them: [{ name, path, current }]. */
  vaults() {
    try {
      const ipc = window.electron.ipcRenderer
      const current = ipc.sendSync("vault").path
      return Object.values(ipc.sendSync("vault-list") || {}).map((v) => ({
        name: require("path").basename(v.path),
        path: v.path,
        current: v.path === current,
      }))
    } catch {
      return []
    }
  }

  /** Switches to the vault at path in this window, as Obsidian's own switcher does: it opens there, and this one closes. */
  openVault(path) {
    const ipc = window.electron.ipcRenderer
    const opened = ipc.sendSync("vault-open", path, false)
    if (opened === true) window.close()
    else new Notice(`Muta: couldn't open that vault${typeof opened === "string" ? ` (${opened})` : ""}`)
  }

  /** Does what an item of Muta's menu says (menuItems()). */
  runMenuAction(action) {
    if (action.send) this.sendToAgent(action.send)
    else if (action.vault) this.openVault(action.vault)
    else if (action.command) this.app.commands.executeCommandById(action.command)
    else if (action.settings) {
      this.app.setting.open()
      this.app.setting.openTabById(this.manifest.id)
    }
  }

  /** Changes setting key to value, saves it and applies it. */
  async saveSetting(key, value) {
    this.settings[key] = value
    await this.saveData(this.settings)
    this.applySettings()
    if (key === "agentLinkedProjects") this.agents.poll()
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
    const rel = path.relative(dir, real)
    const prompt = agentPrompt(rel.startsWith("..") ? real : rel)
    const prompts = path.join(require("os").homedir(), MUTA_DIR, "prompts")
    fs.mkdirSync(prompts, { recursive: true })
    // Earlier ones, read by their agents long since: gone.
    for (const name of fs.readdirSync(prompts))
      try {
        const old = path.join(prompts, name)
        if (Date.now() - fs.statSync(old).mtimeMs > 86400000) fs.rmSync(old, { force: true })
      } catch {}
    const promptFile = path.join(prompts, `${Date.now()}-${kind}.md`)
    fs.writeFileSync(promptFile, prompt)
    const command = `cd ${shellQuote(dir)} && ${AGENT_LAUNCH[kind]} "$(cat ${shellQuote(promptFile)})"`
    const script = `tell application "Terminal"\nactivate\ndo script ${appleQuote(command)}\nend tell`
    require("child_process").execFile("/usr/bin/osascript", ["-e", script], (error) => {
      if (error) new Notice(`Muta: couldn't open Terminal (${error.message})`)
    })
    new Notice(`Muta: sent "${file.basename}" to ${AGENT_NAMES[kind]}`)
  }

  /**
   * A close button in the top bar's right corner (the next hovered link opens
   * the window again), and the page's menu moved to its left corner.
   */
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
    this.hidden = null
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
    const save = (key, value) => plugin.saveSetting(key, value)
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
              .addOptions(HOVER_KEYS)
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

    const ai = new SettingGroup(containerEl)
      .setHeading("AI (experimental)")
      .addSetting((s) =>
        s
          .setName("Show when an agent is working")
          .setDesc(
            "Experimental. A beam runs round the page's edge while a local agent is working in this vault. " +
              "Turn on below each agent to watch: it tells Muta what it's doing through its hooks."
          )
          .addToggle((t) => t.setValue(plugin.settings.agentIndicator).onChange((v) => save("agentIndicator", v)))
      )
      .addSetting((s) =>
        s
          .setName("Watch agents edit")
          .setDesc(
            "Experimental. On the note in the window, what an agent is about to replace is tinted in its colour, " +
              "and the new text types in behind a cursor in its colour, the page scrolling to it."
          )
          .addToggle((t) => t.setValue(plugin.settings.agentEditView).onChange((v) => save("agentEditView", v)))
      )
      .addSetting((s) =>
        s
          .setName("Agents in linked projects")
          .setDesc(
            "Also count agents working anywhere in a project the vault links into: the git repository holding a " +
              "folder the vault links to, though they edit no notes."
          )
          .addToggle((t) => t.setValue(plugin.settings.agentLinkedProjects).onChange((v) => save("agentLinkedProjects", v)))
      )

    for (const kind of AGENTS)
      ai.addSetting((s) =>
        s
          .setName(AGENT_NAMES[kind])
          .setDesc(AGENT_HOOKS_SAY[kind])
          .addToggle((t) =>
            t.setValue(plugin.agents.installed(kind)).onChange((v) => {
              try {
                plugin.agents.setHooks(kind, v)
                new Notice(v ? `Muta: ${AGENT_NAMES[kind]}'s hooks added.` : `Muta: ${AGENT_NAMES[kind]}'s hooks taken out.`)
                plugin.agents.poll()
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
module.exports.testing = {
  AgentWatch,
  AGENTS,
  agentEvent,
  patchEdits,
  hookScript,
  withHookGroups,
  withCursorHooks,
  withAntigravityHooks,
  CLAUDE_HOOKS,
  CODEX_HOOKS,
  HOOK_MARK,
  CURSOR_HOOK_MARK,
  OPENCODE_PLUGIN,
  RUNNING_MIN,
  bouncePath,
  rubberBand,
  within,
  BOUNCE_MAX,
  changedLines,
  blocksWith,
  innermost,
  editLines,
  keysOutline,
  agentPrompt,
  menuItems,
  gitRoot,
  shellQuote,
  appleQuote,
  AGENT_LAUNCH,
}
