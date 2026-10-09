/* LCARS Companion.
   Companion plugin for the LCARS theme.

   - Banner: built from settings, mounted at the top of Notebook
     Navigator and of the core File Explorer.
   - Layout: rows 4px apart. The ship row and the stardate row are sized
     to fill the width (measured, not clamp()).
   - Stardate, clock, condition toggle, standby, activity registry, and
     the five subsystem channels all run on ONE set of timers and paint
     every mounted banner copy.
   The theme's snippets style the banner too; this plugin keeps the class
   names they use, and every theme variable it reads has a fallback.

   Extension hooks (this.hooks, exposed as window.lcarsCompanion.hooks): a
   second plugin can supply the lights model, the lights label, click
   behaviour and extra bar colors. With no hooks the lights run the resting
   patterns and the banner works on its own.
   More hooks: settingsTabs() returns [{ id, name, render(el, ctx) }] to add
   settings tabs; eventEnd(date) returns the end (ms) of the calendar event
   in progress, for the exit "When the calendar event ends".

   Marking a second plugin's influence on the settings page: settingsBanner()
   returns { text } for a banner at the top of the page; settingNote(key, obj)
   returns a short sentence for a setting (or "status:ID") the plugin changes or
   depends on, and that setting gets a badge. It may return { note, level } where
   level is "modified" (orange: the plugin changes it) or "dependent" (red: it needs
   the plugin); a plain string means modified. A tab object may carry badge and level.

   Statuses raised by hand (this.raised): raise(id, { source, until }),
   clear(id, { source, force }), toggle(id, opts). Each status has hand (can
   be raised by hand) and exit ({ mode, minutes, at }). Every change fires
   "lcars-companion-status-changed" on window with { id, change, source }.
   Also window.lcarsCompanion.api.statuses { list, active, raise, clear },
   experimental until 1.0, and the link obsidian://lcars-status?raise=ID,
   clear=ID or toggle=ID, with until=MINUTES and force=1. */
"use strict";
var obsidian = require("obsidian");

var DEFAULTS = {
  allCaps: false,
  motionOff: false, // pause the banner's own motion; the Style Manager switch (body.lcars-motion-off) is separate
  showVersion: true,
  shipName: "USS LEXICON",
  shipRegistry: "NX-85011",
  showStardate: true,
  stardateYear: 2401,
  timeMode: "none", // hours | date | none
  showCondition: true,
  showStatus: true,
  channels: { note: true, mod: true, docks: true, task: true, brdg: true },
  dailyFolder: "", // BRDG: daily notes folder; empty = the core Daily Notes setting
  brdgWeekdayHours: 24, // BRDG: empties after this many hours without a daily note edit (Mon-Fri)
  brdgWeekendHours: 48, // and on Sat-Sun
  idleSeconds: 30,
  embedMarkdown: "",
  embedPosition: "below", // above | below | replace | off
  embedLast: "below", // where it was before it was switched off
  showInSidebar: true,
  spanRibbon: true,
  titleBlocks: true, // wrap each note title in the LCARS block and stripe
  ribbonRoles: true, // color the left ribbon buttons by where their pane opens
  showTactical: true, // while a state shows, the ship status block shows that state's own meters
  lights: null, // filled from LIGHTS on load
  schedule: {}, // status id -> the last cron minute that was raised, so a restart does not raise it again
  alerts: null, // filled from ALERTS on load
};

/* Alert modes. The CONDITION label shows the first status, in list order,
   whose trigger matches the phase the lights model reports right now. The
   list is the priority order. Triggers are phases (ALERT_PHASES) and optional
   title words. Red and gray can also be raised by hand. With no model, the
   phase is always "rest". */
var ALERT_PHASES = [
  ["countdown", "Next event, inside its countdown window"],
  ["final", "Final minutes before an event"],
  ["during", "During an event"],
  ["starting", "Starting soon: before the event starts, inside the starting window"],
  ["started", "Just started: after the event starts, inside the starting window"],
  ["transition", "Starting window, both parts (replaces the situations above while it lasts)"],
  ["rest", "Nothing on the calendar"],
];
var EFFECTS = {
  steady: "Steady",
  pulse: "Pulse: fades in and out",
  flash: "Flash: hard blink",
  flicker: "Flicker: a failing light",
  glow: "Glow: a halo breathes around the letters",
  scan: "Scan: a highlight sweeps the letters",
};
var EFFECT_BASE = { pulse: 2.4, flash: 1.1, flicker: 3, glow: 2.4, scan: 3 }; // seconds per cycle at normal speed
var EFFECT_EASE = { pulse: "ease-in-out", flash: "ease-in-out", flicker: "linear", glow: "ease-in-out", scan: "linear" };
var SPEEDS = { slow: "Slow", normal: "Normal", fast: "Fast", custom: "Custom" };
var ICON = '<svg viewBox="0 0 24 24" fill="none" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="3"></circle></svg>';
// Running-light patterns (data-rest). A status can pick its own; "" uses the Lights setting.
var RESTS = {
  cascade: "Data cascade: segments flicker at random",
  chase: "Chase: a light with an even tail",
  comet: "Comet: a bright head and a long, thinning tail",
  scanner: "Scanner: a dot with a short afterglow",
  wide: "Wide: a wide soft band of light (experimental)",
  warp: "Warp core: a smooth wave rolling through the row (experimental)",
  pulses: "Warp pulses: separate rings of light (experimental)",
  heartbeat: "Heartbeat: the row pulses softly",
  breathe: "Breathe: the row fades slowly in and out",
  off: "Off",
};
// Where a moving style goes, and when it plays.
var RESTS_DIR = { right: "Left to right", left: "Right to left", out: "Out from the middle", in: "In to the middle", bounce: "Back and forth" };
var RESTS_BEH = { constant: "Constant", wake: "When you come back from standby", interval: "Every so often" };
// Per style: its usual direction (none = it has no direction), seconds per segment at
// Normal speed, and its default length in percent of the row.
var DESIGN = {
  cascade: {}, heartbeat: {}, breathe: {}, off: {},
  chase: { dir: "right", sps: 0.1, len: 30 }, comet: { dir: "right", sps: 0.1, len: 60 },
  scanner: { dir: "bounce", sps: 0.1, len: 8 }, wide: { dir: "bounce", sps: 0.1, len: 22 },
  warp: { dir: "out", sps: 0.1 }, pulses: { dir: "out", sps: 0.1, len: 13 },
};
// Styles from before the style, direction and behavior were separate.
var REST_OLD = {
  "chase-l": ["chase", "left"], "comet-l": ["comet", "left"], converge: ["chase", "in"], spread: ["chase", "out"],
  sway: ["wide", "bounce"], warp: ["pulses", "out"], sweep: ["wide", "right", "wake"],
};
function migrateRest(o) {
  var m = o && REST_OLD[o.rest];
  if (!m) return o;
  o.rest = m[0];
  if (!o.restDir) o.restDir = m[1];
  if (m[2] && (!o.restBeh || o.restBeh === "constant")) o.restBeh = m[2];
  return o;
}
// The light levers every state has. Nominal's values are the Lights settings; any other
// state keeps its own copy of a lever, and an empty one means "same as Nominal".
var LOOK_KEYS = ["rest", "restDir", "restBeh", "restInterval", "restSpeed", "restColorMode", "colorRest", "colorRest2", "light", "restMin", "restBrightness", "restConcentration", "restBusy", "restFlow", "restMix", "cascadeRows", "restLength", "restCount", "restSpacing", "colorEmpty"];
// The length lever, in percent of the row: the tail of Chase and Comet, the half-width of
// Scanner and Wide, and the width of a ring of Warp pulses. Empty uses the style's own default.
function lenDefault(rest) { return (DESIGN[rest] || {}).len || 0; }
// Palette roles a light color can follow. The hex is only the fallback inside var(), the palette's dark default.
var PALETTE_ROLES = [
  ["--lcars-frame", "Frame slate", "#2F3749"], ["--lcars-gap-color", "Gap color", "#000000"], ["--lcars-void", "Void black", "#000000"],
  ["--lcars-dim", "Dim gray", "#9EA5BA"], ["--lcars-bh-text", "Banner text", "#F3F4F7"], ["--lcars-readout-fill", "Readout fill", "#37A6D1"],
  ["--lcars-ribbon-left-bright", "Ribbon blue", "#41C4F7"], ["--lcars-ribbon-right-bright", "Ribbon orange", "#FF977B"],
  ["--lcars-alert", "Alert red", "#D13438"], ["--lcars-yellow", "Alert yellow", "#FFCC33"], ["--lcars-free", "Nominal green", "#8FD6A0"],
];
// How a hand-raised status ends by itself.
var EXIT_MODES = {
  cleared: "Until cleared", after: "After a time", clock: "At a clock time",
  event: "When the calendar event ends", other: "When another status is raised",
};
var REST_SPEEDS = { "": "Same as Lights", 0.5: "Slow", 1: "Normal", 2: "Fast" };
var STATUS_BASE = {
  lightTint: true, // the running lights start in this status's color (the divider dot follows tint)
  start: "", // a cron time that raises this status (hand-raisable statuses only)
  rest: "", restDir: "", restBeh: "", restInterval: "", restSpeed: "", lightColor: "", restColorMode: "", colorRest: "", colorRest2: "", light: "", restMin: "", restBrightness: "", restConcentration: "", restBusy: "", restFlow: "", restMix: "", cascadeRows: "", restLength: "", overrideBar: false, restCount: "", restSpacing: "", colorEmpty: "", hand: true, exit: { mode: "cleared", minutes: 30, at: "17:00" },
  id: "", label: "NEW STATUS", desc: "", color: "var(--lcars-bh-text, #F3F4F7)", behavior: "steady", speed: "normal", timing: "",
  fade: "persistent", fadeAfter: 5, fadeTime: 3, fadeTo: "var(--lcars-bh-text, #F3F4F7)", phases: [], words: "", tint: true,
};
function ST(o) { return Object.assign({}, STATUS_BASE, o); }
var ALERTS = {
  tint: true, // tint the lights and the divider dot with the condition color
  statuses: [
    ST({ id: "red", label: "RED ALERT", color: "var(--lcars-alert, #d13438)", behavior: "flash", rest: "heartbeat", restSpeed: "2", overrideBar: true }),
    ST({ id: "gray", label: "GRAY MODE", color: "var(--lcars-bh-dim, #9EA5BA)", phases: ["during"], words: "Focus", rest: "breathe", restSpeed: "0.5" }),
    ST({ id: "blue", label: "BLUE ALERT", color: "var(--lcars-ribbon-left-bright, #41c4f7)", phases: ["transition"] }),
    ST({ id: "yellow", label: "YELLOW ALERT", color: "var(--lcars-yellow, #ffcc33)", phases: [], rest: "comet" }),
    // Green starts out green and fades into the plain text color.
    ST({ id: "green", label: "NOMINAL", color: "var(--lcars-free, #8fd6a0)", phases: ["rest", "countdown", "final"], tint: false, fade: "fade", hand: false }),
  ],
};
// Effect timing for one status. One number is seconds per cycle; two
// numbers are milliseconds on and off. Never faster than 0.4 s a cycle.
function condTiming(st) {
  var base = EFFECT_BASE[st.behavior];
  if (!base) return null;
  var dur = base * (st.speed === "slow" ? 1.8 : st.speed === "fast" ? 0.5 : 1), onoff = null;
  if (st.speed === "custom") {
    var n = String(st.timing || "").split(/[\s,\/]+/).filter(Boolean).map(Number).filter(function (x) { return isFinite(x) && x > 0; });
    if (n.length >= 2) { onoff = { on: n[0], off: n[1] }; dur = (n[0] + n[1]) / 1000; }
    else if (n.length === 1) dur = n[0];
  }
  return { dur: Math.max(0.4, dur), onoff: onoff };
}
// One style tag holds each status's animation (its speed and on/off
// timing are per status). The shared keyframes live in styles.css.
function condCss(statuses) {
  var css = "";
  statuses.forEach(function (st) {
    var t = condTiming(st); if (!t) return;
    var sel = '.lcars-bh-cond[data-cond="' + st.id + '"] .lcars-bh-condtext';
    if (t.onoff) {
      var pc = Math.max(1, Math.min(99, 100 * t.onoff.on / (t.onoff.on + t.onoff.off)));
      css += "@keyframes lcars-cond-oo-" + st.id + " { 0%, " + pc.toFixed(2) + "% { opacity: 1; } " + (pc + 0.01).toFixed(2) + "%, 100% { opacity: 0.12; } }\n";
      css += sel + " { animation: lcars-cond-oo-" + st.id + " " + t.dur.toFixed(3) + "s steps(1) infinite; }\n";
    } else {
      css += sel + " { animation: lcars-cond-" + st.behavior + " " + t.dur.toFixed(3) + "s " + EFFECT_EASE[st.behavior] + " infinite; }\n";
    }
  });
  return css;
}
// Paints one CONDITION element (a banner copy or a settings demo). The
// fade restarts whenever the status changes, or when force is set.
function styleCond(el, st, force) {
  // The word is only as wide as it needs to be. When it changes, the box
  // slides from the old width to the new one, then goes back to auto.
  var txt = el.querySelector(".lcars-bh-condtext"), val = txt.parentElement;
  if (txt.textContent !== st.label) {
    var from = val.offsetWidth;
    if (!from || !el._lbl) setText(txt, st.label);
    else {
      val.style.transition = "none"; val.style.width = from + "px"; val.classList.add("is-sliding");
      setText(txt, st.label);
      var to = txt.offsetWidth;
      void val.offsetWidth;
      val.style.transition = ""; val.style.width = to + "px";
      window.clearTimeout(val._slide);
      val._slide = window.setTimeout(function () { val.style.width = ""; val.classList.remove("is-sliding"); }, 450);
    }
  }
  el._lbl = true;
  setAttr(el, "data-cond", st.id);
  setAttr(el, "data-effect", st.behavior);
  var fade = st.fade === "fade" && st.behavior !== "scan";
  setAttr(el, "data-fade", fade ? "fade" : "off");
  var key = [st.color, st.fadeTo, st.fadeAfter, st.fadeTime].join("|");
  if (el._key !== key) {
    el._key = key;
    el.style.setProperty("--lc-cond", st.color);
    el.style.setProperty("--lc-fade-to", st.fadeTo || "var(--lcars-bh-text, #F3F4F7)");
    el.style.setProperty("--lc-fade-delay", Math.max(0, Number(st.fadeAfter) || 0) + "s");
    el.style.setProperty("--lc-fade-dur", Math.max(0.1, Number(st.fadeTime) || 0.1) + "s");
  }
  if (force || el._id !== st.id) { el._id = st.id; el.dataset.flip = el.dataset.flip === "1" ? "0" : "1"; }
}
function normalizeAlerts(saved) {
  saved = saved || {};
  var A = Object.assign({}, ALERTS, saved), valid = ALERT_PHASES.map(function (p) { return p[0]; });
  var base = {}; ALERTS.statuses.forEach(function (b) { base[b.id] = b; });
  var blank = STATUS_BASE, oldv = !(saved.v >= 3);
  var fix = function (s) {
    var b = base[s.id] || blank, o = Object.assign({}, b, s);
    if (!SPEEDS[o.speed]) o.speed = "normal";
    if (o.fade !== "fade") o.fade = "persistent";
    o.phases = (Array.isArray(s.phases) ? s.phases : b.phases).filter(function (p) { return valid.indexOf(p) >= 0; });
    if (!EFFECTS[o.behavior]) o.behavior = "steady";
    if (oldv) migrateRest(o);
    if (o.rest && !RESTS[o.rest]) o.rest = "";
    if (o.restDir && !RESTS_DIR[o.restDir]) o.restDir = "";
    if (o.restBeh && !RESTS_BEH[o.restBeh]) o.restBeh = "";
    o.restSpeed = REST_SPEEDS[o.restSpeed] && o.restSpeed !== "" ? String(o.restSpeed) : "";
    o.hand = o.id === "green" ? false : o.hand !== false;
    o.exit = Object.assign({}, b.exit || STATUS_BASE.exit, s.exit);
    if (!EXIT_MODES[o.exit.mode]) o.exit.mode = "cleared";
    return o;
  };
  // Version 2 (2026-10-07): yellow is raised by hand (drift), and blue is the
  // calendar transition. Old saved defaults move; anything edited stays.
  var same = function (a, c) { return JSON.stringify(a || []) === JSON.stringify(c); };
  if (!saved.v && Array.isArray(saved.statuses)) {
    saved.statuses.forEach(function (s) {
      if (s && s.id === "blue" && same(s.phases, ["during"]) && !s.words) s.phases = ["transition"];
      if (s && s.id === "yellow" && same(s.phases, ["transition"]) && !s.words) s.phases = [];
    });
  }
  var list = [], seen = {};
  (Array.isArray(saved.statuses) ? saved.statuses : []).forEach(function (s) {
    if (!s || !s.id || seen[s.id]) return;
    seen[s.id] = 1; list.push(fix(s));
  });
  if (!list.length) list = ALERTS.statuses.map(function (s) { return fix(s); });
  // A built-in that went missing comes back just above green (the fallback).
  ALERTS.statuses.forEach(function (b) {
    if (seen[b.id] || list.some(function (s) { return s.id === b.id; })) return;
    var g = list.findIndex(function (s) { return s.id === "green"; });
    list.splice(g < 0 ? list.length : g, 0, fix(b));
  });
  A.statuses = list;
  A.v = 3;
  return A;
}

/* The lights row: layout and the resting patterns. Every choice is a
   setting; colors are CSS values so a theme variable can drive them. */
var LIGHTS = {
  shape: "A", // A segmented | B pill | C chase | D meet in middle | E chase to middle
  align: "centered", // full | centered | left
  form: "circle", // row style besides segments and pill: "" | rect | circle
  cascadeRows: 1, // rows of lights at rest, 1 to 5 (4 and 5 are experimental)
  ripple: true, // Data cascade: a click sends a ripple out from the segment
  rowsHeight: "auto", // with 2+ rows: auto (the module grows) | fixed (two lines of text tall)
  width: 90,
  segments: 16,
  gap: 4,
  caps: "lcars", // square | round | lcars
  // Resting lights, when nothing else is driving the row.
  rest: "chase", // chase | heartbeat | cascade | sweep | off
  restBrightness: 70, // percent: brightest a resting light gets
  restMin: 0, // percent: dimmest (0 = fully dark between flickers)
  restConcentration: 50, // percent of segments that take part (cascade); used when restBusy is empty
  restBusy: "calm", // cascade: calm | normal | busy | packed | overclocked
  restMix: "", // cascade with a flow: share of dots that flicker at random meanwhile: "" | low | mid | high
  restFlow: "", // cascade: which way the flicker moves: "" (random) | right | left | down | up
  restColorMode: "gradient", // single | random | gradient
  colorRest2: "var(--lcars-ribbon-right-bright, #ff977b)",
  restSpeed: 0.5, // 0.5 slow, 1 normal, 2 fast
  colorRest: "var(--lcars-ribbon-left-bright, #41c4f7)",
  fx: { idleDim: true, rest: true },
  colorEmpty: "var(--lcars-row-bg, #1e2229)",
  light: "", // the color of the moving light; empty = the resting colors do the moving
  restDir: "in", // where a moving style goes; empty = the style's usual direction
  restBeh: "constant", // constant | wake | interval
  restInterval: 30, // seconds between plays when the behavior is interval
  restLength: "", // tail or band length in percent of the row; empty = the style's default
  restCount: 1, // lights in a Chase, Converge or Spread group (1 to 4); rings in Warp core (1 to 3)
  restSpacing: "", // gap between the lights of a group in percent of the row; empty = a little more than the tail
  enabled: true, // false hides the row; statuses and the CONDITION label still work
};
// [css variable, setting key]. A hook can add more through hooks.colorVars().
var COLOR_VARS = [["--lt-rest", "colorRest"], ["--lt-rest2", "colorRest2"], ["--lt-empty", "colorEmpty"], ["--lt-light", "light"]];

var HOST = "lcars-bh-host";
// Three segments with each kind of end, for the Caps picker.
var CAP_SVG = {
  lcars: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><path d="M7 0H32V14H7A7 7 0 0 1 7 0Z" fill="currentColor"/><rect x="38" width="32" height="14" fill="currentColor"/><path d="M76 0H101A7 7 0 0 1 101 14H76Z" fill="currentColor"/></svg>',
  round: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><rect width="32" height="14" rx="7" fill="currentColor"/><rect x="38" width="32" height="14" rx="7" fill="currentColor"/><rect x="76" width="32" height="14" rx="7" fill="currentColor"/></svg>',
  square: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><rect width="32" height="14" fill="currentColor"/><rect x="38" width="32" height="14" fill="currentColor"/><rect x="76" width="32" height="14" fill="currentColor"/></svg>',
};
// Data cascade: how busy. Share of segments that take part, and a label.
// Styles whose head is white unless a Light color says otherwise.
var WHITE_HEAD = ["chase", "comet", "scanner"];
// Light styles by kind. The first preset of a kind is what picking the kind selects.
var STYLE_KINDS = {
  cascade: ["Data cascade", ["cascade"]],
  bar: ["Solid bar", ["heartbeat", "breathe"]],
  dots: ["Moving dots", ["scanner", "chase", "comet"]],
  warp: ["Warp core", ["warp", "pulses", "wide"]],
  off: ["Off", ["off"]],
};
var STYLE_PRESETS = {
  heartbeat: "Heartbeat: the row pulses softly", breathe: "Breathe: the row fades slowly in and out",
  scanner: "Scanner: a dot with a short afterglow", chase: "Chase: a light with an even tail", comet: "Comet: a bright head and a long, thinning tail",
  warp: "Warp core: waves of color (experimental)", pulses: "Warp pulses: narrow rings moving out (experimental)", wide: "Wide band: one soft band (experimental)",
};
function styleKind(r) { for (var k in STYLE_KINDS) if (STYLE_KINDS[k][1].indexOf(r) >= 0) return k; return "cascade"; }
// A five-field cron time (minute hour day-of-month month weekday): *, lists, ranges and steps.
function cronParse(expr) {
  var f = String(expr || "").trim().split(/\s+/);
  if (f.length !== 5) return null;
  var lim = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]], out = [];
  for (var i = 0; i < 5; i++) {
    var set = {}, parts = f[i].split(",");
    for (var k = 0; k < parts.length; k++) {
      var m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(parts[k]);
      if (!m) return null;
      var step = m[2] ? Number(m[2]) : 1, lo, hi;
      if (step < 1) return null;
      if (m[1] === "*") { lo = lim[i][0]; hi = lim[i][1]; }
      else { var r = m[1].split("-"); lo = Number(r[0]); hi = r.length > 1 ? Number(r[1]) : (m[2] ? lim[i][1] : lo); }
      if (lo < lim[i][0] || hi > lim[i][1] || lo > hi) return null;
      for (var v = lo; v <= hi; v += step) set[i === 4 && v === 7 ? 0 : v] = true;
    }
    out.push({ set: set, star: f[i].charAt(0) === "*" });
  }
  return out;
}
function cronMatch(c, d) {
  if (!c.length || !c[0].set[d.getMinutes()] || !c[1].set[d.getHours()] || !c[3].set[d.getMonth() + 1]) return false;
  var dom = c[2].set[d.getDate()], dow = c[4].set[d.getDay()];
  return !!(c[2].star || c[4].star ? dom && dow : dom || dow);
}
var BUSY = { calm: [50], normal: [100], busy: [100], packed: [100], overclocked: [100] };
var BUSY_NAMES = { calm: "Standby", normal: "Low", busy: "Medium", packed: "High", overclocked: "Maximum" };
var ROW_SVG = {
  segments: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><rect width="22" height="14" rx="3" fill="currentColor"/><rect x="28" width="22" height="14" rx="3" fill="currentColor"/><rect x="56" width="22" height="14" rx="3" fill="currentColor"/><rect x="84" width="22" height="14" rx="3" fill="currentColor"/></svg>',
  pill: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><rect width="108" height="14" rx="7" fill="currentColor"/></svg>',
  rect: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><rect width="108" height="14" fill="currentColor"/></svg>',
  circle: '<svg viewBox="0 0 108 14" width="64" height="9" aria-hidden="true"><circle cx="7" cy="7" r="6" fill="currentColor"/><circle cx="29" cy="7" r="6" fill="currentColor"/><circle cx="51" cy="7" r="6" fill="currentColor"/><circle cx="73" cy="7" r="6" fill="currentColor"/><circle cx="95" cy="7" r="6" fill="currentColor"/></svg>',
};
// A static SVG string as an element (no innerHTML).
function svgNode(str) { return document.importNode(new DOMParser().parseFromString(str, "text/html").body.firstElementChild, true); }
var REPO_URL = "https://github.com/retronified/lcars-obsidian";
// Tactical readouts: each state's own meters, in place of NOTE, MOD and the
// rest while that state shows. For show, not measurements. Five rows each, so
// the block keeps its height. [key, label, value, bar 0 to 1, motion]. Motion:
// steady, shimmer, pulse, breathe, scan, fill. The canon behind them is in the
// Consolidation note, section 12.
var TACTICAL = {
  red: [["shld", "SHLD", "UP", 1, "shimmer"], ["phsr", "PHSR", "ARMED", 1, "pulse"], ["torp", "TORP", "ARMED", 1, "pulse"],
        ["hull", "HULL", "100%", 1, "steady"], ["stns", "STATIONS", "MANNED", 1, "steady"]],
  yellow: [["shld", "SHLD", "UP", 1, "shimmer"], ["phsr", "PHSR", "OFFLN", 0, "steady"], ["torp", "TORP", "OFFLN", 0, "steady"],
           ["sens", "SENS", "SCAN", 0.3, "scan"], ["defn", "DEFENSE", "READY", 0.85, "breathe"]],
  gray: [["pwr", "PWR", "RSV", 0.2, "breathe"], ["warp", "WARP", "COLD", 0, "steady"], ["life", "LIFE", "MIN", 0.15, "steady"],
         ["deck", "DECKS", "3/11", 0.27, "steady"], ["nons", "NON-ESS", "OFFLN", 0, "steady"]],
  blue: [["algn", "ALIGN", "SEEK", 1, "fill"], ["thrs", "THRST", "LOW", 0.25, "steady"], ["clmp", "CLAMP", "OPEN", 0, "steady"],
         ["dock", "DOCK", "STBY", 0.4, "pulse"], ["ctrl", "CTRL", "MANUAL", 1, "steady"]],
};
var CHANNELS = [["note", "NOTE"], ["mod", "MOD"], ["docks", "DOCKS"], ["task", "TASK"], ["brdg", "BRDG"]];
var SCALE = { note: 2000, docks: 6, task: 3000 }; // full-bar values; settings scaleNote, scaleDocks, scaleTask override
var OPEN_TASK = /^[ \t]*[-*+][ \t]+\[[ ]\]/gm;

