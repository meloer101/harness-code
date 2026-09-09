#!/usr/bin/env bash
# Run `hc` on the Terminal-Bench 2.0 subset via Harbor (local Docker).
#
#   evals/harbor/run-subset.sh [extra harbor run args...]
#
# Prereqs:
#   * Docker running
#   * `uv tool install harbor`
#   * `pnpm bundle` (writes dist-bundle/hc.mjs)
#   * an API key for the chosen model exported (default: DEEPSEEK_API_KEY)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

MODEL="${HC_BENCH_MODEL:-deepseek/deepseek-v4-pro}"
KEY_ENV="${HC_BENCH_KEY_ENV:-DEEPSEEK_API_KEY}"
CONCURRENCY="${HC_BENCH_CONCURRENCY:-4}"
JOBS_DIR="${HC_BENCH_JOBS_DIR:-$repo/evals/harbor/.jobs}"

if [[ ! -f "$repo/dist-bundle/hc.mjs" ]]; then
  echo "dist-bundle/hc.mjs missing — run 'pnpm bundle' first" >&2
  exit 1
fi
if [[ -z "${!KEY_ENV:-}" ]]; then
  echo "\$$KEY_ENV is not set (needed for model $MODEL)" >&2
  exit 1
fi

# subset.txt holds bare names; the dataset namespaces them as
# terminal-bench/<name>, and -i matches on that full name. (Plain `while read`
# loop, not `mapfile` — macOS ships bash 3.2.)
task_args=()
n_tasks=0
while IFS= read -r t; do
  case "$t" in ''|\#*) continue ;; esac
  case "$t" in */*) task_args+=(-i "$t") ;; *) task_args+=(-i "terminal-bench/$t") ;; esac
  n_tasks=$((n_tasks + 1))
done < "$here/subset.txt"

echo "hc @ terminal-bench-2  |  model=$MODEL  tasks=$n_tasks  concurrency=$CONCURRENCY"

exec env PYTHONPATH="$here" harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a hc_agent:HcAgent \
  -m "$MODEL" \
  "${task_args[@]}" \
  -n "$CONCURRENCY" \
  -o "$JOBS_DIR" \
  -y \
  --ae "$KEY_ENV=${!KEY_ENV}" \
  "$@"
