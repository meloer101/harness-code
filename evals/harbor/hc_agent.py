"""Harbor adapter for the `hc` coding agent (this repo's harness).

Runs `hc` headless inside a Harbor / Terminal-Bench task container:

    PYTHONPATH=evals/harbor harbor run \
      -d terminal-bench/terminal-bench-2 \
      -a hc_agent:HcAgent \
      -m deepseek/deepseek-v4-pro \
      -t <task-id> \
      --ae DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY

`hc` is a pnpm-workspace app that is never published to npm, so this adapter
ships a single-file esbuild bundle (`dist-bundle/hc.mjs`, built by
`pnpm bundle` in the repo root) into the container and drives it via:

    hc agent "<instruction>" --model <provider/model> --mode yolo \
      --output-format json --no-mcp --no-skills --no-subagents --max-turns N

Design notes:
  * `--output-format json` implies `-p` (one-shot; never the TUI/REPL) and
    prints one JSON line: {result, stop_reason, turns, is_error, usage:{...}}.
  * `--mode yolo` is what makes it fully autonomous — the default `ask` mode
    denies every write/bash in a non-interactive run.
  * `hc` exits 0 even when the task is not solved; grading is Harbor's job
    (each task's own tests/test.sh -> /logs/verifier/reward.json). This adapter
    never grades; it only reports token/cost back to Harbor.
  * `hc` uses the same `provider/model` convention Harbor/litellm do, so the
    model name is passed straight through. `hc` speaks OpenAI-compatible Chat
    Completions only (no native Anthropic).
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path, PurePosixPath
from typing import Any, override

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    BaseInstalledAgent,
    ErrorPattern,
    ModelNotFoundError,
    NetworkConnectionError,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.model_connection import ModelConnectionSpec
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

# Where the bundle + wrapper land in the container.
_REMOTE_BUNDLE = PurePosixPath("/opt/hc/hc.mjs")
_REMOTE_WRAPPER = PurePosixPath("/usr/local/bin/hc")

# Host path to the bundle: <repo>/dist-bundle/hc.mjs  (this file is at
# <repo>/evals/harbor/hc_agent.py). Built by `pnpm bundle`.
_REPO_ROOT = Path(__file__).resolve().parents[2]
_LOCAL_BUNDLE = _REPO_ROOT / "dist-bundle" / "hc.mjs"

# `hc`'s result / log files, written under the mounted agent log dir
# (host `self.logs_dir` mirrors container `/logs/agent`).
_RESULT_PATH = EnvironmentPaths.agent_dir / "hc-result.json"
_LOG_PATH = EnvironmentPaths.agent_dir / "hc.log"
_TRACE_COPY = EnvironmentPaths.agent_dir / "hc-traces"

_MIN_NODE_MAJOR = 20
_NODE_MAJOR = 22
_NVM_VERSION = "v0.40.2"
# install() symlinks the resolved node here (root), so the wrapper needs no
# nvm/PATH gymnastics at run time.
_NODE_LINK = PurePosixPath("/usr/local/bin/node")
_NODE_PATH_FILE = "/tmp/hc-install/node-path"

_WRAPPER = (
    "#!/bin/sh\n"
    f'exec {shlex.quote(str(_NODE_LINK))} {shlex.quote(str(_REMOTE_BUNDLE))} "$@"\n'
)

# `hc`'s built-in providers and the env var each reads its key from
# (packages/core/src/provider/router.ts). Most line up with Harbor's own
# resolution; the ones that don't (zhipu, siliconflow) can be passed via --ae.
_HC_KEY_ENVS = (
    "OPENAI_API_KEY",
    "DEEPSEEK_API_KEY",
    "MOONSHOT_API_KEY",
    "DASHSCOPE_API_KEY",
    "ZHIPU_API_KEY",
    "SILICONFLOW_API_KEY",
    "OPENROUTER_API_KEY",
    "GROQ_API_KEY",
    "TOGETHER_API_KEY",
    "MISTRAL_API_KEY",
    "XAI_API_KEY",
)


class HcAgent(BaseInstalledAgent):
    """`hc` (harness-code) as a Harbor installed agent."""

    SUPPORTS_ATIF = False

    # Provider inferred from the model-name prefix; passthrough=True forwards
    # the provider's native *_API_KEY / *_BASE_URL into the container env under
    # its own name, which is exactly what `hc` reads.
    MODEL_CONNECTION = ModelConnectionSpec(passthrough=True)

    ERROR_PATTERNS = [
        *BaseInstalledAgent.ERROR_PATTERNS,
        ErrorPattern(r"No model configured", NonZeroAgentExitCodeError),
        ErrorPattern(r"[Mm]issing API key|no API key found", AgentAuthenticationError),
        ErrorPattern(r"unknown model|model .* (not found|unavailable)", ModelNotFoundError),
        # hc's provider layer (packages/core/src/provider/openai-compat.ts) —
        # these are transient, let Harbor's --max-retries handle them.
        ErrorPattern(r"timed out after \d+ms", NetworkConnectionError),
        ErrorPattern(r"Could not reach .+ at http", NetworkConnectionError),
        ErrorPattern(r"dropped mid-stream", NetworkConnectionError),
    ]

    def __init__(
        self,
        *args: Any,
        hc_mode: str = "yolo",
        max_turns: int = 40,
        **kwargs: Any,
    ) -> None:
        self._hc_mode = hc_mode
        self._max_turns = int(max_turns)
        super().__init__(*args, **kwargs)
        valid = {"yolo", "acceptEdits", "ask", "plan", "readOnly"}
        if hc_mode not in valid:
            raise ValueError(
                f"Invalid hc_mode {hc_mode!r}. Valid: {', '.join(sorted(valid))}"
            )

    @staticmethod
    @override
    def name() -> str:
        return "hc"

    @override
    def get_version_command(self) -> str | None:
        return f"sh {shlex.quote(str(_REMOTE_WRAPPER))} --version"

    @override
    def parse_version(self, stdout: str) -> str:
        lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
        return lines[-1] if lines else "unknown"

    # ------------------------------------------------------------------ install

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not _LOCAL_BUNDLE.is_file():
            raise RuntimeError(
                f"hc bundle not found at {_LOCAL_BUNDLE}. Run `pnpm bundle` in the "
                "repo root first (it writes dist-bundle/hc.mjs)."
            )

        # Only curl/bash — NOT distro nodejs/npm: on amd64 task images running
        # under Rosetta on Apple Silicon, `apt-get install nodejs npm` is very
        # slow and bookworm ships Node 18 (< our floor) anyway. nvm downloads a
        # single prebuilt Node tarball instead; on musl (Alpine) nvm's glibc
        # binaries don't run, so there we do use apk's nodejs.
        await self.ensure_system_dependencies(
            environment, ("curl", "bash", "ca_certificates")
        )
        await self.exec_as_agent(
            environment,
            command=(
                "set -eu; "
                'if ldd --version 2>&1 | grep -qi musl || [ -f /etc/alpine-release ]; then '
                "  (command -v node >/dev/null 2>&1 || apk add --no-cache nodejs npm) && node --version; "
                "else "
                '  if command -v node >/dev/null 2>&1 && '
                f'     [ "$(node -p \'process.versions.node.split(".")[0]\')" -ge {_MIN_NODE_MAJOR} ]; then '
                '    echo "using system node $(node --version)"; '
                "  else "
                f"    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/{_NVM_VERSION}/install.sh | bash && "
                '    export NVM_DIR="$HOME/.nvm" && '
                '    \\. "$NVM_DIR/nvm.sh" || true && '
                "    command -v nvm >/dev/null 2>&1 || { echo 'nvm failed to load' >&2; exit 1; } && "
                f"    nvm install {_NODE_MAJOR} && nvm alias default {_NODE_MAJOR}; "
                "  fi; "
                "fi; "
                "node --version && "
                f"mkdir -p {shlex.quote(str(PurePosixPath(_NODE_PATH_FILE).parent))} && "
                f'command -v node > {shlex.quote(_NODE_PATH_FILE)}'
            ),
            env={"NVM_NODEJS_ORG_MIRROR": "https://nodejs.org/dist"},
        )

        # Make the resolved node reachable as /usr/local/bin/node for the
        # wrapper (root; nvm's node lives under the agent's $HOME).
        await self.exec_as_root(
            environment,
            command=(
                f'NB="$(cat {shlex.quote(_NODE_PATH_FILE)})"; '
                f'[ -x "$NB" ] || {{ echo "node not found at $NB" >&2; exit 1; }}; '
                f'[ "$NB" = {shlex.quote(str(_NODE_LINK))} ] || ln -sf "$NB" {shlex.quote(str(_NODE_LINK))}'
            ),
        )

        await self.exec_as_root(
            environment, command=f"mkdir -p {shlex.quote(str(_REMOTE_BUNDLE.parent))}"
        )
        await environment.upload_file(_LOCAL_BUNDLE, str(_REMOTE_BUNDLE))
        await self._upload_config_text(
            environment,
            content=_WRAPPER,
            remote_path=str(_REMOTE_WRAPPER),
            filename="hc",
        )
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 0755 {shlex.quote(str(_REMOTE_WRAPPER))} "
                f"&& chmod 0644 {shlex.quote(str(_REMOTE_BUNDLE))}"
            ),
        )
        # Fail loud in setup rather than mid-run if node / bundle are broken.
        await self.exec_as_agent(
            environment, command=f"sh {shlex.quote(str(_REMOTE_WRAPPER))} --version"
        )

    # ---------------------------------------------------------------------- run

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        if not self.model_name:
            raise ValueError("A model is required: pass `-m <provider/model>`.")

        access = self.model_connection
        env: dict[str, str] = {**self.resolve_env_vars(), **access.env}
        # Forward any hc-relevant key that reached us via --ae / host env but
        # that model_connection did not select (different provider, or a
        # provider whose Harbor env name differs from hc's).
        for key in _HC_KEY_ENVS:
            val = self._get_env(key)
            if val and key not in env:
                env[key] = val
        for key, val in self._get_env_prefixed("HC_").items():
            env[key] = val

        if access.api_key is None and not any(k in env for k in _HC_KEY_ENVS):
            raise ValueError(
                f"No API key found for model {self.model_name!r}. Pass it with "
                "`--ae <PROVIDER>_API_KEY=...` (e.g. --ae DEEPSEEK_API_KEY=$DEEPSEEK_API_KEY)."
            )

        prompt = shlex.quote(instruction)
        model = shlex.quote(self.model_name)
        mode = shlex.quote(self._hc_mode)
        result_path = shlex.quote(str(_RESULT_PATH))
        log_path = shlex.quote(str(_LOG_PATH))
        trace_copy = shlex.quote(str(_TRACE_COPY))

        # `hc` writes .agent/{sessions,traces} into its cwd; capture cwd so the
        # trace can be lifted out for post-mortem `hc trace` inspection.
        command = (
            'HC_CWD="$(pwd)"; '
            f"hc agent {prompt} --model {model} --mode {mode} "
            f"--output-format json --no-mcp --no-skills --no-subagents "
            f"--max-turns {self._max_turns} "
            f"</dev/null >{result_path} 2>{log_path}; "
            "HC_RC=$?; "
            f'cp -r "$HC_CWD/.agent/traces" {trace_copy} 2>/dev/null || true; '
            f"cat {result_path} 2>/dev/null || true; "
            "exit $HC_RC"
        )
        await self.exec_as_agent(environment, command=command, env=env)

    # ------------------------------------------------------- post-run bookkeeping

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        result_file = self.logs_dir / "hc-result.json"
        if not result_file.is_file():
            self.logger.debug("hc-result.json not found at %s", result_file)
            return
        try:
            data: dict[str, Any] = json.loads(result_file.read_text())
        except Exception as exc:  # noqa: BLE001 - best-effort metrics
            self.logger.debug("Failed to parse hc-result.json: %s", exc)
            return

        usage = data.get("usage") or {}
        context.n_input_tokens = usage.get("input_tokens")
        context.n_output_tokens = usage.get("output_tokens")
        context.n_cache_tokens = usage.get("cached_input_tokens")
        context.cost_usd = usage.get("cost_usd")
        context.metadata = {
            **(context.metadata or {}),
            "hc_stop_reason": data.get("stop_reason"),
            "hc_turns": data.get("turns"),
            "hc_is_error": data.get("is_error"),
            "hc_session_id": data.get("session_id"),
        }
