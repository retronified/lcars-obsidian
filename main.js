/* LCARS for Obsidian.
   The plugin for the LCARS theme.

   - Banner: built from settings, mounted at the top of Notebook
     Navigator and of the core File Explorer.
   - Layout: rows 4px apart. The ship row and the stardate row are sized
     to fill the width (measured, not clamp()).
   - Stardate, clock, condition toggle, standby, activity registry, and
     the five subsystem channels all run on ONE set of timers and paint
     every mounted banner copy.
   The theme styles the banner too; this plugin keeps the class
   names they use, and every theme variable it reads has a fallback.

   Extension hooks (this.hooks, exposed as window.lcarsObsidian.hooks): a
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
   "lcars-obsidian-status-changed" on window with { id, change, source }.
   Also window.lcarsObsidian.api.statuses { list, active, raise, clear },
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
    // Two numbers are milliseconds on and off. Only the plain flash is an on/off effect, so only it gets the hard blink;
    // pulse, flicker, glow and scan keep their own motion and just take the combined length as their cycle.
    if (n.length >= 2) { if (st.behavior === "flash") onoff = { on: n[0], off: n[1] }; dur = (n[0] + n[1]) / 1000; }
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

// ─────────────────────────────────────────────────────────────
// Phone layout: the slab (2026-10-15 design; spec in the LCARS Interface
// project, "LCARS Mobile – Build Spec"). Reading view = thin capped bars
// with keys. Left drawer = one solid slate slab whose top and bottom edges
// run out as the same thin bars. Right drawer = thin bracket with a solid
// blue subframe, the view selector as a pill on top, and the details and
// sync in a footer strip. Everything is scoped to body.is-phone plus a
// class this plugin sets, so desktop and tablet never see it and the
// toggle works.
// Sizes are design units: 1 unit = 1/300 of the screen width. Keys are
// never shorter than 44px (tap size).
// One shared bottom offset (--ms-bot, Obsidian's own navbar-bottom-offset,
// which clears the Android navigation buttons) places the lower bar of the
// reading view, the left slab and the right bracket on the same line.
// Obsidian slides the note and the bottom bar sideways by the drawer's
// width, so each drawer is exactly as
// wide as its panel and the note keeps showing beside it. Obsidian's own
// backdrop would darken the note's bars and make them a different gray
// from the drawers', so the backdrop is made clear and the note's content
// is dimmed here instead, leaving the bars at full brightness. The
// connections between the drawer and the note's bars are drawn on the
// note's side (the note's bars lose their end cap and gain the inner curve
// while a drawer is open); the plugin mirrors Obsidian's is-left-sidedock-
// open and is-right-sidedock-open classes onto the body for this.
// Selectors come from the Mobile Frame snippet and Obsidian 1.14's own
// stylesheet; the right drawer's header and selector pill still need a
// check on a real phone.
// ─────────────────────────────────────────────────────────────
var MS_ID = "lcars-mobile-slab-style", MS_CLASS = "lcars-mobile-slab";
var MS_CSS = (function () {
  var u = function (n) { return "calc(" + n + " * var(--ms-u))"; };
  var B = "body.is-phone." + MS_CLASS, D = "  ";
  var L = [];
  var add = function (sel, decls) { L.push(sel + " {\n" + decls.map(function (d) { return D + d + ";"; }).join("\n") + "\n}"); };
  var L_ = B + " .workspace-drawer.mod-left", R_ = B + " .workspace-drawer.mod-right";

  add(B, [
    "--ms-u: calc(100vw / 300)",
    "--ms-frame: var(--lcars-frame, #2f3749)",
    "--ms-frame-r: var(--lcars-row-bg, #1e2229)",
    "--ms-bar: var(--lcars-ribbon-one-shot-icon, #6d748c)",
    "--ms-cap: var(--lcars-ribbon-one-shot-pressed-icon, #9ea5ba)",
    "--ms-key: var(--lcars-ribbon, #52596e)",
    "--ms-blue: #37a6d1",
    "--ms-blue-up: #41c4f7",
    "--ms-red: var(--lcars-ribbon-right-rest, #ae3e2c)",
    "--ms-text: var(--lcars-status-text, #d2d5df)",
    "--ms-salmon: var(--lcars-ribbon-right-bright, #ff977b)",
    "--ms-ink: #000000",
    /* The shared lines every screen hangs from */
    "--ms-top: max(" + u(14) + ", var(--view-header-top-offset, 0px))",
    "--ms-bot: var(--ms-bot-override, max(" + u(18) + ", var(--navbar-bottom-offset, 0px)))",
    "--ms-bar-h: " + u(12),
    "--ms-gap: " + u(5),
    "--ms-key-h: max(" + u(26) + ", 44px)",
    "--ms-key-w: " + u(44),
    "--ms-sel-h: max(" + u(22) + ", 40px)",
    "--ms-foot-h: max(" + u(24) + ", 40px)",
    "--ms-slab-w: " + u(236),
    "--ms-hdr-h: calc(var(--ms-bar-h) + var(--ms-gap) + var(--ms-key-h))",
    "--ms-nav-h: calc(var(--ms-hdr-h) + var(--ms-bot))",
    "--ms-fade: var(--lcars-fade-dur, 120ms) var(--lcars-fade-ease, linear)",
    /* Obsidian's own sizes, matched to the new bars */
    "--view-header-height: var(--ms-hdr-h)",
    "--navbar-height: var(--ms-nav-h)",
    "--navbar-width: auto",
    "--navbar-max-width: none",
    "--navbar-radius: 0",
    "--view-header-action-radius: 0",
    "--mobile-sidebar-radius: 0",
    "--view-top-fade-mask: none",
    "--view-bottom-fade-mask: none",
    "background: var(--ms-ink)"
  ]);

  /* ═══ 1. READING VIEW: thin capped bars and keys (concept B) ═══ */

  /* Top: the header holds the bar (::before) and, below it, the key row. Obsidian floats the header at the top offset (margin in floating mode, padding otherwise), so both are set here. */
  add(B + " .view-header", [
    "left: 0", "right: 0", "box-sizing: border-box",
    "margin-top: var(--ms-top) !important",
    "height: var(--ms-hdr-h) !important",
    "padding: calc(var(--ms-bar-h) + var(--ms-gap)) " + u(14) + " 0 !important",
    "gap: 0",
    "align-items: flex-start",
    "background: transparent !important",
    "border: 0 !important",
    "box-shadow: none !important",
    "backdrop-filter: none !important"
  ]);
  /* The bar: cap, gap, body, gap, cap. Outer corners rounded by the box. */
  var barGrad = "linear-gradient(to right, var(--ms-cap) 0 " + u(14) + ", transparent " + u(14) + " " + u(18) +
    ", var(--ms-bar) " + u(18) + " calc(100% - " + u(18) + "), transparent calc(100% - " + u(18) + ") calc(100% - " + u(14) + "), var(--ms-cap) calc(100% - " + u(14) + "))";
  add(B + " .view-header::before", [
    'content: ""', "position: absolute", "top: 0", "left: " + u(10), "right: " + u(10),
    "height: var(--ms-bar-h)", "border-radius: " + u(6), "background: " + barGrad, "pointer-events: none"
  ]);
  /* Stardate: a black cut in the bar just left of the right end cap, as wide as its text. (The first version used a negative offset written as -calc(), which is invalid, so the browser ignored it and the tag fell into the key row.) */
  add(B + " .view-header::after", [
    'content: var(--padd-stardate, "78756.2")', "position: absolute", "top: 0", "right: " + u(28), "height: var(--ms-bar-h)", "box-sizing: border-box",
    "padding: 0 " + u(5), "display: flex", "align-items: center", "white-space: nowrap",
    "background: var(--ms-ink)", "color: var(--ms-text)", "font-family: var(--lcars-label-font, 'Helvetica Neue', sans-serif)",
    "font-size: " + u(10), "letter-spacing: 0.12em", "line-height: 1", "pointer-events: none"
  ]);
  add(B + " .view-header > *", ["position: relative", "z-index: 2"]);
  add(B + " .view-header .view-header-left, " + B + " .view-header .view-actions", [
    "background: transparent !important", "border: 0 !important", "box-shadow: none !important",
    "backdrop-filter: none !important", "border-radius: 0 !important", "padding: 0", "height: var(--ms-key-h)"
  ]);
  add(B + " .view-header .view-actions", ["gap: var(--ms-gap)", "margin-left: auto"]);
  add(B + " .view-header .view-actions::after", ["display: none !important"]);
  /* Keys: slate pill, black icon */
  add(B + " .view-header .view-action", [
    "width: var(--ms-key-w)", "height: var(--ms-key-h)", "border-radius: 999px !important",
    "background: var(--ms-key) !important", "border: 0 !important", "box-shadow: none", "backdrop-filter: none !important",
    "--icon-color: #000", "--icon-color-hover: #000", "--icon-color-active: #000", "--icon-color-focus: #000", "color: #000",
    "transition: background-color var(--ms-fade)"
  ]);
  add(B + " .view-header .view-action:active", ["background: var(--ms-blue-up) !important", "transition: none"]);
  /* Outline opens the right drawer: dark red. Reading mode on: blue. */
  add(B + " .view-header .view-actions .view-action:nth-last-child(3)", ["background: var(--ms-red) !important"]);
  add(B + " .workspace-leaf-content[data-mode=\"preview\"] .view-header .view-actions .view-action:nth-last-child(2)", ["background: var(--ms-blue) !important"]);

  /* Bottom: key row above the bar, and the bar a shared offset above the screen's bottom edge, clear of the Android navigation buttons. */
  add(B + " .mobile-navbar", [
    "left: 0", "right: 0", "width: auto !important", "max-width: none !important", "margin: 0 !important", "box-sizing: border-box",
    "padding: 0 " + u(14) + " calc(var(--ms-bar-h) + var(--ms-gap) + var(--ms-bot)) !important",
    "height: var(--ms-nav-h) !important",
    "border-radius: 0 !important", "background: transparent !important", "box-shadow: none !important",
    "backdrop-filter: none !important", "border: 0 !important"
  ]);
  add(B + " .mobile-navbar::before", [
    'content: ""', "position: absolute", "bottom: var(--ms-bot)", "left: " + u(10), "right: " + u(10),
    "height: var(--ms-bar-h)", "border-radius: " + u(6), "background: " + barGrad, "pointer-events: none"
  ]);
  add(B + " .mobile-navbar::after", ["display: none !important"]);
  add(B + " .mobile-navbar-actions", ["gap: var(--ms-gap)", "height: var(--ms-key-h)", "--icon-color: #000", "--icon-color-active: #000", "--icon-color-focus: #000"]);
  add(B + " .mobile-navbar-action", [
    "flex: 1 1 0", "width: auto", "height: var(--ms-key-h)", "margin: 0 !important", "border-radius: 999px",
    "background: var(--ms-key)", "transition: background-color var(--ms-fade)"
  ]);
  add(B + " .mobile-navbar-action .clickable-icon, " + B + " .mobile-navbar-action button", ["border-radius: 999px", "background: transparent !important"]);
  add(B + " .mobile-navbar-action:nth-child(3)", ["background: var(--ms-blue)"]);
  add(B + " .mobile-navbar-action:active, " + B + " .mobile-navbar-action.mobile-tap", ["background: var(--ms-blue-up)", "opacity: 1", "transition: none"]);
  add(B + " .mobile-navbar-tabs-number, " + B + " .mobile-navbar-action .navbar-action-flair", ["color: #000", "opacity: 1"]);

  /* Note colors */
  add(B + " .workspace-leaf-content[data-type=\"markdown\"]", ["background: var(--ms-ink)"]);

  /* Dim the note beside an open drawer the way stock Obsidian does, but only its content and keys; the bars stay at full brightness so they match the drawers. */
  var ANY = B + ":is(.lcars-ms-left-open, .lcars-ms-right-open)";
  add(B + " .workspace-drawer-backdrop", ["background: transparent !important", "backdrop-filter: none !important"]);
  add(B + " .mod-root .view-content, " + B + " .mod-root .view-header > *, " + B + " .mobile-navbar-actions", ["transition: opacity 150ms ease-out"]);
  add(ANY + " .mod-root .view-content, " + ANY + " .mod-root .view-header > *, " + ANY + " .mobile-navbar-actions", ["opacity: 0.4"]);

  /* ═══ 2. LEFT DRAWER: THE SLAB ═══ */
  /* Obsidian paints the drawer, its fades and the view selector's backdrop from this one variable; on the left drawer it is the slab color, so no black boxes and no fade to black. The backdrop that dims the note is Obsidian's own. */
  add(L_, [
    "--mobile-sidebar-background: var(--ms-frame)",
    "width: var(--ms-slab-w) !important", "min-width: 0 !important", "max-width: none !important",
    "border-radius: 0", "box-shadow: none", "border: 0", "background: transparent !important"
  ]);
  /* The slab itself: solid slate, big rounded outer corners on the left. */
  add(L_ + " .workspace-drawer-inner", [
    "position: relative", "box-sizing: border-box", "flex: none", "width: 100%",
    "margin: var(--ms-top) 0 var(--ms-bot)", "height: calc(100% - var(--ms-top) - var(--ms-bot))",
    "background-color: var(--ms-frame) !important", "box-shadow: 0 -1px 0 0 var(--ms-frame), 0 1px 0 0 var(--ms-frame)",
    "border-radius: " + u(26) + " 0 0 " + u(26), "padding: " + u(6) + " 0 " + u(6) + " 0"
  ]);
  /* Notebook Navigator's rows run the full width of the slab, edge to edge like the desktop. The scroll bar lives in a black strip down the right edge, so the rows end where the strip begins. */
  add(L_ + " .notebook-navigator", ["--nn-scroller-padding: 0px"]);
  /* Rows run the full width of the slab, to its right edge too; the scroll bar is left to Obsidian (or hidden with the Hider plugin). */
  add(L_ + " .nn-navigation-pane-scroller, " + L_ + " .nn-list-pane-scroller", ["padding: 0 !important", "background-color: var(--ms-frame) !important"]);
  add(L_ + " .notebook-navigator :is(.nn-navitem, .nn-shortcut-item)[data-path]:not(.nn-header)", ["margin-right: 0 !important", "margin-inline-end: 0 !important"]);
  add(L_ + " .workspace-leaf-content::after, " + L_ + " .nav-buttons-container::after, " + L_ + " .nn-pane-bottom-toolbar::before", ["display: none !important", "background: none !important"]);
  add(L_ + " .nn-mobile-toolbar", ["padding-left: " + u(10) + " !important", "padding-right: " + u(10) + " !important"]);
  /* The note, dimmed beside the slab, picks up the connection: its bars run flush to the slab with a small inner curve, and the left end cap goes. */
  var fil = function (pos, c) {
    return "radial-gradient(circle at " + c + ", transparent " + u(12) + ", var(--ms-frame) calc(" + u(12) + " + 0.5px)) no-repeat " + pos + " / " + u(12) + " " + u(12);
  };
  var barOnly = function (pos, size) {
    return "linear-gradient(to right, var(--ms-frame) 0 " + u(36) + ", transparent " + u(36) + " " + u(40) + ", var(--ms-bar) " + u(40) + ") no-repeat " + pos + " / " + size;
  };
  var LO = B + ".lcars-ms-left-open";
  add(LO + " .view-header::before", [
    "left: -2px", "top: -1px", "height: calc(" + u(24) + " + 1px)", "border-radius: 0",
    "background: " + fil("0 calc(" + u(12) + " + 1px)", "100% 100%") + ", " + barOnly("0 0", "100% calc(" + u(12) + " + 1px)")
  ]);
  add(LO + " .mobile-navbar::before", [
    "left: -2px", "height: " + u(24), "border-radius: 0",
    "background: " + fil("0 0", "100% 0") + ", " + barOnly("0 " + u(12), "100% " + u(12))
  ]);
  /* With the right drawer open the note's right end meets the drawer: no right end cap, and the bottom bar gets the slab's inner curve above it. */
  var RO = B + ".lcars-ms-right-open";
  var capL = "linear-gradient(to right, var(--ms-cap) 0 " + u(14) + ", transparent " + u(14) + " " + u(18) + ", var(--ms-bar) " + u(18) + ")";
  var capJ = "linear-gradient(to right, var(--ms-cap) 0 " + u(14) + ", transparent " + u(14) + " " + u(18) + ", var(--ms-bar) " + u(18) + " calc(100% - " + u(40) + "), transparent calc(100% - " + u(40) + ") calc(100% - " + u(36) + "), var(--ms-frame-r) calc(100% - " + u(36) + "))";
  add(RO + " .view-header::before", ["right: -2px", "border-radius: " + u(6) + " 0 0 " + u(6), "background: " + capL]);
  add(RO + " .mobile-navbar::before", [
    "right: -2px", "height: " + u(24), "border-radius: 0",
    "background: radial-gradient(circle at 0 0, transparent " + u(12) + ", var(--ms-frame-r) calc(" + u(12) + " + 0.5px)) no-repeat right 0 top 0 / " + u(12) + " " + u(12) + ", " + capJ + " no-repeat 0 " + u(12) + " / 100% " + u(12)
  ]);
  /* Everything inside sits on the slab, no black panels of its own. */
  add(L_ + " .workspace-drawer-header, " + L_ + " .workspace-drawer-tab-container, " + L_ + " .workspace-drawer-active-tab-container, " +
      L_ + " .workspace-drawer-tab-options, " + L_ + " .workspace-drawer-tab-select, " + L_ + " .workspace-leaf-content, " + L_ + " .nav-buttons-container", [
    "background: transparent !important", "backdrop-filter: none !important", "box-shadow: none !important"
  ]);
  add(L_ + " .workspace-drawer-header-name-text, " + L_ + " .workspace-drawer-vault-name", [
    "font-family: var(--lcars-label-font, var(--lcars-heading-font, 'Antonio', sans-serif))", "text-transform: uppercase", "letter-spacing: 0.08em", "color: var(--ms-cap)"
  ]);
  add(B + " .workspace-drawer .notebook-navigator", ["--nn-theme-mobile-bg: var(--ms-frame)"]);
  /* Notebook Navigator's toolbar buttons as keys (Android; on iOS the toolbar is at the bottom). */
  add(B + " .workspace-drawer .nn-mobile-toolbar", ["background: transparent !important", "border: 0 !important", "gap: var(--ms-gap)"]);
  add(B + " .workspace-drawer .nn-mobile-toolbar-pill, " + B + " .workspace-drawer .nn-mobile-toolbar-left, " + B + " .workspace-drawer .nn-mobile-toolbar-right", [
    "background: transparent !important", "border: 0 !important", "box-shadow: none !important"
  ]);
  /* Pure-circle buttons become pills: the icon centered, just a little room either side. The tap area is kept at 44px high with an invisible extension. */
  add(L_ + " .nn-mobile-toolbar-pill", ["gap: var(--ms-gap)", "justify-content: space-between !important", "padding: 0 " + u(2)]);
  add(B + " .workspace-drawer button.nn-mobile-toolbar-button", [
    "position: relative", "flex: 0 0 auto !important", "width: auto !important", "min-width: 0 !important",
    "height: max(" + u(22) + ", 36px) !important", "min-height: 0 !important", "padding: 0 14px !important",
    "border-radius: 999px !important", "background: var(--ms-key) !important", "transition: background-color var(--ms-fade)"
  ]);
  add(B + " .workspace-drawer button.nn-mobile-toolbar-button::before", ['content: ""', "position: absolute", "left: 0", "right: 0", "top: -4px", "bottom: -4px"]);
  add(L_ + " .workspace-drawer-header-icon, " + L_ + " .workspace-drawer-vault-actions .clickable-icon", [
    "width: auto !important", "min-width: 0 !important", "height: max(" + u(22) + ", 36px) !important", "padding: 0 14px !important",
    "border-radius: 999px !important", "background: var(--ms-key) !important", "color: #000", "--icon-color: #000",
    "display: flex", "align-items: center", "justify-content: center", "box-shadow: none !important"
  ]);
  add(B + " .workspace-drawer button.nn-mobile-toolbar-button svg:not(.nn-vault-icon-svg)", ["stroke: #000"]);
  add(B + " .workspace-drawer button.nn-mobile-toolbar-button.nn-mobile-toolbar-button-active", ["background: var(--ms-blue) !important"]);
  add(B + " .workspace-drawer button.nn-mobile-toolbar-button:active", ["background: var(--ms-blue-up) !important", "transition: none"]);
  /* View selector (both drawers): blue outline pill, in Obsidian's own spot */
  add(B + " .workspace-drawer .workspace-drawer-tab-select .workspace-tab-header-inner", [
    "background: transparent !important", "box-shadow: inset 0 0 0 1.5px var(--ms-blue) !important", "border-radius: 999px", "color: var(--ms-blue)", "--icon-color: var(--ms-blue)"
  ]);
  add(B + " .workspace-drawer .workspace-drawer-tab-select .workspace-tab-header-inner-title", [
    "font-family: var(--lcars-label-font, var(--lcars-heading-font, 'Antonio', sans-serif))", "text-transform: uppercase", "letter-spacing: 0.08em"
  ]);
  /* Left drawer: the Notebook Navigator button is solid blue with black type. */
  add(L_ + " .workspace-drawer-tab-select .workspace-tab-header-inner", [
    "background: var(--ms-blue) !important", "box-shadow: none !important", "color: #000", "--icon-color: #000"
  ]);
  add(B + " .workspace-drawer .workspace-drawer-tab-options-list", [
    "background: var(--ms-ink) !important", "box-shadow: inset 0 0 0 1.5px var(--ms-blue) !important", "border-radius: " + u(18) + " !important"
  ]);

  /* ═══ 3. RIGHT DRAWER: A LIGHT-GRAY SLAB FRAMING A BLACK WINDOW (the "gap" junction) ═══ */
  /* The top bar passes over from the reading view with an end cap; the slab hangs below it behind a thin gap and carries the lower bar into an elbow up the right edge. Inside, Obsidian's own layout: header (details, sync) on top, the window, the view selector below. */
  add(R_, [
    "--mobile-sidebar-background: var(--ms-frame-r)",
    "width: " + u(246) + " !important", "min-width: 0 !important", "max-width: none !important", "border-radius: 0", "box-shadow: none", "border: 0",
    "background: transparent !important", "padding: 0"
  ]);
  add(R_ + "::before", [
    'content: ""', "position: absolute", "left: 0", "right: 0", "top: var(--ms-top)", "height: var(--ms-bar-h)",
    "background: " + [
      "radial-gradient(circle at " + u(6) + " " + u(6) + ", var(--ms-cap) " + u(6) + ", transparent calc(" + u(6) + " + 0.5px)) no-repeat right " + u(12) + " top 0 / " + u(12) + " " + u(12),
      "radial-gradient(circle at " + u(6) + " " + u(6) + ", var(--ms-cap) " + u(6) + ", transparent calc(" + u(6) + " + 0.5px)) no-repeat right " + u(10) + " top 0 / " + u(12) + " " + u(12),
      "linear-gradient(var(--ms-cap), var(--ms-cap)) no-repeat right " + u(16) + " top 0 / " + u(2) + " " + u(12),
      "linear-gradient(var(--ms-bar), var(--ms-bar)) no-repeat left 0 top 0 / calc(100% - " + u(28) + ") 100%"
    ].join(", "),
    "pointer-events: none", "z-index: 2"
  ]);
  add(R_ + " .workspace-drawer-inner", [
    "position: absolute", "box-sizing: border-box", "left: 0", "right: 0",
    "top: calc(var(--ms-top) + var(--ms-bar-h) + " + u(6) + ")", "bottom: var(--ms-bot)",
    "background: var(--ms-frame-r) !important", "border-radius: " + u(18) + " " + u(18) + " " + u(26) + " 0",
    "padding: " + u(6) + " 0 0 0 !important"
  ]);
  /* Header: details and sync on the gray, in black type. */
  add(R_ + " .workspace-drawer-header, " + R_ + " .workspace-drawer-header *", ["background: transparent !important", "box-shadow: none !important", "backdrop-filter: none !important"]);
  add(R_ + " .workspace-drawer-header", [
    "padding-left: " + u(14) + " !important", "padding-right: " + u(16) + " !important",
    "padding-top: " + u(8) + " !important", "padding-bottom: " + u(8) + " !important", "gap: " + u(12)
  ]);
  add(R_ + " .workspace-drawer-header-name-text", [
    "font-family: var(--lcars-heading-font, 'Antonio', sans-serif)", "letter-spacing: 0.06em", "text-transform: uppercase", "color: var(--ms-text)"
  ]);
  add(R_ + " .workspace-drawer-header-info", ["color: var(--ms-cap)", "letter-spacing: 0.06em", "text-transform: uppercase", "margin-top: " + u(6) + " !important"]);
  /* Sync indicator: a black disc with a colored mark: blue at rest, orange while working, red on error. */
  add(R_ + " .workspace-drawer-header-icon", [
    "background: #000 !important", "border-radius: 999px !important", "color: var(--ms-blue)", "--icon-color: var(--ms-blue)", "padding: 0", "align-items: center", "justify-content: center"
  ]);
  add(R_ + " .sync-status-icon.mod-working", ["color: var(--ms-salmon)", "--icon-color: var(--ms-salmon)"]);
  add(R_ + " .sync-status-icon.mod-error", ["color: var(--ms-red-alert, #ff6753)", "--icon-color: var(--ms-red-alert, #ff6753)"]);
  /* The window: Obsidian's content area, black, inset in the slab with rounded corners. */
  add(R_ + " .workspace-drawer-tab-container", ["margin: " + u(4) + " " + u(12) + " 0", "background: transparent !important"]);
  add(R_ + " .workspace-drawer-active-tab-container, " + R_ + " .workspace-leaf-content", ["background: transparent !important"]);
  add(R_ + " .workspace-drawer-active-tab-content", [
    "background: var(--ms-window, #000) !important", "border-radius: " + u(18), "overflow: hidden", "flex: 1 1 auto"
  ]);
  /* No scroll fade: Obsidian's own fades are drawn from the sidebar color, which on this drawer is the gray. */
  add(R_ + " .workspace-leaf-content::after, " + R_ + " .nav-buttons-container::after", ["display: none !important"]);
  add(R_ + " .workspace-drawer-tab-container a, " + R_ + " .workspace-drawer-tab-container .is-active", ["color: var(--ms-blue)"]);
  /* View selector: a black pill with a blue outline, in the lower gray band, in Obsidian's own spot. */
  add(R_ + " .workspace-drawer-tab-options", ["margin: " + u(8) + " 0 0", "background: transparent !important"]);
  add(R_ + " .workspace-drawer-tab-select .workspace-tab-header-inner", ["background: #000 !important"]);

  /* ═══ 4. WITH THE MAIN LCARS PLUGIN ON THE PHONE ═══ */
  /* Its palette and styles now reach the phone too. These rules are raised in specificity (html:root) so they hold. */
  var H = "html:root " + B;
  /* Behind the Android navigation buttons and everywhere else the app shows through: black, never gray. */
  add(H, ["--system-status-background: #000", "--background-secondary: #000", "--background-secondary-alt: #000", "--titlebar-background: #000", "--status-bar-background: #000"]);
  add(H + " .app-container, " + H + " .horizontal-main-container", ["background: #000 !important"]);
  add(H + " .status-bar", ["display: none !important"]);
  /* Left drawer: no divider between the shortcuts and the list */
  add(H + " .workspace-drawer.mod-left .nn-shortcuts-resize-handle", ["display: none !important"]);
  /* Left drawer: the Notebook Navigator button is solid blue, black type */
  add(H + " .workspace-drawer.mod-left .workspace-drawer-tab-select", ["background: transparent !important", "border-radius: 999px !important"]);
  add(H + " .workspace-drawer.mod-left .workspace-drawer-tab-select .workspace-tab-header-inner", [
    "background: var(--ms-blue) !important", "background-color: var(--ms-blue) !important", "border-radius: 999px !important", "box-shadow: none !important", "color: #000 !important", "--icon-color: #000"
  ]);
  add(H + " .workspace-drawer.mod-left .workspace-drawer-tab-select .workspace-tab-header-inner-title, " + H + " .workspace-drawer.mod-left .workspace-drawer-tab-select svg", ["color: #000 !important"]);
  /* Right drawer: the selector pill keeps its blue (outline, icon and type), and so does the sync indicator */
  add(H + " .workspace-drawer.mod-right .workspace-drawer-tab-select .workspace-tab-header-inner", [
    "background: #000 !important", "box-shadow: inset 0 0 0 1.5px var(--ms-blue) !important", "color: var(--ms-blue) !important", "--icon-color: var(--ms-blue)"
  ]);
  add(H + " .workspace-drawer.mod-right .workspace-drawer-tab-select .workspace-tab-header-inner-title, " + H + " .workspace-drawer.mod-right .workspace-drawer-tab-select svg", ["color: var(--ms-blue) !important"]);
  add(H + " .workspace-drawer.mod-right .workspace-drawer-header-icon", ["background: #000 !important", "color: var(--ms-blue) !important", "--icon-color: var(--ms-blue)"]);
  add(H + " .workspace-drawer.mod-right .workspace-drawer-header-icon svg", ["color: var(--ms-blue) !important", "stroke: var(--ms-blue) !important"]);
  add(H + " .workspace-drawer.mod-right .sync-status-icon.mod-working, " + H + " .workspace-drawer.mod-right .sync-status-icon.mod-working svg", ["color: var(--ms-salmon) !important", "stroke: var(--ms-salmon) !important"]);

  /* The band: the main LCARS plugin's desktop frame draws a full-size slate layer (::after) over the root split, and it shows wherever the note's content does not reach (under the bars, above the formatting toolbar, along the right edge). Not wanted on the phone. */
  add(H + " .workspace-split.mod-root::before, " + H + " .workspace-split.mod-root::after", ["display: none !important", "background: none !important", "content: none !important"]);
  add(H + " .workspace-split.mod-vertical.mod-root", ["padding: 0 !important"]);
  add(H + " .workspace, " + H + " .workspace-split.mod-root, " + H + " .mod-root .workspace-tabs, " + H + " .mod-root .workspace-tab-container", ["background: transparent !important"]);
  /* Pop-up menus: gray, with light type and blue icons */
  add(H + " .menu", ["background: var(--ms-frame) !important", "border: 0 !important", "box-shadow: none !important"]);
  add(H + " .menu-item", [
    "background: var(--ms-key) !important", "background-color: var(--ms-key) !important", "border-radius: 999px !important",
    "margin: 4px 8px !important", "color: var(--ms-text) !important", "box-shadow: none !important"
  ]);
  add(H + " .menu-item-title, " + H + " .menu-item-icon, " + H + " .menu-item-icon svg, " + H + " .menu-item-icon .svg-icon", [
    "background: transparent !important", "box-shadow: none !important"
  ]);
  add(H + " .menu-item-title", ["color: var(--ms-text) !important"]);
  add(H + " .menu-item-icon, " + H + " .menu-item-icon svg", ["color: var(--ms-blue) !important", "--icon-color: var(--ms-blue)"]);
  add(H + " .menu-separator", ["display: none !important"]);
  add(H + " .menu-item:active, " + H + " .menu-item.selected, " + H + " .menu-item.is-selected", ["background: var(--ms-bar) !important", "background-color: var(--ms-bar) !important"]);
  return L.join("\n");
})();

