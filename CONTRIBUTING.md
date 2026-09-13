# Contributing

Thanks for looking under the hood. This is a pnpm workspace; the engine lives in
`packages/core` and everything else is a frontend, the server, shared types, or
the eval harness. For the shape of it, read [docs/architecture.md](docs/architecture.md).

## Setup

Requires **Node 22+** and **pnpm 10+**.

```bash
pnpm install
pnpm build
```

## The loop you'll run constantly

```bash
pnpm typecheck     # tsc -b across every package + the web typecheck
pnpm test          # vitest: unit + integration, no network, no credentials
pnpm eval          # the whole agent loop against fixture tasks, replayed from cassettes
pnpm build         # tsc -b + the web bundle
```

All four must be green before a change lands. CI runs `typecheck`, `test`, and
`eval` (replay only — no keys).

## How the tests stay deterministic

No test hits a real endpoint. Provider behavior is exercised through injected
transports: synthesized SSE frames for stream assembly, and a **record/replay
cassette** (`provider/mock.ts`) for anything that once came from a live model.
The loop, tools, and permission engine use a scripted provider so concurrency,
budget cutoffs, and denials are reproducible.

`pnpm eval` replays committed cassettes (`evals/tasks/*/cassette.jsonl`) and gates
on `evals/baseline.json` (a task regressing, or tokens/cost rising >15%, fails).

### Re-recording the eval cassettes

Only needed when a change shifts the request fingerprint (a prompt or tokenizer
change). Requires a live key in `.env`:

```bash
pnpm eval --record              # re-records all cassettes against the live endpoint
pnpm eval --update-baseline     # regenerate baseline.json from a REPLAY pass
pnpm eval                       # confirm the gate is green
```

The second step matters: `--record` numbers come from the endpoint's real
`usage`, but the CI gate runs *replay* (heuristic-estimated, ~tens of % higher).
Keep `baseline.json` replay-derived so the gate is self-consistent. (A durable fix
so `--record` does this itself is tracked in [docs/ROADMAP.md](docs/ROADMAP.md).)

## Adding things

- **A provider / endpoint** — usually a data change in
  `packages/core/src/provider/router.ts`, plus a capability row in
  `capabilities.ts` if it's unusual. Add a cassette fixture for any new wire quirk.
- **A skill** — drop a `SKILL.md` folder under `.agent/skills/` (project) or
  `~/.agent/skills/` (user); builtins live in `packages/core/skills/`.
- **A sub-agent** — a `<name>.md` with `name` / `description` / optional `tools` /
  `model` frontmatter under `.agent/agents/`; builtins in `packages/core/agents/`.
- **An MCP server** — add it to `.mcp.json` (see the README); `${ENV}`
  interpolation handles static tokens, `hc mcp login` handles OAuth.

## Commits

Conventional-commit style, scoped by area:

```
feat(core): …     fix(cli): …     docs: …     test(evals): …
```

Keep each commit one coherent change; if a fix drifts into a second concern,
split it. The build history and deviations are logged in
[docs/PLAN.md](docs/PLAN.md).

## License

By contributing you agree your contributions are licensed under the MIT license.