function pad2(n) { return String(n).padStart(2, "0"); }
function clamp01(n) { return n < 0 ? 0 : n > 1 ? 1 : n; }
function setText(el, t) { if (el && el.textContent !== t) el.textContent = t; }
function setAttr(el, n, v) { if (el && el.getAttribute(n) !== v) el.setAttribute(n, v); }
function hasWord(text, w) {
  return new RegExp("(^|\\W)" + w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "($|\\W)").test(text);
}
function briefAge(ms) {
  var s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + "s";
  var m = Math.floor(s / 60); if (m < 60) return m + "m";
  var h = Math.floor(m / 60); if (h < 48) return h + "h";
  return Math.floor(h / 24) + "d";
}
function pitchOf(el) {
  var cs = getComputedStyle(el);
  var p = parseFloat(cs.getPropertyValue("--lcars-pitch"));
  if (p > 0) return p;
  var r = parseFloat(cs.getPropertyValue("--lcars-row"));
  return r > 0 ? r + 4 : 32;
}

/* Stardate: TNG convention, 41000.0 = 1 Jan 2364, 1000 units a year.
   The configured year is the in-universe year; the real date supplies
   the position within it. 2401 = the 78xxx band (Picard S2-3). */
function stardate(year, when) {
  when = when || new Date();
  var y = when.getFullYear();
  var leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  var doy = Math.floor((Date.UTC(y, when.getMonth(), when.getDate()) - Date.UTC(y, 0, 1)) / 86400000);
  return (year - 2323) * 1000 + (doy / (leap ? 366 : 365)) * 1000;
}

/* Title blocks: wraps each .inline-title in a .lcars-title-row, outside the
   contenteditable, and adds the block-and-stripe assembly beside it. The
   block to the left of the title is CSS only. The assembly is a sibling, so
   the title's font size, line height and cap-height offset are measured and
   handed over as custom properties on the row. Idempotent: a title already in
   a row is only re-measured. Returns a stop function that unwraps the titles. */
function startTitleBlocks() {
  var ROW = "lcars-title-row", RIGHT = "lcars-title-right", BLOCK = "lcars-title-block", STRIPE = "lcars-title-stripe", TITLE = ".inline-title";
  var measureCtx = null;

  // Distance from the line box top down to the cap-height line: half-leading plus
  // ascent minus cap height, read from the title's own font through canvas metrics.
  // A probe element inside the title is out, since it is contenteditable.
  function capOffsetFor(cs, lineHeightPx) {
    if (!measureCtx) measureCtx = document.createElement("canvas").getContext("2d");
    if (!measureCtx) return 0;
    measureCtx.font = cs.fontStyle + " " + cs.fontWeight + " " + cs.fontSize + " " + cs.fontFamily;
    var m = measureCtx.measureText("H");
    var ascent = m.fontBoundingBoxAscent, descent = m.fontBoundingBoxDescent, cap = m.actualBoundingBoxAscent;
    if (![lineHeightPx, ascent, descent, cap].every(Number.isFinite)) return 0;
    // Clamped: a content area taller than the line box would push the assembly up out of the row.
    return Math.max(0, (lineHeightPx - (ascent + descent)) / 2 + ascent - cap);
  }

  // Line-height "normal" computes to a keyword, so the title's own box height stands in for it.
  function syncRow(row) {
    var title = row.querySelector(TITLE), right = row.querySelector("." + RIGHT);
    if (!title || !right) return;
    var cs = getComputedStyle(title), raw = parseFloat(cs.lineHeight);
    var lh = Number.isFinite(raw) ? raw : title.getBoundingClientRect().height;
    row.style.setProperty("--lcars-title-fs", cs.fontSize);
    row.style.setProperty("--lcars-title-lh", lh + "px");
    row.style.setProperty("--lcars-title-cap-offset", capOffsetFor(cs, lh) + "px");
  }

  function wrap(title) {
    var parent = title.parentElement;
    if (!parent) return;
    if (parent.classList.contains(ROW)) { syncRow(parent); return; }
    var row = document.createElement("div");
    row.className = ROW;
    parent.insertBefore(row, title);
    row.appendChild(title);
    var right = document.createElement("span"); right.className = RIGHT;
    var block = document.createElement("span"); block.className = BLOCK;
    var stripe = document.createElement("span"); stripe.className = STRIPE;
    right.append(block, stripe);
    row.appendChild(right);
    syncRow(row);
  }

  function apply() { document.querySelectorAll(TITLE).forEach(wrap); }
  function resync() { document.querySelectorAll("." + ROW).forEach(syncRow); }

  // The title mounts after the view and remounts on every file switch.
  var observer = new MutationObserver(apply);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener("resize", resync);
  // At first paint the font is usually still the fallback; measure again once Antonio is in.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(resync).catch(function () {});
  apply();
  window.lcarsTitleBlocks = { apply: apply, syncRow: syncRow, observer: observer };

  return function () {
    observer.disconnect();
    window.removeEventListener("resize", resync);
    document.querySelectorAll("." + ROW).forEach(function (row) {
      var t = row.querySelector(TITLE);
      if (t && row.parentElement) row.parentElement.insertBefore(t, row);
      row.remove();
    });
    delete window.lcarsTitleBlocks;
  };
}

/* Ribbon roles: each left-ribbon button is filed by where its pane opens
   (right sidebar, editor, left sidebar, or both), learned from a real press,
   and styled by lcars-core.css through data-place and the is-* classes.
   Place picks the hue; state picks the icon. The learned map lives in
   localStorage under lcars-ribbon-map, as it did in the CustomJS script, so a
   vault that already learned its buttons keeps them. Returns a stop function. */
function startRibbonRoles(plugin) {
  var app = plugin.app;
  const RIBBON_MAP_KEY = "lcars-ribbon-map";
  const RIBBON_PLACES_KEY = "lcars-ribbon-places";
  const RIBBON_BTN = ".workspace-ribbon:is(.mod-left, .mod-primary) .side-dock-actions .clickable-icon";

  // The debug switch was once a ribbon icon. It is a command now, but an old
  // copy of that icon may linger, and the learner must never classify it.
  const RIBBON_CONTROL_LABEL = "LCARS ribbon: debug";

  // Where a pane lives is read from its container, never guessed: Obsidian
  // puts the left sidebar inside .mod-left-split, the right inside
  // .mod-right-split, and the editor in the root split (neither class). A
  // view open in more than one place at once is filed as "both".
  const RIBBON_PLACES = ["right", "left", "editor", "both"];

  // Buttons whose view type (and usual place, used only while closed) is already known, keyed by aria-label, so they
  // are colored from the first paint instead of waiting for a click. A seed
  // fills a label with no record or a one-shot record; a learned view record
  // always wins. Labels are English tooltips: if a plugin renames its
  // tooltip, the button falls back to click-learning, and this table is the
  // place to fix it. View types read from app.viewRegistry, 2026-10-03.
  const RIBBON_SEED = {
    "Notebook Navigator": { view: "notebook-navigator", place: "left" },
    "Open graph view": { view: "graph", place: "editor" },
    "Vault graph": { view: "vault-graph-view", place: "editor" },
    "Open Copilot Agent Chat": { view: "copilot-agent-chat-view", place: "right" },
    "Open Git source control": { view: "git-view", place: "right" },
  };

  // Learning is event-driven, not clock-driven. After a press we wait for the
  // workspace to go quiet (RIBBON_SETTLE_MS of no leaf or focus change) and
  // then judge, so a slow plugin or a pane that only takes focus is still
  // caught. The hard ceiling resolves a press that produced no event at all,
  // which is what a modal looks like.
  // Buttons that create a file every time they are pressed. They open a pane
  // for the new file, but there is no pane to show as open or closed, so
  // they are one-shots for good. Most are caught by the vault create event
  // during the press; list one here if its file appears too late.
  const RIBBON_CREATORS = ["Create new canvas", "Create new base"];

  // Body classes that change on their own (focus, window state) and must
  // never be mistaken for a toggle.
  function ribbonIgnoredClass(cls) {
    return cls === "is-focused" || cls.startsWith("is-") || cls.startsWith("mod-");
  }

  const RIBBON_SETTLE_MS = 150;
  const RIBBON_MAX_MS = 2500;

  const ribbonMap = readJson(RIBBON_MAP_KEY);
  const ribbonPlaces = readJson(RIBBON_PLACES_KEY);
  let ribbonArmed = null;
  let ribbonClicked = false;
  let ribbonBefore = new Map();
  let ribbonBeforeActive = "";
  let ribbonDeadline = null;
  let ribbonSettle = null;
  let ribbonLastActive = "";
  let ribbonQueued = false;
  let ribbonLastPaintAt = 0;
  let ribbonWarned = false;
  let ribbonCreated = false;
  let ribbonBeforeBody = [];

  // One live copy only. A reload (or the old CustomJS script, if it is still
  // installed) can leave a second instance; each install stamps a fresh token, and a
  // copy whose token is no longer current tears itself down at its next
  // paint or event instead of fighting the new copy over the ribbon.
  const ribbonToken = `${Date.now()}-${Math.random()}`;
  let ribbonOwnTeardown = null;
  function ribbonStale() {
    if (window.__lcarsRibbonInstance === ribbonToken) return false;
    ribbonOwnTeardown?.();
    ribbonOwnTeardown = null;
    return true;
  }

  // Flip window.lcarsRibbonRoles.debug = true in the console to log what each
  // press actually did. It is the fastest way to see why a button will not
  // learn (wrong view type, a toggle that adds no leaf, a selector miss).
  function ribbonDebugOn() {
    return window.lcarsRibbonRoles?.debug === true;
  }

  function ribbonIsControl(label) {
    return label === RIBBON_CONTROL_LABEL;
  }

  // Obsidian's own per-vault storage. Plain localStorage is shared by every vault, so
  // one vault's learned buttons would show up in the next. The old shared key is read
  // once when this vault has nothing saved yet, so a map learned before still carries over.
  function readJson(key) {
    try {
      var own = app.loadLocalStorage ? app.loadLocalStorage(key) : null;
      if (own && typeof own === "object") return own;
      return JSON.parse(localStorage.getItem(key) || "{}");
    } catch (err) {
      return {};
    }
  }

  function writeJson(key, value) {
    try {
      if (app.saveLocalStorage) app.saveLocalStorage(key, value);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* a full quota: colors still work for the session */
    }
  }

  // A one-word description of which container a leaf lives in.
  function ribbonPlaceOfLeaf(leaf) {
    const el = leaf?.view?.containerEl;
    if (el?.closest?.(".mod-right-split")) return "right";
    if (el?.closest?.(".mod-left-split")) return "left";
    return "editor";
  }

  // view type -> place. A type open in more than one container collapses to
  // "both", so a button whose pane sits on either side still has an answer.
  function ribbonLeafPlaces() {
    const seen = new Map();
    app.workspace.iterateAllLeaves((leaf) => {
      const type = leaf?.view?.getViewType?.();
      if (!type) return;
      if (!seen.has(type)) seen.set(type, new Set());
      seen.get(type).add(ribbonPlaceOfLeaf(leaf));
    });
    const places = new Map();
    for (const [type, set] of seen) {
      places.set(type, set.size > 1 ? "both" : [...set][0]);
    }
    return places;
  }

  // view type -> { place, visible } for every open view, read live. The
  // place follows the pane: if a view is open in more than one container,
  // the visible leaf wins, then the focused one, then the first found.
  // Visible means the leaf is on screen: the front tab in its group, in a
  // sidebar that is not collapsed.
  function ribbonLiveState() {
    const state = new Map();
    app.workspace.iterateAllLeaves((leaf) => {
      const type = leaf?.view?.getViewType?.();
      if (!type) return;
      const el = leaf.view.containerEl;
      // A collapsed sidebar keeps its leaves laid out (offsetParent is
      // still set), so its own collapsed flag is checked as well.
      const visible = !!el?.offsetParent && !leaf.getRoot?.()?.collapsed;
      const focused = !!el?.closest?.(".workspace-leaf")?.classList?.contains("mod-active");
      const rank = (visible ? 2 : 0) + (focused ? 1 : 0);
      const prev = state.get(type);
      if (!prev || rank > prev.rank) {
        state.set(type, { place: ribbonPlaceOfLeaf(leaf), visible: visible || !!prev?.visible, rank });
      } else if (visible) {
        prev.visible = true;
      }
    });
    return state;
  }

  // The learned place, or an override. Empty means "not known yet".
  function ribbonPlace(label) {
    const override = ribbonPlaces[label];
    if (RIBBON_PLACES.includes(override)) return override;
    return ribbonMap[label]?.place || "";
  }

  // getMostRecentLeaf() reports main-area focus, so a pane open in a right or
  // left sidebar never looked active. Obsidian puts mod-active on the host
  // leaf of whichever view actually has focus, in any split, so read that
  // first, then the view the active-leaf-change event last handed us, then the
  // API. The three together cover the sidebar cases the API alone missed.
  function ribbonActiveType() {
    let active = "";
    app.workspace.iterateAllLeaves((leaf) => {
      const host = leaf?.view?.containerEl?.closest?.(".workspace-leaf");
      if (host?.classList?.contains("mod-active")) active = leaf.view.getViewType();
    });
    return active || ribbonLastActive || app.workspace.getMostRecentLeaf()?.view?.getViewType?.() || "";
  }

  function ribbonButtons() {
    return Array.from(document.querySelectorAll(RIBBON_BTN));
  }

  function ribbonPaint() {
    ribbonQueued = false;
    if (ribbonStale()) return;
    try {
      const live = ribbonLiveState();
      const active = ribbonActiveType();

      for (const btn of ribbonButtons()) {
        const label = btn.getAttribute("aria-label");
        if (ribbonIsControl(label)) continue; // leave our own toggle alone
        const rec = ribbonMap[label];
        const viewable = !!rec?.view;
        const toggle = rec?.toggle || "";
        btn.classList.toggle("is-toggle", !!toggle);
        // A toggle is on while its class is on the body, unless the class
        // means the opposite (stealth mode is on when cf-show-hidden is
        // absent), which invertToggle(label) records.
        btn.classList.toggle("is-on", !!toggle && document.body.classList.contains(toggle) !== !!rec.invert);

        btn.classList.toggle("is-openable", viewable);
        const now = viewable ? live.get(rec.view) : undefined;
        btn.classList.toggle("is-open", !!now);
        btn.classList.toggle("is-visible", !!now?.visible);
        btn.classList.toggle("is-live", viewable && rec.view === active);

        // An override pins the place; otherwise the live pane decides,
        // and the learned place only colors a closed button.
        const override = ribbonPlaces[label];
        const place = !viewable
          ? ""
          : RIBBON_PLACES.includes(override)
            ? override
            : now?.place || ribbonPlace(label);
        // Write only on change: an unconditional write is still a DOM
        // mutation, and Style Manager's observer answers every mutation
        // with a body class write, which fed back into a repaint.
        if (place) {
          if (btn.dataset.place !== place) btn.dataset.place = place;
        } else if ("place" in btn.dataset) {
          delete btn.dataset.place;
        }
      }
    } catch (err) {
      if (!ribbonWarned) {
        ribbonWarned = true;
        console.error("[lcars-ribbon] paint failed", err);
      }
    }
  }

  // Obsidian fires layout-change and active-leaf-change often, and re-renders
  // ribbon items on its own schedule. Painting on every one made the browser
  // measure layout repeatedly ("forced reflow while executing JavaScript").
  // Coalesce to one paint per frame, and never drop a pending paint: come back
  // for it if the last one was too recent.
  function ribbonQueuePaint() {
    if (ribbonQueued) return;
    ribbonQueued = true;
    const run = () => {
      ribbonQueued = false;
      const now = performance.now();
      const wait = ribbonLastPaintAt + 150 - now;
      if (wait > 0) {
        ribbonQueued = true;
        setTimeout(run, wait);
        return;
      }
      ribbonLastPaintAt = now;
      ribbonPaint();
    };
    requestAnimationFrame(run);
  }

  function ribbonArm(btn) {
    // Single choke point: the debug control is not a vault action and must
    // never be armed, no matter which listener reaches this.
    if (ribbonIsControl(btn.getAttribute?.("aria-label"))) return;
    ribbonArmed = btn;
    ribbonClicked = false;
    ribbonBefore = ribbonLeafPlaces();
    ribbonBeforeActive = ribbonActiveType();
    ribbonCreated = false;
    ribbonBeforeBody = [...document.body.classList];
    clearTimeout(ribbonDeadline);
    clearTimeout(ribbonSettle);
    ribbonDeadline = setTimeout(ribbonVerdict, RIBBON_MAX_MS);
  }

  // One handler for both workspace events. It keeps the focus type fresh, keeps
  // the ribbon painted, and, if a press is in flight, restarts the settle
  // timer so the verdict runs once the workspace stops moving. This is the
  // "listen for focus" path: a sidebar item that only takes focus still
  // settles, and a pane that opens slowly still lands inside the window.
  function ribbonWorkspaceEvent(leaf) {
    if (ribbonStale()) return;
    const type = leaf?.view?.getViewType?.();
    if (type) ribbonLastActive = type;
    ribbonQueuePaint();
    if (!ribbonArmed) return;
    clearTimeout(ribbonSettle);
    ribbonSettle = setTimeout(ribbonVerdict, RIBBON_SETTLE_MS);
  }

  function ribbonVerdict() {
    if (ribbonStale()) return;
    if (!ribbonArmed) return;
    clearTimeout(ribbonDeadline);
    clearTimeout(ribbonSettle);
    ribbonDeadline = null;
    ribbonSettle = null;

    const btn = ribbonArmed;
    const clicked = ribbonClicked;
    ribbonArmed = null;
    ribbonClicked = false;

    const label = btn.getAttribute("aria-label");
    if (ribbonIsControl(label)) {
      ribbonQueuePaint();
      return;
    }
    const known = ribbonMap[label];

    // Already known to be an opener: never re-judge it. Re-clicking just
    // focuses the pane it opened, which reads as "nothing happened" and
    // would otherwise wipe the color. A one-shot record is still open to
    // upgrade, so a press that was misjudged corrects itself next time.
    if (!label || !clicked || (known && !known.oneShot)) {
      ribbonQueuePaint();
      return;
    }

    const after = ribbonLeafPlaces();
    const fresh = [...after.keys()].filter((type) => !ribbonBefore.has(type));
    const closedTypes = [...ribbonBefore.keys()].filter((type) => !after.has(type));
    const activeAfter = ribbonActiveType();

    let record = null;
    if (ribbonCreated) {
      // The press made a file. Whatever pane opened for it, a creator has
      // no open or closed state to show: a one-shot for good.
      record = { oneShot: true, creator: true };
    } else if (activeAfter && fresh.includes(activeAfter)) {
      // The press opened something and that something now has focus, even
      // if it also closed a sibling on the way in (sidebars replace tabs).
      record = { view: activeAfter, place: after.get(activeAfter) };
    } else if (fresh.length === 1) {
      // Exactly one new view type appeared: this button owns it.
      record = { view: fresh[0], place: after.get(fresh[0]) };
    } else if (fresh.length === 0 && closedTypes.length === 1 && ribbonBeforeActive === closedTypes[0]) {
      // The focused pane closed under the press, so the view that vanished
      // is the one this button owns. This is what teaches a button on a
      // first press while its pane is already open, instead of demanding
      // the pane be closed first. Its place is where it was.
      record = { view: closedTypes[0], place: ribbonBefore.get(closedTypes[0]) };
    } else if (fresh.length === 0 && closedTypes.length === 0 && activeAfter && activeAfter !== ribbonBeforeActive) {
      // Nothing new or gone, but focus moved into a pane: an open view.
      record = { view: activeAfter, place: after.get(activeAfter) };
    } else if (fresh.length === 0 && closedTypes.length === 0 && activeAfter === ribbonBeforeActive) {
      // The workspace is exactly as it was: a modal or a transient command.
      record = { oneShot: true };
    }

    // A press that changed nothing in the workspace but switched exactly one
    // body class on or off is a toggle (stealth mode flips cf-show-hidden).
    if (record?.oneShot && !record.creator) {
      const now = [...document.body.classList];
      const changed = [
        ...now.filter((c) => !ribbonBeforeBody.includes(c)),
        ...ribbonBeforeBody.filter((c) => !now.includes(c)),
      ].filter((c) => !ribbonIgnoredClass(c));
      if (changed.length === 1) record = { toggle: changed[0] };
    }

    if (ribbonDebugOn()) {
      console.log("[lcars-ribbon] verdict", {
        label,
        clicked,
        before: Object.fromEntries(ribbonBefore),
        after: Object.fromEntries(after),
        fresh,
        closed: closedTypes,
        activeBefore: ribbonBeforeActive,
        activeAfter,
        record,
      });
    }

    // Anything else (several new leaves, or a pane that only closed) stays
    // unrecorded so the next press gets another chance.
    if (!record) {
      ribbonQueuePaint();
      return;
    }

    if (!known) ribbonMap[label] = record;
    else if (known.oneShot && !known.creator && (record.view || record.toggle || record.creator)) ribbonMap[label] = record;
    else {
      ribbonQueuePaint();
      return;
    }

    writeJson(RIBBON_MAP_KEY, ribbonMap);
    ribbonQueuePaint();
  }

  function ribbonInstall() {
    // A class reload builds a new instance while the previous instance's
    // listeners are still bound. Tear those down first so the live handlers
    // always match the current code; otherwise an older handler (for example
    // one that predates the debug control) keeps running and mis-learns
    // buttons. A full app restart hides this; a hot-reload does not.
    window.__lcarsRibbonTeardown?.();

    // Self-heal. Drop the debug control if an older build recorded it, and
    // drop any view record with no place: those predate the switch from
    // capability to place, so they re-learn once with a place instead of
    // keeping a stale color.
    let healed = ribbonMap[RIBBON_CONTROL_LABEL] ? 1 : 0;
    delete ribbonMap[RIBBON_CONTROL_LABEL];
    for (const key of Object.keys(ribbonMap)) {
      const rec = ribbonMap[key];
      if (rec?.view && !RIBBON_PLACES.includes(rec.place)) {
        delete ribbonMap[key];
        healed++;
      }
    }
    // Seed the known buttons. This also replaces a one-shot record that was
    // judged wrong (Copilot was saved as a one-shot once).
    for (const [label, seed] of Object.entries(RIBBON_SEED)) {
      const known = ribbonMap[label];
      const stale = known?.seeded && (known.view !== seed.view || known.place !== seed.place);
      if (!known || stale || (known.oneShot && !known.view)) {
        ribbonMap[label] = { view: seed.view, place: seed.place, seeded: true };
        healed++;
      }
    }
    // Known toggle polarity: stealth mode hides things, so it is on when
    // Colorful Folders' cf-show-hidden class is absent.
    const stealth = ribbonMap["Toggle stealth mode"];
    if (stealth?.toggle === "cf-show-hidden" && stealth.invert === undefined) {
      stealth.invert = true;
      healed++;
    }
    for (const label of RIBBON_CREATORS) {
      if (!ribbonMap[label]?.creator) {
        ribbonMap[label] = { oneShot: true, creator: true };
        healed++;
      }
    }
    if (healed) writeJson(RIBBON_MAP_KEY, ribbonMap);

    window.__lcarsRibbonInstance = ribbonToken;

    const ribbonAbort = new AbortController();

    // Pointerdown is the earliest hook: Obsidian can open a pane on
    // pointerdown, before any click event exists. Capture phase puts this
    // ahead of the plugin's own handler. Primary button only.
    document.addEventListener(
      "pointerdown",
      (event) => {
        if (ribbonStale()) return;
        if (event.button !== 0) return;
        const btn = event.target?.closest?.(RIBBON_BTN);
        if (btn) {
          if (!ribbonIsControl(btn.getAttribute?.("aria-label"))) ribbonArm(btn);
          return;
        }
        // A press inside the ribbon that missed the selector is the other
        // way a button stays silently neutral, so report it when debugging.
        if (ribbonDebugOn()) {
          const raw = event.target?.closest?.(".workspace-ribbon:is(.mod-left, .mod-primary) .side-dock-actions *");
          if (raw) {
            console.log("[lcars-ribbon] ribbon press missed the selector", {
              className: raw.className,
              label: raw.getAttribute?.("aria-label"),
            });
          }
        }
      },
      { capture: true, signal: ribbonAbort.signal },
    );

    // Confirm the press became a real activation, and arm for keyboard
    // activation, which never fires pointerdown.
    document.addEventListener(
      "click",
      (event) => {
        if (ribbonStale()) return;
        const btn = event.target?.closest?.(RIBBON_BTN);
        if (!btn || ribbonIsControl(btn.getAttribute?.("aria-label"))) return;
        if (ribbonArmed !== btn) ribbonArm(btn);
        ribbonClicked = true;
      },
      { capture: true, signal: ribbonAbort.signal },
    );

    // These repaint and, while a press is in flight, drive the verdict: the
    // judge runs once the workspace settles, so it does not care what order
    // the events arrive in or how long the pane takes to open.
    // Collapsing a sidebar may not fire layout-change, so a resize repaints
    // too. ribbonQueuePaint coalesces, so a window drag paints at most once
    // per frame.
    window.addEventListener("resize", ribbonQueuePaint, { signal: ribbonAbort.signal });

    const ribbonRefs = [
      app.workspace.on("layout-change", () => ribbonWorkspaceEvent()),
      app.workspace.on("active-leaf-change", (leaf) => ribbonWorkspaceEvent(leaf)),
      // Fires when a sidebar collapses or expands, which layout-change does not.
      app.workspace.on("resize", ribbonQueuePaint),
    ];

    // A file created while a press is in flight marks that press a creator.
    const ribbonVaultRef = app.vault.on("create", () => {
      if (ribbonArmed) ribbonCreated = true;
    });

    // A toggle can be switched from a hotkey or command too, so watch the
    // body class and repaint (coalesced) when it changes.
    // Repaint only when a class a learned toggle watches really changed.
    // Other plugins write the body class attribute without changing it
    // (Style Manager does, several times a second), and repainting on
    // those writes made a loop.
    const ribbonToggleState = () =>
      Object.values(ribbonMap)
        .filter((rec) => rec?.toggle)
        .map((rec) => `${rec.toggle}:${document.body.classList.contains(rec.toggle)}`)
        .join("|");
    let ribbonLastToggles = ribbonToggleState();
    const ribbonBodyObserver = new MutationObserver(() => {
      const now = ribbonToggleState();
      if (now === ribbonLastToggles) return;
      ribbonLastToggles = now;
      ribbonQueuePaint();
    });
    ribbonBodyObserver.observe(document.body, { attributes: true, attributeFilter: ["class"] });

    // Obsidian rebuilds ribbon items when plugins toggle or the workspace
    // changes. Direct children only: a button that swaps its own icon keeps
    // its element and classes, so there is no need to watch inside it, and
    // watching inside caught every icon render for no benefit.
    const ribbonActions = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary) .side-dock-actions");
    const ribbonObserver = new MutationObserver(ribbonQueuePaint);
    if (ribbonActions) {
      ribbonObserver.observe(ribbonActions, { childList: true });
    }

    window.lcarsRibbonRoles = {
      repaint: ribbonPaint,
      map: ribbonMap,
      places: ribbonPlaces,
      place: ribbonPlace,
      debug: false,
      // Pin a button to a place, or pass null to fall back to what was
      // learned. Places are 'right', 'left', 'editor', or 'both'.
      // Survives reload.
      setPlace: (label, place) => {
        if (RIBBON_PLACES.includes(place)) ribbonPlaces[label] = place;
        else delete ribbonPlaces[label];
        writeJson(RIBBON_PLACES_KEY, ribbonPlaces);
        ribbonQueuePaint();
      },
      // Flip which body-class state counts as "on" for a learned toggle.
      invertToggle: (label) => {
        const rec = ribbonMap[label];
        if (!rec?.toggle) return;
        rec.invert = !rec.invert;
        writeJson(RIBBON_MAP_KEY, ribbonMap);
        ribbonQueuePaint();
      },
      reset: (label) => {
        if (label) delete ribbonMap[label];
        else Object.keys(ribbonMap).forEach((key) => delete ribbonMap[key]);
        writeJson(RIBBON_MAP_KEY, ribbonMap);
        ribbonQueuePaint();
      },
    };

    // The next install (a class reload) calls this before rebinding.
    const teardown = () => {
      ribbonAbort.abort();
      ribbonRefs.forEach((ref) => app.workspace.offref(ref));
      app.vault.offref(ribbonVaultRef);
      ribbonObserver.disconnect();
      ribbonBodyObserver.disconnect();
      clearTimeout(ribbonDeadline);
      clearTimeout(ribbonSettle);
      ribbonArmed = null;
      ribbonClicked = false;
    };
    ribbonOwnTeardown = teardown;
    window.__lcarsRibbonTeardown = teardown;

    ribbonQueuePaint();
  }

  ribbonInstall();
  return function () {
    if (window.__lcarsRibbonInstance === ribbonToken) {
      if (ribbonOwnTeardown) ribbonOwnTeardown();
      ribbonOwnTeardown = null;
      window.__lcarsRibbonInstance = null;
      delete window.lcarsRibbonRoles;
    }
    document.querySelectorAll(RIBBON_BTN).forEach(function (btn) {
      btn.classList.remove("is-toggle", "is-on", "is-openable", "is-open", "is-visible", "is-live");
      delete btn.dataset.place;
    });
  };
}

