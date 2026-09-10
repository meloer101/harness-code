# Runtime 对照学习 — Codex / opencode / hermes-agent

2026-09-10 · 分支 `harbor-eval-and-timeout-fix`

对照三个开源 agent 的 runtime 实现，找出我们（`hc`）可以学习的做法，以及对比中暴露出的我们自己的缺陷。
参考代码均为浅克隆、只读，未执行：

| 项目 | 仓库 | 快照 commit | 主要读的部分 |
|---|---|---|---|
| Codex | https://github.com/openai/codex | `818f1cc` | `codex-rs/core/src/session/turn.rs`、`responses_retry.rs`、`tools/parallel.rs`、`compact.rs`、`context_manager/`、`exec/src/exec_events.rs` |
| opencode | https://github.com/anomalyco/opencode | `b3f1a96` | `packages/opencode/src/session/processor.ts`、`retry.ts`、`overflow.ts`、`compaction.ts`、`prompt.ts` |
| hermes-agent | https://github.com/NousResearch/hermes-agent | `ac07e20` | `agent/tool_guardrails.py`、`verification_stop.py`、`turn_stop_gates.py`、`turn_truncation.py`、`error_classifier.py` |

相关文档：[eval-findings.md](eval-findings.md)（C1–C3 等行为问题）、[runtime-hardening.md](runtime-hardening.md)（A6 / B1 已落地）。

---

## 总览

| # | 发现 | 类型 | 证据 | 建议优先级 |
|---|---|---|---|---|
| 1 | 同一轮内工具调用被重排 | 我们的缺陷 | **已复现** | P0 |
| 2 | 输出截断被当成正常结束 | 我们的缺陷 | 读代码确认 | P0 |
| 3 | provider 报上下文超长时直接失败 | 我们的缺陷 | 读代码确认 | P0 |
| 4 | 工具执行中被杀后 `--resume` 可能 400 | 我们的缺陷 | 读代码推断，未复现 | P0 |
| 5 | 工具循环防护（签名级追踪） | 可借鉴，补 C2/C3 | — | P1 |
| 6 | 结束前拦截（stop gate / `onBeforeStop`） | 可借鉴，补 C1 | — | P2（需新 hook 接口） |
| 7 | 最后一轮不给工具，强制总结 | 可借鉴，补子 agent | — | P1 |
| 8 | 重试细节：采用服务端等待时间、按文本判断可重试 | 可借鉴 | — | P2 |
| 9 | 全量摘要前的廉价瘦身 | 可借鉴 | — | P3（与缓存有取舍） |
| 10 | `stream-json` 采用条目为中心的事件格式 | 可借鉴，用于 A5 | — | 做 A5 时 |

建议顺序：1 → 2 → 3 → 4（都是局部改动，1 改动最小、影响最大）→ 5、7 → 6 → 8 → 9；10 随 A5 一起做。

---

## 一、对比中发现的我们自己的缺陷

### 1. 同一轮内的工具调用会被重排 — **P0，已复现**

**现状**：`AgentLoop.runToolCalls`（`packages/core/src/agent/loop.ts`，`const parallel = decisions.filter(...)` 处）
先把所有 `concurrencySafe` 的调用并发跑完，再按顺序跑其余调用，没有保持模型给出的顺序。
- 模型写"先 `edit` 再 `read`"，实际先 `read`，读到的是修改前的内容。
- `task`（子 agent，`concurrencySafe: true` 但会写文件）也会被提前到排在它前面的 `edit` / `bash` 之前。

**复现**：用构建产物跑脚本，脚本化 provider 一轮给出 `[edit, read]`，实际执行顺序为 `read, edit`。

**参考做法**：Codex `core/src/tools/parallel.rs` 的 `ToolCallRuntime`：按模型顺序依次启动工具；
可并发的工具拿 `RwLock` 的读锁，不可并发的拿写锁。于是一个非并发工具会等前面所有并发工具结束，
其后的并发工具也要等它结束 —— 非并发工具天然成为分界点，顺序语义不变。

**修复方向**：按原顺序遍历调用，把**连续的**可并发调用分成一批并发执行，遇到不可并发的调用就作为分界点单独执行。
结果仍按原调用顺序回填（现有逻辑已如此）。补一个"`[edit, read]` 必须先 edit"的回归测试。