// ─────────────────────────────────────────────────────────────
// Drawer lines (phone, left drawer): one or two lines of animated readout
// in the LCARS manner, above Notebook Navigator's toolbar or at the bottom
// of the drawer. Spec: the LCARS Interface project, "LCARS Mobile – Build
// Spec" and the Lines v3 mock. Phone only; the desktop has the banner.
// Data: the Sync plugin's status (event "status-change" and getStatus()),
// the main LCARS plugin's statuses and the events file the Sandbox loads,
// the stardate variable, vault counts. GEO, BIO and MET, the shuttle and
// the away team are placeholders until real measures are chosen.
// ─────────────────────────────────────────────────────────────
var LN_ID = "lcars-lines-style";
var LN_ORDER = [
  ["link", "Data link"], ["net", "Data link, connection"], ["subspace", "Subspace trace (link speed)"], ["casc", "Data cascade"],
  ["power", "Power reserves"], ["endurance", "Power endurance"], ["transfer", "Power transfer (charging)"], ["systems", "Systems status"],
  ["scan", "Condition scan"], ["rotate", "Rotating readout"],
  ["lights", "Condition with lights"], ["trace", "Pulse trace"], ["triA", "Tricorder, adjacent"], ["triS", "Tricorder, stacked"],
  ["sweep", "Sweep scanner"], ["inertial", "Inertial dampers"],
  ["shuttle", "Shuttlecraft status"], ["away", "Away team life signs"]
];
var LN_DEFAULTS = { on: true, slots: [{ on: true, picks: ["link"], cycle: "off", seconds: 4 }, { on: true, picks: ["triA"], cycle: "off", seconds: 4 }], spacer: true, slot: "off", slotW: "half", adj: "boxes", adjSeconds: 8, dot: true, pos: "top", bg: "black", short: "" };
function lnIsTri(k) { return k === "triA" || k === "triS"; }
var LN_STATES = {
  synced:        { term: "ONLINE",        cls: "st-nominal", casc: "c-nominal", hb: "hb-nominal", dot: "d-nominal", rank: 0 },
  syncing:       { term: "ACTIVE",        cls: "st-active",  casc: "c-active",  hb: "hb-active", dot: "d-active", rank: 0 },
  connecting:    { term: "SEARCHING",     cls: "st-search",  casc: "c-search",  hb: "hb-search", dot: "d-search", rank: 1 },
  uninitialized: { term: "UNINITIALIZED", cls: "st-uninit",  casc: "c-none",    hb: "hb-none", dot: "d-uninit", rank: 1 },
  paused:        { term: "STANDBY",       cls: "st-standby", casc: "c-standby", hb: "hb-standby", dot: "d-standby", rank: 0 },
  offline:       { term: "OFFLINE",       cls: "st-offline", casc: "c-offline", hb: "hb-offline", dot: "d-low", rank: 1 },
  disconnected:  { term: "SIGNAL LOST",   cls: "st-lost",    casc: "c-lost",    hb: "hb-lost", dot: "d-lost", rank: 2 },
  error:         { term: "ERROR",         cls: "st-error",   casc: "c-error",   hb: "hb-error", dot: "d-error", rank: 2 },
  none:          { term: null,            cls: "st-conf",    casc: "c-none",    hb: "hb-none", dot: "d-none", rank: -1 }
};
function lnEsc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" }[c]; }); }

