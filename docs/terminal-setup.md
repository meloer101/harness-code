# Terminal setup

The Ink TUI (`hc` with no prompt, or the interactive session) draws box-drawing
characters, gutters, and aligned columns. Those stay aligned only if your
terminal and font agree on character width — especially for CJK text, where a
wrong width estimate drifts the whole line by a column. This is a one-time
setup note to avoid that.

## Recommended terminals

Any terminal with a true-color, Unicode-aware renderer works. Known-good:

- **macOS / Linux** — [WezTerm](https://wezterm.org), [Kitty](https://sw.kovidgoyal.net/kitty/),
  [Alacritty](https://alacritty.org), or iTerm2.
- **Windows** — [Windows Terminal](https://aka.ms/terminal). The legacy
  `cmd.exe` console is **not** supported for the TUI (it falls back to the plain
  REPL); the one-shot CLI works anywhere.

## Font

Use a monospace font with solid box-drawing glyphs, and configure a **CJK
fallback** so Chinese/Japanese/Korean text renders at a consistent width:

- Primary: **JetBrains Mono**, Fira Code, or any programming font you like.
- CJK fallback: **PingFang SC** (macOS), **Noto Sans CJK / Noto Sans Mono CJK**
  (Linux/Windows), or **Sarasa Mono** (a CJK-aware mono that bundles both).

In WezTerm, for example:

```lua
config.font = wezterm.font_with_fallback({ 'JetBrains Mono', 'PingFang SC' })
```

## East-Asian ambiguous width

If box-drawing or CJK columns still drift by one cell, set your terminal's
*ambiguous-width* (a.k.a. "treat ambiguous characters as wide") to match the
font. WezTerm exposes `unicode_version`; Kitty and iTerm2 have the setting under
their Unicode/text options. Pick one and keep the font's CJK fallback consistent
with it.