### 2. 输出被截断时，运行被当成正常结束 — **P0**

**现状**：`loop.ts` 中 `if (response.stopReason !== 'tool_use')` 一律按 `end_turn` 结束。
provider 已把 `finish_reason: length` 归一为 `max_tokens`、把内容过滤归一为 `content_filter`，但 loop 不区分：
- 文本在中途被截断：运行悄悄以 `end_turn` 结束，调用方以为完成了。
- 截断发生在工具参数中间：工具调用带 `parseError`，不执行，运行直接结束，这次调用丢失。

**参考做法**：hermes `agent/turn_truncation.py`：
- 文本截断 → 追加"继续"提示续写，最多 4 次；配合 `repetition_guard.py` 检测退化的重复输出，避免把整段复读拼进结果。
- 工具调用截断 → 调高 `max_tokens` 重试这次调用。

**修复方向**（由简到繁）：
1. 至少给出独立的停止原因（如 `max_output`），不要伪装成 `end_turn`；JSON 结果据此标 `is_error`。
2. 文本截断：有上限地续写（临时提示，沿用现有 ephemeral note 机制，不写入历史）。
3. 工具参数截断：回一个错误 `tool_result`，提示模型拆小写入（或在模型上限允许时调高 `maxOutputTokens` 重试）。

### 3. provider 报上下文超长时直接失败 — **P0**

**现状**：`openai-compat.ts` 能把超长错误识别为 `ProviderError('context_length')`，但 loop 只会把它抛出去。
我们的主动压缩依赖 token 估算（以上一轮真实 usage 为锚），对非 DeepSeek 分词器、或一次追加了超大工具结果的轮次，估算可能偏低，缺少兜底。

**参考做法**：
- Codex `session/turn.rs`：`ContextWindowExceeded` → `run_auto_compact(... CompactionPhase::MidTurn)` → 继续本轮，每个模型步最多补救一次，防止无效压缩导致死循环。
- opencode `processor.ts` 的 `halt()`：`ContextOverflowError` → `needsCompaction = true` → 返回 `"compact"`，由外层压缩后继续；超长错误在 `retry.ts` 中明确**不**走普通重试。

**修复方向**：在 `streamTurnWithRetry` 的调用处捕获 `kind === 'context_length'`，若配置了 `onCompact` 且本轮尚未补救过，则强制压缩后重发一次；
仍失败则按现有路径抛出。压缩被关闭（`--no-compact`）时保持现状。

### 4. 工具执行中进程被杀，`--resume` 很可能直接 400 — **P0，读代码推断，未复现**

**现状**：
- `AgentLoop` 在工具运行**之前**就把带 `tool_use` 的 assistant 消息写入 recorder；`tool_result` 要等本轮工具全部执行完才写入。
- 进程在这段时间被杀（kill、崩溃、终端关闭），会话 `.jsonl` 里就留下"有调用、无结果"的历史。
- `loadSession`（`packages/core/src/agent/session.ts`）恢复时只做拼接，不修补。OpenAI 兼容接口会拒绝这种历史（assistant 的 tool_calls 必须紧跟对应的 tool 消息）。

**参考做法**：Codex `core/src/context_manager/normalize.rs`（`history_tests.rs` 中有完整用例）：
给缺少结果的调用补一条内容为 `"aborted"` 的结果；删除找不到对应调用的孤立结果。debug 构建下还会 panic，便于尽早发现。
opencode 在中断时也会把未完成的工具调用标为 `"Tool execution aborted"`。

**修复方向**：在 `loadSession` 返回前做一次规范化（补 `aborted` 结果、删孤立结果），并加单测：
构造一个只有 assistant tool_use、没有 tool_result 的会话文件，确认恢复后的历史合法。先写复现测试确认问题存在。

---

## 二、能直接补上 C1–C3 的做法

### 5. 工具循环防护：按"工具名 + 参数"签名追踪 — **P1，补 C2 剩余部分和 C3**

**我们的现状**：`loop.ts` 的 step-back 提示只在"连续 3 轮所有工具调用都失败"时触发。
C2 里"调用都成功但没有进展"（如 `largest-eigenval` 写 bench1..bench9）抓不到；C3 的"同一命令微调参数反复失败"也只是间接覆盖。

