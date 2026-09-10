# Runtime 加固 — A6 轮级重试 + B1 无头进度流

2026-09-10 · 分支 `harbor-eval-and-timeout-fix`

> **状态：已实现（未提交）。** `pnpm typecheck` 通过；`pnpm test` 484 个用例中 482 通过，
> 剩余 2 个为已知的 cassette replay 失败。端到端验证：指向不可达的本地端点
> 运行 `--output-format json`，stderr 逐行输出 JSONL（notice / turn_retry / error），发生 2 次
> 轮级重试后错误照常抛出（默认配置下约 26 秒），stdout 仍输出一个
> `stop_reason: "error"` 的 result 对象，退出码仍为 1。
>
> 与原计划的差异：
> - 序列化拆成 `progressOfEvent` / `progressOfNotice` 两个函数，没有合并成一个 `toProgressEvent`。
> - TUI `EventBuffer` 用轮次起点标记来截断：在每轮开始的 `context` 事件处记录位置，
>   而不是整段清空，这样上一轮尚未提交的文本不会被误删。
>
> 追加修复（验证中发现，详见 eval-findings B1）：运行以未捕获的错误结束时，stdout 原本没有任何
> JSON result。现在 `runOneshot` 捕获错误后调用新增的 `OutputSink.fail()` 再重新抛出：
> `JsonSink` 照常写出 result（`stop_reason: "error"`、`is_error: true`、`error: {message, kind}`，
> 以及已完成调用的 `turns` / `usage`），并丢弃中断那次调用的半截文本。
> 仍未覆盖：sink 创建之前的错误（如 `--model` 无效、缺少配置）仍只输出纯文本。

## Context

来自 agent runtime 状况梳理与 [eval-findings.md](eval-findings.md)。本轮范围：

- **做**：A6（流中途瞬断丢整轮）、B1（`--output-format json` 运行期间 stderr 零输出）。
- **暂不做**：eval cassette 重录、Terminal-Bench 2.0 全量测评（之后再定）。
  cassette 仍失配，`evals/src/harness.test.ts` 的 2 个 replay 失败属已知，不在本次范围。

执行顺序：A6 → B1 → 更新相关文档状态。

---

## A6 — 可重试的 ProviderError 在 loop 层按轮重试

**现状**：`packages/core/src/provider/openai-compat.ts` 的 `request()` 只重试首个
fetch；流中途断开/超时被 `normalizeStreamError` 转成 `retryable: true` 的
`ProviderError('network')`，但 `packages/core/src/agent/loop.ts` 在 `streamTurn`
的 catch 里对 `ProviderError` 直接 rethrow → 一次网络抖动就结束整个运行。

### 改动

1. **共享退避工具** `packages/core/src/provider/retry.ts`：把 `openai-compat.ts`
   里的 `backoffMs` / `sleep`（abort 感知，抛 `ProviderError('aborted')`）移过去并导出，
   `openai-compat.ts` 改为 import。
2. **`AgentLoop`**（`packages/core/src/agent/loop.ts`）
   - 新选项 `maxTurnRetries?: number`（默认 2）、`retryBackoffMs?: (attempt) => number`
     （默认 `backoffMs`，测试可注入 0）。
   - `streamTurn(request)` 包成有界重试：`ProviderError && retryable && kind !== 'aborted'
     && attempt < maxTurnRetries` → 发事件、写 trace、退避后**用同一个 request 重试**。
     失败发生在工具执行之前，没有副作用，重试安全。
   - 退避中被 abort → 以 `aborted` 停止；重试耗尽 → 维持现有行为（ProviderError 向上抛）。
   - 新 `AgentEvent`：`{ type: 'turn_retry'; attempt; maxAttempts; delayMs; message }`。
     语义：本轮已流出的 text/thinking delta **作废**，消费方需丢弃。
   - trace：`TraceSink.error` 增加可选 `willRetry?: boolean`（`telemetry/trace.ts` 的
     `error` TraceEvent 同步加字段）。
   - 注意：失败的半截流没有 `message_end`，其 token 不计入 usage。
