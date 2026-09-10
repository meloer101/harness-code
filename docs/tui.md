# TUI design notes

The Ink terminal UI (`packages/tui`) is a second frontend over the same
`AgentSession` engine the one-shot CLI and the readline REPL drive. One binary,
three surfaces, zero duplicated harness logic.

## Colour

One accent — **Apple system blue** (`#0A84FF`, calibrated for a terminal) —
everything else near-black / near-white, and **never a background colour**: the
terminal's own background wins. Accent is reserved for focus, the plan-mode dot,
spinners, links and modal borders; headings are bold `text`, never accent. That
restraint is the look.

| token | dark | light (structure only, v1 ships dark) |
| --- | --- | --- |
| text | `#E6E6E6` | `#1A1A1A` |
| dim | `#9B9B9B` | `#6B6B6B` |
| faint | `#5A5A5A` | `#C8C8C8` |
| accent | `#0A84FF` | `#0066CC` |
| success / warning / error | `#3FB950` / `#D29922` / `#F85149` | `#1A7F37` / `#9A6700` / `#CF222E` |

On chalk: Ink transitively depends on chalk, so `packages/tui` does too — that's
fine. The "no chalk" rule is about **scriptable `hc` output** (`TextSink` still
emits raw `\x1b[…m`); the TUI is purely interactive and Ink owns its colours.

## Push → pull event bridge

`AgentSession.onEvent` fires synchronously, once per token. The TUI never
dispatches React state on that path — a mutable `EventBuffer` absorbs deltas,
and a ~33ms flush loop copies a snapshot into the reducer. Tool-call start/end
and turn end request an **immediate** flush so the final token is never dropped.
`<Static>` holds the committed transcript (rendered once, native scrollback, no
height cap); only the small live region re-renders while a turn streams.

## CJK width safety

All display-width math goes through `util/width.ts` (`string-width` +
`cli-truncate`), never `.length` / `.slice()`. Fullwidth CJK counts as 2 columns
and truncation cuts on display width, so `│` gutters and right-aligned meter
bars stay aligned with mixed CJK/ASCII content. See
[terminal-setup.md](./terminal-setup.md) for the font stack.

## Deferred (v1.1)

`stream-json` output, OSC-11 light-theme auto-detection + `/theme` persistence,
a hand-rolled multi-line cursor editor + input history, per-card focus
navigation, `cli-highlight` syntax highlighting, `/model` live switching, rich
`/mcp` / `/skills` overlays, Markdown tables, Windows polish.
