# Roadmap — what's left to build

> The single forward-looking doc for `harness-code` (`hc`). It lists **only what
> remains**: unfinished work and nice-to-have polish. Anything already shipped is
> deliberately omitted — see [`README.md`](../README.md) for what works today and
> [`PLAN.md`](./PLAN.md) for the phase-by-phase build history and deviation log.
>
> This file replaces the previous scatter of working docs (phase plans, runtime
> studies, the gap taxonomy, per-feature references). Their open items are folded
> in below; their shipped-feature descriptions live in the README.
>
> Last consolidated: 2026-09-13.

## Where the project stands

Feature-complete across the original plan and the two follow-on milestones:

- **Done:** Phase 0–8 (provider layer · agent loop · tools · permissions/sandbox ·
  context engineering · MCP client+server · skills · sub-agents · telemetry · eval
  suite), Phase 9 (CLI polish + Ink TUI + web UI), Phase 11 (cross-session memory),
  Phase 12 (in-session context engineering ①–⑦).
- **Correctness foundation** (the P0 loop-reliability items) is closed: tool-call
  ordering, truncation-as-distinct-stop, mid-turn context-exceeded salvage, and
  dangling-tool-call repair on `--resume` are all implemented and tested.

What's left is the finish line (docs + demo), a short list of behavior-quality and
robustness items, and a set of clearly-scoped stretch enhancements.

---

## 1. Finish line — to call the project "done"

These are the last items from the original 10-phase plan. **Only F2 remains** —
F1/F3/F4/F5 shipped 2026-09-13 (after re-recording the eval cassettes against
the Phase 12 prompt).

| # | Item | Effort | Notes |
|---|---|---|---|
| F1 | ~~`docs/architecture.md`~~ | — | **Done.** Narrative doc with a dataflow diagram, the one the README links to. |
| F2 | **Demo GIF** in the README | S | **Remaining.** `asciinema` + `agg`, driven by a cassette/cheap model, < 30s. `scripts/record-demo.sh` (lock the font). Needs the recording tools installed + a recording pass. |
| F3 | ~~README polish~~ | — | **Done.** Dropped "Phase 8 of 10"; added Context-engineering + Memory sections; refreshed eval baseline + ablation tables to current numbers; 401→699 tests; roadmap table + architecture link. |
| F4 | ~~`docs/terminal-setup.md`~~ | — | **Done.** Recommended terminals + CJK-safe font stack. |
| F5 | ~~`CONTRIBUTING.md`~~ | — | **Done.** (`npm publish` still optional, not done.) |

---

## 2. Open engineering items

Grouped by the harness taxonomy category they belong to. Severity/effort in the
right column. "Measured via" flags items that need the ablation runner (now built)
or a real Harbor run to validate.

### A · Model / Provider layer
- **Native Anthropic provider** — Claude is reachable only via OpenRouter/proxy
  today. High strategic value (lets `hc` benchmark against/with Claude), low
  immediate-reliability value. **Deferred, not a current priority.** Additive and
  non-confounding; can proceed independently whenever picked back up. *(M)*
- **`stream-json` output format** — currently a stub; NDJSON-per-event + trailing
  `result`. *(S)*

### B · Orchestration loop
- **Bounded text-truncation auto-continuation** — a pure-text `max_tokens` stop is
  surfaced as a distinct stop reason (correct), but the loop stops rather than
  offering a bounded hermes-agent-style continuation. Optional enhancement, not
  urgent. *(S, Low)*

### C · Tool system & execution
- **Tool-loop guardrails (signature-level tracking)** — detect repeated identical
  tool calls (blind retries / rabbit-holing) and intervene, generalizing the
  current step-back nudge. Partially addressed by the nudge; the structural version
  is the borrow from hermes-agent's `tool_guardrails`. *(M, P1)*
- **Broaden the structured-error sink** — `NoModelConfiguredError` now emits
  structured JSON for `--output-format json`, but other pre-sink errors (e.g. an
  unknown provider name from deeper in `buildSessionConfig`) still exit as plain
  text. Broadening covers the top-level `main()`/`unhandledRejection` path. *(S)*
- **`.env` loaded relative to `process.cwd()`, not `--cwd`** — minor correctness
  wrinkle when running against another directory. *(S, minor)*

### E · Context engineering (in-session)
- **Large-repo exploration fixture** — the `subagents` and `compaction` ablation
  arms can't show their real "isolation/compaction saves context" signal on the
  current 5 small fixtures. A big-repo exploration task is the follow-up that would
  give them a real signal. *(M)*

### G · Observability & evaluation
- **Finish the 89-task Harbor benchmark** — 18/89 tasks run so far (DeepSeek
  balance ran out mid-run). Until complete, keep labeling every capability claim
  **"18/89 provisional."** Budget/time-gated, not engineering. *(L)*