3. **`AgentSession`**（`session-runner.ts` `#onEvent`）：把 `turn_retry` 转成 Notice
   （新增 `NoticeKind 'provider-retry'`，level `warn`，如
   `provider: stream failed — retrying (1/2) in 2.0s: <message>`），TextSink / TUI
   通过现有 notice 通道显示。
4. **消费方丢弃半截输出**
   - `JsonSink`（`packages/cli/src/output.ts`）：文本拆成 `committed` + `pending`，
     `turn_end` 提交，`turn_retry` 丢弃 —— 否则最终 `result` 会重复出现半截文本。
   - TUI `EventBuffer`（`packages/tui/src/state/eventBuffer.ts`）：`turn_retry` 时清空
     `live.text` / `live.thinking`（此时不会有工具项）。
   - `TextSink`：stdout 已写出的无法撤回，靠 notice 行标明重试。
   - 子 agent 走同一个 `AgentLoop`，自动获得重试。

### 测试

- `ScriptedTurn` 新增 `error?: { kind; retryable?; afterText? }`：先 yield 部分文本再抛错。
- `loop.test.ts`：瞬断后重试成功（历史无重复、发出 `turn_retry`）；重试耗尽后抛
  ProviderError；非 retryable（如 `auth`）不重试；退避期间 abort → `aborted`；
  `maxTurnRetries: 0` 等价旧行为。
- `output.test.ts`：JsonSink 在 `turn_retry` 后 `result` 不含半截文本。
- `eventBuffer.test.ts`：`turn_retry` 清空 live 文本。

---

## B1 — `--output-format json` 时向 stderr 输出 JSONL 进度

**现状**：`JsonSink.notice()` 为空实现，`event()` 只攒文本；Harbor 的 `hc.log`（即 stderr）
在整个运行期间为空，只能事后读 `.agent/traces`。

### 改动

1. **新文件 `packages/cli/src/progress.ts`**：`toProgressEvent(e: AgentEvent | Notice)`，
   snake_case，风格与 `ResultJSON` 一致；将来可直接复用于 A5 `stream-json`（写 stdout）。
   - `tool_call_start` → `{type:'tool_start', id, name, input}`，`input` 为截断摘要
     （导出并复用 `telemetry/trace.ts` 的 `summarizeInput`）。
   - `tool_call_end` → `{type:'tool_end', id, name, is_error, output_bytes}`，出错附截断 `error`。
   - `turn_end` → `{type:'turn_end', usage:{input_tokens, output_tokens, cached_input_tokens, cost_usd?}}`。
   - `turn_retry` / `compaction` / `stop` → 对应精简对象；Notice → `{type:'notice', kind, level, text}`。
   - `text_delta` / `thinking_delta` / `context` 不输出（太吵）；`turn_end` 附本轮文本长度 `text_chars`。
   - 每行带 `ts`（epoch ms）。
2. **`JsonSink`**：构造参数 `{ progress: boolean }`；开启时每条事件/notice 写一行 JSON 到
   **stderr**。stdout 仍只有最终一个 result 对象（契约不变）。
3. **CLI 开关**（`packages/cli/src/index.ts`）：json 模式**默认开启**（Harbor 适配器无需改动），
   新增 `--no-progress` 关闭。
4. `evals/harbor/README.md` 注明 `hc.log` 现为 JSONL 进度流。

### 测试

- `output.test.ts`：进度开启时 tool start/end、notice、turn_end 各一行合法 JSON，stdout 仅一行
  result；关闭时 stderr 无输出。
- `progress.test.ts`：`toProgressEvent` 映射与输入截断。

---

## 收尾

- [eval-findings.md](eval-findings.md)：A6、B1 标 **fixed**；D4 注明已有 loop 级重试兜底。
- [telemetry.md](telemetry.md)：记录 `error.willRetry` 字段。

## 验证

```
pnpm typecheck
pnpm test          # 预期仅剩 2 个已知 cassette replay 失败
```

- 手动：`pnpm build` 后无头跑一次，确认 stderr 为逐行 JSON、stdout 仅一个 result：
  `node packages/cli/dist/index.js --output-format json -p "list the files here" 2>progress.jsonl`
