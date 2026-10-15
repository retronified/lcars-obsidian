# Changelog

## Unreleased

- Fixed: a Custom timing of two numbers (on and off) forced a hard blink on every light behavior. Now only the plain flash blinks; pulse, flicker, glow and scan keep their own motion and use the combined length as their cycle.
- Changed: the banner is not mounted on phones and tablets.

## 0.2.0

- Changed: the plugin id is now `lcars-obsidian` (it was `lcars-companion`), so a by-hand install goes in `.obsidian/plugins/lcars-obsidian/`. If you installed 0.1.0, move your settings (`data.json`) into the new folder and remove the old one.
- Changed: the extension interface is renamed from "companion" to "extension". `window.lcarsCompanion` is now `window.lcarsObsidian`, and the events `lcars-companion-ready`, `lcars-companion-gone` and `lcars-companion-status-changed` are now `lcars-obsidian-ready`, `lcars-obsidian-gone` and `lcars-obsidian-status-changed`. The doc moved to `docs/extension-contract.md`. It is still experimental.
- Changed: the theme sources moved from `snippets/` to `theme/`, and the README no longer describes copying snippets by hand. The theme comes with the plugin.
- Changed: Style Manager is described as optional.
- Changed: wording across the README, the theme comments and the plugin source no longer calls the plugin the "Companion".
- Fixed: Style Manager could not load the LCARS Palette pickers. The "Void black" description held a colon in the middle of the sentence, which broke the settings block's YAML, so none of the palette settings appeared. The description is now quoted.

## 0.1.0

First release. The repository holds the plugin and the theme it carries.

- The theme is built into the plugin: install the plugin and you have it. The Antonio font is built in too.
- MIT license.

- A banner at the top of the left sidebar: ship name and registry, stardate and clock, CONDITION, ship status readout and an optional embed.
- Statuses as expanding cards in priority order, with triggers (by hand, exit, cron start time), appearance, an override for event bars, and a Custom config look.
- Running lights with a default look and Motion, Color and Layout settings: Data cascade, Solid bar, Moving dots and Warp core styles, row styles, up to 5 rows, and a click ripple.
- Ribbon roles: each left-ribbon button is colored by where its pane opens (right sidebar, editor, left sidebar), learned from a press. Switch: General, Interface.
- Note title blocks: the block and stripe beside each note's title, drawn by the plugin. Switch: General, Interface.
- Style Manager settings for the banner's padding and the active folder's pulse. The banner re-fits as soon as a Style Manager value changes.
- The ribbon roles are remembered in Obsidian's per-vault storage, not the storage every vault shares.
- The theme builds in the dark palette, including Obsidian's own colors, so neither Minimal nor Style Manager is required.
- File Explorer: square corners, names end in an ellipsis, item counters and file-type tags are readable.
- Style Manager switch to turn folder focus off.
- Notebook Navigator with Shortcuts pinned and Recent files in the list lines up on the grid.
- Commands, Obsidian links and an experimental extension interface for other plugins.
- A banner height that eases when it changes, and a debug view that explains why the lights look as they do.