class LcarsCompanion extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.channels = Object.assign({}, DEFAULTS.channels, this.settings.channels);
    this.hooks = {};
    this.applyMotion();
    var hadBusy = !!(this.settings.lights && this.settings.lights.restBusy);
    var oldLights = !(this.settings.lights && this.settings.lights.restv >= 1);
    this.settings.lights = Object.assign({}, LIGHTS, this.settings.lights);
    if (oldLights) { migrateRest(this.settings.lights); this.settings.lights.restv = 1; }
    this.settings.lights.fx = Object.assign({}, LIGHTS.fx, this.settings.lights.fx);
    // Before "Processing activity", the cascade had a percent of segments. Keep what it looked like.
    if (!hadBusy) this.settings.lights.restBusy = Number(this.settings.lights.restConcentration) >= 75 ? "normal" : "calm";
    this.settings.alerts = normalizeAlerts(this.settings.alerts);
    this.raised = new Map();
    this.settings.schedule = Object.assign({}, this.settings.schedule);
    this._lastStart = this.settings.schedule;
    this.demoEls = new Set();
    this.whyEls = new Set();
    this.condStyle();
    this.previewHosts = new Set();
    this.tagEls = new Set();
    this.hosts = new Set();
    this.state = {
      note: { pct: 0, text: "—", void: true }, mod: { pct: 0, text: "—", void: true },
      docks: { pct: 0, text: "0", void: false }, task: { pct: 0, text: "—", void: true },
      brdg: { pct: 0, text: "—", void: true },
    };
    this.bridgeStamp = null;
    this.claims = new Set();
    this.taskCounts = new Map();
    this.taskTotal = 0;
    this.addSettingTab(new CompanionSettings(this.app, this));
    var me = this;
    // One command per status that can be raised by hand. Red and gray keep
    // their first ids, so existing hotkeys still work. A status added later
    // gets its command after the plugin reloads.
    this.handStatuses().forEach(function (st) {
      var id = st.id === "red" ? "toggle-red-alert" : st.id === "gray" ? "toggle-gray-mode" : "toggle-status-" + st.id;
      var name = st.id === "red" ? "Toggle red alert" : st.id === "gray" ? "Toggle gray mode" : "Toggle status: " + st.label;
      me.addCommand({ id: id, name: name, callback: function () { me.pickToggle(st.id); } });
    });
    this.addCommand({ id: "toggle-ribbon-debug", name: "Toggle ribbon debug logging", callback: function () {
      var api = window.lcarsRibbonRoles;
      if (!api) { new obsidian.Notice("Ribbon roles are off"); return; }
      api.debug = !api.debug;
      new obsidian.Notice("LCARS ribbon debug " + (api.debug ? "on" : "off"));
    } });
    this.registerObsidianProtocolHandler("lcars-status", function (q) {
      var mins = Number(q.until), until = mins > 0 ? Date.now() + mins * 60000 : 0;
      if (q.raise) me.raise(q.raise, { source: "link", until: until });
      if (q.clear) me.clear(q.clear, { source: "link", force: q.force === "1" || q.force === "true" });
      if (q.toggle) me.toggle(q.toggle, { source: "link", until: until, force: q.force === "1" || q.force === "true" });
    });
    this.exposeGlobals();
    this.startStandby();

    var self = this;
    this.app.workspace.onLayoutReady(function () {
      self.applyInterface();
      // The theme's Style Manager settings arrive with this plugin's stylesheet. Style Manager
      // rescans when the page's CSS changes, so tell it once that ours has loaded.
      window.setTimeout(function () { self.app.workspace.trigger("css-change"); }, 1200);
      self.mountAll();
      // The banner's size depends on the theme snippet (row height, top
      // mode), fonts, and the ribbon, and all of those can land after the
      // first fit. Refit when each one arrives, in one frame, not per event.
      var refit = function () {
        window.cancelAnimationFrame(self._refitRaf);
        self._refitRaf = window.requestAnimationFrame(function () {
          self.hosts.forEach(function (h) { self.fit(h); });
          self.alignRibbon();
          self.syncNnScroll();
        });
      };
      self.refitAll = refit;
      self.registerEvent(self.app.workspace.on("css-change", refit));
      // Style Manager writes a changed setting straight into its style element and
      // sends no css-change, so the banner's fit (width scaling, drop, top and bottom
      // padding) would wait for some other event. Watch the element and fit again.
      // A timer rather than a frame, so it also runs in a background window.
      var smFit = function () {
        window.clearTimeout(self._smTimer);
        self._smTimer = window.setTimeout(function () {
          self.hosts.forEach(function (h) { self.fit(h); });
          self.alignRibbon();
          self.syncNnScroll();
        }, 60);
      };
      var smObs = new MutationObserver(smFit);
      var smWatch = function () {
        var el = document.getElementById("style-manager-css");
        if (!el || el === self._smEl) return;
        self._smEl = el;
        smObs.disconnect();
        smObs.observe(el, { childList: true, characterData: true, subtree: true });
        smFit();
      };
      self._smHead = new MutationObserver(smWatch);
      self._smHead.observe(document.head, { childList: true });
      self._smObs = smObs;
      smWatch();
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(refit);
      if (document.fonts) { self._fontsRefit = refit; document.fonts.addEventListener("loadingdone", refit); }
      [300, 1000, 3000].forEach(function (ms) { window.setTimeout(refit, ms); });
      self.registerEvent(self.app.workspace.on("layout-change", function () {
        refit();
        self.syncNnScroll();
        self.mountAll(); self.readDocks(); self.paintAll(); self.syncFrame();
      }));
      // lcars-frame.css reads these instead of searching the page with body:has().
      self.registerEvent(self.app.workspace.on("active-leaf-change", function () {
        self.syncFrame();
        // Notebook Navigator redraws its list a beat after a note switch;
        // measure again once it has settled so the ribbon stays level.
        [60, 250, 800].forEach(function (ms) { window.setTimeout(function () { self.alignRibbon(); }, ms); });
      }));
      self.registerEvent(self.app.workspace.on("resize", function () { self.syncFrame(); }));
      self.syncFrame();
      self.registerInterval(window.setInterval(function () { self.paneReadout(); self.syncNnScroll(); self.alignRibbon(); }, 4000));
      // Word count reads the whole note, so it waits for a typing pause.
      self.registerEvent(self.app.workspace.on("editor-change", function () {
        window.clearTimeout(self._noteTimer);
        self._noteTimer = window.setTimeout(function () { self.readNote(); self.paintAll(); }, 2000);
      }));
      self.registerEvent(self.app.workspace.on("active-leaf-change", function () { self.readNote(); self.paintAll(); }));
      self.registerEvent(self.app.metadataCache.on("changed", function (f, d, cache) { self.setTaskCount(f.path, self.openIn(cache)); }));
      self.registerEvent(self.app.vault.on("delete", function (f) { if (f.path) self.setTaskCount(f.path, 0); }));
      self.registerEvent(self.app.vault.on("rename", function (f, old) {
        var n = self.taskCounts.get(old) || 0; self.setTaskCount(old, 0); self.setTaskCount(f.path, n);
      }));
      // BRDG: a daily note edited, added or removed refreshes the age.
      ["modify", "create", "delete"].forEach(function (ev) {
        self.registerEvent(self.app.vault.on(ev, function (f) { if (self.inDaily(f.path)) self.loadBridge(); }));
      });
      // One clock for every banner copy.
      self.registerInterval(window.setInterval(function () { self.tick(); }, 1000));
      self.registerInterval(window.setInterval(function () { self.loadBridge(); }, 60000));
      self.readDocks(); self.readNote(); self.loadBridge(); self.readTasks();
      self.tick();
      self.checkSchedules(true);
      self.registerInterval(window.setInterval(function () { self.checkSchedules(false); }, 20000));
    });
  }

  // Title blocks and ribbon roles follow their switches on General.
  applyInterface() {
    var s = this.settings;
    if (s.titleBlocks && !this._stopTitles) this._stopTitles = startTitleBlocks();
    else if (!s.titleBlocks && this._stopTitles) { this._stopTitles(); this._stopTitles = null; }
    if (s.ribbonRoles && !this._stopRibbon) this._stopRibbon = startRibbonRoles(this);
    else if (!s.ribbonRoles && this._stopRibbon) { this._stopRibbon(); this._stopRibbon = null; }
  }

  onunload() {
    if (this._stopTitles) this._stopTitles();
    if (this._stopRibbon) this._stopRibbon();
    this.raised.forEach(function (r) { window.clearTimeout(r.timer); });
    this.unmountAll();
    if (this._headStyle) this._headStyle.remove();
    if (this._condStyle) this._condStyle.remove();
    document.body.classList.remove("lcars-idle", "lcars-busy", "lcars-copilot-open", "lcars-gray", "lcars-plugin-motion-off", "lcars-nn-recent-listed");
    document.body.style.removeProperty("--lcars-row");
    ["label", "readout", "top", "bottom", "pip"].forEach(function (k) { document.body.style.removeProperty("--lcars-pane-" + k); });
    ["max", "min"].forEach(function (k) { document.body.style.removeProperty("--lcars-light-" + k); });
    if (document.fonts && this._fontsRefit) document.fonts.removeEventListener("loadingdone", this._fontsRefit);
    if (this._rowObs) this._rowObs.disconnect();
    if (this._smObs) this._smObs.disconnect();
    if (this._smHead) this._smHead.disconnect();
    window.clearTimeout(this._smTimer);
    if (window.lcarsActivity && window.lcarsActivity._owner === this) delete window.lcarsActivity;
    if (window.lcarsCompanion && window.lcarsCompanion.plugin === this) {
      delete window.lcarsCompanion; delete window.lcarsStardate; delete window.lcarsStardateString;
      window.dispatchEvent(new Event("lcars-companion-gone"));
    }
  }

  // Flags for lcars-frame.css. body.lcars-copilot-open: Copilot is the
  // showing view in the right sidebar (§43's line under the reading pane).
  // --lcars-row on body: Notebook Navigator's item height minus 4px (§32),
  // re-read whenever Notebook Navigator rewrites that setting.
  // body.lcars-plugin-motion-off is this plugin's own motion switch. The
  // Style Manager switch is body.lcars-motion-off; styles.css honors both.
  applyMotion() {
    var on = !!this.settings.motionOff;
    if (document.body.classList.contains("lcars-plugin-motion-off") !== on) document.body.classList.toggle("lcars-plugin-motion-off", on);
  }

  syncFrame() {
    var ws = this.app.workspace;
    var open = !ws.rightSplit.collapsed && ws.getLeavesOfType("copilot-agent-chat-view").some(function (l) {
      return l.getRoot() === ws.rightSplit && l.view.containerEl.offsetParent !== null;
    });
    if (document.body.classList.contains("lcars-copilot-open") !== open) document.body.classList.toggle("lcars-copilot-open", open);
    // Notebook Navigator with Shortcuts pinned but Recent files in the scrolling list: the
    // list gets an 8px spacer after Recent files that the theme must pull the rows up over.
    // Read from NN's settings rather than from the rows, which come and go as the list scrolls.
    var nnp = this.app.plugins && this.app.plugins.plugins && this.app.plugins.plugins["notebook-navigator"];
    var nns = nnp && nnp.settings;
    var listed = !!(nns && nns.showRecentNotes && !nns.pinRecentNotesWithShortcuts && document.querySelector(".mod-left-split .nn-shortcut-pinned-scroll"));
    if (document.body.classList.contains("lcars-nn-recent-listed") !== listed) document.body.classList.toggle("lcars-nn-recent-listed", listed);
    var host = document.querySelector(".notebook-navigator .nn-split-container");
    if (host !== this._rowHost) {
      if (this._rowObs) this._rowObs.disconnect();
      this._rowHost = host;
      if (host) {
        var self = this;
        this._rowObs = new MutationObserver(function () { self.readRow(); });
        this._rowObs.observe(host, { attributes: true, attributeFilter: ["style"] });
      }
    }
    this.readRow();
    this.paneReadout();
  }

  // Right-sidebar bracket labels for lcars-frame.css §43: the showing pane's
  // name, a live count for it, and its colors, written as CSS variables on
  // body. Runs on layout/leaf changes and every few seconds (git status and
  // Copilot's session count have no event).
  paneReadout() {
    var app = this.app, ws = app.workspace, rs = ws.rightSplit, st = document.body.style;
    var leaf = null;
    if (rs && !rs.collapsed) {
      ws.iterateAllLeaves(function (l) {
        if (!leaf && l.getRoot() === rs && l.view && l.view.containerEl && l.view.containerEl.offsetParent !== null) leaf = l;
      });
    }
    if (!leaf) return;
    var type = leaf.view.getViewType(), file = ws.getActiveFile(), cache = file && app.metadataCache.getFileCache(file) || {};
    var BLUE = "#37A6D1", MDB = "#2A7193";
    var P = {
      "backlink": ["BACKLINKS", "#37A6D1", "#2A7193"],
      "outgoing-link": ["OUTGOING LINKS", "#41C4F7", "#37A6D1"],
      "outline": ["OUTLINE", "#2A7193", "#1C3C55"],
      "all-properties": ["PROPERTIES", "#9EA5BA", "#6D748C"],
      "file-properties": ["FILE PROPERTIES", "#9EA5BA", "#6D748C"],
      "localgraph": ["LOCAL GRAPH", "#41C4F7", "#2A7193"],
      "tag": ["TAGS", "#6D748C", "#52596E"],
      "git-view": ["SOURCE CONTROL", "#37A6D1", "#2A7193"],
      "copilot-agent-chat-view": ["ACTIVE CHAT", "#37A6D1", "#2A7193"]
    };
    var p = P[type] || [String(leaf.getDisplayText() || type).toUpperCase(), BLUE, MDB];
    var readout = "ONLINE", pip = "#FF977B";
    try {
      var n = null, unit = "";
      if (type === "backlink" && file) {
        var bl = app.metadataCache.getBacklinksForFile(file), d = bl && bl.data;
        n = d ? (d.size != null ? d.size : Object.keys(d).length) : 0; unit = "BACKLINKS";
      } else if (type === "outgoing-link") { n = (cache.links || []).length; unit = "LINKS"; }
      else if (type === "outline") { n = (cache.headings || []).length; unit = "HEADINGS"; }
      else if (type === "tag") { n = Object.keys(app.metadataCache.getTags() || {}).length; unit = "TAGS"; }
      else if (type === "file-properties") {
        n = Object.keys(cache.frontmatter || {}).filter(function (k) { return k !== "position"; }).length; unit = "FIELDS";
      } else if (type === "all-properties") {
        var info = app.metadataCache.getAllPropertyInfos && app.metadataCache.getAllPropertyInfos();
        n = info ? Object.keys(info).length : null; unit = "PROPERTIES";
      } else if (type === "git-view") {
        var g = app.plugins && app.plugins.plugins && app.plugins.plugins["obsidian-git"], gs = g && g.cachedStatus;
        n = gs ? (gs.changed || []).length + (gs.staged || []).length : null; unit = "CHANGES";
        if (n === 0) pip = p[1];
      } else if (type === "copilot-agent-chat-view") {
        n = leaf.view.containerEl.querySelectorAll('[role="tab"]').length; unit = "SESSIONS";
      }
      if (n != null) readout = n + " " + unit;
    } catch (e) { /* a readout is decoration; never let it throw */ }
    var set = function (k, v) { if (st.getPropertyValue(k) !== v) st.setProperty(k, v); };
    set("--lcars-pane-label", JSON.stringify(p[0]));
    set("--lcars-pane-readout", JSON.stringify(readout));
    set("--lcars-pane-top", p[1]);
    set("--lcars-pane-bottom", p[2]);
    set("--lcars-pane-pip", pip);
  }

  readRow() {
    var h = this._rowHost && parseFloat(this._rowHost.style.getPropertyValue("--nn-setting-nav-item-height"));
    var row = h >= 20 && h <= 48 ? (h - 4) + "px" : "";
    if (document.body.style.getPropertyValue("--lcars-row") === row) return;
    if (row) document.body.style.setProperty("--lcars-row", row);
    else document.body.style.removeProperty("--lcars-row");
  }

  // Settings text fields save on every keystroke; the disk write and the
  // banner rebuild wait until typing pauses for a quarter second.
  save() {
    var self = this;
    return new Promise(function (done) {
      (self._saveWaiters = self._saveWaiters || []).push(done);
      window.clearTimeout(self._saveTimer);
      self._saveTimer = window.setTimeout(async function () {
        await self.saveData(self.settings);
        self.applyMotion();
        self.unmountAll();
        self.mountAll();
        self.startStandby();
        self.rebuildPreviews();
        self.condStyle();
        self.paintDemos();
        if (self.hooks && self.hooks.onSave) self.hooks.onSave.call(self);
        self.tick();
        var w = self._saveWaiters; self._saveWaiters = [];
        w.forEach(function (f) { f(); });
      }, 250);
    });
  }

  /* ── Mounting ─────────────────────────────────────────────────── */

  // One banner on top of every left sidebar tab group, above the
  // pane headers and outside any view's own scroller (2026-10-06).
  mountPoints() {
    var out = [];
    if (this.settings.showInSidebar && this.settings.spanRibbon) {
      var rb = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary)");
      if (rb && rb.parentElement) out.push(rb.parentElement);
    } else if (this.settings.showInSidebar) {
      document.querySelectorAll(".workspace-split.mod-left-split .workspace-tabs > .workspace-tab-container")
        .forEach(function (c) { out.push(c); });
    }
    return out;
  }

  mountAll() {
    var self = this;
    this.mountPoints().forEach(function (parent) {
      var first = parent.firstElementChild;
      if (first && first.classList.contains(HOST)) return;
      parent.querySelectorAll(":scope > ." + HOST).forEach(function (h) { self.dropHost(h); });
      var host = self.build();
      var corner = !!parent.querySelector(":scope > .workspace-ribbon:is(.mod-left, .mod-primary)");
      parent.classList.add(corner ? "lcars-bh-corner" : "lcars-bh-parent");
      host.classList.toggle("is-corner", corner);
      parent.insertBefore(host, parent.firstChild);
      self.hosts.add(host);
      self.watch(host, parent);
      self.paintHost(host, new Date());
      self.fit(host);
    });
  }

  watch(host, parent) {
    var self = this, lastW = -1;
    var ro = new ResizeObserver(function () {
      if (host.clientWidth === lastW) return;
      lastW = host.clientWidth;
      self.fit(host);
    });
    ro.observe(host);
    if (host.classList.contains("is-corner")) {
      var again = function () {
        window.cancelAnimationFrame(host._cornerRaf);
        host._cornerRaf = window.requestAnimationFrame(function () { self.fit(host); });
      };
      var cro = new ResizeObserver(again);
      parent.querySelectorAll(":scope > .workspace-ribbon:is(.mod-left, .mod-primary), :scope > .workspace-split.mod-left-split").forEach(function (n) { cro.observe(n); });
      host._lcarsObs = [cro];
    }
    // Work only for banners on screen: a collapsed sidebar or a hidden
    // pane pauses painting and animation for that copy.
    var io = new IntersectionObserver(function (entries) {
      var vis = entries[entries.length - 1].isIntersecting;
      if (host._vis === vis) return;
      host._vis = vis;
      host.classList.toggle("is-offscreen", !vis);
      if (vis) { self.readChannels(); self.paintHost(host, new Date()); }
    });
    io.observe(host);
    // Views re-render their lists; put the banner back if it is removed.
    var mo = new MutationObserver(function () {
      if (!host.isConnected || parent.firstElementChild !== host) { self.dropHost(host); self.mountAll(); }
    });
    mo.observe(parent, { childList: true });
    host._lcarsObs = (host._lcarsObs || []).concat([ro, mo, io]);
  }

  dropHost(host) {
    (host._lcarsObs || []).forEach(function (o) { o.disconnect(); });
    if (host._lcarsMd) host._lcarsMd.unload();
    host.remove();
    this.hosts.delete(host);
  }

  unmountAll() {
    var self = this;
    Array.from(this.hosts).forEach(function (h) { self.dropHost(h); });
    document.querySelectorAll("." + HOST).forEach(function (h) { h.remove(); });
    document.querySelectorAll(".lcars-bh-parent, .lcars-bh-corner").forEach(function (p) { p.classList.remove("lcars-bh-parent", "lcars-bh-corner"); });
    document.body.style.removeProperty("--lcars-bh-h");
    document.body.style.removeProperty("--lcars-ribbon-nudge");
    document.querySelectorAll(".nn-navigation-pane-scroller").forEach(function (sc) {
      if (sc._lcarsRo) { sc._lcarsRo.disconnect(); sc._lcarsRo = null; }
      sc.classList.remove("lcars-overflow");
    });
  }

  /* ── Building the banner from settings ────────────────────────── */

  build() {
    var s = this.settings, self = this;
    var outer = createDiv({ cls: HOST + (s.allCaps ? "" : " is-nocaps") });
    // Padding lives on an inner box: Notebook Navigator strips padding
    // from the scroller's direct children, which dropped the side
    // padding and the grid offset (2026-10-05).
    var host = outer.createDiv({ cls: "lcars-bh-inner" });
    var rows = host.createDiv({ cls: "lcars-bh-rows" });

    // Always shown, read from manifest.json so it follows each release, and a link to the repo.
    // Anyone who wants it gone can hide .lcars-bh-version in a CSS snippet.
    rows.createDiv({ cls: "lcars-bh-row lcars-bh-version" }).createEl("a", {
      cls: "lcars-bh-version-link", text: "LCARS v" + this.manifest.version,
      attr: { href: REPO_URL, target: "_blank", rel: "noopener" },
    });

    var ship = rows.createDiv({ cls: "lcars-bh-row", attr: { "data-lcars-fit": "", "data-fit-max": "64" } });
    ship.createSpan({ cls: "lcars-bh-name", text: s.shipName });
    if (s.shipName && s.shipRegistry) ship.createSpan({ cls: "lcars-bh-dot", text: "•" });
    ship.createSpan({ cls: "lcars-bh-registry", text: s.shipRegistry });

    if (s.showStardate || s.showCondition) {
      var row3 = rows.createDiv({
        cls: "lcars-bh-row",
        attr: { "data-lcars-fit": "", "data-fit-fill": "0.82", "data-fit-min": "9", "data-fit-max": "15" },
      });
      if (s.showStardate) {
        var sd = row3.createSpan({ cls: "lcars-sd lcars-bh-dim" });
        sd.appendText("STARDATE: ");
        sd.createSpan({ cls: "lcars-bh-value lcars-bh-stardate", text: "—" });
        if (s.timeMode !== "none") {
          sd.appendText(" - ");
          sd.createSpan({ cls: "lcars-bh-dim lcars-bh-clock", text: "0000" });
        }
      } else {
        row3.createSpan();
      }
      if (s.showCondition) {
        var cond = row3.createSpan({
          cls: "lcars-bh-cond lcars-bh-dim lcars-condition",
          attr: { role: "button", tabindex: "0", "aria-pressed": "false", title: "CONDITION opens the status menu. The status itself toggles red alert." },
        });
        cond.appendChild(svgNode(ICON));
        cond.appendText("CONDITION: ");
        // fit() sizes the row for the longest label, so the font stays put
        // when the condition changes; the row itself takes only the room the
        // current label needs.
        cond.dataset.longest = s.alerts.statuses.reduce(function (a, x) { return String(x.label).length > a.length ? String(x.label) : a; }, "");
        var val = cond.createSpan({ cls: "lcars-bh-value lcars-bh-condval" });
        val.createSpan({ cls: "lcars-bh-condtext", text: "NOMINAL" });
        var press = function (e) {
          e.preventDefault(); e.stopPropagation();
          var onValue = e.type === "click" && e.target && e.target.closest && e.target.closest(".lcars-bh-condval");
          if (onValue) self.pickToggle("red");
          else self.statusMenu(e);
        };
        cond.addEventListener("click", press);
        cond.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") press(e); });
      }
    }

    var embedOn = s.embedPosition !== "off" && s.embedMarkdown.trim();
    var statusOn = s.showStatus && s.embedPosition !== "replace";
    if (embedOn && s.embedPosition === "above") this.buildEmbed(host);
    if (statusOn) this.buildStatus(host);
    if (embedOn && s.embedPosition !== "above") this.buildEmbed(host);
    if (this.settings.lights.enabled !== false) this.buildLights(host);
    else this.lightVars();
    return outer;
  }

  buildStatus(host) {
    var box = host.createDiv({ cls: "lcars-subsys", attr: { role: "group", "aria-label": "Ship subsystems" } });
    this.fillStatus(box, "");
  }

  // The rows of the ship status block: the channels, or while a state shows
  // (set = its id) that state's tactical meters.
  fillStatus(box, set) {
    box.empty();
    box._set = set;
    var rows = set && TACTICAL[set];
    if (rows) {
      rows.forEach(function (r) {
        var row = box.createDiv({ cls: "lcars-subsys-row is-tactical", attr: { "data-fx": r[4] } });
        if (!r[3]) row.setAttribute("data-off", "");
        row.createSpan({ cls: "lcars-subsys-label", text: r[1] });
        var bar = row.createSpan({ cls: "lcars-subsys-bar", attr: { "aria-hidden": "true" } });
        bar.createSpan({ cls: "lcars-subsys-fill" }).style.setProperty("--lcars-subsys-pct", Math.round(r[3] * 100) + "%");
        row.createSpan({ cls: "lcars-subsys-val", text: r[2] });
      });
      return;
    }
    var on = this.settings.channels;
    CHANNELS.forEach(function (c) {
      if (!on[c[0]]) return;
      var row = box.createDiv({ cls: "lcars-subsys-row" });
      row.dataset.ch = c[0];
      row.createSpan({ cls: "lcars-subsys-label", text: c[1] });
      var bar = row.createSpan({ cls: "lcars-subsys-bar", attr: { "aria-hidden": "true" } });
      bar.createSpan({ cls: "lcars-subsys-fill" });
      row.createSpan({ cls: "lcars-subsys-val" });
    });
  }

  buildEmbed(host) {
    var el = host.createDiv({ cls: "lcars-bh-embed" });
    var comp = new obsidian.Component();
    comp.load();
    host.parentElement._lcarsMd = comp;
    var file = this.app.workspace.getActiveFile();
    var self = this;
    obsidian.MarkdownRenderer.render(this.app, this.settings.embedMarkdown, el, file ? file.path : "/", comp)
      .then(function () { self.fit(host.parentElement); });
  }

  // The lights settings for a phase. A hook can lay per-phase overrides on top.
  eff(phase) {
    var h = this.hooks && this.hooks.eff;
    return h ? h.call(this, phase) : Object.assign({}, this.settings.lights);
  }

  // The event bar's layout and look over a state's look. m.layout = { rows }, m.look = { rest, restSpeed, ... }.
  barLook(lk, m) {
    var o = m && m.look, lay = m && m.layout;
    if (!o && !lay) return lk;
    var r = Object.assign({}, lk);
    if (o) Object.keys(o).forEach(function (k) { if (LOOK_KEYS.indexOf(k) >= 0 && o[k] !== undefined && o[k] !== "") r[k] = o[k]; });
    if (lay && Number(lay.rows) >= 1) r.cascadeRows = Math.min(5, Math.round(Number(lay.rows)));
    return r;
  }

  // look: a state's light look (see look()). A banner row uses the showing
  // state's; an inline preview is given the state it previews.
  buildLights(host, kind, look) {
    var self = this, phase = kind || (this.lt ? (this.lt.progress ? "rest" : this.lt.phase) : "rest");
    var L = this.eff(phase === "std" ? "none" : phase);
    if (!look && !kind) look = this._curLook;
    if (look) { L = Object.assign({}, L); LOOK_KEYS.forEach(function (k) { L[k] = look[k]; }); if (look.cascadeRows) L.cascadeRows = look.cascadeRows; }
    if (kind) { L = Object.assign({}, L, { restBeh: "constant" }); } // a settings preview always plays
    var n = this.segCount(L);
    var twoBars = Number(L.rows) === 2 && L.fill === "twotone";
    // At rest, any style can take 2 or 3 rows of smaller dots; the module grows to fit.
    var cRows = L.rest !== "off" ? Math.max(1, Math.min(5, Math.round(Number(L.cascadeRows) || 1))) : 1;
    var showLabel = this.hooks && this.hooks.showLabel && this.hooks.showLabel.call(this, kind);
    var labelPos = showLabel ? (L.labelPos || "right") : "hidden";
    var box = host.createDiv({
      cls: "lcars-lt",
      attr: {
        "data-phase": phase, "data-rest": L.rest, "data-rowh": L.rowsHeight === "fixed" ? "fixed" : "auto", "data-busy": BUSY[L.restBusy] ? L.restBusy : "", "data-shape": L.shape, "data-form": L.form || "", "data-fill": L.fill || "gradient", "data-align": L.align, "data-label": labelPos,
        "data-caps": L.caps, "data-motion": L.motion || "none", "data-final": L.finalMode || "off", "data-click": L.click || "none",
        "data-fx-off": Object.keys(L.fx).filter(function (k) { return !L.fx[k]; }).join(" "), "aria-label": "Lights",
      },
    });
    box._kind = kind || "";
    var st = box.style;
    st.setProperty("--lt-width", L.align === "full" ? "100%" : Math.max(10, Math.min(100, Number(L.width) || 80)) + "%");
    st.setProperty("--lt-gap", (L.shape === "B" ? 0 : Math.max(0, Math.min(L.form === "circle" ? 12 : 4, Number(L.gap) || 0))) + "px");
    st.setProperty("--lt-n", String(n));
    if (cRows > 1) st.setProperty("--lt-rows", String(cRows));
    this.lookVars(box, L);
    // The right-sidebar brackets (lcars-frame.css §43) follow the same
    // brightness range, so the Nominal glow and peak drive them too. A state's
    // own look or a preview never moves them.
    if (!look && !kind) {
      var rMax = Math.max(5, Math.min(100, Number(L.restBrightness) || 70)) / 100;
      document.body.style.setProperty("--lcars-light-max", String(rMax));
      document.body.style.setProperty("--lcars-light-min", String(Math.min(rMax, Math.max(0, Number(L.restMin) || 0) / 100)));
    }
    var busy = BUSY[L.restBusy] ? L.restBusy : "";
    var cn = busy ? BUSY[busy][0] : L.restConcentration === "" || L.restConcentration == null || !isFinite(Number(L.restConcentration)) ? 50 : Number(L.restConcentration);
    var conc = Math.max(0, Math.min(100, cn)) / 100;
    box._skey = this.lookKey(L);
    var extraVars = this.hooks && this.hooks.colorVars ? this.hooks.colorVars() : [];
    COLOR_VARS.concat(extraVars).forEach(function (c) { if (LOOK_KEYS.indexOf(c[1]) >= 0) return; var dflt = c[2] !== undefined ? c[2] : LIGHTS[c[1]]; if (L[c[1]]) st.setProperty(c[0], L[c[1]]); else if (dflt) st.setProperty(c[0], dflt); });
    st.setProperty("--lt-label-max", Math.max(20, Math.min(100, Number(L.labelMax) || 70)) + "%");
    st.setProperty("--lt-label-size", Math.max(40, Math.min(300, Number(L.labelSize) || 100)) / 100 + "");
    this.headStyle(n);
    var main = box.createDiv({ cls: "lcars-lt-main" });
    var bars = main.createDiv({ cls: "lcars-lt-bars", attr: { "aria-hidden": "true" } });
    // Data cascade flow: each line shares one run of flicker and the run is shifted along the
    // line, so the flicker looks like it travels. Up and down need more than one row.
    var flow = L.rest === "cascade" && phase === "rest" ? String(L.restFlow || "") : "";
    if ((flow === "up" || flow === "down") && cRows < 2) flow = "";
    if (["right", "left", "up", "down"].indexOf(flow) < 0) flow = "";
    var vert = flow === "up" || flow === "down", rowSeed = [], colSeed = [];
    for (var q0 = 0; q0 < 5; q0++) rowSeed.push(Math.random());
    for (var q1 = 0; q1 < n; q1++) colSeed.push(Math.random());
    if (flow) box.setAttribute("data-flow", flow);
    for (var r = 0; r < (cRows > 1 ? cRows : twoBars ? 2 : 1); r++) {
      var bar = bars.createDiv({ cls: "lcars-lt-bar" });
      for (var i = 0; i < n; i++) {
        var sg = bar.createSpan({ cls: "lcars-lt-seg" });
        // Fixed per segment: position for the resting sweep, random for the cascade.
        sg.style.setProperty("--i", String(i));
        sg.style.setProperty("--row", String(r));
        sg.style.setProperty("--d", String(Math.min(i, n - 1 - i)));
        var rnd = Math.random();
        sg.style.setProperty("--r", rnd.toFixed(3));
        // With a flow, a share of the dots ignore it and flicker at random meanwhile.
        var free = flow && Math.random() < ({ low: 0.2, mid: 0.4, high: 0.6 }[L.restMix] || 0);
        sg.dataset.c = String(flow && !free ? (vert ? i : r) % 4 : Math.floor(Math.random() * 4)); // which of the four cascade runs this one follows
        if (free) sg.classList.add("is-free");
        if (flow && !free) {
          sg.style.setProperty("--ph", (vert ? colSeed[i] : rowSeed[r]).toFixed(3));
          sg.style.setProperty("--pos", String(flow === "right" ? i : flow === "left" ? n - 1 - i : flow === "down" ? r : cRows - 1 - r));
        }
        // Concentration: this share of segments take part in the cascade.
        if (rnd < conc || free) sg.classList.add("is-rest-on");
        // Resting color mix: one color, a random pick of two, or a gradient.
        sg.style.setProperty("--rm", L.restColorMode === "random" ? String(Math.round(Math.random()))
          : L.restColorMode === "gradient" ? (i / (n - 1 || 1)).toFixed(3) : "0");
      }
    }
    if (labelPos !== "hidden") main.createSpan({ cls: "lcars-lt-label" });
    // A click can ripple (Data cascade at rest), run the click action the ticker sets, both, or neither.
    var action = !kind && this.hooks && this.hooks.click && L.click && L.click !== "none";
    box.addEventListener("click", function (e) {
      if (action) { e.preventDefault(); self.clickLights(); }
      self.ripple(box, e);
    });
  }

  // A state's light look: its own values over Nominal's (the Lights settings).
  // An empty value means "same as Nominal". Nominal itself uses the settings.
  look(st) {
    var o = Object.assign({}, this.settings.lights);
    if (st && st.id !== "green") {
      // A tinted state's lights start in its own color; its own settings come next.
      if (st.lightTint !== false && st.color) { o.restColorMode = "single"; o.colorRest = st.color; o.colorRest2 = st.color; }
      // Its own settings count while Custom config is on (or was never turned off).
      if (st.customConfig !== false) LOOK_KEYS.forEach(function (k) {
        var v = st[k]; if (v !== undefined && v !== null && v !== "") o[k] = v;
      });
    }
    // Chase, Comet and Scanner come with a white head. "none" turns the separate light off.
    if (o.light === "none") o.light = "";
    else if (!o.light && WHITE_HEAD.indexOf(o.rest) >= 0) o.light = "var(--lcars-bh-text, #F3F4F7)";
    return o;
  }

  // The part of a look that is fixed when the row is built (color mode, which
  // segments take part in the cascade, whether there is a moving light).
  lookKey(L) { return [L.rest, L.restColorMode, L.restConcentration, L.restBusy, L.light ? 1 : 0, L.rest !== "off" ? L.cascadeRows + "/" + L.rowsHeight + "/" + (L.rest === "cascade" ? L.restFlow + (L.restMix || "") : "") : "", L.form].join("|"); }

  // The colors, brightness and speed of a look, as variables on a lights row.
  lookVars(box, L) {
    var st = box.style, put = function (k, v) { if (st.getPropertyValue(k) !== v) st.setProperty(k, v); };
    var rMax = Math.max(5, Math.min(100, Number(L.restBrightness) || 70)) / 100;
    var rMin = Math.min(rMax, Math.max(0, Number(L.restMin) || 0) / 100);
    put("--lt-rest-b", String(rMax));
    // With a moving light, the resting glow lights the base and the light starts from nothing.
    if (L.light) { put("--lt-rest-min", "0"); put("--lt-glow", String(rMin)); }
    else { put("--lt-rest-min", String(rMin)); st.removeProperty("--lt-glow"); }
    var speed = Math.max(0.25, Math.min(4, Number(L.restSpeed) || 1));
    put("--lt-rest-speed", String(speed));

    // Style, direction and behavior.
    var dz = DESIGN[L.rest] || {}, n = Number(st.getPropertyValue("--lt-n")) || 16;
    var dir = dz.dir ? (RESTS_DIR[L.restDir] ? L.restDir : dz.dir) : "";
    var beh = RESTS_BEH[L.restBeh] ? L.restBeh : "constant";
    setAttr(box, "data-rest", L.rest); setAttr(box, "data-dir", dir); setAttr(box, "data-beh", beh);
    // The path: the whole row, or half of it when the lights go out from or in to the middle.
    var S = dir === "out" || dir === "in" ? n / 2 : n;
    var cnt = Math.max(1, Math.min(4, Math.round(Number(L.restCount)) || 1));
    // Rings and waves repeat along the path; a light or a band makes one trip.
    var repeats = L.rest === "pulses" || L.rest === "warp";
    var P = repeats ? S / cnt : S;
    put("--lt-S", S.toFixed(2)); put("--lt-P", P.toFixed(2)); put("--lt-sps", String(dz.sps || 0.1));
    // Tail or band length, in segments.
    var pct = Number(L.restLength) > 0 ? Number(L.restLength) : (dz.len || 12);
    var len = Math.max(L.rest === "scanner" ? 2.5 : 1, Math.min(n, pct / 100 * n));
    // Rings must leave a gap between them: each is no wider than a bit under half its slot.
    if (L.rest === "pulses") len = Math.max(1, Math.min(len, P * 0.45));
    put("--lt-len", len.toFixed(2));
    // The calendar bar uses the same colors: Color 1 to Color 2 for the lit part, the Light color (white if none) for the head.
    put("--lt-bar-g0", L.colorRest || LIGHTS.colorRest);
    put("--lt-bar-g1", L.restColorMode === "single" ? (L.colorRest || LIGHTS.colorRest) : (L.colorRest2 || LIGHTS.colorRest2));
    put("--lt-bar-head", L.light || "var(--lcars-bh-text, #F3F4F7)");
    // A group of lights follows the first at an even gap.
    var spPct = Number(L.restSpacing), sp = spPct > 0 ? spPct / 100 * n : len + 1.5;
    if (cnt > 1) sp = Math.min(sp, (S - 1) / (cnt - 1));
    put("--lt-sp", sp.toFixed(2));
    setAttr(box, "data-grp", !repeats && cnt > 1 && (L.rest === "chase" || L.rest === "comet") ? "multi" : "");
    for (var w = 1; w <= 3; w++) put("--lt-w" + w, !repeats && cnt > w ? "1" : "0");

    // When a one-shot behavior plays, and for how long.
    var trip = dir === "bounce" ? 2 * (n - 1) * (dz.sps || 0.1) : P * (dz.sps || 0.1);
    box._beh = beh;
    box._interval = Math.max(2, Number(L.restInterval) || 30);
    box._playMs = Math.round((dz.dir ? trip / speed * 1000 : L.rest === "heartbeat" ? 12000 / speed : L.rest === "breathe" ? 18000 / speed : 8000 / speed) + 400);

    LOOK_KEYS.forEach(function (k) {
      var c = COLOR_VARS.filter(function (x) { return x[1] === k; })[0];
      if (!c) return;
      var v = L[k] || LIGHTS[k];
      if (v) put(c[0], v); else st.removeProperty(c[0]);
    });
    if (box.hasAttribute("data-light") !== !!L.light) box.toggleAttribute("data-light", !!L.light);
  }

  // Play a one-shot behavior now (wake and interval). A row at rest between plays sits at the resting glow.
  playRow(box) {
    window.clearTimeout(box._pt);
    box.classList.remove("is-play"); void box.offsetWidth; box.classList.add("is-play");
    box._pt = window.setTimeout(function () { box.classList.remove("is-play"); }, box._playMs || 5000);
    box._lastPlay = Date.now();
  }

  // The right-sidebar brackets follow the lights' brightness range even when
  // the row is hidden, so the two body properties are written here too.
  lightVars() {
    var L = this.settings.lights;
    var rMax = Math.max(5, Math.min(100, Number(L.restBrightness) || 70)) / 100;
    document.body.style.setProperty("--lcars-light-max", String(rMax));
    document.body.style.setProperty("--lcars-light-min", String(Math.min(rMax, Math.max(0, Number(L.restMin) || 0) / 100)));
  }

  // The chaser keyframes depend on its length, so they are written once
  // per settings change into one shared style tag.
  headStyle(n) {
    var L = this.settings.lights, len = Math.max(1, Math.min(n, Math.round(Number(L.chaseLength) || 3)));
    var hold = (100 / n).toFixed(2), fade = Math.min(100, (100 * len) / n).toFixed(2);
    var css = "@keyframes lcars-lt-head { 0%, " + hold + "% { opacity: 1; } " + fade + "%, 100% { opacity: 0; } }";
    if (!this._headStyle) { this._headStyle = document.head.createEl("style"); this._headStyle.id = "lcars-lt-head"; }
    if (this._headStyle.textContent !== css) this._headStyle.textContent = css;
  }

  paintTag(tag) {
    var phase = this.lt ? this.lt.phase : "rest", on = tag.dataset.phase.split(" ").indexOf(phase) >= 0;
    setText(tag, this.previewSince ? "PREVIEW" : "CURRENT");
    if (tag.classList.contains("is-preview") !== !!this.previewSince) tag.classList.toggle("is-preview", !!this.previewSince);
    if (tag.hidden === on) tag.hidden = !on;
  }

  // The parts of a settings preview: the situation's model, the status being previewed, and the event bar for it.
  previewParts(kind, stateId, now) {
    var m = this.lightsModel(now, kind), st = this.statusById(stateId || "green"), bar = null, ovr = !!(st && st.overrideBar);
    if (ovr) m = Object.assign({}, m, { progress: { share: 1, anchor: "left", dim: 1 }, layout: null, look: null, speed: 1 });
    else if (st && this.hooks && this.hooks.eventBar) {
      bar = this.hooks.eventBar.call(this, st, m);
      if (bar) m = Object.assign({}, m, bar);
    }
    return { m: m, st: st, bar: bar, ovr: ovr };
  }
  previewModel(kind, stateId, now) { return this.previewParts(kind, stateId, now).m; }

  // Why the lights look as they do: each value, and the layer it came from. cs is the status showing, m0 the
  // calendar's model before the event bar, bar the event bar's answer for that status (or null), ovr whether
  // the status overrides the bar. The layers, lowest first: the Running lights default, the status, the event bar.
  explain(cs, m0, bar, ovr) {
    var self = this, nom = cs.id === "green", lk = this.look(cs), out = [];
    if (!ovr && bar) lk = this.barLook(lk, bar);
    var has = function (v) { return v !== undefined && v !== null && v !== ""; };
    var why = bar && bar.why ? bar.why : { src: "", set: [] }, set = function (k) { return why.set.indexOf(k) >= 0; };
    var styleName = function (r) { return String(RESTS[r] || r).split(":")[0]; };
    var cal = !!(m0 && m0.calc);
    var sit = cal ? (ALERT_PHASES.filter(function (x) { return x[0] === m0.situation; })[0] || [m0.situation, m0.situation])[1].split(":")[0].split(",")[0] : "";
    var push = function (label, value, from) { out.push({ label: label, value: value, from: from }); };
    // Which status, and why it is showing.
    var by = this.raised.has(cs.id) ? "raised by hand" : nom ? "nothing else applies" : cal && m0.alert && m0.alert.phase !== "rest" ? "triggered by " + sit.toLowerCase() : "raised";
    push("Status", cs.label, by);
    push("Event bar", ovr ? "ignored" : bar ? sit : cal ? "defaults" : "none", ovr ? "this status overrides the event bar" : bar ? (why.set.length ? why.src : "defaults; none set for " + cs.label) : cal ? "no settings for this status in this situation" : "no calendar");
    push("Colors", nom || cs.lightTint === false ? "the resting colors" : "the status color", nom || cs.lightTint === false ? "Running lights, Look of" : cs.label);
    var layer = function (k, barSet, statusVal) {
      return barSet && !ovr ? "event bar (" + why.src + ")" : (!nom && cs.customConfig !== false && has(statusVal)) ? "status " + cs.label : "Running lights default";
    };
    push("Light style", styleName(lk.rest), layer("rest", !!(bar && bar.look && has(bar.look.rest)), cs.rest));
    var dir = lk.restDir || (DESIGN[lk.rest] || {}).dir;
    if (dir) push("Direction", RESTS_DIR[dir] || dir, layer("restDir", !!(bar && bar.look && has(bar.look.restDir)), cs.restDir));
    var baseSpeed = Number(lk.restSpeed) || 1, calSpeed = ovr ? 1 : bar && bar.speed ? bar.speed : (m0 && m0.speed) || 1;
    push("Speed", baseSpeed + (calSpeed !== 1 ? " × " + calSpeed : ""), ((bar && bar.look && has(bar.look.restSpeed) && !ovr) ? "event bar (" + why.src + ")" : (!nom && cs.customConfig !== false && has(cs.restSpeed)) ? "status " + cs.label : "Running lights default") + (calSpeed !== 1 ? "; × " + calSpeed + " from " + (set("speed") ? "event bar (" + why.src + ")" : "the calendar speed-up default") : ""));
    push("Rows", String(lk.cascadeRows || 1), bar && bar.layout && !ovr ? "event bar (" + why.src + ")" : (!nom && cs.customConfig !== false && has(cs.cascadeRows)) ? "status " + cs.label : "Layout default");
    if (cal && m0.progress) {
      if (ovr) push("Progress", "none", "this status overrides the event bar");
      else {
        var pg = (bar && bar.progress) || m0.progress, from = { left: "left", right: "right", center: "the middle", edges: "the edges", top: "the top row", bottom: "the bottom row" }[pg.anchor] || pg.anchor;
        var usedBar = set("progress") || set("from") || set("region") || set("dim");
        push("Progress", Math.round(pg.share * 100) + "% lit from " + from + (pg.rows && pg.rows !== "all" ? ", " + pg.rows + " row only" : "") + ", unlit at " + Math.round(pg.dim * 100) + "%", usedBar ? "event bar (" + why.src + ")" : "Calendar, Light modifiers default");
      }
    }
    return out;
  }
  explainLive(now) {
    var m0 = this.lt || (this.lt = this.lightsModel(now)), cs = this.condition(now), ovr = !!cs.overrideBar;
    var bar = !ovr && this.hooks && this.hooks.eventBar ? this.hooks.eventBar.call(this, cs, m0) : null;
    return this.explain(cs, m0, bar, ovr);
  }
  // Writes the lines into a box. A live box keeps itself current while the settings page is open.
  fillWhy(box, lines) {
    var key = JSON.stringify(lines);
    if (box._wk === key) return;
    box._wk = key; box.empty();
    lines.forEach(function (l) {
      var d = box.createDiv();
      d.createEl("b", { text: l.label + ": " }); d.appendText(l.value + " ");
      d.createSpan({ cls: "lcars-why-from", text: "(" + l.from + ")" });
    });
  }
  renderWhy(el, stateId, kind) {
    var box = el.createDiv({ cls: "lcars-why" }), pp = this.previewParts(kind, stateId, new Date());
    var m0 = this.lightsModel(new Date(), kind);
    var lines = pp.st ? this.explain(pp.st, m0, pp.bar, pp.ovr) : [];
    if (lines.length) lines[0].from = "the status being previewed";
    this.fillWhy(box, lines);
    return box;
  }
  renderLiveWhy(el) {
    var self = this, box = el.createDiv({ cls: "lcars-why" });
    var rec = { box: box, update: function () { self.fillWhy(box, self.explainLive(new Date())); } };
    this.whyEls.add(rec); rec.update();
    return box;
  }

  addPreview(el, kind, stateId) {
    var host = el.createDiv({ cls: "lcars-set-preview" });
    var pv = { host: host, kind: kind, state: stateId || "green" };
    this.previewHosts.add(pv);
    var pm0 = this.previewModel(kind, pv.state, new Date());
    this.buildLights(host, kind, this.barLook(this.look(this.statusById(pv.state)), pm0));
    this.paintLights(host, new Date(), pm0);
    return host;
  }

  rebuildPreviews() {
    var self = this;
    this.previewHosts.forEach(function (pv) {
      if (!pv.host.isConnected) { self.previewHosts.delete(pv); return; }
      pv.host.empty(); self.buildLights(pv.host, pv.kind, self.barLook(self.look(self.statusById(pv.state)), self.previewModel(pv.kind, pv.state, new Date())));
    });
  }

  // Circle: dots are one fixed size, so the count follows the width. Measured
  // after layout; the row is rebuilt only when the count changes.
  circleSync(host) {
    var lb = host.querySelector('.lcars-lt[data-form="circle"]');
    if (!lb || lb._kind || this._lightsRebuilding) return false;
    var bar = lb.querySelector(".lcars-lt-bar"), seg = bar && bar.firstElementChild;
    if (!bar || !seg) return false;
    var W = bar.clientWidth, d = seg.offsetWidth, gap = parseFloat(getComputedStyle(bar).columnGap) || 0;
    if (!(W > 0) || !(d > 0)) return false;
    var n = Math.max(8, Math.min(80, Math.floor((W + gap) / (d + gap))));
    if (n === bar.children.length) return false;
    this._circleN = n;
    this._lightsRebuilding = true;
    try {
      var holder = lb.parentElement || host;
      lb.remove();
      this.buildLights(holder, undefined, this._curLook);
      this.paintLights(host, new Date());
    } finally { this._lightsRebuilding = false; }
    return true;
  }

  // Ripple: a click on Data cascade sends a ring outward from the nearest segment. Up to three
  // rings at once; a new click adds one and the oldest goes if there are already three. The
  // rings are CSS variables on the row for about 1.8 seconds (updated each frame), then they are removed.
  ripple(box, e) {
    if (!box || this.settings.lights.ripple === false) return;
    if (box.getAttribute("data-rest") !== "cascade" || box.getAttribute("data-mode") !== "rest") return;
    if (this.settings.motionOff || this.settings.lights.fx.rest === false || document.hidden) return;
    if (document.body.classList.contains("lcars-motion-off") || document.body.classList.contains("lcars-plugin-motion-off")) return;
    var segs = box.querySelectorAll(".lcars-lt-seg"), bars = box.querySelectorAll(".lcars-lt-bar");
    if (!segs.length || !bars.length) return;
    var best = null, bd = Infinity;
    segs.forEach(function (sg) {
      var r = sg.getBoundingClientRect(), dx = (r.left + r.right) / 2 - e.clientX, dy = (r.top + r.bottom) / 2 - e.clientY, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = sg; }
    });
    var n = bars[0].children.length, rows = bars.length;
    var colPitch = n > 1 ? bars[0].children[1].getBoundingClientRect().left - bars[0].children[0].getBoundingClientRect().left : 1;
    var rowPitch = rows > 1 ? bars[1].getBoundingClientRect().top - bars[0].getBoundingClientRect().top : colPitch;
    var aspect = colPitch > 0 && rowPitch > 0 ? rowPitch / colPitch : 1;
    var ox = Number(best.style.getPropertyValue("--i")) || 0, oy = Number(best.style.getPropertyValue("--row")) || 0;
    // The ring ends at a quarter of the row's width from where you clicked, so the whole ripple spans no more than half the row.
    var maxR = Math.max(3, n * 0.25);
    var list = box._rip || (box._rip = []);
    list.push({ x: ox, y: oy, t0: performance.now() });
    while (list.length > 3) list.shift();
    box.style.setProperty("--lt-aspect", aspect.toFixed(3));
    box.setAttribute("data-ripple", "");
    if (box._ripRaf) return;
    var dur = 1800, step = function (now) {
      box._ripRaf = 0;
      for (var k = list.length - 1; k >= 0; k--) if (now - list[k].t0 >= dur) list.splice(k, 1);
      for (var j = 1; j <= 3; j++) {
        var rp = list[j - 1];
        if (rp) {
          var u = (now - rp.t0) / dur, ease = 1 - Math.pow(1 - u, 2);
          box.style.setProperty("--r" + j + "x", String(rp.x)); box.style.setProperty("--r" + j + "y", String(rp.y));
          box.style.setProperty("--r" + j + "r", (maxR * ease).toFixed(2)); box.style.setProperty("--r" + j + "a", (1 - u).toFixed(3));
        } else box.style.setProperty("--r" + j + "a", "0");
      }
      if (list.length && box.isConnected && !document.hidden) box._ripRaf = window.requestAnimationFrame(step);
      else {
        list.length = 0; box.removeAttribute("data-ripple");
        for (var q = 1; q <= 3; q++) ["x", "y", "r", "a"].forEach(function (c) { box.style.removeProperty("--r" + q + c); });
      }
    };
    box._ripRaf = window.requestAnimationFrame(step);
  }

  // Calendar progress over the state's own look. m.progress = { share: 0..1 of the row that is lit,
  // anchor: left | right | center | edges | top | bottom, dim: 0..1 brightness of the unlit part }.
  // The lit part is the resting look unchanged; the unlit part is that look dimmed. Left, right,
  // center and edges work by column. Top and bottom fill the rows one after another (row by row
  // from the top or the bottom), so with several rows the progress has finer steps.
  paintProgress(box, pg) {
    var bars = box.querySelectorAll(".lcars-lt-bar"), all = bars.length, share = Math.max(0, Math.min(1, Number(pg.share))), anchor = pg.anchor || "left";
    // Which rows the progress uses. The others stay fully lit, in the status's own look.
    var sel = [], mid = Math.floor((all - 1) / 2);
    for (var q = 0; q < all; q++) if (all < 2 || !pg.rows || pg.rows === "all" || (pg.rows === "top" && q === 0) || (pg.rows === "bottom" && q === all - 1) || (pg.rows === "middle" && q === mid)) sel.push(q);
    if (!sel.length) sel = [0];
    var R = sel.length;
    if ((anchor === "top" || anchor === "bottom") && R < 2) anchor = "left";
    var dim = isFinite(Number(pg.dim)) ? Math.max(0, Math.min(1, Number(pg.dim))) : 0.25;
    if (box._dim !== dim) { box._dim = dim; box.style.setProperty("--lt-unlit", String(dim)); }
    bars.forEach(function (bar, r) {
      var segs = bar.children, n = segs.length, pos = sel.indexOf(r), used = pos >= 0;
      var total = n * R, kk = Math.round(share * total), k = Math.round(share * n);
      for (var i = 0; i < n; i++) {
        var lit;
        if (!used) lit = true;
        else if (anchor === "top" || anchor === "bottom") lit = ((anchor === "top" ? pos : R - 1 - pos) * n + i) < kk;
        else if (anchor === "right") lit = i >= n - k;
        else if (anchor === "center") { var a = Math.floor((n - k) / 2); lit = i >= a && i < a + k; }
        else if (anchor === "edges") lit = i < Math.ceil(k / 2) || i >= n - Math.floor(k / 2);
        else lit = i < k;
        var el = segs[i];
        if (el.classList.contains("is-unlit") === lit) el.classList.toggle("is-unlit", !lit);
        if (el.classList.contains("is-on")) el.classList.remove("is-on", "is-dim");
      }
    });
  }

  segCount(L) {
    L = L || this.settings.lights;
    return L.shape === "B" ? 40 : L.form === "circle" ? (this._circleN || 28) : Math.max(8, Math.min(40, Math.round(Number(L.segments) || 16)));
  }

  clickLights() {
    var h = this.hooks && this.hooks.click;
    if (h) h.call(this);
  }

  // Flags Notebook Navigator's navigation scroller while its content is
  // taller than the pane, so the theme can paint it black only then. A
  // class set here replaces a body:has() rule in the CSS.
  syncNnScroll() {
    document.querySelectorAll(".workspace-split.mod-left-split .nn-navigation-pane-scroller").forEach(function (sc) {
      if (!sc._lcarsRo) {
        sc._lcarsF = function () { sc.classList.toggle("lcars-overflow", sc.scrollHeight > sc.clientHeight + 1); };
        sc._lcarsRo = new ResizeObserver(sc._lcarsF);
        sc._lcarsRo.observe(sc);
      }
      var vc = sc.querySelector(".nn-virtual-container");
      if (vc) sc._lcarsRo.observe(vc);
      sc._lcarsF();
    });
  }

  // Put the top of the first ribbon button level with the top of the
  // Notebook Navigator "Shortcuts" row. The ribbon's own top padding
  // takes a nudge (--lcars-ribbon-nudge) that this works out by measuring.
  alignRibbon() {
    var tog = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary) > .sidebar-toggle-button");
    // Whichever pane the sidebar is showing: Notebook Navigator's Shortcuts
    // row, or the first row of File Explorer. A hidden pane measures as
    // zeros, so only a target that is actually on screen counts.
    var nn = null;
    [".workspace-split.mod-left-split .nn-navitem.nn-shortcut-header-item",
     ".workspace-split.mod-left-split .nav-files-container .tree-item-self"].some(function (sel) {
      var el = document.querySelector(sel);
      if (el && el.getClientRects().length && el.getBoundingClientRect().height > 0) { nn = el; return true; }
      return false;
    });
    if (!tog || !nn) return;
    var body = document.body;
    for (var i = 0; i < 2; i++) {
      var spacer = parseFloat(getComputedStyle(tog).borderTopWidth) || 0;
      var delta = nn.getBoundingClientRect().top - (tog.getBoundingClientRect().top + spacer);
      if (Math.abs(delta) < 0.5) break;
      var cur = parseFloat(body.style.getPropertyValue("--lcars-ribbon-nudge")) || 0;
      body.style.setProperty("--lcars-ribbon-nudge", (cur + delta).toFixed(1) + "px");
    }
  }

  /* ── Fit and grid snap ────────────────────────────────────────── */

  // The banner's height, moved the way Obsidian moves its own sidebars: the content is already laid out at its
  // final size, the banner clips it (overflow hidden), and one CSS transition on `height` does the rest. No script
  // runs while it moves. The two things that sit below the banner follow with the same transition on the property
  // the page derives from --lcars-bh-h: the ribbon's top padding and the sidebar container's top margin. Same
  // duration and curve, so all three ease together. The ribbon is measured once the move ends. Nothing animates
  // the first time, for a change under 2 px, or with motion off.
  setHeight(host, total, corner) {
    var self = this, body = document.body, cur = host._ah;
    var still = this.settings.motionOff || body.classList.contains("lcars-motion-off") || body.classList.contains("lcars-plugin-motion-off") || document.hidden;
    if (host._moveTo === total && !still) return; // already heading there
    var snap = function () {
      window.clearTimeout(host._mt); host._mt = 0; host._moveTo = null;
      host.style.transition = ""; host._ah = total; host.style.height = total.toFixed(1) + "px";
      if (corner) { self.endFollow(host); body.style.setProperty("--lcars-bh-h", total.toFixed(1) + "px"); self.alignRibbon(); }
    };
    if (cur === undefined || still || (!host._moveTo && Math.abs(total - cur) < 2)) { snap(); return; }
    var from = host._moveTo ? host.getBoundingClientRect().height : cur;
    var dur = 300, fn = "var(--anim-motion-swing, cubic-bezier(0, 0.55, 0.45, 1))";
    if (corner) this.startFollow(host, dur, fn);
    window.clearTimeout(host._mt);
    host.style.transition = "none"; host.style.height = from.toFixed(1) + "px";
    void host.offsetHeight; // a frame at the starting height, so the transition has somewhere to start from
    host.style.transition = "height " + dur + "ms " + fn;
    host.style.height = total.toFixed(1) + "px";
    host._ah = total; host._moveTo = total;
    if (corner) body.style.setProperty("--lcars-bh-h", total.toFixed(1) + "px");
    host._mt = window.setTimeout(function () {
      host._mt = 0; host._moveTo = null; host.style.transition = "";
      if (corner) { self.alignRibbon(); host._ft = window.setTimeout(function () { self.endFollow(host); }, dur + 40); }
    }, dur + 50);
  }

  // The panes below the banner ease with it. Their transitions are on only while a move runs (and a little after,
  // so the ribbon's small correction eases too).
  startFollow(host, dur, fn) {
    window.clearTimeout(host._ft); host._ft = 0;
    var rib = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary)");
    var con = document.querySelector(".workspace-split.mod-left-split > .workspace-tabs > .workspace-tab-container");
    if (rib) rib.style.transition = "padding-top " + dur + "ms " + fn;
    if (con) con.style.transition = "margin-top " + dur + "ms " + fn;
    host._f = { rib: rib, con: con };
  }
  endFollow(host) {
    window.clearTimeout(host._ft); host._ft = 0;
    var f = host._f; if (!f) return;
    if (f.rib) f.rib.style.transition = ""; if (f.con) f.con.style.transition = "";
    host._f = null;
  }

  fit(host) {
    var inner = host.querySelector(".lcars-bh-inner");
    if (!inner) return;
    var cornerDrop = 0;
    if (host.classList.contains("is-corner")) {
      // Span the left ribbon and the left sidebar. A collapsed sidebar
      // hides the banner and gives the height back.
      var rib = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary)");
      var spl = document.querySelector(".workspace-split.mod-left-split");
      var sw = spl ? spl.getBoundingClientRect().width : 0;
      var off = !rib || !spl || spl.classList.contains("is-sidedock-collapsed") || sw < 8;
      host.classList.toggle("is-hidden", off);
      if (off) { host._ah = undefined; host._moveTo = null; document.body.style.setProperty("--lcars-bh-h", "0px"); return; }
      // Start where the ribbon's gray bar starts, end at the sidebar's edge.
      // The ribbon keeps a 24px strip on its left (--lcars-ribbon-cut);
      // the banner's left edge sits where the ribbon's buttons begin.
      var rr = rib.getBoundingClientRect(), pr = host.parentElement.getBoundingClientRect();
      var btn = rib.querySelector(":scope > .sidebar-toggle-button, .side-dock-ribbon-action");
      var edge = btn ? btn.getBoundingClientRect().left : rr.left + 24;
      host.style.left = Math.max(0, edge - pr.left).toFixed(1) + "px";
      // 16px short of the sidebar's right edge (2026-10-06).
      host.style.width = Math.max(0, spl.getBoundingClientRect().right - edge - 16).toFixed(1) + "px";
      // Style Settings: "Banner drop" (px) lowers the banner under the tab row.
      var dv = parseFloat(getComputedStyle(host).getPropertyValue("--lcars-bh-drop"));
      cornerDrop = dv >= 0 ? dv : 32;
      // Sit just under the sidebar's tab-icon row, so the frame's top
      // curves and that row stay where they were; the panes below are
      // pushed down by the banner's height (lcars-frame.css §40b).
      var hdr = spl.querySelector(".workspace-tab-header-container");
      var pTop = host.parentElement.getBoundingClientRect().top;
      host.style.top = (hdr ? Math.max(0, hdr.getBoundingClientRect().bottom - pTop) : 0).toFixed(1) + "px";
      // The drop is a gray band at the top of the banner. It holds the
      // version line, so a drop under 16px leaves the version inline.
      host.style.setProperty("--lcars-bh-band", cornerDrop.toFixed(1) + "px");
      host.classList.toggle("has-band", cornerDrop >= 16);
    }
    var cs = getComputedStyle(inner);
    var avail = inner.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (avail <= 0) return;
    var pitch = pitchOf(host);
    var cornerMode = host.classList.contains("is-corner");
    // --lcars-bh-top: auto means "start on the ribbon's grid": measure
    // the first ribbon button and pad down to the next grid line.
    inner.style.paddingTop = "";
    inner.style.paddingBottom = "";
    host.style.marginTop = "";
    if (cornerMode) {
      var cpad = parseFloat(cs.getPropertyValue("--lcars-bh-pad"));
      cpad = cpad >= 0 ? cpad : 0;
      inner.style.paddingTop = (cpad + cornerDrop) + "px";
      inner.style.paddingBottom = cpad + "px";
    } else if (cs.getPropertyValue("--lcars-bh-top").trim() === "ribbon") {
      // The banner's top edge sits on the top of the first ribbon block
      // (its 4px black spacer); the first row starts one gap below it,
      // on a gray grid line. Margin moves the whole banner down to that
      // line, whatever sits above the tab container.
      var tog = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary) > .sidebar-toggle-button");
      var gap = parseFloat(getComputedStyle(host).getPropertyValue("--lcars-row-gap")) || 4;
      if (tog) {
        var gapOff = tog.getBoundingClientRect().top - host.getBoundingClientRect().top;
        var lift = parseFloat(cs.getPropertyValue("--lcars-bh-lift")) || 0;
        host.style.marginTop = ((((gapOff % pitch) + pitch) % pitch) - lift).toFixed(1) + "px";
      }
      // Minimum breathing room above and below the rows, on top of the gap.
      var pad = parseFloat(cs.getPropertyValue("--lcars-bh-pad"));
      pad = pad >= 0 ? pad : 0;
      inner.style.paddingTop = (gap + pad) + "px";
      inner.style.paddingBottom = pad + "px";
    } else if (cs.getPropertyValue("--lcars-bh-top").trim() === "auto") {
      var anchor = document.querySelector(".workspace-ribbon:is(.mod-left, .mod-primary) .side-dock-ribbon-action");
      if (anchor) {
        var scroller = host.parentElement;
        var hostTop = host.getBoundingClientRect().top + (scroller ? scroller.scrollTop : 0);
        var off = ((anchor.getBoundingClientRect().top - hostTop) % pitch + pitch) % pitch;
        inner.style.paddingTop = off.toFixed(1) + "px";
      }
    }
    inner.style.setProperty("--lcars-bh-base", Math.max(9, Math.min(22, avail / 20)).toFixed(2) + "px");
    // While the banner is moving its height is left alone; it is measured from its content instead.
    if (!host._moveTo) host.style.height = "auto";

    var ctext = host.querySelector(".lcars-bh-condtext"), ckeep = ctext ? ctext.textContent : null, clong = ctext && ctext.closest(".lcars-bh-cond").dataset.longest;
    if (ctext && clong) ctext.textContent = clong;
    host.querySelectorAll("[data-lcars-fit]").forEach(function (row) {
      var min = parseFloat(row.dataset.fitMin) || 8;
      var max = parseFloat(row.dataset.fitMax) || 200;
      var fill = parseFloat(row.dataset.fitFill) || 1;
      row.style.fontSize = "100px";
      row.style.width = "max-content";
      row.style.justifyContent = "flex-start";
      var natural = row.scrollWidth;
      row.style.width = "";
      row.style.justifyContent = "";
      var size = natural > 0 ? (100 * avail * fill) / natural : min;
      row.style.fontSize = Math.max(min, Math.min(max, size)).toFixed(2) + "px";
    });
    if (ctext && ckeep !== null) ctext.textContent = ckeep;

    // Rows stay tight; spare space goes at the bottom, up to the next
    // whole grid row.
    if (cornerMode) {
      // Drop + banner fill whole grid rows, so everything under it stays
      // on the grid. The ribbon and the sidebar make room by that total.
      // The banner is as tall as its content (no grid rounding). The
      // ribbon is then lined up with the first NN row, below.
      this.setHeight(host, Math.max(1, Math.ceil(host._moveTo ? inner.offsetHeight : host.scrollHeight)), true);
    } else {
      this.setHeight(host, Math.max(1, Math.ceil((host._moveTo ? inner.offsetHeight : host.scrollHeight) / pitch - 0.01)) * pitch, false);
    }
    if (!this._circleFit && this.circleSync(host)) { this._circleFit = true; try { this.fit(host); } finally { this._circleFit = false; } }
  }

  /* ── Painting ─────────────────────────────────────────────────── */

  // One clock. Nothing runs while Obsidian is in the background or no
  // banner (and no settings preview) is on screen. The ship status
  // readouts refresh every 15 seconds, not every second.
  tick() {
    this._ticks = (this._ticks || 0) + 1;
    if (this._ticks % 3 === 0) this.paintBusy();
    if (document.hidden) return;
    var seen = false;
    this.hosts.forEach(function (h) { if (h._vis) seen = true; });
    if (!seen && !this.previewHosts.size) return;
    this.lt = null;
    if (this._ticks % 15 === 0) this.readChannels();
    this.paintAll();
  }

  readChannels() { this.readMod(); this.readBridge(); this.readDocks(); }

  paintAll() {
    var now = new Date(), self = this;
    this.hosts.forEach(function (h) { if (h._vis !== false) self.paintHost(h, now); });
    this.previewHosts.forEach(function (pv) { self.paintLights(pv.host, now, self.previewModel(pv.kind, pv.state, now)); });
    this.whyEls.forEach(function (w) { if (!w.box.isConnected) self.whyEls.delete(w); else w.update(); });
    this.tagEls.forEach(function (tag) { self.paintTag(tag); });
    // A property on body restyles the whole page, so only write it when the
    // stardate actually changes (about once every 50 minutes).
    var sd = '"' + this.stardateString(now) + '"';
    if (sd !== this._sdProp) { this._sdProp = sd; document.body.style.setProperty("--padd-stardate", sd); }
  }

  stardateString(now) { return stardate(Number(this.settings.stardateYear) || 2401, now).toFixed(1); }

  clockString(now) {
    if (this.settings.timeMode === "date") return pad2(now.getMonth() + 1) + "." + pad2(now.getDate());
    return pad2(now.getHours()) + pad2(now.getMinutes());
  }

  paintHost(host, now) {
    setText(host.querySelector(".lcars-bh-stardate"), this.stardateString(now));
    setText(host.querySelector(".lcars-bh-clock"), this.clockString(now));
    var stamp;
    try {
      if (!this._fmt) this._fmt = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "medium" });
      stamp = this._fmt.format(now);
    }
    catch (e) { stamp = now.toString(); }
    setAttr(host.querySelector(".lcars-sd"), "data-tooltip", stamp);
    // Running lights only: paint once; CSS does the rest.
    var lb = host.querySelector(".lcars-lt");
    var live = this.hooks && this.hooks.live && this.hooks.live.call(this);
    // The status decides the look. The event bar (from the calendar) adds layout, progress, speed and a light
    // style over it, unless the status overrides the bar (Red alert), and then the status's own look runs.
    var m0 = this.lt || (this.lt = this.lightsModel(now));
    var cs = this.condition(now), cond = host.querySelector(".lcars-condition");
    host._ovr = !!cs.overrideBar;
    // The event bar is set per status (the Sandbox's Event bar section on each status card).
    var bar = !host._ovr && this.hooks && this.hooks.eventBar ? this.hooks.eventBar.call(this, cs, m0) : null;
    host._bm = bar ? Object.assign({}, m0, bar) : m0;
    var lk = this.look(cs);
    if (!host._ovr) lk = this.barLook(lk, host._bm);
    this._curLook = lk;
    if (live || (lb && !lb._painted)) this.paintLights(host, now);

    if (cond) {
      styleCond(cond, cs);
      setAttr(cond, "aria-pressed", String(this.alert));
    }
    // Tint: the lights and the divider dot take the condition color.
    var tint = cs.tint !== false;
    if (host.hasAttribute("data-tint") !== tint) host.toggleAttribute("data-tint", tint);
    if (host._col !== cs.color) { host._col = cs.color; host.style.setProperty("--lt-cond", cs.color); }
    // The lights can take their own color for a status; empty means the status color.
    var lc = cs.lightColor || cs.color;
    if (host._lcol !== lc) { host._lcol = lc; host.style.setProperty("--lt-lights", lc); }
    // Running lights follow the status: its own pattern and speed, else the Lights setting.
    if (lb) {
      // Color mode, concentration and a moving light are set when the row is
      // built, so a state that differs rebuilds the row once.
      if (lb._skey !== this.lookKey(lk) && !this._lightsRebuilding) {
        this._lightsRebuilding = true;
        try {
          var holder = lb.parentElement || host;
          lb.remove();
          this.buildLights(holder, undefined, lk);
          this.paintLights(host, now);
          lb = host.querySelector(".lcars-lt");
        } finally { this._lightsRebuilding = false; }
        this.fit(host);
      }
      if (lb) {
        this.lookVars(lb, lk);
        if (lb._beh === "interval" && lb.getAttribute("data-mode") === "rest" && Date.now() - (lb._lastPlay || 0) >= lb._interval * 1000) this.playRow(lb);
      }
    }

    // Tactical meters replace the channels while a state with a set is showing.
    var sub = host.querySelector(".lcars-subsys");
    if (sub) {
      var want = this.settings.showTactical !== false && TACTICAL[cs.id] ? cs.id : "";
      if (sub._set !== want) { this.fillStatus(sub, want); if (this.refitAll) this.refitAll(); }
    }

    var st = this.state;
    host.querySelectorAll(".lcars-subsys-row").forEach(function (row) {
      var s = st[row.dataset.ch];
      if (!s) return;
      setText(row.querySelector(".lcars-subsys-val"), s.text);
      var fill = row.querySelector(".lcars-subsys-fill");
      var pct = Math.round(s.pct * 100) + "%";
      if (fill.style.getPropertyValue("--lcars-subsys-pct") !== pct) fill.style.setProperty("--lcars-subsys-pct", pct);
      if (row.classList.contains("is-void") !== !!s.void) row.classList.toggle("is-void", !!s.void);
    });
  }

  /* ── Alert modes (section 4) ──────────────────────────────────── */

  get alert() { return !!this.raised && this.raised.has("red"); }
  get grayManual() { return !!this.raised && this.raised.has("gray"); }
  setRed(on) { if (on) this.pick("red"); else this.clear("red", { source: "user" }); }
  setGray(on) { if (on) this.pick("gray"); else this.clear("gray", { source: "user" }); }

  /* ── Raising a status by hand ─────────────────────────────────── */

  statusById(id) {
    return this.settings.alerts.statuses.filter(function (st) { return st.id === id; })[0] || null;
  }

  // The statuses a person can raise: all but the fallback, and any switched off.
  handStatuses() {
    return this.settings.alerts.statuses.filter(function (st) { return st.id !== "green" && st.hand !== false; });
  }

  // When a status ends by itself, as epoch ms: 0 = it does not, -1 = the time
  // has already passed.
  exitTime(st, now) {
    var e = st.exit || {}, mode = e.mode || "cleared";
    if (mode === "after") { var m = Number(e.minutes); return m > 0 ? now + m * 60000 : 0; }
    if (mode === "clock") {
      var t = /^(\d{1,2}):(\d{2})$/.exec(String(e.at || "").trim());
      if (!t) return 0;
      var d = new Date(now); d.setHours(Number(t[1]), Number(t[2]), 0, 0);
      return d.getTime() > now ? d.getTime() : -1;
    }
    if (mode === "event") {
      var h = this.hooks && this.hooks.eventEnd, end = h ? Number(h.call(this, new Date(now))) : 0;
      return end > now ? end : 0;
    }
    return 0;
  }

  // Statuses with a cron start time. Checked every 20 seconds, once per minute that matches,
  // and once on load, looking back over the exit window so a start while Obsidian was closed still counts.
  checkSchedules(startup) {
    var self = this, now = Date.now(), minute = Math.floor(now / 60000);
    // After a long gap (the computer slept) look back the same way as on load.
    var catchUp = startup || (this._lastCheck && minute - this._lastCheck > 2);
    this._lastCheck = minute;
    this.settings.alerts.statuses.forEach(function (st) {
      if (!st.start || st.hand === false) return;
      var c = cronParse(st.start); if (!c) return;
      var back = catchUp && st.exit && st.exit.mode === "after" ? Math.min(1440, Math.floor(Number(st.exit.minutes) || 0)) : 0;
      for (var k = 0; k <= back; k++) {
        var t = (minute - k) * 60000;
        if (!cronMatch(c, new Date(t))) continue;
        var last = self._lastStart[st.id] || 0;
        if (last >= minute - k) return;
        self._lastStart[st.id] = minute - k; self.save();
        var until = k > 0 ? t + Number(st.exit.minutes) * 60000 : 0;
        if (k === 0 || until > now) self.raise(st.id, { source: "schedule", until: until });
        return;
      }
    });
  }

  // Raise a status. opts.until (epoch ms) replaces the status's own exit for
  // this raise. Returns false when it cannot be raised.
  raise(id, opts) {
    var st = this.statusById(id), self = this;
    if (!st || id === "green" || st.hand === false) return false;
    opts = opts || {};
    var now = Date.now(), until = Number(opts.until) > 0 ? Number(opts.until) : this.exitTime(st, now);
    if (until === -1) {
      new obsidian.Notice(st.label + " would already have ended at " + st.exit.at + ", so it was not raised.");
      return false;
    }
    var old = this.raised.get(id);
    if (old) window.clearTimeout(old.timer);
    var rec = { id: id, source: opts.source || "user", since: now, until: until, timer: 0 };
    this.raised.set(id, rec);
    if (until) rec.timer = window.setTimeout(function () { self.clear(id, { source: "timer", force: true }); }, Math.min(Math.max(until - Date.now(), 0), 2147000000));
    // A status that steps aside when another is raised.
    Array.from(this.raised.keys()).forEach(function (other) {
      var o = self.statusById(other);
      if (other !== id && o && o.exit && o.exit.mode === "other") self.clear(other, { source: "exit", force: true });
    });
    this.changed(id, "raise", rec.source);
    return true;
  }

  // Clear a status. A script or link clears only what it raised, unless force
  // is set; a person can always clear anything.
  clear(id, opts) {
    var rec = this.raised.get(id);
    if (!rec) return false;
    opts = opts || {};
    var by = opts.source || "user";
    if (by !== "user" && !opts.force && rec.source !== by) return false;
    window.clearTimeout(rec.timer);
    this.raised.delete(id);
    this.changed(id, "clear", by);
    return true;
  }

  toggle(id, opts) {
    return this.raised.has(id) ? this.clear(id, opts) : this.raise(id, opts);
  }

  // The state shown by hand now: the highest in the list that is raised.
  topRaised() {
    var self = this, hit = "";
    this.settings.alerts.statuses.some(function (st) { if (self.raised.has(st.id)) { hit = st.id; return true; } return false; });
    return hit;
  }

  // Pick one state by hand: it is raised and every other one raised by hand is
  // cleared. An empty id clears them all. The menu, the commands, the status
  // click and the settings dropdown all work this way. Links and scripts can
  // still raise several.
  pick(id) {
    var self = this;
    Array.from(this.raised.keys()).forEach(function (k) { if (k !== id) self.clear(k, { source: "user" }); });
    if (id && !this.raised.has(id)) return this.raise(id, { source: "user" });
    return true;
  }

  pickToggle(id) { return this.topRaised() === id ? this.pick("") : this.pick(id); }

  changed(id, change, source) {
    this.lt = null; this._condFor = null;
    this.paintAll();
    if (typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent("lcars-companion-status-changed", { detail: { id: id, change: change, source: source } }));
  }

  // The small menu on the word CONDITION: pick one state to raise by hand. The
  // one showing has a check, with the time left; None clears it.
  statusMenu(e) {
    var self = this, menu = new obsidian.Menu(), now = Date.now(), top = this.topRaised();
    this.handStatuses().forEach(function (st) {
      var rec = self.raised.get(st.id), left = rec && rec.until ? "  (" + briefAge(rec.until - now) + " left)" : "";
      menu.addItem(function (it) { it.setTitle(st.label + left).setChecked(top === st.id).onClick(function () { self.pickToggle(st.id); }); });
    });
    if (this.raised.size) {
      menu.addSeparator();
      menu.addItem(function (it) { it.setTitle("None").onClick(function () { self.pick(""); }); });
    }
    if (e.type === "click") menu.showAtMouseEvent(e);
    else { var r = e.target.getBoundingClientRect(); menu.showAtPosition({ x: r.left, y: r.bottom }); }
  }

  // Settings demo: show a status on the real banner for ten seconds.
  testStatus(id) {
    this._test = { id: id, until: Date.now() + 10000 };
    this.lt = null; this._condFor = null; this.paintAll();
    new obsidian.Notice("Showing this status on the banner for 10 seconds.");
  }
  // Style tag with each status's own animation timing.
  condStyle() {
    var css = condCss(this.settings.alerts.statuses);
    if (!this._condStyle) { this._condStyle = document.head.createEl("style"); this._condStyle.id = "lcars-cond-style"; }
    if (this._condStyle.textContent !== css) this._condStyle.textContent = css;
  }
  paintDemos() {
    var self = this;
    this.demoEls.forEach(function (d) {
      if (!d.el.isConnected) { self.demoEls.delete(d); return; }
      styleCond(d.el, d.st, true);
    });
  }

  // The status the CONDITION label shows now: the first in the priority
  // list that is raised by hand or matches the calendar, else green (the
  // fallback). Cached per model, so every banner copy shares one answer.
  condition(now) {
    var m = this.lt || (this.lt = this.lightsModel(now));
    if (this._condFor === m) return this._cond;
    var A = this.settings.alerts, ph = m.alert.phase, title = String(m.alert.title || "").toLowerCase(), self = this;
    var hit = null;
    if (this._test && this._test.until > Date.now()) hit = A.statuses.filter(function (st) { return st.id === self._test.id; })[0] || null;
    if (!hit) A.statuses.some(function (st) {
      if (self.raised.has(st.id)) { hit = st; return true; }
      if (st.phases.indexOf(ph) < 0 && !((ph === "starting" || ph === "started") && st.phases.indexOf("transition") >= 0)) return false;
      var ws = String(st.words || "").toLowerCase().split(",").map(function (w) { return w.trim(); }).filter(Boolean);
      if (ws.length && !ws.some(function (w) { return hasWord(title, w); })) return false;
      hit = st; return true;
    });
    if (!hit) hit = A.statuses.filter(function (st) { return st.id === "green"; })[0] || A.statuses[A.statuses.length - 1];
    // body.lcars-gray is a hook for the theme; nothing else changes yet.
    var gray = hit.id === "gray";
    if (document.body.classList.contains("lcars-gray") !== gray) document.body.classList.toggle("lcars-gray", gray);
    this._condFor = m; this._cond = hit;
    return hit;
  }

  /* ── Lights ───────────────────────────────────────────────────── */

  // One model per tick, shared by every banner copy. Without a hook it is
  // the resting row: no lit segments, no label, phase "rest".
  restModel() {
    var n = this.segCount(this.eff("rest"));
    var blank = function () { var a = []; for (var i = 0; i < n; i++) a.push({ on: false }); return a; };
    return { phase: "rest", mode: "rest", final: false, label: "", tip: "", url: "", dur: 2, rows: [blank(), blank()], alert: { phase: "rest", title: "" } };
  }

  lightsModel(now, kind) {
    var h = this.hooks && this.hooks.lightsModel;
    return h ? h.call(this, now, kind) : this.restModel();
  }

  // Rebuild every banner, for a hook that changes what the lights row has.
  refreshLights() { this.unmountAll(); this.mountAll(); this.lt = null; this.paintAll(); }

  paintLights(host, now, pm) {
    var box = host.querySelector(".lcars-lt");
    if (!box) return;
    var m = pm || host._bm || this.lt || (this.lt = this.lightsModel(now));
    // A status that overrides the event bar keeps its own look: no progress, layout, style or speed from the bar.
    if (host._ovr && !pm) m = Object.assign({}, m, { progress: { share: 1, anchor: "left", dim: 1 }, layout: null, look: null, speed: 1 });
    // A phase can change the shape or fill, so the row is rebuilt once.
    if (!pm && box.getAttribute("data-phase") !== (m.progress ? "rest" : m.phase)) {
      // Rebuild only the lights row, inside the old row's own parent (the
      // banner's inner box, not the outer host passed in here). A guard
      // keeps a phase mismatch from rebuilding forever (2026-10-06 freeze).
      if (this._lightsRebuilding) return;
      this._lightsRebuilding = true;
      try {
        var holder = box.parentElement || host;
        box.remove();
        this.buildLights(holder);
        this.paintLights(host, now, pm);
      } finally { this._lightsRebuilding = false; }
      this.fit(host);
      return;
    }
    box._painted = true;
    if (box.classList.contains("is-final") !== m.final) box.classList.toggle("is-final", m.final);
    // A model with progress is the resting look with the calendar's progress laid over it (see paintProgress).
    setAttr(box, "data-mode", m.progress ? "rest" : m.mode);
    setAttr(box, "data-cal", m.progress ? m.mode : "");
    setAttr(box, "title", m.tip);
    // The calendar can speed the lights up as an event nears (m.speed, 1 or more).
    var calSpeed = m.speed > 0 ? Math.max(0.25, Math.min(4, m.speed)) : 1;
    if (box._cal !== calSpeed) { box._cal = calSpeed; box.style.setProperty("--lt-cal", String(calSpeed)); }
    var dur = m.dur.toFixed(2) + "s";
    if (box.style.getPropertyValue("--lt-dur") !== dur) box.style.setProperty("--lt-dur", dur);
    if (m.progress) this.paintProgress(box, m.progress);
    else box.querySelectorAll(".lcars-lt-bar").forEach(function (bar, r) {
      var cells = m.rows[r] || m.rows[0], segs = bar.children;
      if (!cells) return;
      for (var i = 0; i < segs.length && i < cells.length; i++) {
        var el = segs[i], c = cells[i];
        if (el.classList.contains("is-unlit")) el.classList.remove("is-unlit");
        if (el.classList.contains("is-on") !== c.on) el.classList.toggle("is-on", c.on);
        if (el.classList.contains("is-dim") !== !!c.dim) el.classList.toggle("is-dim", !!c.dim);
        setAttr(el, "data-tone", c.tone || "");
        if (c.p !== undefined) {
          var p = c.p.toFixed(3), o = String(c.o);
          if (el.style.getPropertyValue("--p") !== p) el.style.setProperty("--p", p);
          if (el.style.getPropertyValue("--o") !== o) el.style.setProperty("--o", o);
        }
      }
    });
    var pl = this.hooks && this.hooks.paintLabel;
    if (pl) pl.call(this, box.querySelector(".lcars-lt-label"), m);
  }

  /* ── Channels ─────────────────────────────────────────────────── */

  readNote() {
    var ed = this.app.workspace.activeEditor;
    var text = ed && ed.editor ? ed.editor.getValue() : null;
    if (typeof text !== "string") { this.state.note = { pct: 0, text: "—", void: true }; return; }
    var words = text.trim() ? text.trim().split(/\s+/).length : 0;
    this.state.note = { pct: clamp01(words / this.scale("note")), text: String(words), void: false };
  }

  readMod() {
    var f = this.app.workspace.getActiveFile();
    var mtime = f && f.stat && f.stat.mtime;
    if (typeof mtime !== "number") { this.state.mod = { pct: 0, text: "—", void: true }; return; }
    var age = Date.now() - mtime;
    this.state.mod = { pct: clamp01(1 - (age - 60000) / 3540000), text: briefAge(age), void: false };
  }

  readDocks() {
    var n = this.app.workspace.getLeavesOfType("markdown").length;
    this.state.docks = { pct: clamp01(n / this.scale("docks")), text: String(n), void: false };
  }

  // BRDG: how long since a daily note was last edited or added. The bar
  // empties after 24 h on weekdays and 48 h on weekends (both settings).
  scale(ch) {
    var v = Number(this.settings["scale" + ch.charAt(0).toUpperCase() + ch.slice(1)]);
    return v > 0 ? v : SCALE[ch];
  }

  readBridge() {
    if (this.bridgeStamp === null) { this.state.brdg = { pct: 0, text: "—", void: true }; return; }
    var age = Math.max(0, Date.now() - this.bridgeStamp), S = this.settings, wd = new Date().getDay();
    var hrs = Math.max(1, Number(wd === 0 || wd === 6 ? S.brdgWeekendHours : S.brdgWeekdayHours) || 24);
    this.state.brdg = { pct: clamp01(1 - age / (hrs * 3600000)), text: briefAge(age), void: false };
  }

  // The folder comes from the setting, else the core Daily Notes plugin
  // (read once from .obsidian/daily-notes.json).
  dailyRoot() {
    var f = (this.settings.dailyFolder || "").trim() || this._coreDaily;
    return f ? f.replace(/^\/+|\/+$/g, "") : "";
  }
  inDaily(path) { var r = this.dailyRoot(); return !!r && !!path && path.indexOf(r + "/") === 0; }

  // A scan of the folder's notes on each change and once a minute. Reads
  // modification times from the index, never file contents.
  loadBridge() {
    var self = this;
    var run = function () {
      var stamp = null, now = Date.now();
      if (self.dailyRoot()) self.app.vault.getMarkdownFiles().forEach(function (f) {
        if (!self.inDaily(f.path)) return;
        var t = Math.max(f.stat.mtime || 0, f.stat.ctime || 0);
        if (t <= now + 60000 && (stamp === null || t > stamp)) stamp = t; // a stamp from the future is never fresh
      });
      self.bridgeStamp = stamp;
      self.readBridge(); self.paintAll();
    };
    if (this._coreDaily !== undefined || (this.settings.dailyFolder || "").trim()) { run(); return; }
    this.app.vault.adapter.read(this.app.vault.configDir + "/daily-notes.json").then(function (raw) {
      try { self._coreDaily = String(JSON.parse(raw).folder || ""); } catch (e) { self._coreDaily = ""; }
      run();
    }, function () { self._coreDaily = ""; run(); });
  }

  // TASK: open tasks counted from Obsidian's own index, with no file
  // reads. Counted per file once at load, then only the file that
  // changed is recounted.
  openIn(cache) {
    var n = 0, li = cache && cache.listItems;
    if (li) for (var i = 0; i < li.length; i++) if (li[i].task === " ") n++;
    return n;
  }

  setTaskCount(path, n) {
    var old = this.taskCounts.get(path) || 0;
    if (n) this.taskCounts.set(path, n); else this.taskCounts.delete(path);
    this.taskTotal += n - old;
    this.state.task = { pct: clamp01(this.taskTotal / this.scale("task")), text: String(this.taskTotal), void: false };
  }

  readTasks() {
    var app = this.app, self = this;
    this.taskCounts = new Map(); this.taskTotal = 0;
    app.vault.getMarkdownFiles().forEach(function (f) { self.setTaskCount(f.path, self.openIn(app.metadataCache.getFileCache(f))); });
    this.paintAll();
  }

  /* ── Standby and activity ─────────────────────────────────────── */

  startStandby() {
    var self = this;
    if (!this._wake) {
      var lastMove = 0;
      this._wake = function () {
        if (self._idleTimer) window.clearTimeout(self._idleTimer);
        if (document.body.classList.contains("lcars-idle")) self.sweep();
        document.body.classList.remove("lcars-idle");
        self._idleTimer = window.setTimeout(function () { document.body.classList.add("lcars-idle"); },
          Math.max(1, Number(self.settings.idleSeconds) || 30) * 1000);
      };
      this.registerDomEvent(document, "pointermove", function () {
        var n = Date.now(); if (n - lastMove < 1000) return; lastMove = n; self._wake();
      }, { passive: true });
      ["pointerdown", "keydown", "wheel", "input", "focusin"].forEach(function (ev) {
        self.registerDomEvent(document, ev, self._wake, { passive: true });
      });
      ["active-leaf-change", "file-open", "layout-change"].forEach(function (ev) {
        self.registerEvent(self.app.workspace.on(ev, self._wake));
      });
      this.register(function () { window.clearTimeout(self._idleTimer); });
    }
    this._wake();
  }

  // Coming back from standby plays every row whose behavior is "wake".
  sweep() {
    var self = this;
    document.querySelectorAll(".lcars-lt[data-mode='rest'][data-beh='wake']").forEach(function (b) { self.playRow(b); });
  }

  // The settings button: play every row at rest that waits to be played.
  playNow() {
    var self = this;
    document.querySelectorAll(".lcars-lt[data-mode='rest']").forEach(function (b) { if (b._beh && b._beh !== "constant") self.playRow(b); });
  }

  paintBusy() {
    var on = this.claims.size > 0 ||
      document.querySelector('[data-testid="chat-messages"] .tw-animate-pulse') !== null;
    if (document.body.classList.contains("lcars-busy") !== on) document.body.classList.toggle("lcars-busy", on);
  }

  exposeGlobals() {
    var self = this;
    window.lcarsActivity = {
      _owner: this,
      begin: function (n) { self.claims.add(String(n)); self.paintBusy(); },
      end: function (n) { self.claims.delete(String(n)); self.paintBusy(); },
      active: function () { return Array.from(self.claims); },
    };
    // The extension interface for a second plugin: apiVersion, the plugin,
    // and the hooks object it fills in. See the header of this file.
    // api.statuses is experimental until 1.0.
    var me = this;
    var api = { apiVersion: 2, statuses: {
      list: function () { return me.settings.alerts.statuses.map(function (st) { return { id: st.id, label: st.label, hand: st.hand !== false, raised: me.raised.has(st.id) }; }); },
      active: function () { return Array.from(me.raised.values()).map(function (r) { return { id: r.id, source: r.source, since: r.since, until: r.until }; }); },
      raise: function (id, o) { return me.raise(id, Object.assign({ source: "api" }, o)); },
      clear: function (id, o) { return me.clear(id, Object.assign({ source: "api" }, o)); },
    } };
    window.lcarsCompanion = { apiVersion: 1, plugin: this, hooks: this.hooks, api: api };
    window.dispatchEvent(new Event("lcars-companion-ready"));
    window.lcarsStardate = function (when) { return stardate(Number(self.settings.stardateYear) || 2401, when); };
    window.lcarsStardateString = function () { return self.stardateString(new Date()); };
  }
}