var LN_CSS = (function () {
  var u = function (n) { return "calc(" + n + " * var(--ms-u))"; };
  var B = "body.is-phone.lcars-mobile-slab .lcars-ml", L = [];
  var add = function (sel, decls) { L.push(sel + " {\n" + decls.map(function (d) { return "  " + d + ";"; }).join("\n") + "\n}"); };
  add(B, ["--l-blue: #37a6d1", "--l-blue2: #41c4f7", "--l-navy: #1c3c55", "--l-dimred: #8f3a32", "--l-red: #ff6753", "--l-salmon: #ff977b", "--l-cap: #9ea5ba", "--l-bar: #6d748c",
    "--l-geo: #ff977b", "--l-bio: #a98fe0", "--l-met: #41c4f7", "--l-orange: #ff9d3c",
    "flex: none", "box-sizing: border-box", "display: flex", "flex-direction: column", "width: 100%", "position: relative", "z-index: 1"]);
  add(B + ".is-top", ["margin: " + u(20) + " 0 " + u(8) + " 0"]);
  add(B + ".is-bottom", ["margin: " + u(8) + " 0 0 0"]);
  add(B + " .l-strip", [
    "--l-empty: #232a3a", "--l-rule: #2b2f3a", "height: " + u(24), "min-height: 20px", "background: #000", "display: flex", "align-items: center", "padding: 0 " + u(10), "box-sizing: border-box",
    "font-family: var(--lcars-heading-font, 'Antonio', 'Arial Narrow', sans-serif)", "font-size: " + u(13), "letter-spacing: 0.14em", "text-transform: uppercase", "white-space: nowrap", "overflow: hidden", "position: relative", "color: var(--l-cap)", "contain: layout paint"
  ]);
  add(B + ".is-frame .l-strip", ["background: transparent", "--l-empty: rgba(0, 0, 0, 0.28)", "--l-rule: rgba(255, 255, 255, 0.14)"]);
  add(B + ".has-gap .l-strip:first-child", ["margin-bottom: var(--ms-gap)"]);
  add(B + " .l-lab", ["color: var(--l-cap)"]);
  add(B + " .l-val", ["color: var(--l-salmon)"]);
  add(B + " .l-grow", ["flex: 1"]);
  add(B + " .l-tap", ["position: absolute", "right: " + u(6), "color: var(--l-bar)", "font-size: " + u(10)]);
  /* link states: blue is good */
  add(B + " .st", ["display: inline-block"]);
  add(B + " .st-nominal", ["color: var(--l-blue2)", "text-shadow: 0 0 6px rgba(65, 196, 247, 0.55)", "animation: lnGlow 4.2s ease-in-out infinite"]);
  add(B + " .st-active", ["color: var(--l-blue2)", "animation: lnFlash 0.8s steps(2, end) infinite"]);
  add(B + " .st-search", ["background: linear-gradient(90deg, #b5532f 35%, #ffd2b8 50%, #b5532f 65%) 0 0 / 250% 100%", "-webkit-background-clip: text", "background-clip: text", "color: transparent", "animation: lnSweep 2.4s steps(16, end) infinite"]);
  add(B + " .st-standby", ["color: var(--l-blue)"]);
  add(B + " .st-lost", ["color: var(--l-dimred)"]);
  add(B + " .st-error", ["color: var(--l-red)", "animation: lnFlash 1.3s steps(2, end) infinite"]);
  add(B + " .st-conf", ["color: var(--l-cap)", "border-bottom: 1px dotted var(--l-bar)"]);
  add(B + " .st-uninit", ["color: var(--l-cap)"]);
  add(B + " .st-offline, " + B + " .st-low", ["color: var(--l-orange)"]);
  add(B + " .l-b", ["color: var(--l-blue2)"]);
  add(B + " .l-o", ["color: var(--l-orange)"]);
  add(B + " .l-r", ["color: var(--l-red)"]);
  add(B + " .l-dim", ["color: var(--l-bar)"]);
  L.push("@keyframes lnGlow { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }");
  L.push("@keyframes lnFlash { 0% { opacity: 1; } 50% { opacity: 0.15; } }");
  L.push("@keyframes lnSweep { from { background-position: 100% 0; } to { background-position: 0 0; } }");
  L.push("@keyframes lnScroll { from { transform: translateX(0); } to { transform: translateX(-50%); } }");
  L.push("@keyframes lnBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }");
  L.push("@keyframes lnCascO { 0%, 100% { opacity: 0.12; } 10% { opacity: 1; } 30% { opacity: 0.5; } 50% { opacity: 0.12; } }");
  L.push("@keyframes lnPing { from { transform: translateX(0); } to { transform: translateX(354%); } }");
  L.push("@keyframes lnChase { 0%, 100% { opacity: 0.25; } 12% { opacity: 1; } 40% { opacity: 0.25; } }");
  L.push("@keyframes lnIn { from { opacity: 0; transform: translateY(40%); } to { opacity: 1; transform: none; } }");
  /* cascades */
  add(B + " .l-casc", ["display: flex", "gap: 2px", "align-items: center", "flex: 1", "justify-content: flex-end"]);
  add(B + " .l-casc b", ["display: block", "width: " + u(5), "height: " + u(12), "background: var(--l-navy)"]);
  add(B + " .c-nominal", ["animation: lnBreathe 4.2s ease-in-out infinite"]);
  add(B + " .c-nominal b", ["background: #2a7193"]);
  add(B + " .c-active b", ["background: var(--l-blue2)", "animation: lnCascO 1.1s linear infinite"]);
  add(B + " .c-standby b", ["background: #2a7193", "opacity: 0.8"]);
  add(B + " .c-lost b", ["background: #4a2320"]);
  add(B + " .c-error b", ["background: var(--l-red)", "animation: lnFlash 1.3s steps(2, end) infinite"]);
  add(B + " .c-none b", ["background: #3a4054"]);
  add(B + " .c-search", ["position: relative", "overflow: hidden"]);
  add(B + " .c-search b", ["background: #5a2e1e"]);
  add(B + " .c-search::after", ['content: ""', "position: absolute", "top: 0", "bottom: 0", "left: 0", "width: 22%", "background: linear-gradient(90deg, transparent, #b5532f, var(--l-salmon), #b5532f, transparent)", "animation: lnPing 1.7s ease-in-out infinite alternate"]);
  /* condition scan, lights, trace, rotating */
  add(B + " .l-scan", ["background: linear-gradient(90deg, color-mix(in srgb, var(--l-c) 55%, #000) 35%, #fff 50%, color-mix(in srgb, var(--l-c) 55%, #000) 65%) 0 0 / 250% 100%", "-webkit-background-clip: text", "background-clip: text", "color: transparent", "animation: lnSweep 3.2s steps(20, end) infinite"]);
  add(B + " .l-cond", ["color: var(--l-c)"]);
  add(B + " .l-lights", ["display: flex", "gap: 3px", "margin-left: auto"]);
  add(B + " .l-lights b", ["display: block", "width: " + u(12), "height: " + u(10), "background: var(--l-c)", "animation: lnChase 2s linear infinite"]);
  add(B + " .l-trace", ["position: absolute", "left: 0", "right: 0", "top: 0", "bottom: 0", "overflow: hidden"]);
  add(B + " .l-trace svg, " + B + " .l-hb svg", ["position: absolute", "left: 0", "top: 2px", "width: 200%", "height: 80%", "animation: lnScroll 3.2s linear infinite"]);
  add(B + " .l-trace path, " + B + " .l-hb path", ["stroke: currentColor", "fill: none", "stroke-width: 1.5"]);
  add(B + " .l-trace", ["color: var(--l-blue)"]);
  add(B + " .l-rot", ["display: inline-block", "animation: lnIn 0.45s ease-out"]);
  /* tricorder */
  add(B + " .gl", ["color: var(--l-geo)"]);
  add(B + " .bl", ["color: var(--l-bio)"]);
  add(B + " .ml", ["color: var(--l-met)"]);
  add(B + " .l-seg", ["display: flex", "gap: 1px", "flex: 1", "min-width: 0"]);
  add(B + " .l-seg u", ["display: block", "flex: 1", "background: var(--l-empty)", "text-decoration: none"]);
  add(B + " .l-seg.g u.on", ["background: var(--l-geo)"]);
  add(B + " .l-seg.b u.on", ["background: var(--l-bio)"]);
  add(B + " .l-seg.m u.on", ["background: var(--l-met)"]);
  add(B + " .l-tri", ["display: flex", "align-items: center", "width: 100%", "height: 100%", "gap: " + u(8)]);
  add(B + " .l-main", ["flex: 1 1 0", "min-width: 0", "display: flex", "align-items: center", "height: 100%"]);
  add(B + " .l-slot", ["flex: none", "display: flex", "align-items: center", "height: 70%", "border-left: 1px solid var(--l-rule)", "padding-left: " + u(8), "box-sizing: border-box", "overflow: hidden", "position: relative"]);
  add(B + " .l-slot.half", ["width: 50%"]);
  add(B + " .l-slot.two3", ["width: 66.67%"]);
  add(B + " .l-adj", ["display: flex", "width: 100%", "gap: " + u(8), "align-items: center"]);
  add(B + " .l-adj .g", ["flex: 1 1 0", "display: flex", "align-items: center", "gap: " + u(4), "min-width: 0"]);
  add(B + " .l-adj .l-seg u", ["height: " + u(11)]);
  add(B + " .l-stk", ["display: flex", "align-items: center", "gap: " + u(7), "width: 100%", "height: 100%"]);
  add(B + " .l-stk .labs", ["display: flex", "flex-direction: column", "justify-content: center", "font-size: " + u(8), "line-height: " + u(8), "letter-spacing: 0.14em", "width: " + u(22), "flex: none"]);
  add(B + " .l-stk .rows", ["flex: 1", "display: flex", "flex-direction: column", "justify-content: center", "gap: 1px", "min-width: 0"]);
  add(B + " .l-stk .l-seg u", ["height: " + u(6)]);
  add(B + " .l-eq", ["display: flex", "width: 100%", "height: 100%", "gap: " + u(8), "align-items: center"]);
  add(B + " .l-eq .g", ["flex: 1 1 0", "display: flex", "align-items: flex-end", "gap: 3px", "height: 80%", "min-width: 0"]);
  add(B + " .l-eq .g > span", ["font-size: " + u(10), "letter-spacing: 0.08em", "align-self: center"]);
  add(B + " .l-eq .cols2", ["flex: 1", "display: flex", "align-items: flex-end", "gap: 1px", "height: 90%"]);
  add(B + " .cols2 b", ["display: block", "flex: 1", "height: 100%", "transform-origin: 50% 100%", "transform: scaleY(0.4)", "transition: transform 0.6s ease-out"]);
  add(B + " .l-adj .cols2", ["flex: 1", "display: flex", "align-items: flex-end", "gap: 1px", "height: " + u(18), "min-width: 0"]);
  add(B + " .cols2 .c1", ["background: var(--l-geo)"]);
  add(B + " .cols2 .c2", ["background: var(--l-bio)"]);
  add(B + " .cols2 .c3", ["background: var(--l-met)"]);
  add(B + " .l-st-txt", ["display: flex", "align-items: center", "gap: " + u(5), "font-size: " + u(11), "letter-spacing: 0.1em"]);
  add(B + " .l-ic svg", ["width: " + u(13), "height: " + u(13), "display: block"]);
  add(B + " .l-hb", ["position: relative", "width: 100%", "height: " + u(16), "overflow: hidden", "color: var(--l-blue2)"]);
  add(B + " .hb-nominal", ["color: var(--l-blue2)"]);
  add(B + " .hb-active", ["color: var(--l-blue2)", "animation: lnFlash 0.8s steps(2, end) infinite"]);
  add(B + " .hb-search", ["color: var(--l-salmon)"]);
  add(B + " .hb-standby", ["color: var(--l-blue)"]);
  add(B + " .hb-standby svg, " + B + " .hb-lost svg, " + B + " .hb-none svg", ["animation: none"]);
  add(B + " .hb-lost", ["color: var(--l-dimred)"]);
  add(B + " .hb-error", ["color: var(--l-red)", "animation: lnFlash 1.3s steps(2, end) infinite"]);
  add(B + " .hb-none", ["color: #3a4054"]);
  /* the status circle left of the data link text */
  add(B + " .l-d", ["flex: none", "width: " + u(15), "display: flex", "align-items: center"]);
  add(B + " .l-dot", ["display: inline-block", "flex: none", "width: " + u(7), "height: " + u(7), "border-radius: 50%", "background: var(--l-blue)"]);
  add(B + " .l-dot.d-low", ["background: var(--l-orange)"]);
  add(B + " .l-dot.d-uninit", ["background: var(--l-bar)"]);
  add(B + ".no-dot .l-d", ["display: none"]);
  add(B + " .l-strip.hd .l-trace", ["left: " + u(25)]);
  add(B + " .c-offline b", ["background: #6b4a1e"]);
  add(B + " .hb-offline", ["color: var(--l-orange)"]);
  add(B + " .hb-offline svg", ["animation: none"]);
  /* power: gauge cells and the charging cascade */
  add(B + " .l-pg", ["display: flex", "gap: 2px", "flex: none", "margin-right: " + u(10)]);
  add(B + " .l-pg u", ["display: block", "width: " + u(12), "height: " + u(11), "background: var(--l-empty)", "text-decoration: none"]);
  add(B + " .l-pg u.on", ["background: var(--l-blue2)"]);
  add(B + " .l-pg.warn u.on", ["background: var(--l-orange)"]);
  add(B + " .l-pg.crit u.on", ["background: var(--l-red)"]);
  /* sweep scanner: transform and opacity only */
  add(B + " .l-sw", ["position: relative", "flex: 1", "min-width: 0", "height: " + u(18), "overflow: hidden", "margin-right: " + u(10), "background: repeating-linear-gradient(90deg, var(--l-rule) 0 1px, transparent 1px 14px)"]);
  add(B + " .l-sw::after", ['content: ""', "position: absolute", "top: 0", "bottom: 0", "left: 0", "width: 26px", "background: linear-gradient(90deg, transparent, rgba(65, 196, 247, 0.55))", "border-right: 1.5px solid var(--l-blue2)", "transform: translateX(-26px)", "animation: lnSw 3.2s linear infinite"]);
  add(B + " .l-sw i", ["position: absolute", "width: 5px", "height: 5px", "border-radius: 50%", "opacity: 0", "animation: lnBlip 3.2s linear infinite"]);
  L.push("@keyframes lnSw { from { transform: translateX(-26px); } to { transform: translateX(var(--sw-w, 300px)); } }");
  L.push("@keyframes lnBlip { 0%, 40% { opacity: 0; } 50% { opacity: 1; } 100% { opacity: 0; } }");
  /* inertial dampers: horizon and bubble */
  add(B + " .l-hz", ["position: relative", "flex: none", "width: " + u(44), "height: " + u(18), "border: 1.5px solid var(--l-bar)", "border-radius: 999px", "overflow: hidden", "margin-right: " + u(10), "box-sizing: border-box"]);
  add(B + " .l-hz i", ["position: absolute", "left: -20%", "right: -20%", "top: 50%", "height: 1.5px", "background: var(--l-blue2)", "will-change: transform"]);
  add(B + " .l-hz.sim i", ["animation: lnTilt 5s ease-in-out infinite"]);
  add(B + " .l-hz.sim u", ["animation: lnBubble 5s ease-in-out infinite"]);
  L.push("@keyframes lnTilt { 0%, 100% { transform: rotate(-8deg) translateY(-2px); } 50% { transform: rotate(8deg) translateY(2px); } }");
  L.push("@keyframes lnBubble { 0%, 100% { transform: translate(-14px, -2px); } 50% { transform: translate(14px, 2px); } }");
  add(B + " .l-hz u", ["position: absolute", "left: 50%", "top: 50%", "width: 6px", "height: 6px", "margin: -3px 0 0 -3px", "border-radius: 50%", "background: var(--l-salmon)", "text-decoration: none", "will-change: transform"]);
  add(B + " .l-dot.d-nominal", ["background: var(--l-blue2)", "box-shadow: 0 0 6px rgba(65, 196, 247, 0.7)", "animation: lnGlow 4.2s ease-in-out infinite"]);
  add(B + " .l-dot.d-active", ["background: var(--l-blue2)", "animation: lnFlash 0.8s steps(2, end) infinite"]);
  add(B + " .l-dot.d-search", ["background: var(--l-salmon)", "animation: lnFlash 1.1s steps(2, end) infinite"]);
  add(B + " .l-dot.d-standby", ["background: var(--l-blue)"]);
  add(B + " .l-dot.d-lost", ["background: var(--l-dimred)"]);
  add(B + " .l-dot.d-error", ["background: var(--l-red)", "animation: lnFlash 1.3s steps(2, end) infinite"]);
  add(B + " .l-dot.d-none", ["background: #3a4054"]);
  /* sparkline graph (adjacent tricorder) */
  add(B + " .l-spark", ["flex: 1", "min-width: 0", "height: " + u(18), "display: block", "overflow: hidden", "position: relative"]);
  add(B + " .l-spark svg", ["position: absolute", "left: 0", "top: 0", "width: 200%", "height: 100%", "animation: lnScroll 10s linear infinite"]);
  add(B + " .l-spark polyline", ["fill: none", "stroke-width: 1.4", "vector-effect: non-scaling-stroke", "stroke-linejoin: round"]);
  add(B + " .l-spark.g polyline", ["stroke: var(--l-geo)"]);
  add(B + " .l-spark.b polyline", ["stroke: var(--l-bio)"]);
  add(B + " .l-spark.m polyline", ["stroke: var(--l-met)"]);
  add(B + " .l-spark.n polyline", ["stroke: var(--l-blue2)"]);
  add(B + " .l-spark.n", ["margin: 0 " + u(6) + " 0 0"]);
  /* shuttle, away team */
  add(B + " .l-shut, " + B + " .l-away", ["display: flex", "align-items: center", "gap: " + u(7), "width: 100%"]);
  add(B + " .l-sg", ["flex: none", "width: " + u(36), "display: flex", "gap: 1px"]);
  add(B + " .l-sg u", ["display: block", "flex: 1", "height: " + u(11), "background: var(--l-empty)"]);
  add(B + " .l-sg u.on", ["background: var(--l-blue2)"]);
  add(B + " .l-life", ["width: " + u(26), "height: " + u(16), "overflow: hidden", "position: relative", "flex: none", "background: rgba(0, 0, 0, 0.4)"]);
  add(B + " .l-life svg", ["position: absolute", "left: 0", "top: 0", "width: 200%", "height: 100%", "animation: lnScroll 1.8s linear infinite"]);
  add(B + " .l-life.hurt svg", ["animation-duration: 0.7s"]);
  add(B + " .l-life.flat svg", ["animation: none"]);
  add(B + " .l-life path", ["fill: none", "stroke-width: 1.3"]);
  /* standby: the main plugin's idle class pauses the motion */
  add("body.lcars-idle .lcars-ml *", ["animation-play-state: paused !important"]);
  L.push("@media (prefers-reduced-motion: reduce) { .lcars-ml * { animation: none !important; transition: none !important; } }");
  return L.join("\n");
})();

