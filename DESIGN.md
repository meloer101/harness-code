# Design

Visual system for the `hc web` console. Strategic context lives in [PRODUCT.md](PRODUCT.md); this file answers "how it looks". Source of truth in code: `packages/web/src/index.css` (tokens), `packages/web/src/lib/theme.ts` (theme switching).

## Mood

"A bookbinder's workshop at dusk" — oiled wood, brass tools, violet twilight. 工匠感、迅捷、飞跃: a surface built for hours of reading, with the warmth carried by typography and one brass accent, never by a cream background.

## Color

Strategy: **Restrained+** — tinted neutrals in the violet hue family (285°), one violet primary (seed hue 280°), one brass accent. Light and dark are tuned independently, not mechanically inverted. All values OKLCH.

### Light

| Role | Value | Notes |
| --- | --- | --- |
| `background` | `oklch(0.982 0.004 285)` | near-white, whisper of violet — never cream |
| `foreground` | `oklch(0.235 0.02 285)` | violet ink, ~14:1 |
| `card` / `popover` | `oklch(0.996 0.002 285)` | elevation via near-white + border + `shadow-xs` |
| `primary` | `oklch(0.51 0.16 280)` | the brand violet; white text on fills |
| `muted-foreground` | `oklch(0.475 0.022 285)` | ≥4.5:1 — no washed-out gray |
| `brass` | `oklch(0.55 0.1 78)` | warm accent, text-safe on light bg |
| `brass-subtle` | `oklch(0.945 0.03 85)` | tint for pending/attention surfaces |
| `destructive` | `oklch(0.55 0.19 25)` | |
| `success` | `oklch(0.56 0.12 155)` | |
| `border` | `oklch(0.9 0.009 285)` | |

### Dark

| Role | Value | Notes |
| --- | --- | --- |
| `background` | `oklch(0.178 0.012 285)` | violet-twilight near-black (environmental tint, deliberate) |
| `foreground` | `oklch(0.925 0.009 285)` | ~14:1 |
| `card` / `popover` | `oklch(0.212 / 0.218 0.014 285)` | |
| `primary` | `oklch(0.485 0.14 280)` | deep enough for white text (≥4.5:1) |
| `muted-foreground` | `oklch(0.685 0.02 285)` | ≥4.5:1 |
| `brass` | `oklch(0.78 0.11 84)` | brighter for dark surfaces |
| `border` | `oklch(0.92 0.01 285 / 11%)` | alpha borders on dark |

### Semantic mapping

- **Violet (`primary`)**: identity, running state, links, plan review, focus rings, send/approve actions.
- **Brass**: waiting-on-you states — permission asks, pending dots, reconnecting banner, thinking marker, list markers, blockquote rule, the `·` in the wordmark.
- **Success / destructive**: tool results and diff add/del only.
- Text on saturated fills is always white/near-white (Helmholtz-Kohlrausch); dark text only on pale or neutral fills.

## Typography

Self-hosted via Fontsource (same-origin; the server CSP is `font-src 'self'`):

| Role | Face | Used for |
| --- | --- | --- |
| `--font-serif` | **Spectral** | assistant prose (`.md`), the wordmark, empty states, thinking body — the reading surface |
| `--font-sans` | **Hanken Grotesk Variable** | UI chrome: buttons, sidebar, labels, headers |
| `--font-mono` | **JetBrains Mono Variable** | code, paths, commands, usage numbers, kbd, tool names |

Rules: assistant prose is 15px/1.75 serif capped at 68ch; UI labels stay sans; CJK falls back to system fonts (PingFang SC / Noto). Code highlighting: Shiki `rose-pine-dawn` / `rose-pine-moon`, switched by `.dark` via CSS variables.

## Theming

- Class-based: `html.dark` toggles `@custom-variant dark`. `color-scheme` set per theme.
- `public/theme.js` applies the persisted theme before first paint (external file — CSP forbids inline scripts). `lib/theme.ts` owns state: `system | light | dark`, persisted as `hc.theme` via platform storage, OS changes tracked while in `system`.
- UI: one footer button in the sidebar cycles system → light → dark.
- Theme switches glide (180ms ease-out on background/border/color); all motion has `prefers-reduced-motion` fallbacks.

## Components

- **Sidebar**: serif wordmark `hc·web` (brass dot), card-style New session button with `⌘K` hint, session rows 13px with mono timestamps, footer = theme toggle + connection dot.
- **Tool cards**: rounded-lg card, mono tool name, status icon in token colors (primary spinner / success check / destructive X), hover tint on the header row, body on `muted/40`.
- **Pending dock** (no modals): brass border + tint for permission asks, violet for plan review; kbd hints (`y`/`a`/`n`).
- **Composer**: card surface, focus = violet border + ring + shadow lift.
- **Diffs**: `success`/`destructive` at 10% bg with matching text; mono 11px.
- **Banners**: brass tint for connection, destructive tint for errors.

## Layout

App shell: 256px sidebar + main column; transcript and composer centered at `max-w-3xl`. Radius scale anchored at `--radius: 0.625rem`. Thin themed scrollbars. Selection tinted violet.

## Motion

Intentional and minimal: committed transcript rows rise 240ms expo-out (`animate-rise`), pending dock rises in, theme transition glide, existing spin/pulse for running states. No layout-property animation; reduced-motion disables all of it.

## Anti-patterns (per PRODUCT.md)

No cream/beige backgrounds, no gradient text, no neon terminal green, no side-stripe accent borders, no glassmorphism, no decorative eyebrows. Warmth comes from Spectral, brass, and ink levels — not from the surface color.
