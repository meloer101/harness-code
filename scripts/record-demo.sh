#!/usr/bin/env bash
#
# Record the README demo GIF: hc fixing a failing test suite, end to end.
#
#   scripts/record-demo.sh            # -> docs/demo.gif
#
# Needs `asciinema` and `agg` (brew install asciinema agg) and a live model key
# (DEEPSEEK_API_KEY, or any in .env). The run hits a cheap endpoint once (~$0.004);
# the demo is a self-contained throwaway project in a temp dir, never your repo.
#
# The font, theme, size, and playback speed are pinned below so the GIF is
# reproducible; re-run any time the CLI's output changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/packages/cli/dist/index.js"
OUT="$ROOT/docs/demo.gif"
MODEL="${HC_DEMO_MODEL:-deepseek/deepseek-v4-flash}"

# --- pinned rendering knobs ------------------------------------------------
WINDOW_SIZE="100x28"
THEME="github-dark"
FONT_SIZE="16"
SPEED="1.0"          # real-time playback (readable)
IDLE_LIMIT="1.5"     # collapse model-latency pauses to 1.5s max
LAST_FRAME="3"       # hold the final "tests pass" frame

for tool in asciinema agg; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: '$tool' not found — brew install asciinema agg" >&2; exit 1; }
done
[ -f "$CLI" ] || { echo "error: CLI not built — run 'pnpm build' first" >&2; exit 1; }

# Load .env so the key is available (real env wins), same as the eval harness.
if [ -f "$ROOT/.env" ]; then
  set -a; # shellcheck disable=SC1091
  . "$ROOT/.env"; set +a
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/hc-demo.XXXXXX")"
CAST="$(mktemp "${TMPDIR:-/tmp}/hc-demo.XXXXXX.cast")"
RUNNER="$(mktemp "${TMPDIR:-/tmp}/hc-demo-run.XXXXXX.sh")"
cleanup() { rm -rf "$WORK" "$CAST" "$RUNNER"; }
trap cleanup EXIT

# --- the throwaway project: one failing test, one small bug ----------------
mkdir -p "$WORK/src" "$WORK/test"
cat > "$WORK/package.json" <<'JSON'
{ "name": "demo", "type": "module", "scripts": { "test": "node --test" } }
JSON
cat > "$WORK/src/config.js" <<'JS'
export function getPort(config) {
  return config.server.port;
}
JS
cat > "$WORK/test/config.test.js" <<'JS'
import { test } from 'node:test';
import assert from 'node:assert';
import { getPort } from '../src/config.js';

test('reads the configured port', () => {
  assert.equal(getPort({ server: { port: 8080 } }), 8080);
});

test('defaults to 3000 when server is absent', () => {
  assert.equal(getPort({}), 3000);
});
JS

PROMPT="A bug in src/config.js makes the test suite fail. Use the read tool to inspect it, fix it with an edit, then run \`npm test\` to confirm all tests pass. Do not change any file under test/."

# Inner runner keeps asciinema's -c argument free of nested quoting.
cat > "$RUNNER" <<RUN
#!/usr/bin/env bash
cd "$WORK"
node "$CLI" agent "$PROMPT" \
  -m "$MODEL" --mode acceptEdits --cwd "$WORK" -p \
  --no-mcp --no-memory --no-subagents --no-skills --no-trace \
  --allow 'Bash(cd:*)' --allow 'Bash(npm:*)' --allow 'Bash(node:*)'
RUN
chmod +x "$RUNNER"

echo "recording ($MODEL) …" >&2
asciinema rec --headless --overwrite -f asciicast-v2 \
  --window-size "$WINDOW_SIZE" -c "bash $RUNNER" "$CAST"

echo "rendering $OUT …" >&2
agg --theme "$THEME" --font-size "$FONT_SIZE" --speed "$SPEED" \
  --idle-time-limit "$IDLE_LIMIT" --last-frame-duration "$LAST_FRAME" \
  "$CAST" "$OUT"

echo "done: $OUT" >&2