var LN_PATH = '<svg viewBox="0 0 120 16" preserveAspectRatio="none"><path d="M0 8 H14 L17 8 L20 2 L24 14 L27 8 H44 L47 8 L50 5 L53 11 L56 8 H60 M60 8 H74 L77 8 L80 2 L84 14 L87 8 H104 L107 8 L110 5 L113 11 L116 8 H120"/></svg>';
var LN_PULSE = '<svg viewBox="0 0 52 16" preserveAspectRatio="none"><path style="stroke:COLOR" d="M0 8 H8 L10 8 L12 2 L15 14 L17 8 H26 M26 8 H34 L36 8 L38 2 L41 14 L43 8 H52"/></svg>';
var LN_FLAT = '<svg viewBox="0 0 52 16" preserveAspectRatio="none"><path style="stroke:COLOR" d="M0 8 H52"/></svg>';

// Everything the lines read, with the plugin passed in.
function lnSyncState(app) {
  try { return lnSyncStateRaw(app); } catch (e) { return "none"; }
}
function lnSyncStateRaw(app) {
  var p = app.internalPlugins && app.internalPlugins.getPluginById && app.internalPlugins.getPluginById("sync");
  if (!p || !p.enabled || !p.instance || !p.instance.vaultId) return "none";
  var i = p.instance, st;
  try { st = i.getStatus(); } catch (e) { return "none"; }
  // The phone has no network at all: shown as OFFLINE, apart from the server being unreachable (SIGNAL LOST).
  if (typeof navigator !== "undefined" && navigator.onLine === false) return "offline";
  if (st === "uninitialized") return i.syncStatus === "Connecting to server" ? "connecting" : "uninitialized";
  return LN_STATES[st] && st !== "connecting" && st !== "offline" ? st : "none";
}
function lnShip(pl) {
  var s = (pl.ms.lines.short || "").trim();
  if (s) return s;
  var full = (pl.settings && pl.settings.shipName) || "";
  return String(full).replace(/^\s*(U\.?S\.?S\.?|I\.?S\.?S\.?)\s+/i, "").trim() || "Ship";
}
function lnCondition(pl) {
  var out = { label: "NOMINAL", color: "var(--l-blue2)", raised: false };
  try {
    var api = window.lcarsObsidian && window.lcarsObsidian.api, act = api ? api.statuses.active() : [];
    if (act.length) {
      var id = act[0].id, list = (pl.settings && pl.settings.alerts && pl.settings.alerts.statuses) || [];
      var st = list.filter(function (x) { return x.id === id; })[0];
      out.label = String((st && st.label) || id).toUpperCase(); out.color = (st && st.color) || "var(--l-salmon)"; out.raised = true;
    }
  } catch (e) { /* the main plugin is not running */ }
  return out;
}
function lnStardate() {
  var v = getComputedStyle(document.body).getPropertyValue("--padd-stardate").replace(/["']/g, "").trim();
  if (v) return v;
  try { return window.lcarsStardateString ? window.lcarsStardateString() : "—"; } catch (e) { return "—"; }
}
function lnNextEvent(pl) {
  var now = Date.now(), best = null;
  (pl.events || []).forEach(function (e) {
    var s = Date.parse(e.start);
    if (!isFinite(s) || s <= now || e.allDay) return;
    if (!best || s < best.s) best = { s: s, t: String(e.title || "Event") };
  });
  if (!best) return "NO EVENTS DUE";
  var d = new Date(best.s);
  return "NEXT " + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " " + best.t.toUpperCase().slice(0, 14);
}
function lnCounts(pl) {
  var now = Date.now();
  if (!pl._cnt || now - pl._cnt.at > 60000) {
    var files = pl.app.vault.getFiles().length, folders = pl.app.vault.getAllLoadedFiles().filter(function (f) { return f.children; }).length;
    pl._cnt = { at: now, files: files, folders: folders };
  }
  return pl._cnt;
}

// Builders (HTML strings; text that comes from the vault is escaped).
function lnSeg(n, cls) { var u = ""; for (var i = 0; i < n; i++) u += "<u></u>"; return '<span class="l-seg ' + cls + '" data-seg="' + n + '">' + u + "</span>"; }
function lnCols(c) { var h = '<span class="cols2">'; for (var i = 0; i < 5; i++) h += '<b class="' + c + '" data-eq="1"></b>'; return h + "</span>"; }
function lnCasc(s, n) { var d = LN_STATES[s], b = ""; for (var i = 0; i < n; i++) b += '<b style="animation-delay:' + (i * 0.09).toFixed(2) + 's"></b>'; return '<span class="l-casc ' + d.casc + '" data-casc="' + s + '" data-sd="casc">' + b + "</span>"; }
function lnDot(pl, s) { return pl.ms.lines.dot === false ? "" : '<span class="l-d"><span class="l-dot ' + LN_STATES[s].dot + '" data-sd="dot"></span></span>'; }
function lnDotX(pl, cls, style) { return pl.ms.lines.dot === false ? "" : '<span class="l-d"><span class="l-dot ' + (cls || "") + '"' + (style ? ' style="' + style + '"' : "") + "></span></span>"; }

// Power (battery) and connection, from the browser. x.pw: {pct, ch, st, t} or null; x.net: {online, type, eff, dl}.
var LN_PW = {
  nom:      { term: "NOMINAL",  cls: "st-nominal", dot: "d-nominal", gauge: "",     rank: 0 },
  charging: { term: "CHARGING", cls: "st-active",  dot: "d-active",  gauge: "",     rank: 0 },
  low:      { term: "LOW",      cls: "st-low",     dot: "d-low",     gauge: "warn", rank: 1 },
  crit:     { term: "CRITICAL", cls: "st-error",   dot: "d-error",   gauge: "crit", rank: 2 }
};
function lnFmtT(sec) {
  if (!isFinite(sec) || sec <= 0) return "";
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h + "H " + (m < 10 ? "0" : "") + m + "M";
}
function lnPwRead(b) {
  if (!b) return null;
  var l = b.level, ch = !!b.charging;
  return { pct: Math.round(l * 100), l: l, ch: ch, st: ch ? "charging" : l < 0.15 ? "crit" : l < 0.30 ? "low" : "nom", t: ch ? b.chargingTime : b.dischargingTime };
}
function lnNetRead() {
  var c = navigator.connection || navigator.mozConnection || navigator.webkitConnection, t = c && c.type ? String(c.type) : "";
  var names = { wifi: "WI-FI", cellular: "CELL", ethernet: "ETHERNET", bluetooth: "BLUETOOTH", none: "NONE" };
  return { online: navigator.onLine !== false, type: names[t] || "", eff: c && c.effectiveType ? String(c.effectiveType).toUpperCase() : "", dl: c && isFinite(c.downlink) ? c.downlink : null };
}
// One line of speed history as a polyline that repeats once, so the CSS scroll loops without a jump.
function lnHistPts(h) {
  var v = h.length ? h.slice() : [0, 0], lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), n = v.length, i;
  while (v.length < 18) v.unshift(v[0]);
  n = v.length; v[n - 1] = v[0];
  var y = function (x) { return hi - lo < 0.05 ? 6 : (10.5 - ((x - lo) / (hi - lo)) * 9).toFixed(1); };
  var one = v.map(function (x, k) { return (k * 40 / (n - 1)).toFixed(1) + "," + y(x); });
  var two = v.map(function (x, k) { return (40 + k * 40 / (n - 1)).toFixed(1) + "," + y(x); });
  return one.concat(two).join(" ");
}
function lnCascPlain(cls, n) { var b = ""; for (var i = 0; i < n; i++) b += '<b style="animation-delay:' + (i * 0.09).toFixed(2) + 's"></b>'; return '<span class="l-casc ' + cls + '">' + b + "</span>"; }
function lnSpark(cls) { return '<span class="l-spark ' + cls + '"><svg viewBox="0 0 80 12" preserveAspectRatio="none" data-spark="1"><polyline points=""/></svg></span>'; }
var LN_KINDS = ["boxes", "equalizer", "spark"];
function lnGraph(kind, c, n) { return kind === "equalizer" ? lnCols(n) : kind === "spark" ? lnSpark(c) : lnSeg(6, c); }
function lnAdjMain(pl, shift) {
  var st = pl.ms.lines.adj || "boxes", k;
  if (st === "mixed") k = LN_KINDS;
  else if (st === "rotate") { shift = shift || 0; k = [LN_KINDS[shift % 3], LN_KINDS[(shift + 1) % 3], LN_KINDS[(shift + 2) % 3]]; }
  else k = [st, st, st];
  return '<div class="l-adj" data-geo="1" data-adj="' + st + '"><span class="g"><span class="gl">GEO</span>' + lnGraph(k[0], "g", "c1") + '</span><span class="g"><span class="bl">BIO</span>' + lnGraph(k[1], "b", "c2") + '</span><span class="g"><span class="ml">MET</span>' + lnGraph(k[2], "m", "c3") + "</span></div>";
}
function lnSlot(pl, s) {
  var L = pl.ms.lines;
  if (L.slot === "off") return "";
  var d = LN_STATES[s], w = L.slotW === "two3" ? "two3" : "half", inner;
  if (L.slot === "text") inner = '<span class="l-st-txt"><span class="l-ic" data-ic="satellite-dish"></span><span class="st ' + d.cls + '" data-sd="st">' + (d.term ? "[" + d.term + "]" : "CONFIGURE") + "</span></span>";
  else if (L.slot === "visual") inner = lnCasc(s, w === "two3" ? 30 : 22);
  else inner = '<span class="l-hb ' + d.hb + '" data-sd="hb">' + LN_PATH + "</span>";
  return '<div class="l-slot ' + w + '">' + inner + "</div>";
}
function lnTri(pl, main, s) { return '<div class="l-tri"><div class="l-main">' + main + "</div>" + lnSlot(pl, s) + "</div>"; }
// The dot at the left of every line: its color says what that line is reporting.
function lnDotFor(pl, key, s, x) {
  var c, w;
  switch (key) {
    // Only lines that show the connection or sync state themselves carry the link-state dot.
    case "link": case "net": case "subspace": case "casc": return lnDot(pl, s);
    case "power": case "endurance": case "transfer": return x.pw ? lnDotX(pl, LN_PW[x.pw.st].dot) : lnDotX(pl, "d-none");
    case "systems": w = lnSystemsRank(s, x); return lnDotX(pl, w === 2 ? "d-error" : w === 1 ? "d-low" : "d-nominal");
    case "scan": case "lights": c = lnCondition(pl); return lnDotX(pl, "", "background:" + c.color);
    default: return lnDotX(pl, "d-standby");
  }
}
// Worst state among link, power and sync: 0 good, 1 warning, 2 failing.
function lnSystemsRank(s, x) {
  var a = x.net && x.net.online === false ? 1 : 0, b = x.pw ? LN_PW[x.pw.st].rank : 0, c = Math.max(0, LN_STATES[s].rank);
  return Math.max(a, b, c);
}
function lnLine(pl, key, s, x) {
  var d = LN_STATES[s], c, p, n;
  x = x || {};
  switch (key) {
    case "link":
      return d.term ? '<span class="l-lab">Data link:&nbsp;</span><span class="l-val">' + lnEsc(lnShip(pl)) + '</span>&nbsp;<span class="st ' + d.cls + '" data-sd="st">[' + d.term + "]</span>" : '<span class="st ' + d.cls + '">Configure data link&nbsp;›</span>';
    case "net":
      n = x.net || lnNetRead();
      if (!n.online) return '<span class="l-lab">Link:&nbsp;</span><span class="l-o">Offline</span>';
      return '<span class="l-lab">Link:&nbsp;</span><span class="l-val">' + (n.type || "Online") + (n.eff ? " · " + n.eff : "") + "</span>" + (n.dl != null ? '<span class="l-grow"></span><span class="l-b">' + n.dl + " Mbps</span>" : "");
    case "subspace":
      n = x.net || lnNetRead();
      return '<span class="l-lab">Subspace&nbsp;</span>' + (n.online ? '<span class="l-spark n"><svg viewBox="0 0 80 12" preserveAspectRatio="none" style="animation-duration:14s"><polyline points="' + lnHistPts(x.hist || []) + '"/></svg></span>' : '<span class="l-grow"></span>') + '<span class="' + (n.online ? "l-b" : "l-o") + '">&nbsp;' + (n.online ? (n.dl != null ? n.dl : "Online") : "Offline") + "</span>";
    case "casc": return '<span class="l-lab">Data link&nbsp;</span>' + lnCasc(s, 24);
    case "power":
      p = x.pw; if (!p) return '<span class="l-lab">Reserves&nbsp;</span><span class="l-dim">Unavailable</span>';
      c = Math.max(p.pct > 0 ? 1 : 0, Math.round(p.l * 6));
      return '<span class="l-lab">Reserves&nbsp;</span><span class="l-pg ' + LN_PW[p.st].gauge + '">' + [0, 1, 2, 3, 4, 5].map(function (i) { return "<u" + (i < c ? ' class="on"' : "") + "></u>"; }).join("") + '</span><span class="l-val">' + p.pct + "%</span>";
    case "endurance":
      p = x.pw; if (!p) return '<span class="l-lab">Endurance&nbsp;</span><span class="l-dim">Unavailable</span>';
      c = lnFmtT(p.t);
      return '<span class="l-lab">' + (p.ch ? "Full in" : "Endurance") + '&nbsp;</span><span class="l-b">' + (c || "—") + '</span><span class="l-grow"></span><span class="st ' + LN_PW[p.st].cls + '">[' + LN_PW[p.st].term + "]</span>";
    case "transfer":
      p = x.pw; if (!p) return '<span class="l-lab">Transfer&nbsp;</span><span class="l-dim">Unavailable</span>';
      return '<span class="l-lab">Transfer&nbsp;</span>' + lnCascPlain(p.ch ? "c-active" : "c-standby", 18) + '<span class="l-val">&nbsp;' + p.pct + '%</span>' + (p.ch ? '&nbsp;<span class="l-b">' + (lnFmtT(p.t) || "") + "</span>" : '&nbsp;<span class="l-dim">Idle</span>');
    case "systems":
      n = x.net || lnNetRead();
      var wd = function (rank) { return rank === 2 ? "l-r" : rank === 1 ? "l-o" : "l-b"; };
      return '<span class="l-lab">Systems&nbsp;</span><span class="' + wd(n.online ? 0 : 1) + '">Link</span>&nbsp;&nbsp;<span class="' + (x.pw && !x.simPw ? wd(LN_PW[x.pw.st].rank) : "l-dim") + '">Power</span>&nbsp;&nbsp;' + (s === "none" ? '<span class="l-dim">Sync</span>' : '<span class="' + wd(Math.max(0, d.rank)) + '">Sync</span>');
    case "sweep":
      n = x.contacts || 1;
      var bl = ""; for (var k = 0; k < Math.min(8, n); k++) { var fr = ((k * 0.37 + 0.11) % 0.88) + 0.05; bl += '<i style="left:' + (fr * 100).toFixed(0) + "%;top:" + (3 + ((k * 7) % 10)) + "px;background:" + ["var(--l-geo)", "var(--l-bio)", "var(--l-blue2)"][k % 3] + ";animation-delay:" + (fr * 3.2 - 1.6).toFixed(2) + 's"></i>'; }
      return '<span class="l-lab">Sweep&nbsp;</span><span class="l-sw" data-sw="1">' + bl + '</span><span class="l-b">' + n + (n === 1 ? " contact" : " contacts") + "</span>";
    case "inertial":
      return '<span class="l-lab">Inertial&nbsp;</span><span class="l-hz" data-inertial="1"><i></i><u></u></span><span class="l-val" data-in="p">P —</span>&nbsp;<span class="l-val" data-in="r">R —</span><span class="l-grow"></span><span class="st st-nominal" data-in="s">[STABLE]</span>';
    case "scan": c = lnCondition(pl); return '<span class="l-scan" style="--l-c:' + c.color + '">' + (c.raised ? lnEsc(c.label) : "Systems nominal") + " · all decks</span>";
    case "rotate": return '<span class="l-lab">&#9656;&nbsp;</span><span class="l-rot" data-rot="1"></span>';
    case "lights": c = lnCondition(pl); var b = ""; for (var i = 0; i < 9; i++) b += '<b style="animation-delay:' + (i * 0.22).toFixed(2) + 's"></b>'; return '<span class="l-lab">Condition&nbsp;</span><span class="l-cond" style="--l-c:' + c.color + '">' + lnEsc(c.raised ? c.label : "BLUE") + '</span><span class="l-lights" style="--l-c:' + c.color + '">' + b + "</span>";
    case "trace": return '<div class="l-trace">' + LN_PATH + "</div>";
    case "triA": return lnTri(pl, lnAdjMain(pl, 0), s);
    case "triS": return lnTri(pl, '<div class="l-stk"><div class="labs"><span class="gl">GEO</span><span class="bl">BIO</span><span class="ml">MET</span></div><div class="rows">' + lnSeg(14, "g") + lnSeg(14, "b") + lnSeg(14, "m") + "</div></div>", s);
    case "triE": return lnTri(pl, '<div class="l-eq"><span class="g"><span class="gl">GEO</span>' + lnCols("c1") + '</span><span class="g"><span class="bl">BIO</span>' + lnCols("c2") + '</span><span class="g"><span class="ml">MET</span>' + lnCols("c3") + "</span></div>", s);
    case "shuttle": return '<div class="l-shut"><svg width="20" height="12" viewBox="0 0 20 12"><path d="M2 6 L7 2 H15 L18 6 L15 10 H7 Z" fill="#9ea5ba"/><rect x="8" y="5" width="6" height="2" fill="#000"/></svg><span class="l-lab">Shuttle 1&nbsp;</span><span class="st st-standby">[DOCKED]</span><span class="l-grow"></span><span class="l-sg"><u class="on"></u><u class="on"></u><u class="on"></u><u class="on"></u><u class="on"></u><u class="on"></u></span></div>';
    case "away": return '<div class="l-away"><span class="l-lab">Away team&nbsp;</span>' + [0, 1, 2, 3].map(function () { return '<span class="l-life">' + LN_PULSE.replace("COLOR", "#41c4f7") + "</span>"; }).join("") + '<span class="l-grow"></span><span class="st st-nominal">4 / 4</span></div>';
  }
  return "";
}

// The lifecycle: put the host element in the left drawer, draw the picked lines, keep them current.
function startDrawerLines(pl) {
  var app = pl.app, L = pl.ms.lines, stopped = false, timers = [], cur = {}, ref = null, syncInst = null, rotIdx = 0, tick = 0;
  var style = document.createElement("style"); style.id = LN_ID; style.textContent = LN_CSS; document.head.appendChild(style);
  var host = document.createElement("div"); host.className = "lcars-ml";
  var state = lnSyncState(app);
  // Untested on iOS, so nothing here may throw into Obsidian: timers are guarded, a line that fails to draw says so, and missing APIs just leave the value blank.
  var warned = false, sensSince = 0;
  function warn(e) { if (!warned) { warned = true; console.warn("LCARS drawer lines:", e); } }
  function gSet(fn, ms) { return window.setInterval(function () { try { fn(); } catch (e) { warn(e); } }, ms); }

  // Device data: battery and connection are event-driven; motion streams only while a line that uses it is on screen.
  var batt = null, hist = [], pwT = 0, mo = { m: 0, p: 0, r: 0, t: 0 }, sensOn = false, sensTimer = 0, slots = [];
  var battEv = ["levelchange", "chargingchange", "chargingtimechange", "dischargingtimechange"];
  var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  function contactCount() { try { return Math.max(1, app.workspace.getLeavesOfType("markdown").length); } catch (e) { return 1; } }
  // No battery API (iOS Safari-style webviews): the power lines run on a slowly drifting stand-in so they still work. No connection speed: the trace runs on a stand-in too.
  var sim = { level: 0.55 + Math.random() * 0.35, charging: false, chargingTime: Infinity, dischargingTime: Infinity }, simDl = 8;
  function ctx() { return { pw: lnPwRead(batt || sim), simPw: !batt, net: lnNetRead(), hist: hist, contacts: contactCount() }; }
  function redrawKinds(keys) {
    slots.forEach(function (sl, i) { var k = sl.picks[(cur[i] || 0) % sl.picks.length]; if (keys.indexOf(k) > -1) drawStrip(i); });
  }
  function simNext() { simDl = Math.max(2, Math.min(20, simDl * (0.8 + Math.random() * 0.4))); return Math.round(simDl * 10) / 10; }
  function pushHist() {
    var n = lnNetRead();
    if (!n.online) return;
    if (n.dl == null && !hist.length) for (var i = 0; i < 18; i++) hist.push(simNext());
    hist.push(n.dl != null ? n.dl : simNext());
    if (hist.length > 18) hist.shift();
  }
  function onPower() { redrawKinds(["power", "endurance", "transfer", "systems"]); }
  function onPowerSoft() { window.clearTimeout(pwT); pwT = window.setTimeout(onPower, 1000); }
  function onNet() { pushHist(); onState(); redrawKinds(["net", "subspace", "systems"]); }
  function ondo(e) { if (e.beta != null) { mo.p = e.beta - 90; mo.r = e.gamma || 0; mo.t = Date.now(); } }
  function onmo(e) {
    var a = e.acceleration, g = e.accelerationIncludingGravity, mag = 0;
    if (a && a.x != null) mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
    else if (g && g.x != null) mag = Math.abs(Math.sqrt(g.x * g.x + g.y * g.y + g.z * g.z) - 9.81);
    mo.m = mo.m * 0.85 + Math.min(1, mag / 4) * 0.15; mo.t = Date.now();
  }
  function sensUpdate() {
    if (stopped || document.hidden || !host.offsetParent || document.body.classList.contains("lcars-idle")) return;
    if (!mo.t) {
      // No motion events (iOS asks for permission first, and some phones have no sensor): after 3 s the line says so.
      if (Date.now() - sensSince > 3000) host.querySelectorAll('[data-in="s"]').forEach(function (el) { if (el.dataset.mv !== "x") { el.dataset.mv = "x"; el.className = "st st-nominal"; el.textContent = "[STABLE]"; } });
      if (Date.now() - sensSince > 3000) host.querySelectorAll("[data-inertial]").forEach(function (h) { h.classList.add("sim"); });
      return;
    }
    var cl = function (v) { return Math.max(-45, Math.min(45, v)); };
    host.querySelectorAll("[data-inertial]").forEach(function (h) {
      var pi = cl(mo.p), ro = cl(mo.r), row = h.parentElement;
      if (h.classList.contains("sim")) { h.classList.remove("sim"); h.firstChild.style.transform = ""; h.lastChild.style.transform = ""; }
      h.firstChild.style.transform = "rotate(" + (-ro / 3).toFixed(1) + "deg) translateY(" + (pi / 5).toFixed(1) + "px)";
      h.lastChild.style.transform = "translate(" + (ro / 45 * 15).toFixed(1) + "px," + (pi / 45 * 4).toFixed(1) + "px)";
      var set = function (k, t) { var el = row.querySelector('[data-in="' + k + '"]'); if (el && el.textContent !== t) el.textContent = t; };
      set("p", "P " + Math.round(pi) + "°"); set("r", "R " + Math.round(ro) + "°");
      var mv = mo.m > 0.12 ? "1" : "0", sEl = row.querySelector('[data-in="s"]');
      if (sEl && sEl.dataset.mv !== mv) { sEl.dataset.mv = mv; sEl.className = "st " + (mv === "1" ? "st-active" : "st-nominal"); sEl.textContent = mv === "1" ? "[MOTION]" : "[STABLE]"; }
    });
  }
  function stopSens() {
    window.removeEventListener("deviceorientation", ondo); window.removeEventListener("devicemotion", onmo);
    window.clearInterval(sensTimer); sensOn = false; mo.t = 0; mo.m = 0;
  }
  function syncSensors() {
    var need = !!host.querySelector("[data-inertial],[data-geo]");
    if (need && !sensOn) { sensSince = Date.now(); window.addEventListener("deviceorientation", ondo); window.addEventListener("devicemotion", onmo); sensTimer = gSet(sensUpdate, 150); sensOn = true; }
    else if (!need && sensOn) stopSens();
  }

  function place() {
    var inner = document.querySelector(".workspace-drawer.mod-left .workspace-drawer-inner");
    if (!inner) return false;
    host.className = "lcars-ml " + (L.pos === "bottom" ? "is-bottom" : "is-top") + (L.bg === "frame" ? " is-frame" : "") + (L.dot === false ? " no-dot" : "");
    if (L.pos === "bottom") {
      var hdr = inner.querySelector(":scope > .workspace-drawer-header");
      if (hdr) { if (host.parentElement !== inner || host.nextElementSibling !== hdr) inner.insertBefore(host, hdr); host.style.order = getComputedStyle(hdr).order; }
      else if (host.parentElement !== inner) inner.appendChild(host);
    } else {
      if (inner.firstElementChild !== host) inner.insertBefore(host, inner.firstChild);
      host.style.order = "-1";
    }
    return true;
  }
  var order = LN_ORDER.map(function (x) { return x[0]; });
  function activeSlots() {
    return L.slots.filter(function (sl, i) { return (i === 0 || sl.on !== false) && sl.picks && sl.picks.length; }).map(function (sl) {
      var pk = order.filter(function (k) { return sl.picks.indexOf(k) > -1; });
      return { picks: pk, cycle: pk.length > 1 && sl.cycle !== "tap" ? "auto" : sl.cycle, seconds: sl.seconds };
    });
  }
  function stripHTML(sl, i) {
    try {
      var p = sl.picks, idx = (cur[i] || 0) % p.length, x = ctx();
      return lnDotFor(pl, p[idx], state, x) + lnLine(pl, p[idx], state, x);
    } catch (e) { warn(e); return lnDotX(pl, "d-none") + '<span class="l-dim">Unavailable</span>'; }
  }
  function seed(el) {
    el.querySelectorAll("[data-spark]").forEach(function (g) {
      // One long random line, made to repeat seamlessly; CSS scrolls it, so nothing runs per tick.
      var n = 18, v = [], x = 0.5, i;
      for (i = 0; i < n; i++) { x = Math.max(0.1, Math.min(0.95, x + (Math.random() - 0.5) * 0.5)); v.push(x); }
      v[n - 1] = v[0];
      var pts = v.map(function (y, k) { return (k * 40 / (n - 1)).toFixed(1) + "," + (11 - y * 10).toFixed(1); }).concat(v.map(function (y, k) { return (40 + k * 40 / (n - 1)).toFixed(1) + "," + (11 - y * 10).toFixed(1); }));
      g.firstChild.setAttribute("points", pts.join(" "));
    });
    el.querySelectorAll("[data-eq]").forEach(function (b) { b.style.transform = "scaleY(" + (0.2 + Math.random() * 0.8).toFixed(2) + ")"; });
    el.querySelectorAll(".l-seg[data-seg]").forEach(function (g) {
      var n = +g.dataset.seg, us = g.children, c = Math.max(1, Math.round(n * (0.25 + Math.random() * 0.6)));
      g._c = c; g._t = c; for (var j = 0; j < n; j++) us[j].className = j < c ? "on" : "";
    });
  }
  function sweepW() { host.querySelectorAll("[data-sw]").forEach(function (n) { var w = n.offsetWidth; if (w && n._w !== w) { n._w = w; n.style.setProperty("--sw-w", w + "px"); } }); }
  function afterDraw(el) { el.querySelectorAll(".l-ic").forEach(function (n) { obsidian.setIcon(n, n.dataset.ic); }); seed(el); rot(); sweepW(); syncSensors(); }
  function drawStrip(i) {
    var sl = slots[i], el = host.querySelectorAll(".l-strip")[i];
    if (!sl || !el) return;
    el.innerHTML = stripHTML(sl, i);
    try { afterDraw(el); } catch (e) { warn(e); }
  }
  function draw() {
    try { drawRaw(); } catch (e) { warn(e); }
  }
  function drawRaw() {
    if (stopped || !place()) return;
    slots = activeSlots();
    host.classList.toggle("has-gap", slots.length > 1 && !!L.spacer);
    host.innerHTML = slots.map(function (sl, i) { return '<div class="l-strip' + (L.dot === false ? "" : " hd") + '" data-slot="' + i + '" style="' + (sl.cycle === "tap" && sl.picks.length > 1 ? "cursor:pointer" : "") + '">' + stripHTML(sl, i) + "</div>"; }).join("");
    host.querySelectorAll(".l-strip").forEach(function (el, i) {
      var sl = slots[i];
      el.onclick = sl.cycle === "tap" && sl.picks.length > 1 ? function () { cur[i] = (cur[i] || 0) + 1; drawStrip(i); } : null;
      try { afterDraw(el); } catch (e) { warn(e); }
    });
  }
  function rot() {
    host.querySelectorAll("[data-rot]").forEach(function (el) {
      var c = lnCounts(pl), items = [
        '<span class="l-val">Stardate ' + lnEsc(lnStardate()) + "</span>",
        '<span class="st st-nominal">' + c.files.toLocaleString() + " files · " + c.folders.toLocaleString() + " folders</span>",
        '<span class="st ' + LN_STATES[state].cls + '">Link ' + (LN_STATES[state].term ? LN_STATES[state].term : "not set up") + "</span>",
        '<span class="l-val">' + lnEsc(lnNextEvent(pl)) + "</span>"
      ];
      el.innerHTML = items[rotIdx % items.length]; el.style.animation = "none"; void el.offsetWidth; el.style.animation = "";
    });
  }
  // A state change patches the classes and words of the pieces that show it; the rest of the lines keep running. A change must hold for 1.5 s first, so a sync that flaps does not flicker the display.
  var pend = null, pt = 0;
  function patch(n) {
    var was = state, d = LN_STATES[n]; state = n;
    if ((was === "none") !== (n === "none")) { draw(); return; }
    host.querySelectorAll("[data-sd]").forEach(function (el) {
      var k = el.dataset.sd;
      if (k === "dot") el.className = "l-dot " + d.dot;
      else if (k === "st") { el.className = "st " + d.cls; el.textContent = d.term ? "[" + d.term + "]" : "CONFIGURE"; }
      else if (k === "casc") { el.className = "l-casc " + d.casc; el.dataset.casc = n; }
      else if (k === "hb") el.className = "l-hb " + d.hb;
    });
    redrawKinds(["systems"]);
  }
  function onState() {
    var n = lnSyncState(app);
    if (n === state) { pend = null; window.clearTimeout(pt); return; }
    if (n === pend) return;
    pend = n; window.clearTimeout(pt);
    pt = window.setTimeout(function () { pend = null; var m = lnSyncState(app); if (m !== state) patch(m); }, 1500);
  }

  try {
    var sp = app.internalPlugins && app.internalPlugins.getPluginById && app.internalPlugins.getPluginById("sync");
    if (sp && sp.instance && typeof sp.instance.on === "function") { syncInst = sp.instance; ref = syncInst.on("status-change", onState); }
  } catch (e) { /* fall back to polling below */ }
  timers.push(gSet(onState, 5000));
  // Battery and connection: listeners, plus a speed sample every 20 s for the subspace trace.
  try { if (navigator.getBattery) navigator.getBattery().then(function (b) { if (stopped) return; batt = b; battEv.forEach(function (e) { b.addEventListener(e, onPowerSoft); }); onPower(); }, function () { /* no battery data */ }); } catch (e) { /* no battery data */ }
  if (conn && conn.addEventListener) conn.addEventListener("change", onNet);
  window.addEventListener("online", onNet); window.addEventListener("offline", onNet);
  pushHist();
  timers.push(gSet(function () { if (stopped || document.hidden) return; pushHist(); redrawKinds(["subspace"]); }, 20000));
  timers.push(gSet(function () { if (!stopped && (!host.isConnected || (L.pos === "top" ? host.parentElement && host.parentElement.firstElementChild !== host : false))) draw(); }, 2500));
  activeSlots().forEach(function (sl, i) {
    if (sl.cycle === "auto" && sl.picks.length > 1) timers.push(gSet(function () { if (!stopped) { cur[i] = (cur[i] || 0) + 1; drawStrip(i); } }, Math.max(2, Number(sl.seconds) || 4) * 1000));
  });
  // One shared tick, every 800 ms, for the random bars; paused while the page is hidden or the main plugin says it is idle. Only the segments that change are written.
  timers.push(gSet(function () {
    if (stopped || document.hidden || !host.offsetParent || document.body.classList.contains("lcars-idle")) return;
    tick++;
    // GEO follows the accelerometer when it is reporting; the other sensors are simulated.
    var gm = mo.t ? Math.min(1, mo.m * 2.5) : -1;
    host.querySelectorAll("[data-eq]").forEach(function (el) {
      if (Math.random() >= 0.6) return;
      el.style.transform = "scaleY(" + (gm >= 0 && el.classList.contains("c1") ? 0.18 + Math.random() * (0.15 + 0.85 * gm) : 0.15 + Math.random() * 0.85).toFixed(2) + ")";
    });
    sweepW();
    host.querySelectorAll(".l-seg[data-seg]").forEach(function (el) {
      var n = +el.dataset.seg, us = el.children, c = el._c === undefined ? Math.round(n / 2) : el._c, t = el._t === undefined ? c : el._t;
      if (c === t && Math.random() < 0.4) t = Math.round((gm >= 0 && el.classList.contains("g") ? Math.random() * (0.15 + 0.85 * gm) : Math.random()) * n);
      if (t > c) { us[c].className = "on"; c++; } else if (t < c) { c--; us[c].className = ""; }
      el._c = c; el._t = t;
    });
    if (tick % 4 === 0) { rotIdx++; rot(); }
    if (!batt && tick % 75 === 0) { sim.level = Math.max(0.35, Math.min(0.98, sim.level + (Math.random() - 0.55) * 0.03)); onPower(); }
  }, 800));
  // The adjacent tricorder, one of each graph and rotating: every sensor takes the next graph in turn.
  if (L.adj === "rotate") {
    var adjShift = 0;
    timers.push(gSet(function () {
      if (stopped || document.hidden || !host.offsetParent || document.body.classList.contains("lcars-idle")) return;
      adjShift++;
      host.querySelectorAll('.l-adj[data-adj="rotate"]').forEach(function (el) {
        var tmp = document.createElement("div"); tmp.innerHTML = lnAdjMain(pl, adjShift); var nn = tmp.firstChild; el.replaceWith(nn); seed(nn);
      });
    }, Math.max(3, Number(L.adjSeconds) || 8) * 1000));
  }
  pl.registerEvent(app.workspace.on("layout-change", function () { window.setTimeout(draw, 50); }));
  draw();
  return function stop() {
    stopped = true;
    timers.forEach(function (t) { window.clearInterval(t); }); window.clearTimeout(pt); window.clearTimeout(pwT);
    stopSens();
    try { if (batt) battEv.forEach(function (e) { batt.removeEventListener(e, onPowerSoft); }); } catch (e) { /* ignore */ }
    if (conn && conn.removeEventListener) conn.removeEventListener("change", onNet);
    window.removeEventListener("online", onNet); window.removeEventListener("offline", onNet);
    try { if (syncInst && ref) syncInst.offref(ref); } catch (e) { /* ignore */ }
    host.remove(); style.remove();
  };
}

class LcarsObsidian extends obsidian.Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.settings.channels = Object.assign({}, DEFAULTS.channels, this.settings.channels);
    try { await this.initPhone(); }
    catch (e) {
      // The phone layout must never stop the plugin from loading.
      console.warn("LCARS phone layout settings could not be read; the layout is off:", e);
      this.settings.phone = { on: false, lines: Object.assign({}, LN_DEFAULTS, { on: false }) };
    }
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
    this.addSettingTab(new LcarsSettings(this.app, this));
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
      // The banner's size depends on the theme (row height, top
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

  // The phone layout settings live under settings.phone: on, bottom, lines.
  get ms() { return this.settings.phone; }
  savePhone() { return this.saveData(this.settings); }

  async initPhone() {
    var S = this.settings, saved = S.phone, fresh = !saved;
    if (!saved) {
      // First run with the phone layout inside this plugin: bring over what LCARS Local Sandbox saved, if it is installed.
      try {
        var d = JSON.parse(await this.app.vault.adapter.read(this.app.vault.configDir + "/plugins/lcars-local-sandbox/data.json"));
        if (d && (d.lines || d.bottom || d.on !== undefined)) saved = { on: d.on, bottom: d.bottom, lines: d.lines };
      } catch (e) { /* not installed, or nothing saved */ }
    }
    var loaded = saved || {};
    var hadSlots = !!(loaded.lines && Array.isArray(loaded.lines.slots));
    var ph = S.phone = Object.assign({ on: true }, loaded);
    ph.lines = Object.assign({}, LN_DEFAULTS, ph.lines);
    var ml = ph.lines;
    if (!hadSlots) {
      // From the first version (picks and mode): two lines became two slots; one cycling line became one slot that cycles.
      var order = LN_ORDER.map(function (x) { return x[0]; }), old = (Array.isArray(ml.picks) ? ml.picks : ["link", "triA"]).filter(function (k) { return order.indexOf(k) > -1; });
      old.sort(function (a, b) { return order.indexOf(a) - order.indexOf(b); });
      if (ml.mode === "auto" || ml.mode === "tap") ml.slots = [{ on: true, picks: old, cycle: ml.mode, seconds: Number(ml.seconds) || 4 }, { on: false, picks: [], cycle: "off", seconds: 4 }];
      else ml.slots = [{ on: true, picks: old.slice(0, 1), cycle: "off", seconds: 4 }, { on: old.length > 1, picks: old.slice(1, 2), cycle: "off", seconds: 4 }];
    }
    ml.slots = [0, 1].map(function (i) { return Object.assign({ on: true, picks: [], cycle: "off", seconds: 4 }, ml.slots[i]); });
    ml.slots.forEach(function (sl) {
      if (sl.picks.indexOf("triE") > -1) {
        sl.picks = sl.picks.filter(function (k) { return k !== "triE"; });
        if (sl.picks.indexOf("triA") < 0) sl.picks.push("triA");
        if (!loaded.lines || !loaded.lines.adj) ml.adj = "equalizer";
      }
    });
    if (fresh) await this.savePhone();
  }

  // Phone layout (the slab). Pure styling.
  applyMobile() {
    var on = this.ms.on !== false, el = document.getElementById(MS_ID), b = document.body;
    if (on && !el) { el = document.createElement("style"); el.id = MS_ID; el.textContent = MS_CSS; document.head.appendChild(el); }
    if (!on && el) el.remove();
    b.classList.toggle(MS_CLASS, on);
    // Bottom clearance: Auto follows Obsidian's own offset for the Android navigation buttons; Custom sets it in px (0 = edge to edge).
    var bot = this.ms.bottom || {};
    if (on && bot.mode === "custom") b.style.setProperty("--ms-bot-override", Math.max(0, Number(bot.px) || 0) + "px");
    else b.style.removeProperty("--ms-bot-override");
    this.watchDrawers(on);
  }

  // The drawer lines (phone only): stop any running set, start a new one from the saved settings.
  applyLines() {
    if (this._stopLines) { this._stopLines(); this._stopLines = null; }
    var L = this.ms.lines;
    if (this.ms.on !== false && L.on !== false && document.body.classList.contains("is-phone")) {
      try { this._stopLines = startDrawerLines(this); }
      catch (e) { console.warn("LCARS drawer lines could not start:", e); this._stopLines = null; }
    }
  }

  // Mirror Obsidian's own drawer-open classes (set on the workspace element) onto the body, so the note's bars and the navbar, which sit outside it, can pick them up.
  watchDrawers(on) {
    var self = this, b = document.body;
    if (this._dw) { this._dw.disconnect(); this._dw = null; }
    if (!on) { b.classList.remove("lcars-ms-left-open", "lcars-ms-right-open"); return; }
    this.app.workspace.onLayoutReady(function () {
      var ws = self.app.workspace.containerEl;
      if (!ws || self.ms.on === false) return;
      var sync = function () {
        b.classList.toggle("lcars-ms-left-open", ws.classList.contains("is-left-sidedock-open"));
        b.classList.toggle("lcars-ms-right-open", ws.classList.contains("is-right-sidedock-open"));
      };
      sync();
      self._dw = new MutationObserver(sync);
      self._dw.observe(ws, { attributes: true, attributeFilter: ["class"] });
    });
  }

  onunload() {
    if (this._stopTitles) this._stopTitles();
    var msEl = document.getElementById(MS_ID);
    if (msEl) msEl.remove();
    if (this._stopLines) { this._stopLines(); this._stopLines = null; }
    if (this._dw) this._dw.disconnect();
    document.body.classList.remove(MS_CLASS, "lcars-ms-left-open", "lcars-ms-right-open");
    document.body.style.removeProperty("--ms-bot-override");
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
    if (window.lcarsObsidian && window.lcarsObsidian.plugin === this) {
      delete window.lcarsObsidian; delete window.lcarsStardate; delete window.lcarsStardateString;
      window.dispatchEvent(new Event("lcars-obsidian-gone"));
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
    // The banner is a desktop feature for now: no banner on phones and tablets.
    if (obsidian.Platform.isMobile) return out;
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
    // Anyone who wants it gone can hide .lcars-bh-version with your own CSS.
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
    if (typeof CustomEvent === "function") window.dispatchEvent(new CustomEvent("lcars-obsidian-status-changed", { detail: { id: id, change: change, source: source } }));
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
    try { this.applyMobile(); } catch (e) { console.warn("LCARS phone layout could not start:", e); }
    this.app.workspace.onLayoutReady(function () { try { me.applyLines(); } catch (e) { console.warn("LCARS drawer lines could not start:", e); } });
    window.lcarsObsidian = { apiVersion: 1, plugin: this, hooks: this.hooks, api: api };
    window.dispatchEvent(new Event("lcars-obsidian-ready"));
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
class LcarsSettings extends obsidian.PluginSettingTab {
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
    var p = this.plugin, list = [["general", "General"], ["banner", "Banner"], ["statuses", "Statuses"], ["lights", "Running lights"], ["phone", "Phone"]], extra = [];
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
    else if (p._tab === "phone") this.renderPhone();
    else this.renderStatuses();
  }

  renderPhone() {
    var root = this.containerEl, host = this.plugin;
    new obsidian.Setting(root).setName("Phone layout: the slab")
      .setDesc("LCARS look for the phone: thin capped bars with keys, a solid slate left drawer, a blue subframe on the right drawer. Phone only; tablets and desktop are untouched.")
      .addToggle(function (t) {
        t.setValue(host.ms.on !== false).onChange(async function (v) { host.ms.on = v; await host.savePhone(); host.applyMobile(); });
      });
    var bot = host.ms.bottom || (host.ms.bottom = { mode: "auto", px: 48 });
    new obsidian.Setting(root).setName("Bottom clearance")
      .setDesc("Where the lower bars sit above the screen's bottom edge, so they clear the phone's navigation buttons. Auto follows what Obsidian reports for your phone. Custom is for phones that report it wrongly; 0 runs the bars to the very edge.")
      .addDropdown(function (d) {
        d.addOption("auto", "Auto").addOption("custom", "Custom (px)").setValue(bot.mode || "auto")
          .onChange(async function (v) { bot.mode = v; await host.savePhone(); host.applyMobile(); });
      })
      .addText(function (t) {
        t.setPlaceholder("48").setValue(String(bot.px === undefined ? 48 : bot.px))
          .onChange(async function (v) { bot.px = Number(v) || 0; await host.savePhone(); host.applyMobile(); });
      });
    // Drawer lines (phone)
    var ln = host.ms.lines, self = this;
    var saveLn = async function (redraw) { await host.savePhone(); host.applyLines(); if (redraw) self.display(); };
    var openSl = host._lnOpen || (host._lnOpen = {});
    new obsidian.Setting(root).setName("Drawer lines (phone)").setDesc("Animated readout lines in the left drawer, next to Notebook Navigator's buttons. Phone only; the desktop has the banner.").setHeading();
    new obsidian.Setting(root).setName("Show Data Lines").addToggle(function (t) { t.setValue(ln.on !== false).onChange(async function (v) { ln.on = v; await saveLn(true); }); });
    if (ln.on !== false) {
      new obsidian.Setting(root).setName("Short ship name").setDesc("Used on one-line readouts where the full name does not fit. Empty: the banner's ship name without \"USS\".")
        .addText(function (t) { t.setPlaceholder(lnShip(host)).setValue(ln.short || "").onChange(async function (v) { ln.short = v; await saveLn(false); }); });
      var names = {}; LN_ORDER.forEach(function (x) { names[x[0]] = x[1]; });
      [0, 1].forEach(function (i) {
        var sl = ln.slots[i];
        if (i === 1) new obsidian.Setting(root).setName("Second slot").setDesc("A second line under the first.").addToggle(function (t) { t.setValue(sl.on !== false).onChange(async function (v) { sl.on = v; await saveLn(true); }); });
        if (i === 1 && sl.on === false) return;
        var d = root.createEl("details", { cls: "lcars-set-sec" });
        d.open = !!openSl[i]; d.addEventListener("toggle", function () { openSl[i] = d.open; });
        var cyc = sl.picks.length > 1 ? (sl.cycle === "tap" ? "cycling on tap" : "cycling every " + (Number(sl.seconds) || 4) + " s") : "";
        d.createEl("summary", { cls: "lcars-set-sum", text: "Slot " + (i + 1) + ": " + (sl.picks.length ? LN_ORDER.filter(function (x) { return sl.picks.indexOf(x[0]) > -1; }).map(function (x) { return names[x[0]]; }).join(", ") : "empty") + (cyc ? " (" + cyc + ")" : "") });
        var body = d.createDiv({ cls: "lcars-set-body" });
        LN_ORDER.forEach(function (it) {
          new obsidian.Setting(body).setName(it[1]).addToggle(function (t) {
            t.setValue(sl.picks.indexOf(it[0]) > -1).onChange(async function (v) {
              sl.picks = sl.picks.filter(function (k) { return k !== it[0]; }); if (v) sl.picks.push(it[0]);
              if (sl.picks.length > 1 && sl.cycle === "off") sl.cycle = "auto";
              if (sl.picks.length < 2) sl.cycle = "off";
              await saveLn(true);
            });
          });
        });
        if (sl.picks.length > 1) {
          new obsidian.Setting(root).setName("Slot " + (i + 1) + " cycles").setDesc("The slot shows one line at a time.").addDropdown(function (dd) {
            dd.addOption("auto", "Automatically").addOption("tap", "On tap").setValue(sl.cycle === "tap" ? "tap" : "auto").onChange(async function (v) { sl.cycle = v; await saveLn(true); });
          });
          if (sl.cycle !== "tap") new obsidian.Setting(root).setName("Slot " + (i + 1) + " seconds per line").addText(function (t) { t.setValue(String(sl.seconds)).onChange(async function (v) { sl.seconds = Math.max(2, Number(v) || 4); await saveLn(false); }); });
        }
      });
      var both = ln.slots[0].picks.length && ln.slots[1].on !== false && ln.slots[1].picks.length;
      if (both) new obsidian.Setting(root).setName("Gray spacer between the slots").setDesc("Keeps the frame-colored gap between two black lines. On the frame color the gap is invisible.").addToggle(function (t) { t.setValue(!!ln.spacer).onChange(async function (v) { ln.spacer = v; await saveLn(false); }); });
      new obsidian.Setting(root).setName("Position").setDesc("Above the buttons: below the drawer's top curve. Bottom: above the vault name, clear of the bottom curve.").addDropdown(function (dd) {
        dd.addOption("top", "Above the buttons").addOption("bottom", "Bottom of the drawer").setValue(ln.pos).onChange(async function (v) { ln.pos = v; await saveLn(false); });
      });
      new obsidian.Setting(root).setName("Background").addDropdown(function (dd) {
        dd.addOption("black", "Black").addOption("frame", "LCARS frame color").setValue(ln.bg).onChange(async function (v) { ln.bg = v; await saveLn(false); });
      });
      // Tricorder settings appear only while a tricorder line is in a slot.
      var inSlots = function (test) { return ln.slots.some(function (sl, i) { return (i === 0 || sl.on !== false) && sl.picks.some(test); }); };
      new obsidian.Setting(root).setName("Status circle on every line").setDesc("The colored circle at the left of each line. It follows what that line reports: link state, power level, the active condition, or steady blue for lines with no state.").addToggle(function (t) { t.setValue(ln.dot !== false).onChange(async function (v) { ln.dot = v; await saveLn(true); }); });
      if (inSlots(function (k) { return k === "triA"; })) new obsidian.Setting(root).setName("Adjacent tricorder graph").setDesc("How GEO, BIO and MET are drawn side by side.").addDropdown(function (dd) {
        dd.addOption("boxes", "Boxes (horizontal segments)").addOption("equalizer", "Equalizer (columns)").addOption("spark", "Sparkline (scrolling line)").addOption("mixed", "One of each (boxes, equalizer, sparkline)").addOption("rotate", "One of each, rotating").setValue(ln.adj || "boxes").onChange(async function (v) { ln.adj = v; await saveLn(true); });
      });
      if (ln.adj === "rotate" && inSlots(function (k) { return k === "triA"; })) new obsidian.Setting(root).setName("Seconds per rotation").setDesc("Each sensor takes the next graph after this many seconds.").addText(function (t) { t.setValue(String(ln.adjSeconds || 8)).onChange(async function (v) { ln.adjSeconds = Math.max(3, Number(v) || 8); await saveLn(false); }); });
      var anyTri = inSlots(lnIsTri);
      if (anyTri) {
        new obsidian.Setting(root).setName("Tricorder fourth metric").setDesc("An extra slot on the tricorder lines: the data link word with an icon, a small cascade, or a heartbeat.").addDropdown(function (dd) {
          dd.addOption("off", "None").addOption("text", "Data text").addOption("visual", "Data visual").addOption("heartbeat", "Heartbeat").setValue(ln.slot).onChange(async function (v) { ln.slot = v; await saveLn(true); });
        });
        if (ln.slot !== "off") new obsidian.Setting(root).setName("Fourth metric width").setDesc("One half is the minimum that fits the text.").addDropdown(function (dd) {
          dd.addOption("half", "One half").addOption("two3", "Two thirds").setValue(ln.slotW === "two3" ? "two3" : "half").onChange(async function (v) { ln.slotW = v; await saveLn(false); });
        });
      }
    }
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

    this.group("Interface", "Pieces of the LCARS look that need a script. The theme draws them; these switches decide whether the plugin runs the script.");
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

module.exports = LcarsObsidian;