class ConfirmModal extends obsidian.Modal {
  constructor(app, title, text, label, onYes) { super(app); this.t = title; this.x = text; this.l = label; this.y = onYes; }
  onOpen() {
    var me = this;
    this.titleEl.setText(this.t);
    this.contentEl.createEl("p", { text: this.x });
    new obsidian.Setting(this.contentEl)
      .addButton(function (b) { b.setButtonText("Cancel").onClick(function () { me.close(); }); })
      .addButton(function (b) { b.setButtonText(me.l).setWarning().onClick(function () { me.close(); me.y(); }); });
  }
  onClose() { this.contentEl.empty(); }
}
class CompanionSettings extends obsidian.PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  // Redraws (settings that show or hide others) keep the scroll spot.
  // Every scrolling box from the tab up is saved and put back.
  display() {
    var boxes = [];
    for (var n = this.containerEl; n; n = n.parentElement) if (n.scrollTop > 0) boxes.push([n, n.scrollTop]);
    this.render();
    var put = function () { boxes.forEach(function (b) { b[0].scrollTop = b[1]; }); };
    put();
    window.requestAnimationFrame(put);
  }

  hide() {
    this.plugin.previewHosts.clear();
    this.plugin.tagEls.clear();
    this.plugin.demoEls.clear(); this.plugin.whyEls.clear();
    if (this.plugin.previewSince) new obsidian.Notice("Heads up: the lights preview is still on. It turns off by itself in 15 minutes.");
  }

  // The tab list. A second plugin can add tabs through hooks.settingsTabs:
  // it returns [{ id, name, render(el, ctx) }]. They sit before Statuses.
  tabList() {
    var p = this.plugin, list = [["general", "General"], ["banner", "Banner"], ["statuses", "Statuses"], ["lights", "Running lights"]], extra = [];
    try { var h = p.hooks && p.hooks.settingsTabs; if (h) extra = h.call(p) || []; } catch (e) { extra = []; }
    extra.forEach(function (t) {
      if (t && t.id && t.name && typeof t.render === "function") list.push([t.id, t.name, t]);
    });
    return list;
  }

  // A group: a heading, one line saying what it does, then its controls
  // straight on the page. The tag marks the group the lights are using
  // right now: CURRENT, or a yellow PREVIEW while the master preview runs.
  group(name, desc, phase) {
    var p = this.plugin, st = new obsidian.Setting(this.containerEl).setName(name).setHeading();
    if (desc) st.setDesc(desc);
    if (phase) {
      var tag = st.nameEl.createSpan({ cls: "lcars-set-current" });
      tag.dataset.phase = phase;
      p.tagEls.add(tag);
      p.paintTag(tag);
    }
    return this.containerEl;
  }

  // A color field: a palette role to follow, or any CSS color or variable.
  // An empty value falls back to dflt, or stays empty when allowEmpty (then
  // emptyLabel names what empty means: None, or Same as Nominal).
  colorField(obj, key, name, desc, dflt, allowEmpty, el, emptyLabel, redrawOnToggle, bkey) {
    var self = this, p = this.plugin, dd, tx, btn;
    var roleOf = function (v) {
      var m = /^var\(\s*(--[\w-]+)/.exec(String(v || ""));
      return m && PALETTE_ROLES.some(function (r) { return r[0] === m[1]; }) ? m[1] : "";
    };
    var setv = async function (v) {
      var was = !!obj[key];
      obj[key] = v;
      if (btn) btn.setDisabled(!v);
      self.legendUpdate();
      await p.save();
      if (redrawOnToggle && was !== !!v) self.display();
    };
    var row = new obsidian.Setting(el || this.containerEl).setName(name).setDesc(desc || "");
    if (bkey) this.badge(row, bkey);
    row.addDropdown(function (d) {
      dd = d;
      var opts = { "": emptyLabel || "Custom" };
      if (key === "light") opts.none = "None (resting colors only)";
      PALETTE_ROLES.forEach(function (r) { opts[r[0]] = r[1]; });
      d.addOptions(opts).setValue(obj[key] === "none" ? "none" : roleOf(obj[key])).onChange(async function (v) {
        if (v === "none") { tx.setValue("none"); await setv("none"); return; }
        if (!v) { tx.setValue(""); await setv(allowEmpty ? "" : dflt); return; }
        var r = PALETTE_ROLES.filter(function (x) { return x[0] === v; })[0];
        var val = "var(" + v + ", " + r[2] + ")";
        tx.setValue(val); await setv(val);
      });
    });
    row.addText(function (t) {
      tx = t;
      t.setPlaceholder(dflt || "").setValue(obj[key] || "").onChange(async function (v) {
        v = v.trim(); if (!v && !allowEmpty) v = dflt;
        dd.setValue(v === "none" ? "none" : roleOf(v)); await setv(v);
      });
    });
    // A way back to empty (the inherited value, or none).
    if (allowEmpty) row.addExtraButton(function (b) {
      btn = b;
      b.setIcon("rotate-ccw").setTooltip(emptyLabel || "Clear").setDisabled(!obj[key]).onClick(async function () {
        tx.setValue(""); dd.setValue(""); await setv(""); b.setDisabled(true);
      });
    });
  }

  // The legend under the Colors heading: what the settings produce. The
  // chips use the same mix the lights use, so the glow and peak are real.
  // "How the lights work": the parts of the row, named, and how the pieces fit together.
  anatomy(el) {
    var p = this.plugin;
    var d = el.createEl("details", { cls: "lcars-set-anatomy" });
    d.open = p._anatOpen !== false;
    d.addEventListener("toggle", function () { p._anatOpen = d.open; });
    d.createEl("summary", { text: "How the lights work" });
    var L = this._lookFn ? this._lookFn() : p.settings.lights;
    var strip = d.createDiv({ cls: "lcars-anat" });
    strip.style.setProperty("--lg-empty", L.colorEmpty || LIGHTS.colorEmpty);
    strip.style.setProperty("--lg-c1", L.colorRest || LIGHTS.colorRest);
    strip.style.setProperty("--lg-c2", L.restColorMode === "single" ? (L.colorRest || LIGHTS.colorRest) : (L.colorRest2 || LIGHTS.colorRest2));
    strip.style.setProperty("--lg-light", L.light || "var(--lcars-bh-text, #F3F4F7)");
    for (var i = 0; i < 14; i++) {
      var cell = strip.createSpan({ cls: "lcars-anat-seg " + (i < 3 || i > 10 ? "is-empty" : "is-lit") });
      if (i >= 3 && i < 11) cell.style.setProperty("--k", String((i - 3) / 7));
    }
    // The moving light runs over the lit segments; its label travels with it, on its own line.
    strip.createSpan({ cls: "lcars-anat-light" });
    var names = d.createDiv({ cls: "lcars-anat-names" });
    names.createSpan({ text: "Empty color", attr: { style: "grid-column: 1 / 4" } });
    names.createSpan({ text: "Color 1 to Color 2", attr: { style: "grid-column: 4 / 11" } });
    names.createSpan({ text: "Empty", attr: { style: "grid-column: 12 / 15; text-align: right" } });
    var run = d.createDiv({ cls: "lcars-anat-run" });
    run.createSpan({ cls: "lcars-anat-runlabel" }).createSpan({ text: "Light" });
    var ul = d.createEl("ul", { cls: "lcars-anat-list" });
    ul.createEl("li", { text: "Resting lights: what the row does when there is no event to show. Light style, Direction and Behavior are for these." });
    var extra = this.tabList().filter(function (t) { return t[2]; })[0];
    if (extra) ul.createEl("li", { text: "Event bar: while an event is coming up or on, the same row fills with the event, in the same colors and layout. Its fill and movement are on the " + extra[1] + " tab." });
    ul.createEl("li", { text: "The state that is showing (Nominal, Red alert and so on) decides the colors. Pick one under Look of to edit its colors." });
    ul.createEl("li", { text: "Resting glow is how lit a segment sits between pulses; Peak is how lit it gets at the top of one." });
  }

  legend(el) {
    this._legend = el.createDiv({ cls: "lcars-set-legend" });
    this.legendUpdate();
  }

  legendUpdate() {
    var box = this._legend; if (!box) return;
    var L = this._lookFn ? this._lookFn() : this.plugin.settings.lights, single = L.restColorMode === "single";
    var rMax = Math.max(5, Math.min(100, Number(L.restBrightness) || 70)) / 100;
    var rMin = Math.min(rMax, Math.max(0, Number(L.restMin) || 0) / 100);
    var st = box.style;
    st.setProperty("--lg-empty", L.colorEmpty || LIGHTS.colorEmpty);
    st.setProperty("--lg-c1", L.colorRest || LIGHTS.colorRest);
    st.setProperty("--lg-c2", L.colorRest2 || LIGHTS.colorRest2);
    st.setProperty("--lg-light", L.light || "transparent");
    st.setProperty("--lg-max", String(rMax));
    st.setProperty("--lg-min", String(rMin));
    var key = (single ? "s" : "m") + (L.light ? "l" : "");
    if (box._ck !== key) {
      box._ck = key;
      box.empty();
      var chips = [["empty", "Empty"], ["c1", single ? "Color" : "Color 1"]];
      if (!single) chips.push(["c2", "Color 2"]);
      chips.push(["glow", "Resting glow"]);
      if (L.light) chips.push(["light", "Light"]);
      chips.push(["peak", "Peak"]);
      chips.forEach(function (c) {
        var chip = box.createDiv({ cls: "lcars-set-chip", attr: { "data-k": c[0] } });
        chip.createEl("i");
        chip.createSpan({ text: c[1] });
      });
    }
  }

  // An expandable section (a native details element). Its body is a container for settings.
  section(name, desc, phase) {
    var p = this.plugin, open = p._openSecs || (p._openSecs = new Set()), key = "acc:" + name;
    var d = this.containerEl.createEl("details", { cls: "lcars-set-acc" });
    d.open = open.has(key);
    d.addEventListener("toggle", function () { if (d.open) open.add(key); else open.delete(key); });
    var sum = d.createEl("summary");
    sum.createSpan({ text: name });
    if (phase) {
      var tag = sum.createSpan({ cls: "lcars-set-current" });
      tag.dataset.phase = phase;
      p.tagEls.add(tag);
      p.paintTag(tag);
    }
    if (desc) d.createDiv({ cls: "setting-item-description lcars-set-acc-desc", text: desc });
    return d.createDiv({ cls: "lcars-set-body" });
  }

  // What a second plugin says about a setting, if it relates to or changes it.
  sandboxNote(key, obj) {
    var h = this.plugin.hooks && this.plugin.hooks.settingNote, r = "";
    try { if (h) r = h.call(this.plugin, key, obj) || ""; } catch (e) { r = ""; }
    if (!r) return null;
    var o = typeof r === "string" ? { note: r } : r;
    return o.note ? { note: String(o.note), level: o.level === "dependent" ? "dependent" : "modified" } : null;
  }

  // A badge beside a setting's name and the sentence under its description.
  // Orange: the second plugin changes this. Red: this needs the second plugin.
  badge(setting, key, obj) {
    var n = this.sandboxNote(key, obj);
    if (!n || !setting) return setting;
    var cls = "is-" + n.level;
    if (setting.nameEl) setting.nameEl.createSpan({ cls: "lcars-sbx-badge " + cls, text: n.level === "dependent" ? "Needs Sandbox" : "Sandbox", attr: { title: n.note } });
    if (setting.descEl) setting.descEl.createDiv({ cls: "lcars-sbx-note " + cls, text: n.note });
    return setting;
  }

  toggle(name, desc, key, redraw) {
    var s = this.plugin.settings, self = this, p = this.plugin;
    var st = new obsidian.Setting(this.containerEl).setName(name).setDesc(desc).addToggle(function (t) {
      t.setValue(!!s[key]).onChange(async function (v) { s[key] = v; await p.save(); if (redraw) self.display(); });
    });
    this.badge(st, "banner." + key);
    return st;
  }

  text(name, desc, key, ph) {
    var s = this.plugin.settings, p = this.plugin;
    var st = new obsidian.Setting(this.containerEl).setName(name).setDesc(desc).addText(function (t) {
      t.setPlaceholder(ph || "").setValue(String(s[key] || "")).onChange(async function (v) { s[key] = v; await p.save(); });
    });
    this.badge(st, "banner." + key);
    return st;
  }

  render() {
    var root = this.containerEl, p = this.plugin, self = this;
    root.empty();
    this._legend = null; this._lookFn = null;
    root.addClass("lcars-set-page");
    // The settings pane has padding at the top. A sticky bar sticks inside it, and the page
    // scrolls through the gap above the bar. The bar takes the padding's space and sticks
    // flush with the top, so nothing shows above it.
    var sc = root;
    while (sc && sc !== document.body) {
      var oy = getComputedStyle(sc).overflowY;
      if (oy === "auto" || oy === "scroll") break;
      sc = sc.parentElement;
    }
    var padTop = sc && sc !== document.body ? parseFloat(getComputedStyle(sc).paddingTop) || 0 : 0;
    root.style.setProperty("--lcars-set-pad", padTop + "px");
    p.previewHosts.clear();
    p.tagEls.clear();
    p.demoEls.clear(); p.whyEls.clear();
    var tabs = this.tabList();
    if (!tabs.some(function (t) { return t[0] === p._tab; })) p._tab = tabs[0][0];
    var bar = root.createDiv({ cls: "lcars-set-tabs", attr: { role: "tablist" } });
    tabs.forEach(function (t) {
      var on = t[0] === p._tab;
      var b = bar.createEl("button", { cls: "lcars-set-tab" + (on ? " is-active" : ""), text: t[1], attr: { role: "tab", "aria-selected": String(on) } });
      if (t[2] && t[2].badge) b.createSpan({ cls: "lcars-sbx-badge is-" + (t[2].level === "modified" ? "modified" : "dependent"), text: t[2].badge });
      b.addEventListener("click", function () {
        if (p._tab === t[0]) return;
        p._tab = t[0]; self.render(); root.scrollTop = 0;
      });
    });
    // A second plugin that changes this page says so here, under the tab bar so the bar can stay flush at the top.
    var sb = null;
    try { sb = p.hooks && p.hooks.settingsBanner ? p.hooks.settingsBanner.call(p) : null; } catch (e) { sb = null; }
    if (sb && sb.text) {
      var bn = root.createDiv({ cls: "lcars-sbx-banner", attr: { role: "note" } });
      bn.createSpan({ cls: "lcars-sbx-badge is-modified", text: sb.label || "Sandbox" });
      var bt = bn.createDiv({ cls: "lcars-sbx-text" });
      bt.createDiv({ text: sb.text });
      var lg = bt.createDiv({ cls: "lcars-sbx-legend" });
      lg.createSpan({ cls: "lcars-sbx-badge is-modified", text: "Orange" });
      lg.appendText(" the Sandbox changes it.  ");
      lg.createSpan({ cls: "lcars-sbx-badge is-dependent", text: "Red" });
      lg.appendText(" it needs the Sandbox to work.");
    }
    var active = tabs.filter(function (t) { return t[0] === p._tab; })[0];
    if (active[2]) {
      var ctx = {
        plugin: p, group: function (n, d, ph) { return self.group(n, d, ph); },
        // An expandable section: its body is where the settings go. Open ones stay open across redraws.
        section: function (n, d, ph) { return self.section(n, d, ph); },
        // A line that stays under the tab bar while the page scrolls. level: "dependent" (red) or "modified" (orange).
        notice: function (text, level) {
          var nb = root.createDiv({ cls: "lcars-sbx-banner is-sticky is-" + (level === "modified" ? "modified" : "dependent"), attr: { role: "note" } });
          nb.createSpan({ cls: "lcars-sbx-badge is-" + (level === "modified" ? "modified" : "dependent"), text: level === "modified" ? "Sandbox" : "Needs Sandbox" });
          nb.createSpan({ text: text });
          return nb;
        },
        save: function () { return p.save(); }, redraw: function () { self.display(); },
      };
      try { active[2].render(root, ctx); }
      catch (e) { new obsidian.Setting(root).setName("This tab could not load").setDesc(String(e && e.message || e)); }
    }
    else if (p._tab === "general") this.renderGeneral();
    else if (p._tab === "banner") this.renderBanner();
    else if (p._tab === "lights") this.renderLights();
    else this.renderStatuses();
  }

  renderGeneral() {
    var p = this.plugin, s = p.settings, L = s.lights, root = this.containerEl, self = this;
    // Style Manager's All motion off wins: while it is on, the controls here do nothing.
    var smOff = document.body.classList.contains("lcars-motion-off");
    if (s.showInSidebar) {
      this.group("Ship", "The name and registry on the banner.");
      this.text("Ship's name", "", "shipName", "USS LEXICON");
      this.text("Ship's registry", "", "shipRegistry", "NX-85011");
    }
    this.group("Current status", "The one status raised by hand. Clicking CONDITION opens the same list, clicking the status word toggles red alert, and every status has a command. A link such as obsidian://lcars-status?raise=ID works too. Raised statuses are not saved across a restart.");
    new obsidian.Setting(root).setName("Current status").setDesc("None, or the one status raised by hand.")
      .addDropdown(function (d) {
        var opts = { "": "None" };
        p.handStatuses().forEach(function (st) { opts[st.id] = st.label; });
        d.addOptions(opts).setValue(p.topRaised()).onChange(function (v) { p.pick(v); });
      });
    this.group("Standby", "The frame dims after a while with no input.");
    new obsidian.Setting(root).setName("Standby after (seconds)").setDesc("How long with no input before the frame dims.")
      .addText(function (t) {
        t.setValue(String(s.idleSeconds)).onChange(async function (v) { s.idleSeconds = Number(v) || 30; await p.save(); });
      });
    new obsidian.Setting(root).setName("Dim in standby").setDesc("Turn the dimming off without changing the delay.")
      .addToggle(function (t) {
        t.setDisabled(smOff);
        t.setValue(!!L.fx.idleDim).onChange(async function (v) { L.fx.idleDim = v; await p.save(); });
      });

    // Everything that can be switched off to find what is slow, in one place.
    this.group("Debug", "Turn things off one at a time to find what is slow. Motion runs only when its switch here and the Style Manager switch both allow it.");
    if (smOff) new obsidian.Setting(root).setName("Motion is off in Style Manager")
      .setDesc("The LCARS Palette switch All motion off is on, so the switches here have no effect. Switch it off in Style Manager to use them.");
    new obsidian.Setting(root).setName("Pause all motion in the banner")
      .setDesc("Stops every animation in the banner: the lights, the CONDITION text effects and the tactical meters.")
      .addToggle(function (t) {
        t.setValue(!!s.motionOff).onChange(async function (v) { s.motionOff = v; await p.save(); });
      });
    new obsidian.Setting(root).setName("Running lights animation").setDesc("The resting light styles. Off leaves the row still.")
      .addToggle(function (t) {
        t.setDisabled(smOff);
        t.setValue(!!L.fx.rest).onChange(async function (v) { L.fx.rest = v; await p.save(); });
      });
    new obsidian.Setting(root).setName("Why the lights look like this right now").setDesc("The status showing, and where each value comes from: the Running lights default, the status, or the event bar. It updates while this page is open.").setHeading();
    p.renderLiveWhy(root);
    // A second plugin adds its own switches here (the ticker's chase, blink and so on).
    try {
      var dh = p.hooks && p.hooks.debugRows;
      if (dh) dh.call(p, root, { plugin: p, save: function () { return p.save(); }, redraw: function () { self.display(); }, smOff: smOff });
    } catch (e) { new obsidian.Setting(root).setName("A debug switch could not load").setDesc(String(e && e.message || e)); }

    this.group("Interface", "Pieces of the LCARS look that need a script. The theme snippet draws them; these switches decide whether the plugin runs the script.");
    [["titleBlocks", "Note title blocks", "Draw the block and stripe beside each note's title."],
     ["ribbonRoles", "Ribbon roles", "Color each left-ribbon button by where its pane opens: red right sidebar, blue editor, gray left sidebar. The plugin learns each button the first time you press it."]
    ].forEach(function (r) {
      new obsidian.Setting(root).setName(r[1]).setDesc(r[2]).addToggle(function (t) {
        t.setValue(!!s[r[0]]).onChange(async function (v) { s[r[0]] = v; await p.save(); p.applyInterface(); });
      });
    });

    this.group("About");
    new obsidian.Setting(root).setName("Version").setDesc(String(p.manifest && p.manifest.version || ""));
  }

  renderBanner() {
    var p = this.plugin, s = p.settings, root = this.containerEl, self = this;
    this.group("Banner", "The bridge banner at the top of the left sidebar: ship name, stardate, condition and the ship status readout.");
    this.toggle("Show the banner", "Off removes the banner. The settings below, and the ship's name on General, then do not apply.", "showInSidebar", true);
    if (!s.showInSidebar) return;
    new obsidian.Setting(root).setName("Where").setDesc("Inside the left sidebar, or across the sidebar and the ribbon with the ribbon icons below it.")
      .addDropdown(function (d) {
        d.addOptions({ sidebar: "In the left sidebar", span: "Across the left sidebar and the ribbon" })
          .setValue(s.spanRibbon ? "span" : "sidebar").onChange(async function (v) { s.spanRibbon = v === "span"; await p.save(); });
      });
    this.toggle("All caps", "Show the banner text in capitals. Off shows it as you typed it.", "allCaps");

    this.group("Stardate", "The stardate and the time beside it.");
    this.toggle("Stardate block", "Show the stardate on the bottom line.", "showStardate", true);
    if (s.showStardate) {
      new obsidian.Setting(root).setName("Beside the stardate").setDesc("Show the hours (0200), the date (10.05), or nothing.")
        .addDropdown(function (d) {
          d.addOptions({ hours: "Hours", date: "Date", none: "Nothing" }).setValue(s.timeMode)
            .onChange(async function (v) { s.timeMode = v; await p.save(); });
        });
      this.text("Stardate year", "The in-universe year. 2401 gives the 78xxx band (Picard seasons 2-3).", "stardateYear", "2401");
    }

    this.group("Condition", "The CONDITION label. Click it to raise red alert.");
    this.toggle("Condition block", "Show CONDITION: NOMINAL. Click it to raise RED ALERT.", "showCondition");

    this.group("Ship status", "The subsystem readout under the banner.");
    this.toggle("Ship status block", "Show the subsystem readout under the banner.", "showStatus", true);
    if (s.showStatus) {
      this.toggle("Tactical readouts", "While yellow, red, gray or blue shows, the block shows that state's own meters (shields, phasers, power and so on) instead of the channels below. They are for show, not measurements.", "showTactical");
      // Each channel has a switch, and its own settings sit right under it while it is on.
      var chans = [
        ["note", "NOTE: words in the open note", [["scaleNote", "Full bar at (words)", "Word count that fills the bar. Default 2000.", "2000"]]],
        ["mod", "MOD: time since the open note was saved", []],
        ["docks", "DOCKS: open note panes", [["scaleDocks", "Full bar at (panes)", "Open note panes that fill the bar. Default 6.", "6"]]],
        ["task", "TASK: unchecked tasks in the vault", [["scaleTask", "Full bar at (tasks)", "Open tasks in the vault that fill the bar. Default 3000.", "3000"]]],
        ["brdg", "BRDG: time since a daily note was edited", [
          ["dailyFolder", "Daily notes folder", "BRDG watches this folder and every folder inside it (Daily/2026/10 counts). Leave empty to use the core Daily Notes folder.", "Daily"],
          ["brdgWeekdayHours", "Weekday limit (hours)", "The bar is empty after this long without a daily note edit or addition, Monday to Friday.", "24"],
          ["brdgWeekendHours", "Weekend limit (hours)", "The same, Saturday and Sunday.", "48"]]],
      ];
      chans.forEach(function (c) {
        new obsidian.Setting(root).setName(c[1]).addToggle(function (t) {
          t.setValue(!!s.channels[c[0]]).onChange(async function (v) { s.channels[c[0]] = v; await p.save(); self.display(); });
        });
        if (s.channels[c[0]]) c[2].forEach(function (f) { self.text(f[1], f[2], f[0], f[3]).settingEl.addClass("lcars-set-sub"); });
      });
    }

    this.group("Custom embed", "Your own content in the banner, in Markdown or HTML.");
    var embedOn = s.embedPosition !== "off";
    new obsidian.Setting(root).setName("Use a custom embed").setDesc("Off shows nothing of it.")
      .addToggle(function (t) {
        t.setValue(embedOn).onChange(async function (v) {
          if (!v) { s.embedLast = s.embedPosition; s.embedPosition = "off"; }
          else s.embedPosition = s.embedLast && s.embedLast !== "off" ? s.embedLast : "below";
          await p.save(); self.display();
        });
      });
    if (embedOn) {
      new obsidian.Setting(root).setName("Placement").setDesc("Where your own content goes, relative to the ship status block.")
        .addDropdown(function (d) {
          d.addOptions({ above: "Above ship status", below: "Below ship status", replace: "Instead of ship status" })
            .setValue(s.embedPosition).onChange(async function (v) { s.embedPosition = v; await p.save(); });
        });
      var cs = new obsidian.Setting(root).setName("Content").setDesc("Markdown or HTML. Links, embeds, and Dataview blocks render as in a note.");
      cs.settingEl.addClass("lcars-wide");
      cs.addTextArea(function (t) {
        t.setValue(s.embedMarkdown).onChange(async function (v) { s.embedMarkdown = v; await p.save(); });
        t.inputEl.rows = 14; t.inputEl.addClass("lcars-code");
      });
    }
  }

  renderLights() {
    var p = this.plugin, s = p.settings, L = s.lights, self = this, root = this.containerEl;
    var save = function () { return p.save(); };
    this.group("Running lights", "The default look of the row of lights under the banner. Off removes the row. Each status can have its own look (Statuses, Custom config), and an event can add its own on top.");
    this.anatomy(root);
    this.badge(new obsidian.Setting(root).setName("Show running lights").setDesc("Off hides the row and stops its animations."), "lights.enabled")
      .addToggle(function (t) {
        t.setValue(L.enabled !== false).onChange(async function (v) { L.enabled = v; await save(); self.display(); });
      });
    if (L.enabled === false) return;
    var green = s.alerts.statuses.filter(function (x) { return x.id === "green"; })[0] || s.alerts.statuses[s.alerts.statuses.length - 1];
    p._lookId = green.id;
    this.lookEditor(root, this.lookTarget(green));
  }

  // The look of one thing: the default (Nominal), a status (its own custom config), or an event bar of a status.
  lookTarget(st, B, sit, sitName) {
    var p = this.plugin, L = p.settings.lights, nomSt = p.statusById("green");
    var pickLook = function (o) { var r = {}; LOOK_KEYS.forEach(function (k) { var v = o[k]; if (v !== undefined && v !== null && v !== "") r[k] = v; }); return r; };
    if (B) return {
      kind: "bar", st: st, obj: B, isDefault: false, inheritName: st.label + "'s look", key: st.id + ":" + sit, noPreview: true, label: st.label + ", " + sitName,
      lookObj: function () { return Object.assign({}, p.look(st), pickLook(B)); },
      base: function (k) { return p.look(st)[k]; },
    };
    if (st.id === "green") return {
      kind: "default", st: st, obj: L, isDefault: true, inheritName: "", key: "default", previewState: st.id, label: "the resting lights",
      lookObj: function () { return p.look(st); },
      base: function (k) { return L[k]; },
    };
    return {
      kind: "status", st: st, obj: st, isDefault: false, inheritName: nomSt ? nomSt.label : "Nominal", key: st.id, previewState: st.id, label: st.label,
      lookObj: function () { return p.look(st); },
      base: function (k) { return L[k]; },
    };
  }

  lookEditor(root, T) {
    var p = this.plugin, s = p.settings, L = s.lights, self = this;
    var save = function () { return p.save(); };
    // Every look has the same options. The target says whose they are: the default (the Running lights tab), a
    // status, or an event bar. An empty value on a status or an event bar means "same as the layer below".
    var st = T.st, nom = T.isDefault, nomName = T.inheritName, obj = T.obj;
    this._lookFn = T.lookObj;
    var restore = this.containerEl; this.containerEl = root;
    try {
    var fresh = function (key) { if (nom) return true; var v = obj[key]; return v !== undefined && v !== null && v !== ""; };
    var eff = function (key) { return T.lookObj()[key]; };
    // A tinted state's lights start in the state's own color, so its colors are "same as the state's color".
    var tinted = T.kind === "status" && st.lightTint !== false && !!st.color;
    var inh = function (key) { return tinted && (key === "colorRest" || key === "colorRest2" || key === "restColorMode") ? "the state's color" : nomName; };
    var row = function (name, desc, key) {
      var d = desc || "";
      var r = new obsidian.Setting(root).setName(name).setDesc(d);
      self.badge(r, "look." + key);
      if (!nom) r.addExtraButton(function (b) {
        r._reset = b;
        b.setIcon("rotate-ccw").setTooltip("Same as " + inh(key)).setDisabled(!fresh(key)).onClick(async function () { obj[key] = ""; await save(); self.display(); });
      });
      return r;
    };
    var touched = function (r) { if (r._reset) r._reset.setDisabled(false); };
    var drop = function (name, desc, key, opts, redraw) {
      var r = row(name, desc, key);
      r.addDropdown(function (d) {
        var shown = eff(key);
        if (key === "restDir" && !shown) shown = (DESIGN[String(eff("rest"))] || {}).dir || "right";
        if (key === "restBeh" && !shown) shown = "constant";
        d.addOptions(opts).setValue(String(shown)).onChange(async function (v) {
          obj[key] = (key === "restSpeed" && nom) || key === "restCount" ? Number(v) : v;
          touched(r); self.legendUpdate(); await save();
          if (redraw) self.display();
        });
      });
    };
    var num = function (name, desc, key) {
      var r = row(name, desc, key);
      r.addText(function (t) {
        t.setValue(String(eff(key))).onChange(async function (v) {
          var x = Number(v);
          if (v.trim() !== "" && isFinite(x)) { obj[key] = x; touched(r); self.legendUpdate(); await save(); }
        });
      });
    };
    // A slider with its value beside it. Same inherit rules as the other levers.
    var slider = function (name, desc, key, min, max, step) {
      var r = row(name, desc, key), out = null, v0 = Number(eff(key));
      if (!isFinite(v0)) v0 = min;
      r.addSlider(function (sl) {
        sl.setLimits(min, max, step).setValue(Math.max(min, Math.min(max, v0))).setDynamicTooltip().onChange(async function (v) {
          obj[key] = v; if (out) out.textContent = String(v);
          touched(r); self.legendUpdate(); await save();
        });
      });
      out = r.controlEl.createSpan({ cls: "lcars-slider-val", text: String(v0) });
    };
    var color = function (key, name, desc, dflt, inheritOnly) {
      if (nom) self.colorField(L, key, name, desc, dflt, !!inheritOnly, root, key === "light" ? "Default" : inheritOnly ? "None" : "Custom", key === "light", "look." + key);
      else self.colorField(obj, key, name, desc, tinted && (key === "colorRest" || key === "colorRest2") ? st.color : (L[key] || dflt), true, root, "Same as " + inh(key), key === "light", "look." + key);
    };

    if (!T.noPreview) {
      var pinned = p.addPreview(root, T.previewKind || "rest", T.previewState);
      if (pinned && pinned.addClass) pinned.addClass("is-pinned");
      p.renderWhy(root, T.previewState, T.previewKind || "rest");
    }

    var pat = String(eff("rest")), dz = DESIGN[pat] || {};
    var KEYS = {
      motion: ["rest", "restDir", "restBeh", "restInterval", "restSpeed", "restLength", "restCount", "restSpacing", "restConcentration", "restBusy", "restFlow", "restMix"],
      color: ["restColorMode", "colorRest", "colorRest2", "light", "restMin", "restBrightness", "colorEmpty"],
      layout: ["shape", "align", "width", "segments", "gap", "caps"],
    };
    var changed = function (g) {
      return KEYS[g].some(function (k) {
        if (g === "layout" || nom) return String(L[k] === undefined || L[k] === null ? "" : L[k]) !== String(LIGHTS[k] === undefined ? "" : LIGHTS[k]);
        return fresh(k);
      }) || (!nom && g !== "layout" && !!(obj.lookCustom && obj.lookCustom[g]));
    };
    var tabs = p._ltabs || (p._ltabs = {});
    var sub = tabs[T.key] || "motion";
    if (["motion", "color", "layout"].indexOf(sub) < 0) sub = "motion";
    var sbar = root.createDiv({ cls: "lcars-set-tabs lcars-subtabs", attr: { role: "tablist" } });
    [["motion", "Motion"], ["color", "Color"], ["layout", "Layout"]].forEach(function (t) {
      var on = t[0] === sub;
      var b = sbar.createEl("button", { cls: "lcars-set-tab" + (on ? " is-active" : ""), text: t[1], attr: { role: "tab", "aria-selected": String(on) } });
      b.addEventListener("click", function () { if (tabs[T.key] !== t[0]) { tabs[T.key] = t[0]; self.display(); } });
    });
    // A state follows Nominal for a part until it is set to Custom.
    var custom = function (g) { return nom || !!(obj.lookCustom && obj.lookCustom[g]) || KEYS[g].some(fresh); };
    var follow = function (g, label, withStatus) {
      if (nom) return true;
      var cur = custom(g) ? "custom" : (withStatus && tinted ? "status" : "inherit");
      var opts = { inherit: "Default (inherit from " + nomName.toUpperCase() + ")" };
      if (withStatus && T.kind === "status") opts.status = "Status color";
      opts.custom = "Custom";
      new obsidian.Setting(root).setName(label).setDesc("Default follows " + nomName + ". Custom gives this " + (T.kind === "bar" ? "event bar" : "status") + " its own.")
        .addDropdown(function (d) {
          d.addOptions(opts).setValue(cur).onChange(async function (v) {
            obj.lookCustom = Object.assign({}, obj.lookCustom, { [g]: v === "custom" });
            if (v !== "custom") KEYS[g].forEach(function (k) { obj[k] = ""; });
            if (withStatus && T.kind === "status") st.lightTint = v === "status";
            await save(); self.display();
          });
        });
      return cur === "custom";
    };
    if (sub === "motion" && follow("motion", "Motion")) {
    var kindRow = row("Light style", "The kind of light. Some kinds have presets.", "rest");
    kindRow.addDropdown(function (d) {
      var o = {}; Object.keys(STYLE_KINDS).forEach(function (k) { o[k] = STYLE_KINDS[k][0]; });
      d.addOptions(o).setValue(styleKind(String(eff("rest")))).onChange(async function (v) {
        if (styleKind(String(eff("rest"))) === v) return;
        obj.rest = STYLE_KINDS[v][1][0]; touched(kindRow); self.legendUpdate(); await save(); self.display();
      });
    });
    var kindNow = styleKind(String(eff("rest")));
    if (STYLE_KINDS[kindNow][1].length > 1) {
      var presetOpts = {}; STYLE_KINDS[kindNow][1].forEach(function (r) { presetOpts[r] = STYLE_PRESETS[r]; });
      drop("Preset", "A preset sets the look. Change anything below, or use Reset to go back.", "rest", presetOpts, true);
    }
    if (["wide", "warp", "pulses"].indexOf(String(eff("rest"))) >= 0) root.createDiv({ cls: "lcars-sbx-note is-modified", text: "Experimental: this light type redraws every frame and may slow down your computer, especially a slow one. If Obsidian feels sluggish, pick another type." });
    if (pat !== "off") {
      // A number that may be empty (empty uses the style's own value).
      var optnum = function (name, desc, key, ph) {
        var r = row(name, desc, key);
        r.addText(function (t) {
          t.setPlaceholder(ph).setValue(fresh(key) && obj[key] !== "" ? String(obj[key]) : "").onChange(async function (v) {
            var x = Number(v); obj[key] = v.trim() === "" ? "" : (isFinite(x) && x > 0 ? Math.min(100, x) : obj[key]);
            touched(r); await save();
          });
        });
      };
      new obsidian.Setting(root).setName("Show advanced settings").setDesc("Length, lights in the group, spacing, rings and waves. The style already has good values for these.")
        .addToggle(function (t) { t.setValue(!!L.showAdvanced).onChange(async function (v) { L.showAdvanced = v; await save(); self.display(); }); });
      var adv = !!L.showAdvanced;
      if (adv) new obsidian.Setting(root).setName("Reset this style").setDesc("Keeps the style and preset you picked. Puts its direction, behavior, speed, length, count, spacing, activity and Light color back to the preset's values.")
        .addButton(function (b) {
          b.setButtonText("Reset").setWarning().onClick(function () {
            new ConfirmModal(self.app, "Reset " + T.label, "This overwrites every change you made to this style's direction, behavior, speed, length, count, spacing, activity and Light color. The style itself and your colors stay. It cannot be undone.", "Reset", async function () {
              ["restDir", "restBeh", "restInterval", "restSpeed", "restLength", "restCount", "restSpacing", "restConcentration", "restBusy", "restFlow", "restMix", "light"].forEach(function (k) { obj[k] = nom && LIGHTS[k] !== undefined ? LIGHTS[k] : ""; });
              await save(); self.display();
            }).open();
          });
        });
      if (adv && dz.len) optnum("Length (% of the row)", pat === "chase" || pat === "comet" ? "How long the tail is. Empty uses " + dz.len + "." : pat === "pulses" ? "How wide a ring is. Empty uses " + dz.len + "." : "How wide the band is. Empty uses " + dz.len + ".", "restLength", String(dz.len));
      if (adv && (pat === "chase" || pat === "comet")) {
        drop("Lights in the group", "One light, or two to four running together, one behind the other.", "restCount", { 1: "1", 2: "2", 3: "3", 4: "4" }, true);
        if (Number(eff("restCount")) > 1) optnum("Spacing (% of the row)", "The gap between the lights in the group. Empty keeps them just clear of each other's tails. A value smaller than Length makes the lights overlap, and where they overlap the brighter one shows.", "restSpacing", "auto");
      }
      if (adv && pat === "pulses") drop("Rings at once", "How many rings of light are flowing at the same time.", "restCount", { 1: "1", 2: "2", 3: "3", 4: "4" }, true);
      if (adv && pat === "warp") drop("Waves across the row", "How many crests of the wave fit along the path.", "restCount", { 1: "1", 2: "2", 3: "3", 4: "4" }, true);
      if (pat === "cascade") new obsidian.Setting(root).setName("Ripple on click").setDesc("Clicking the lights sends a ripple out from that segment. Up to three at once. It also runs the ticker's click action, if you set one.")
        .addToggle(function (t) { t.setValue(L.ripple !== false).onChange(async function (v) { L.ripple = v; await save(); }); });
      if (pat === "cascade") drop("Flow", "Which way the flicker travels, so the dots look like data moving. Up and down need 2 or more rows. None leaves each dot on its own.", "restFlow", { "": "None (random)", right: "Left to right", left: "Right to left", down: "Top to bottom", up: "Bottom to top" }, true);
      if (pat === "cascade" && String(eff("restFlow") || "")) drop("Random flicker", "Some dots ignore the flow and flicker at random while the rest stream.", "restMix", { "": "None", low: "A little", mid: "Some", high: "A lot" }, true);
      if (pat === "cascade") drop("Processing activity", "How much of the row is lit at once, and how fast it flickers. Standby flickers about half the segments now and then; High keeps most of the row glowing; Maximum is High running faster and uses the most processor time.", "restBusy", BUSY_NAMES);
      if (pat !== "cascade") drop("Speed", "", "restSpeed", { 0.5: "Slow", 1: "Normal", 2: "Fast" });

      if (dz.dir) drop("Direction", "Left to right, right to left, out from the middle, in to the middle, or back and forth.", "restDir", RESTS_DIR, true);
      drop("Behavior", "Constant keeps playing. The others play once and then rest at the resting glow.", "restBeh", RESTS_BEH, true);
      var beh = String(eff("restBeh") || "constant");
      if (beh === "interval") num("Every (seconds)", "How long between plays.", "restInterval");
      if (beh !== "constant") new obsidian.Setting(root).setName("Play now").setDesc("Plays it now on every row at rest, to see what it does.")
        .addButton(function (b) { b.setButtonText("Play now").onClick(function () { p.playNow(); }); });
    }

    }
    if (sub === "color" && follow("color", "Colors", true)) {
    this.group("Colors", "Every segment sits on the empty color. The pattern moves the resting colors between the resting glow and the peak. A Light color adds a separate light on top: the colors then sit at the resting glow and the light rises to the peak. While a status tints the lights (see Statuses), its color takes the place of these.");
    if (pat !== "off") this.legend(root);
    if (pat !== "off") {
      drop("Resting colors", "", "restColorMode", { single: "One color", random: "Two colors, mixed at random", gradient: "Two colors, as a gradient" }, true);
      var single = String(eff("restColorMode")) === "single";
      color("colorRest", single ? "Color" : "Color 1", "", LIGHTS.colorRest);
      if (!single) color("colorRest2", "Color 2", "", LIGHTS.colorRest2);
      if (["cascade", "heartbeat", "breathe"].indexOf(pat) < 0) color("light", "Light color", "Colors only the head of a moving light, or the crest of a band. The tail keeps the resting colors, so white here over a gradient gives a white head with a colored tail. Default is white for Chase, Comet and Scanner, and none for the other styles. None turns the separate light off.", "", true);
      slider("Resting glow (%)", "How lit a segment looks between pulses. 0 is fully dark; higher keeps every segment glowing.", "restMin", 0, 100, 1);
      slider("Peak (%)", "How lit a segment looks at the top of a pulse.", "restBrightness", 5, 100, 1);
    }
    color("colorEmpty", "Empty color", "Unlit segments, and the base under every light.", LIGHTS.colorEmpty);

    }
    // Layout. The default has the whole shape of the row. A status or an event bar can only change the number of rows.
    if (sub === "layout" && !nom) {
      new obsidian.Setting(root).setName("Rows").setDesc("The number of rows of lights. Empty follows " + nomName + ". An event bar's rows beat the status's, unless the status overrides the event bar.")
        .addDropdown(function (d) {
          var o = { "": "Same as " + nomName + " (" + (Number(T.base("cascadeRows")) || 1) + ")", 1: "1 row", 2: "2 rows", 3: "3 rows", 4: "4 rows (experimental)", 5: "5 rows (experimental)" };
          d.addOptions(o).setValue(obj.cascadeRows === undefined || obj.cascadeRows === "" ? "" : String(obj.cascadeRows)).onChange(async function (v) { obj.cascadeRows = v === "" ? "" : Number(v); await save(); self.display(); });
        });
    }
    // Layout is shared by every state.
    if (sub === "layout" && nom) {
    var gdrop = function (name, desc, key, opts, redraw) {
      self.badge(new obsidian.Setting(root).setName(name).setDesc(desc), "layout." + key).addDropdown(function (d) {
        d.addOptions(opts).setValue(String(L[key])).onChange(async function (v) { L[key] = v; await save(); if (redraw) self.display(); });
      });
    };
    var gnum = function (name, desc, key, min, max, step) {
      var r = new obsidian.Setting(root).setName(name).setDesc(desc), out = null, v0 = Number(L[key]);
      if (!isFinite(v0)) v0 = min;
      r.addSlider(function (sl) {
        sl.setLimits(min, max, step).setValue(Math.max(min, Math.min(max, v0))).setDynamicTooltip().onChange(async function (v) {
          L[key] = v; if (out) out.textContent = String(v); await save();
        });
      });
      out = r.controlEl.createSpan({ cls: "lcars-slider-val", text: String(v0) });
    };
    new obsidian.Setting(root).setName("The shape and size of the row").setDesc("This is the default. A status or an event bar can only change the number of rows (in its own Custom config).");
    var formNow = L.shape === "B" ? (L.form === "rect" ? "rect" : "pill") : (L.form === "circle" ? "circle" : "segments");
    var rs = new obsidian.Setting(root).setName("Row style").setDesc("Segments, one continuous pill or rectangle, or round dots that fill the width.");
    self.badge(rs, "layout.rowstyle");
    var rpick = rs.controlEl.createDiv({ cls: "lcars-caps" });
    [["segments", "Segments"], ["pill", "Pill"], ["rect", "Rectangle"], ["circle", "Circle"]].forEach(function (c) {
      var btn = rpick.createEl("button", { cls: "lcars-cap" + (formNow === c[0] ? " is-on" : ""), attr: { title: c[1], "aria-label": c[1], "aria-pressed": String(formNow === c[0]) } });
      btn.appendChild(svgNode(ROW_SVG[c[0]]));
      btn.createSpan({ text: c[1] });
      btn.addEventListener("click", async function () {
        var seg = L.shapeSeg && L.shapeSeg !== "B" ? L.shapeSeg : "A";
        if (c[0] === "pill" || c[0] === "rect") { if (L.shape !== "B") L.shapeSeg = L.shape; L.shape = "B"; L.form = c[0] === "rect" ? "rect" : ""; }
        else { if (L.shape === "B") L.shape = seg; L.form = c[0] === "circle" ? "circle" : ""; }
        await save(); self.display();
      });
    });
    if (formNow === "segments") {
      var cr = new obsidian.Setting(root).setName("Caps").setDesc("How the ends of the segments are shaped.");
      var pick = cr.controlEl.createDiv({ cls: "lcars-caps" });
      [["lcars", "LCARS end caps"], ["round", "Round"], ["square", "Square"]].forEach(function (c) {
        var btn = pick.createEl("button", { cls: "lcars-cap" + (L.caps === c[0] ? " is-on" : ""), attr: { title: c[1], "aria-label": c[1], "aria-pressed": String(L.caps === c[0]) } });
        btn.appendChild(svgNode(CAP_SVG[c[0]]));
        btn.createSpan({ text: c[1] });
        btn.addEventListener("click", async function () { L.caps = c[0]; await save(); self.display(); });
      });
    }
    // Width 100 is the full-width mode, and then there is nothing to align.
    var full = L.align === "full", wv = full ? 100 : Math.max(10, Math.min(100, Number(L.width) || 80));
    var wset = new obsidian.Setting(root).setName("Width (%)").setDesc("How much of the row the lights take. At 100 they fill it and alignment does not apply."), wout = null;
    wset.addSlider(function (sl) {
      sl.setLimits(10, 100, 1).setValue(wv).setDynamicTooltip().onChange(async function (v) {
        if (wout) wout.textContent = String(v);
        var was = L.align === "full";
        if (v >= 100) { L.align = "full"; }
        else { L.width = v; if (was) L.align = "centered"; }
        await save();
        if (was !== (L.align === "full")) self.display();
      });
    });
    wout = wset.controlEl.createSpan({ cls: "lcars-slider-val", text: String(wv) });
    if (!full) gdrop("Alignment", "Where the lights sit when they are narrower than the row.", "align", { centered: "Centered", left: "Left" });
    if (L.shape !== "B" && L.form !== "circle") gnum("Segments", "How many lights the row is made of.", "segments", 8, 40, 1);
    if (L.form === "circle") gnum("Spacing (px)", "The space between dots. The dots are one size and repeat to fill the width.", "gap", 0, 12, 1);
    else if (L.shape !== "B") gnum("Gap (px)", "The space between segments.", "gap", 0, 4, 1);
    gdrop("Rows", "The number of rows of lights. More rows give smaller dots. Works with every style, and looks best with Circle.", "cascadeRows", { 1: "1 row", 2: "2 rows", 3: "3 rows", 4: "4 rows (experimental)", 5: "5 rows (experimental)" }, true);
    if (Number(L.cascadeRows) >= 4) root.createDiv({ cls: "lcars-sbx-note is-modified", text: "Experimental: 4 and 5 rows make very small dots, and the banner gets taller unless Height is set to Two lines of text." });
    if (Number(L.cascadeRows) >= 2) gdrop("Height", "Grows with the rows keeps each row the same size and makes the banner taller. Two lines of text fixes the lights to the height of two lines of the ticker label, so more rows mean smaller dots.", "rowsHeight", { auto: "Grows with the rows", fixed: "Two lines of text" });
    }
    } finally { this.containerEl = restore; }
  }

  // One tab per status across the top; the page has three sections: General,
  // Triggers (how it is raised and how it ends) and Appearance.
  // The status list, highest priority first. Each status is a card that expands.
  renderStatuses() {
    var p = this.plugin, A = p.settings.alerts, self = this;
    var save = function () { return p.save(); };
    this.group("Statuses", "Highest priority first. A status sets the CONDITION word and its look. The first status in the list that is raised, or whose trigger matches, wins. Nominal is the fallback.");
    var open = p._openSecs || (p._openSecs = new Set());
    A.statuses.forEach(function (st, idx) { self.statusCard(st, idx, self.containerEl, open); });
    new obsidian.Setting(this.containerEl).setName("Add a status").setDesc("Goes just above Nominal. Give it a name, a color and a way to be raised.")
      .addButton(function (b) {
        b.setButtonText("Add status").onClick(function () {
          var id = "c" + Date.now().toString(36), g = A.statuses.findIndex(function (x) { return x.id === "green"; });
          A.statuses.splice(g < 0 ? A.statuses.length : g, 0, ST({ id: id, label: "NEW STATUS" }));
          open.add("status:" + id);
          save().then(function () { self.display(); });
        });
      });
  }

  statusCard(st, idx, root, open) {
    var p = this.plugin, A = p.settings.alerts, self = this;
    var save = function () { return p.save(); };
    var d = root.createEl("details", { cls: "lcars-set-status" });
    d.open = open.has("status:" + st.id);
    d.addEventListener("toggle", function () { if (d.open) open.add("status:" + st.id); else open.delete("status:" + st.id); });
    var sum = d.createEl("summary");
    var dot = sum.createSpan({ cls: "lcars-set-dot" }); dot.style.background = st.color;
    sum.appendText(" " + (idx + 1) + ". " + st.label);
    if (st.desc) sum.createSpan({ cls: "lcars-set-note", text: " — " + st.desc });
    var sbxNote = self.sandboxNote("status:" + st.id, st);
    if (sbxNote) sum.createSpan({ cls: "lcars-sbx-badge is-" + sbxNote.level, text: sbxNote.level === "dependent" ? "Needs Sandbox" : "Sandbox", attr: { title: sbxNote.note } });
    var el = d.createDiv(), prevC = this.containerEl;
    this.containerEl = el;
    try {
    var row = function (name, desc) { return new obsidian.Setting(el).setName(name).setDesc(desc || ""); };
    var num = function (name, desc, key, min) {
      row(name, desc).addText(function (t) {
        t.setValue(String(st[key])).onChange(async function (v) {
          var x = Number(v); if (v.trim() !== "" && isFinite(x) && x >= min) { st[key] = x; await save(); }
        });
      });
    };
    var sbxNote = self.sandboxNote("status:" + st.id, st);

    // General: always open.
    this.group("General", "");
    if (sbxNote) el.createDiv({ cls: "lcars-sbx-note is-" + sbxNote.level, text: sbxNote.note });
    row("Id", st.id + ". Used in commands and links, for example obsidian://lcars-status?raise=" + st.id + ".");
    row("Name", "Shown after CONDITION:").addText(function (t) {
      t.setValue(st.label).onChange(async function (v) { st.label = v.trim() || st.label; await save(); });
    });
    var why = row("Description", "Your own note: why this status exists.");
    why.settingEl.addClass("lcars-wide");
    why.addTextArea(function (t) {
      t.setPlaceholder("Why did I set this up?").setValue(st.desc || "").onChange(async function (v) { st.desc = v.trim(); await save(); });
      t.inputEl.rows = 2;
    });
    var move = function (by) {
      var to = idx + by; if (to < 0 || to >= A.statuses.length) return;
      A.statuses.splice(to, 0, A.statuses.splice(idx, 1)[0]);
      save().then(function () { self.display(); });
    };
    var acts = row("Priority", "Number " + (idx + 1) + " of " + A.statuses.length + ". Higher in the list wins when several statuses apply.");
    acts.addExtraButton(function (b) { b.setIcon("arrow-up").setTooltip("Higher priority").setDisabled(idx === 0).onClick(function () { move(-1); }); });
    acts.addExtraButton(function (b) { b.setIcon("arrow-down").setTooltip("Lower priority").setDisabled(idx === A.statuses.length - 1).onClick(function () { move(1); }); });
    if (["red", "gray", "blue", "yellow", "green"].indexOf(st.id) < 0) {
      acts.addExtraButton(function (b) {
        b.setIcon("trash").setTooltip("Delete this status").onClick(function () {
          A.statuses.splice(idx, 1); save().then(function () { self.display(); });
        });
      });
    }
    // Preview: the label as it will look, replayable, or on the real banner.
    var box = el.createDiv({ cls: "lcars-set-preview lcars-set-demo" });
    var demo = box.createSpan({ cls: "lcars-bh-cond lcars-bh-dim lcars-condition" });
    demo.appendChild(svgNode(ICON)); demo.appendText("CONDITION: ");
    demo.createSpan({ cls: "lcars-bh-value lcars-bh-condval" }).createSpan({ cls: "lcars-bh-condtext" });
    var rec = { el: demo, st: st }; p.demoEls.add(rec); styleCond(demo, st, true);
    row("Preview", "Plays the color, fade and effect from Appearance. Test on banner shows it in the sidebar for 10 seconds.")
      .addButton(function (b) { b.setButtonText("Replay").onClick(function () { styleCond(demo, st, true); }); })
      .addButton(function (b) { b.setButtonText("Test on banner").onClick(function () { p.testStatus(st.id); }); });

    // Triggers: how it is raised, when it starts, how it ends.
    this.group("Triggers", "How this status is raised and how it ends.");
    if (st.id === "green") row("Nominal is the fallback", "It shows when nothing else applies, so it has no triggers.");
    else {
      row("Can be raised by hand", "Puts it in the CONDITION menu and gives it a command. Off leaves it to events.").addToggle(function (t) {
        t.setValue(st.hand !== false).onChange(async function (v) { st.hand = v; await save(); self.display(); });
      });
      if (st.hand !== false) {
        st.exit = Object.assign({ mode: "cleared", minutes: 30, at: "17:00" }, st.exit);
        var modes = Object.assign({}, EXIT_MODES);
        if (!(p.hooks && p.hooks.eventEnd) && st.exit.mode !== "event") delete modes.event;
        self.badge(row("Exit", "How a hand-raised status ends by itself. A link or script can give one raise its own time."), "status.exit", st).addDropdown(function (dd) {
          dd.addOptions(modes).setValue(st.exit.mode).onChange(async function (v) { st.exit.mode = v; await save(); self.display(); });
        });
        if (st.exit.mode === "after") {
          row("Ends after (minutes)").addText(function (t) {
            t.setValue(String(st.exit.minutes)).onChange(async function (v) { var x = Number(v); if (v.trim() !== "" && isFinite(x) && x > 0) { st.exit.minutes = x; await save(); } });
          });
        }
        if (st.exit.mode === "clock") {
          row("Ends at (24-hour time)", "For example 17:00. Raised after that time, it is not raised at all.").addText(function (t) {
            t.setPlaceholder("17:00").setValue(String(st.exit.at)).onChange(async function (v) { if (/^\d{1,2}:\d{2}$/.test(v.trim())) { st.exit.at = v.trim(); await save(); } });
          });
        }
        var sr = row("Start time (cron)", "Raises this status on a schedule. Five fields: minute, hour, day of month, month, weekday. For example 0 9 * * 1-5 is 9:00 on weekdays. Obsidian has to be open at that time; when it opens, a start inside the exit window (After a time) is still honored. Empty means no schedule. ");
        sr.descEl.createEl("a", { text: "Open crontab.guru", href: "https://crontab.guru", attr: { target: "_blank", rel: "noopener" } });
        var note = sr.descEl.createDiv({ cls: "lcars-set-note" });
        var showCron = function (v) { note.textContent = !v ? "" : cronParse(v) ? "Valid." : "Not a valid cron time."; };
        sr.addText(function (t) {
          t.setPlaceholder("0 9 * * 1-5").setValue(st.start || "").onChange(async function (v) { st.start = v.trim(); showCron(st.start); await save(); });
        });
        showCron(st.start);
      }
      // A second plugin adds its own rows here (what raises this status).
      try {
        var sf = p.hooks && p.hooks.statusFields;
        if (sf) sf.call(p, st, el, { plugin: p, save: save, redraw: function () { self.display(); } });
      } catch (e) { row("Could not load", String(e && e.message || e)); }
    }

    // Appearance: color, text and animation.
    this.group("Appearance", "How the CONDITION word looks. The lights follow this color if you choose Status color under Running lights.");
    this.colorField(st, "color", "Color", "A palette color, or any CSS color or variable.", STATUS_BASE.color, false, el, "Custom");
    row("Color behavior", "Persistent keeps the color. Fade to default lets it settle into another color after a while.").addDropdown(function (dd) {
      dd.addOptions({ persistent: "Persistent", fade: "Fade to default" }).setValue(st.fade).onChange(async function (v) { st.fade = v; await save(); self.display(); });
    });
    if (st.fade === "fade") {
      num("Fade starts after (seconds)", "How long the color holds when this status begins.", "fadeAfter", 0);
      num("Fade takes (seconds)", "", "fadeTime", 0.1);
      row("Fade to", "The color it settles into. The plain text color by default (white).").addText(function (t) {
        t.setValue(st.fadeTo || "").onChange(async function (v) { st.fadeTo = v.trim() || STATUS_BASE.fadeTo; await save(); });
      });
      if (st.behavior === "scan") row("", "Scan draws its own color, so the fade does not apply to it.");
    }
    if (st.id !== "green") row("Override the event bar", "When the calendar has an event bar running, this status keeps its own look instead (Red alert does). Off: the event bar adds its layout, progress, speed and light style over this status's colors.").addToggle(function (t) {
      t.setValue(!!st.overrideBar).onChange(async function (v) { st.overrideBar = v; await save(); });
    });
    row("Text effect", "How the word moves.").addDropdown(function (dd) {
      dd.addOptions(EFFECTS).setValue(st.behavior).onChange(async function (v) { st.behavior = v; await save(); self.display(); });
    });
    if (st.behavior !== "steady") {
      row("Effect speed").addDropdown(function (dd) {
        dd.addOptions(SPEEDS).setValue(st.speed).onChange(async function (v) { st.speed = v; await save(); self.display(); });
      });
      if (st.speed === "custom") {
        row("Custom duration", "One number is seconds per cycle, for example 2. Two numbers are milliseconds on, then off, for example 500, 300 (a hard blink). Nothing runs faster than 0.4 seconds a cycle.").addText(function (t) {
          t.setPlaceholder("2   or   500, 300").setValue(st.timing || "").onChange(async function (v) { st.timing = v.trim(); await save(); });
        });
      }
    }
    // Look: this status's own lights, with every option the Running lights tab has.
    this.group("Look", "The lights while this status shows. They start in the status color either way. Custom config gives this status its own style, speed, colors and rows; the options are the same as on the Running lights tab.");
    if (st.id === "green") row("Nominal is the default", "Nominal's look is the Running lights tab. Every other status follows it unless it has a Custom config.");
    else {
      var hasOwn = LOOK_KEYS.some(function (k) { var v = st[k]; return v !== undefined && v !== null && v !== ""; }) || !!(st.lookCustom && Object.keys(st.lookCustom).some(function (g) { return st.lookCustom[g]; }));
      var cc = st.customConfig !== undefined ? !!st.customConfig : hasOwn;
      row("Custom config", cc ? "On: the settings below are this status's own. Turning it off keeps them but uses the Running lights default." : "Off: this status uses the Running lights default.").addToggle(function (t) {
        t.setValue(cc).onChange(async function (v) { st.customConfig = v; await save(); self.display(); });
      });
      if (cc) {
        var holder = el.createDiv({ cls: "lcars-look-holder" }), built = false;
        var build = function () { if (built) return; built = true; self.lookEditor(holder, self.lookTarget(st)); };
        if (d.open) build();
        d.addEventListener("toggle", function () { if (d.open) build(); });
      }
    }

    // A second plugin adds its Event bar here (what the calendar does with the lights while this status shows).
    try {
      var eb = p.hooks && p.hooks.statusEventBar;
      if (eb) eb.call(p, st, el, { plugin: p, save: save, redraw: function () { self.display(); }, open: open, barEditor: function (holder, B, sit, sitName) { self.lookEditor(holder, self.lookTarget(st, B, sit, sitName)); } });
    } catch (e) { row("Could not load the event bar", String(e && e.message || e)); }
    } finally { this.containerEl = prevC; }
  }

}

module.exports = LcarsCompanion;