- **OpenTelemetry exporter** — the telemetry layer's declared stretch; never built.
  A span/metric exporter over the existing trace events. *(M, stretch)*

### H · Agentic behavior quality
Prompt fixes for the behavior gaps below **landed** (a `<working_style>` block in
`AGENT_CONVENTIONS`) but their **effect is unmeasured** — none of the local
fixtures reproduce the multi-attempt/optimization failure modes. Each needs a real
Harbor re-run and/or a purpose-built eval signal to confirm it helps.

- **Turn-budget nudge regression on optimization tasks** — the nudge is net
  positive (+2/−1) but not clean; it hurts iterative/optimization-style tasks. Make
  it conditional on task-shape signals (e.g. repeated-iteration patterns in todo
  state). The ablation runner to measure this is now available. *(M)* — **measure**
- **Nudge copy tuning near the wall** — "stop polishing, ship current state" past
  the budget wall; consider a distinct hard-wrap-up mode past 90%. Addresses the
  "fussing over trivial details" symptom. *(S–M)*
- **Over-engineering / simplicity bias** — an upfront "try simple first" rule
  landed; verify it recovers the `largest-eigenval`-style case on Harbor. The eval
  check (diff-size / new-file-count) is not built. *(M)* — **measure**
- **Late commitment to the deliverable** — prompt rule landed ("touch the real
  deliverable in the first third"); build the telemetry proxy metric
  (time-to-first-touch of the deliverable) to actually measure it. *(M)* — **measure**
- **Scratch-file sprawl** — prompt convention landed; the structural option (a
  harness-enforced scratch dir) is worth it only if the prompt-only fix proves
  insufficient on a real run. *(S–M)*
- **Stop gate / `onBeforeStop` hook** — intercept the model just before it declares
  done to verify the task's real acceptance criteria (borrow from hermes-agent's
  `verification_stop`). Needs a new hook interface. *(M, P2)*
- **Last-turn forced summarize** — on the final allowed turn, drop tools and force
  a summary/handoff instead of a truncated tool call. *(S, P1)*

### F · Protocol & state sync (web)
- **Markdown raw-display bug** — an unresolved cosmetic issue in the web renderer
  (`Markdown.tsx`/`MarkdownBody.tsx`): some content shows as raw text instead of
  going through the sanitized/highlighted renderer. Pin an exact repro against
  current state, then find the raw-text fallback path. Standalone, low-risk. *(S, Low)*

---

## 3. Nice-to-have / stretch

Deferred deliberately; none block "done." Pick up by interest.

### TUI v1.1 (the Ink TUI shipped v1 — dark theme, streaming markdown, tool cards,
modals, slash commands)
- Syntax highlighting in code blocks (`cli-highlight`) — v1 renders code dim.
- Markdown tables (v1 renders them as plain text).
- OSC-11 light-theme auto-detection + `/theme` persistence (light palette is
  wired, but v1 ships dark only and doesn't auto-switch).
- Hand-written multiline editor (in-buffer cursor movement) + input history.
- Per-tool-card focus navigation (v1 has a global "expand last output" toggle).
- Live `/model` switching (v1 shows the model read-only); richer `/mcp` `/skills`
  overlays.
- Windows polish (old-console fallback is REPL; cmd.exe TUI marked unsupported).

### Other
- **Write-capable sub-agents** — the read-only `explore` isolation pattern is
  proven; a sub-agent that can write is the next step, after the large-repo fixture
  validates the isolation payoff.
- **`hc eval` thin command** — a `child_process.spawn` wrapper over
  `evals/dist/cli.js` (deliberately *not* an import, to keep fixtures/cassettes out
  of the `hc` binary). `pnpm eval` already exists; this is just the CLI verb.
- **Port the eval harness onto `AgentSession`** — `evals/src/harness.ts` still runs
  its own ~80-line headless distillation. Folding it onto `AgentSession` removes the
  duplication, but is risky: cassettes are keyed on the fingerprinted request, so it
  must call `buildAgentSystemPrompt` byte-for-byte identically or every cassette
  needs re-recording. Isolate in its own commit; revert if it drifts.
- **Per-tool `readOnly`/`concurrencySafe` overrides for MCP tools** — MCP tools are
  hardcoded serial + non-read-only (safe default, same tier as `bash`). A
  per-tool `.mcp.json` override would let known-safe tools run in parallel. No
  consumer today.
- **Standalone `capabilities.yaml`** — capability-bit user overrides currently live
  in `.agent/settings.json` under `capabilities`. The original plan had a separate
  YAML; splitting it back out is cheap if ever wanted. (Flagged "待确认" in the PLAN
  deviation log.)
- **Default `timeoutMs`** — 600 000 ms per request is very generous; consider a
  tighter default. *(minor)*