**参考做法**：hermes `agent/tool_guardrails.py` 的 `ToolCallGuardrailController`（纯逻辑、无副作用，只返回决策）：

| 情况 | 追踪键 | 警告 | 拦截 / 终止 |
|---|---|---|---|
| 同一调用反复失败 | 工具名 + 规范化参数 | 第 2 次 | 第 5 次拦截（不执行，回合成错误结果） |
| 同一工具换着参数失败 | 工具名 | 第 3 次 | 第 8 次终止（容错型工具只警告不终止） |
| 只读工具结果不变却重复调用 | 签名 + 结果哈希 | 第 2 次 | 第 5 次拦截 |

- 期间只要有一次文件修改成功，相关计数清零（修改之后的重试算新实验）。
- 警告以 `[Tool loop warning: ...]` 的形式**追加到该次工具结果**里，并附带"先诊断再重试、换参数或换工具、外部阻塞就直接报告"的恢复建议。
- 连续出现的相同大段结果（≥512 字符）换成一个引用占位，节省上下文。

opencode 的简化版（`processor.ts`，`DOOM_LOOP_THRESHOLD = 3`）：最近 3 次调用工具名和参数完全相同，就触发一次 `doom_loop` 权限确认。

**落地方向**：做成一个 `AgentHooks` 实现（`onBeforeToolCall` 决定拦截、`onAfterToolCall` 记录并返回警告），与权限 hook 用 `mergeHooks` 组合；
警告文本追加进 tool_result。阈值可配置。注意：写进 tool_result 会进入历史，与 step-back 的临时提示不同，需评估对 eval cassette 的影响。

### 6. 允许在"准备结束"时拦一下 — **P2，补 C1，需新 hook 接口**

**参考做法**：
- Codex `session/turn.rs` 的 `run_turn_stop_hooks`：模型给出最终回答时运行 Stop hook，hook 可以阻止本轮结束（`should_block`），把原因反馈给模型继续跑。
- hermes `agent/turn_stop_gates.py` + `verification_stop.py`：模型改完代码、还没有新的验证证据（`verification_evidence.py` 被动记录的测试/命令结果）就要结束时，
  把这次回答暂存，追加一次有上限的"去验证"提示继续跑；预算耗尽时用暂存的回答兜底。默认关闭；只改了 `.md`、`.txt` 等文档类文件时不触发。

**落地方向**：在 `AgentHooks` 增加 `onBeforeStop(finalMessage, ctx) → { continue?: string }`，返回提示文本则追加并继续，每次运行设上限（如 1–2 次）。
C1 的 `<finishing>` 约束、按需开启的完成前验证、以后 Harbor 的完成判定都可以挂在这里。
注意 C1 的主要问题是**过度**验证，因此该 gate 必须默认关闭、严格限次，避免加剧 C1/C7。

### 7. 最后一轮不给工具，强制总结 — **P1，主要受益者是子 agent**

**参考做法**：opencode `session/prompt.ts`：`step >= agent.steps` 时追加 `MAX_STEPS_PROMPT`（来自 `packages/core` 的 `session/runner/max-steps`），
声明"工具已禁用，只能用文字回答"，要求说明已到上限、已完成的内容、未完成的任务和建议的下一步。

**我们的现状**：`turnBudgetNote` 最后一轮只是提示"这是最后一轮"，工具仍然可用，模型常常还在调工具时就被 `max_turns` 截断。
子 agent 跑满轮数时，`runSubagent` 经常只能返回"(the sub-agent finished without producing a text answer)"，父 agent 拿不到任何信息。

**落地方向**：最后一轮请求不带 `tools`（或只对子 agent 默认开启），并附上类似的总结要求。与现有 turn-budget 提示配合：前面的轮次引导收敛，最后一轮保证有产出。

---

## 三、值得借鉴，但优先级较低

### 8. 重试细节 — **P2**

