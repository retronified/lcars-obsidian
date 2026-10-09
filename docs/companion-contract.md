# Extension interface (experimental)

LCARS for Obsidian offers a small interface for a second plugin. It is **experimental until 1.0**: names and shapes may change between 0.x releases. Nothing here is needed to use the plugin on its own. With nothing attached, the hooks do nothing and the settings pages show no extra items.

The first user is a private calendar plugin, which supplies a countdown, event situations and a ticker label. Anything else that wants to draw on the lights, or raise statuses, can use the same interface.

## Attaching

The plugin publishes `window.lcarsCompanion` and fires `lcars-companion-ready` on `window` when it loads. It fires `lcars-companion-gone` when it unloads.

```js
function attach(api) {
  if (!api || api.apiVersion !== 1) return;     // the interface version
  var plugin = api.plugin;                       // the Companion plugin instance
  Object.assign(api.hooks, { /* the hooks below */ });
  plugin.refreshLights();                        // rebuild the banner's lights with your hooks
}
if (window.lcarsCompanion) attach(window.lcarsCompanion);
window.addEventListener("lcars-companion-ready", function () { attach(window.lcarsCompanion); });
window.addEventListener("lcars-companion-gone", function () { /* drop your reference */ });
```

Remove your hooks when your plugin unloads (`delete api.hooks.name`) and call `plugin.refreshLights()`.

Hooks run with `this` set to the plugin. Settings are in `this.settings`; `this.settings.lights` and `this.settings.alerts` are the lights and the statuses. The plugin saves everything in its own `data.json`, so a second plugin can keep its settings there.

## Statuses

`window.lcarsCompanion.api.statuses`:

- `list()` returns `[{ id, label, hand, raised }]`.
- `active()` returns `[{ id, source, since, until }]` for statuses raised now.
- `raise(id, { source, until })` raises a status. `until` is an epoch time in milliseconds that replaces the status's own exit for this raise.
- `clear(id, { source, force })` clears one. A `source` can only clear what it raised, unless `force` is true.

Every change fires `lcars-companion-status-changed` on `window` with `{ id, change, source }`.

The same operations are available as Obsidian links: `obsidian://lcars-status?raise=ID`, `clear=ID`, `toggle=ID`, with `until=MINUTES` and `force=1`.

## The lights model

`hooks.lightsModel(now, kind)` returns a model for the lights. It runs about once a second, once for every banner, and `kind` is set (`"countdown"`, `"final"`, `"during"`, and so on) when a settings preview asks for a made-up situation. The plugin draws the lights from the model; the model does not describe segments.

```js
{
  phase: "rest",            // the situation, for settings tags
  mode: "rest",             // "rest" | "countdown" | "during" | "free"
  final: false,             // inside the final minutes: the final-minutes effect runs
  label: "", tip: "", url: "",
  dur: 2,                   // unused by the new drawing, kept for compatibility
  alert: { phase: "rest", title: "" },   // what raises statuses: rest, countdown, final, during, starting, started
  progress: { share: 0..1, anchor: "left"|"right"|"center"|"edges"|"top"|"bottom", dim: 0..1, rows: "all"|"top"|"middle"|"bottom" },
  layout: { rows: 1..5 },   // optional
  look: { rest: "chase", restDir: "left", ... },   // optional: any look setting
  speed: 1,                 // multiplier on the lights' own speed, 0.25 to 4
}
```

- **progress**: the lit part is the status's own look; the unlit part is that look dimmed to `dim`. With `rows` set to one row, the other rows stay lit. `top` and `bottom` fill the rows one after another.
- **layout** and **look** are laid over the showing status's look. A status can say *Override the event bar* and then ignores them.
- A model without `progress` and with `rows: [[{on, dim, tone}...]]` is drawn the old way, one cell per segment.

## The other hooks

All are optional.

| Hook | Called with | Returns / does |
| --- | --- | --- |
| `eff(phase)` | a phase name | the lights settings for that phase (copy of `settings.lights` by default) |
| `live()` | nothing | true if the lights should be painted every second |
| `showLabel(kind)` | `kind` or undefined | true to create the label next to the lights |
| `paintLabel(el, model)` | the label element and the model | fills the label |
| `click()` | nothing | the click action; the lights' `click` setting must be non-empty |
| `colorVars()` | nothing | `[["--css-var", "settingKey", defaultValue], ...]` to write on the lights row |
| `onSave()` | nothing | after the plugin saves |
| `eventEnd(date)` | a Date | the end (ms) of the event in progress, for the exit "When the calendar event ends" |
| `eventBar(status, model)` | the status and the model | the part of the model for that status: `{ progress, layout, look, speed, why }`. The status that is showing decides it. |

## Settings pages

| Hook | Called with | Does |
| --- | --- | --- |
| `settingsTabs()` | nothing | returns `[{ id, name, render(el, ctx), badge?, level? }]`, tabs added before Running lights |
| `statusFields(status, el, ctx)` | the status card | adds rows to the card's Triggers |
| `statusEventBar(status, el, ctx)` | the status card | adds a section to the card (`ctx.barEditor(holder, obj, key, name)` draws the shared look editor for an object) |
| `debugRows(el, ctx)` | the Debug group | adds rows to General, Debug |
| `settingsBanner()` | nothing | `{ label, text }`, a banner at the top of the settings page |
| `settingNote(key, obj)` | a setting key or `"status:ID"` | a short sentence, or `{ note, level }` with `level` `"modified"` (orange) or `"dependent"` (red); the setting gets a badge |

`ctx` has `plugin`, `save()`, `redraw()` and, where it applies, `open` (a set that remembers expanded sections).

## Methods on the plugin

The plugin offers a few methods a second plugin may call: `refreshLights()`, `addPreview(el, kind, statusId)`, `renderWhy(el, statusId, kind)`, `lookEditor(el, target)`, `lookTarget(status, obj, key, name)`, `previewParts(kind, statusId, now)`, `statusById(id)` and `look(status)`. These are the least stable part of the interface.