- **采用服务端给的等待时间**：opencode `session/retry.ts` 的 `delay()` 依次解析 `retry-after-ms`、`retry-after`（秒或 HTTP 日期）；
  Codex 用错误自带的 `retry_delay()`，没有才退回指数退避。我们只在传输层（`openai-compat.ts` 的首次 fetch）用了 `retry-after`，
  A6 新增的 loop 层重试只用固定退避。修复方向：`ProviderError` 携带服务端建议的延迟，`streamTurnWithRetry` 优先使用。
- **按错误文本判断能否重试**：opencode 的 `RETRYABLE_MESSAGE_PATTERNS` 匹配 `overloaded`、`rate limit`、`ECONNRESET`、`socket hang up`、`resource exhausted`、`try again later` 等；
  并且 5xx 一律重试，即使 SDK 没标记可重试。OpenAI 兼容 provider 的报错格式五花八门（有的在 200 响应的流里报错），这能减少误判为不可重试。
- 参考参数：opencode 初始延迟 2s、指数 2、25% 抖动、无响应头时封顶 30s、最多 5 次。
- Codex 另有"断网无限重连"（交互场景下网络断开时持续等待并提示 "Reconnecting... waiting for network"），只适合交互前端，不适合无头运行。

### 9. 全量摘要之前，先做一次便宜的瘦身 — **P3，与前缀缓存有取舍**

- **清理旧工具输出**：opencode `session/compaction.ts` 的 `prune()`：从最新往回数，保留最近约 40k token（`PRUNE_PROTECT`）的工具输出，
  更早的清空为占位符；可回收量超过 20k token（`PRUNE_MINIMUM`）才动手；`skill` 工具的输出受保护。
- **尾部按 token 预算保留**：opencode 按 token 预算决定保留多少最近的轮次（`tail_turns` 可配），我们是固定保留 3 轮（`DEFAULT_KEEP_TURNS`）。
- **用户消息原文保留**：Codex `compact.rs` 压缩时把所有用户消息原文保留（新到旧，上限 `COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000`），
  再加一段"交接给另一个 LLM"式的摘要（`prompts/templates/compact/prompt.md`），用户的原始意图不会被摘要改写。压缩后还会重新注入初始上下文，并提示"多次压缩会降低准确性"。
- **取舍**：这些做法都会改写提示前缀、使 provider 的前缀缓存失效。hermes 的类似功能 `micro_compaction.py` 因此默认关闭。
  这与我们"临时提示不写入历史、保持前缀稳定"的约定一致 —— 只应在接近压缩阈值时使用，不要每轮做。

### 10. `stream-json` 采用以"条目"为中心的事件格式 — **做 A5 时参考**

Codex `exec/src/exec_events.rs`（`codex exec --json`）的事件：

- 线程与轮次：`thread.started`、`turn.started`、`turn.completed`（带 usage）、`turn.failed`、`error`。
- 条目生命周期：`item.started` / `item.updated` / `item.completed`，条目类型包括 `agent_message`、`reasoning`、`command_execution`、`file_change`、`mcp_tool_call`、`web_search`、`todo_list`、`error`。

我们在 B1 中做的 stderr 进度流（`packages/cli/src/progress.ts`）以"事件"为中心（`tool_start` / `tool_end` / `turn_end`）。
做 A5 `--output-format stream-json` 时，建议向这种条目模型对齐：同一条目的开始/更新/完成用同一个 id 关联，调用方更容易还原状态。

---

## 附：暂时不建议照搬

- **模型输出流未结束就开始执行工具（Codex）**：`try_run_sampling_request` 在每个条目完成时就把工具 future 放进 `FuturesOrdered`，能省延迟；
  但重试时要复用已执行过的工具结果（`executed_tool_calls.attach_to_prompt`），会让 A6 的轮级重试复杂很多。
- **每一步 git 快照以支持撤销（opencode `snapshot/`）**：是 TUI 的功能，不是 runtime 正确性问题。
- **hermes 的多 key 轮换、模型回退链、空回复防护、卡死看门狗**（`credential_pool.py`、`fallback_cooldown.py`、`empty_response_guard.py`、`turn_liveness.py`）：份量很重。
  以后 Harbor 需要更稳时，可再考虑模型回退链。
- **轮次进行中插入新的用户输入（Codex 的待处理输入队列）**：交互功能，与 runtime 正确性无关。
