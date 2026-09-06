# Phase 3.5 — 补齐"最简可用 coding agent"的三块缺口

> 本文件是 [PLAN.md](./PLAN.md) 的补充：一个插在 Phase 3 与 Phase 4 之间的里程碑。
> 与 PLAN.md 同样的约定——**完成后在小节标注状态，不要事后重写本文**，
> 计划与实际的偏差本身就是有价值的记录。
>
> **状态：已完成（2026-09-06）** —— Step 1 / 2 / 3 全部落地，`pnpm build && pnpm test && pnpm typecheck` 全绿（228 单测），plan mode 端到端手测通过。

## Context

Phase 0–3 已完成（provider 兼容层 / agent loop + 工具集 / 权限与沙箱），`hc agent` 能跑真实任务。
但离"日常敢用"还差三件事，都是 harness 层的：

1. **没有"先探索再规划"的流程** —— `plan` 模式目前只是权限引擎里的一个只读档位
   （[engine.ts:158-164](../packages/core/src/permissions/engine.ts#L158)），没有 prompt overlay、没有计划产物、
   没有"呈现计划 → 用户批准 → 切换到执行"的闭环。模型在 plan 模式下只会被拒绝，不知道自己该干什么。
2. **该问用户的时候不会问** —— `AskHandler` 接口早就预留好了
   （[permissions/types.ts](../packages/core/src/permissions/types.ts)），但 CLI 无条件使用
   `nonInteractiveAskHandler`（[index.ts:254](../packages/cli/src/index.ts#L254)），`ask` 一律拒绝。
   f63eb8c 加了 REPL 之后**现场已经有人了**，这个降级就不再成立。
3. **没有 token 预算** —— loop 只认 `maxTurns` 和 `maxCostUSD`；`ModelRequest.maxOutputTokens` 一路铺到
   [openai-compat.ts:322](../packages/core/src/provider/openai-compat.ts#L322) 却从没被赋值；
   `capabilities.contextWindow` 声明了但**没有任何读取方**；`onContextPressure`
   （[hooks.ts:33](../packages/core/src/agent/hooks.ts#L33)）没有调用点。长会话只能撞到 provider 的 400 才知道爆了。

### 关于"Session 内要知道上下文"——已经是对的，不用改

REPL 每轮把完整消息列表传回去（[index.ts:374-375](../packages/cli/src/index.ts#L374) 的 `messages = result.messages`），
`--resume` 连读取账本一起重放（`rebuildSessionState`）。这块不存在缺口。
真正缺的是**上下文占用的可见性**——本里程碑只做可见性（计量 + 阈值告警 + 优雅停止），
真正的压缩（`compactor.ts`）留给 Phase 4。

### 落地方式

三个可独立验证的提交，按依赖顺序：**Step 1（预算）→ Step 2（交互确认）→ Step 3（Plan Mode）**。
Step 3 依赖 Step 2 的 prompter。

---

## Step 1 — Token 预算与上下文可见性

> **状态：已完成（2026-09-06）。** 偏差：
> - 本文写作时引用的 `packages/cli/src/index.ts` 行号多已过时（f63eb8c 重写了 REPL），按当前代码落位。
> - `heuristicTokenCount` 移入 `context/tokenizer.ts`，但 openai-compat 仍 `export { heuristicTokenCount } from '../context/tokenizer.js'` 一行再导出，避免改动既有 import / 测试。`TokenCounter` 同样并到 tokenizer 为单一来源。
> - `estimateRequestTokens` / `estimateMessageTokens` 的 counter 形参默认 `heuristicTokenCount`（loop 不注入自定义计数器）。
> - "flag ?? settings.X ?? 默认值" 提成 `packages/cli/src/budgets.ts` 的纯函数 `resolveBudgets`，好单测——这是文中点名的回归防线。
> - warn 阈值的显式告警一个 session 只打一行（避免每轮刷屏），`ctx x/y (z%)` 仍每轮 `printUsage` 都带。
> - `TurnContext` 的 `signal?` 在本步就加上了（loop 透传），Step 2 直接用。

### 1.1 抽出可复用的 token 估算器

新建 `packages/core/src/context/tokenizer.ts`：

- 把 `heuristicTokenCount`（现在在 [openai-compat.ts:866+](../packages/core/src/provider/openai-compat.ts#L866)，
  CJK 加权的那个）**移到这里**，openai-compat 改为从这里 import（保持它现有的 `TokenCounter` 注入点不变）。
- 把 `OpenAICompatProvider.estimateUsage`（[openai-compat.ts:408-432](../packages/core/src/provider/openai-compat.ts#L408)）
  里那段"把 system + messages + tool schema 拍平成文本"的逻辑提成 `flattenRequestText(req)` 并共用——
  之后这段逻辑只有一份实现，loop 和 provider 都吃它。
- 新增 `estimateMessageTokens(messages, count)`：只估算增量消息，供下面的上下文核算用。

### 1.2 上下文占用核算（用真实 usage 做锚，不全量估算）

在 [loop.ts](../packages/core/src/agent/loop.ts) 的 `run()` 里维护 `contextTokens`：

- 第一轮：`estimateRequestTokens(request)`。
- 之后每轮：`prevUsage.inputTokens + prevUsage.outputTokens + estimateMessageTokens(本轮追加的 tool_result 消息)`。

上一轮的 `usage.inputTokens` 是端点报回来的真实数字，所以误差只累积在"新追加的这几条消息"上，
比每轮全量启发式估算准得多，也几乎不花 CPU。

可用窗口 `available = capabilities.contextWindow - maxOutputTokens`（给输出留位置）。

### 1.3 三档预算，全部在 turn 开头判定

`AgentLoopOptions` 新增：`maxTokens?`（累计 input+output）、`maxOutputTokens?`、`temperature?`、
`contextWarnRatio = 0.8`、`contextStopRatio = 0.95`。

`AgentStopReason` 新增 `'max_tokens' | 'context_limit'`。判定顺序接在现有
`aborted / max_turns / max_cost` 之后（[loop.ts:96-100](../packages/core/src/agent/loop.ts#L96)）：

- `usage.inputTokens + usage.outputTokens > maxTokens` → `'max_tokens'`
- `contextTokens / available >= contextStopRatio` → `'context_limit'`
- `>= contextWarnRatio` → 调用 `hooks.onContextPressure`（**这是它的第一个调用点**）

`onContextPressure` 签名扩成 `(ctx: TurnContext, pressure: { usedTokens, windowTokens, ratio })`
—— Phase 4 的 compactor 直接消费这个签名，届时 loop 不用再改。

`ModelRequest` 组装处（[loop.ts:105-111](../packages/core/src/agent/loop.ts#L105)）补上 `maxOutputTokens` 和
`temperature`（`hc raw` 已经这么用了，见 [index.ts:137](../packages/cli/src/index.ts#L137)）。

新增事件 `{ type: 'context'; usedTokens; windowTokens; ratio }`，每轮 emit 一次。

### 1.4 接上一直是死配置的 settings

`settings.maxTurns` / `maxCostUSD` / `temperature` 现在**只在 settings.json 里存在，`hc agent` 从不读**
（[index.ts:308-309](../packages/cli/src/index.ts#L308) 只转发 CLI flag，所以 `maxTurns: 10` 会被静默忽略成 50）。
改成 `flag ?? settings.X ?? 默认值`。`Settings` 增加 `maxTokens?` / `maxOutputTokens?`；
CLI 增加 `--max-tokens <n>`。

### 1.5 CLI 渲染

- `printUsage`（[index.ts:406](../packages/cli/src/index.ts#L406)）追加一段 `ctx 12.3k/120k (10%)`。
- 越过 warn 阈值时 stderr 打一行显式告警：说明当前占用、以及"开新会话"这个当前唯一的出路
  （诚实标注 `/compact` 属于 Phase 4，别写成已有功能）。
- `'context_limit'` / `'max_tokens'` 停止时打印可读的原因。

> 已知且**不改**：`maxCostUSD` 会超一轮才停（成本只有花完才知道）。在 CLI 提示里说清是"上限触发后停止"而非"绝不超过"。

---

## Step 2 — 权限 `ask` 真正弹问

> **状态：已完成（2026-09-06）。** 偏差：
> - `PermissionEngine` 顺带加了 `getMode()`（Step 3 CLI 要读当前模式）。
> - `confirm` 的整个提示块通过 `rl.question` 的 query 字符串输出（而不是无条件 `process.stdout.write`），这样它落在 readline 自己的输出流上、可被注入测试。
> - `confirm` 的选项对象加了 `alwaysLabel?`（doc 的接口里没有）——prompter 不知道工具名，靠调用方传入渲染 `[a] always allow Bash`。
> - 交互式 ask handler 提成 `prompter.ts` 的 `interactiveAskHandler(engine, prompter, opts)` 工厂，好用假 prompter 单测；`index.ts` 只做 `process.stdin.isTTY` 分流和 `onBeforePrompt`/`echo` 回调。
> - 非交互（非 TTY）分流点在 `index.ts` 内联，未单独抽函数——`nonInteractiveAskHandler` 的确定性拒绝本身已有 loop 层测试覆盖。

### 2.1 引擎侧的两个小口子

[engine.ts](../packages/core/src/permissions/engine.ts) 增加：

- `setMode(mode: PermissionMode)` —— Step 3 的批准后切换要用。
- `addAllowRule(raw: string)` —— 给"本会话内一直允许"用，内部走现成的 `parseRule` 追加到 `this.allow`。

`AskHandler` 的入参加上 `signal?: AbortSignal`；`TurnContext` 加 `signal?`，由 loop 透传，
`createPermissionHooks`（[permissions/hooks.ts:20](../packages/core/src/permissions/hooks.ts#L20)）转发进 ask 请求。
这样 Ctrl+C 能打断正在等待的提问，而不是把 REPL 卡死。

### 2.2 新建 `packages/cli/src/prompter.ts`

```ts
export interface Prompter {
  confirm(o: { title: string; detail: string; signal?: AbortSignal }):
    Promise<{ choice: 'once' | 'always' | 'deny'; feedback?: string }>;
  askText(query: string, signal?: AbortSignal): Promise<string>;
  close(): void;
}
export function createPrompter(shared?: Interface): Prompter;
```

两个必须处理的实现细节：

- **串行化**：`runToolCalls` 用 `Promise.all` **并行**收集所有权限判定
  （[loop.ts:181-186](../packages/core/src/agent/loop.ts#L181)）。一轮里两个工具都要问时，
  两次 `rl.question()` 会打架。prompter 内部挂一条 promise 链把提问排队——
  和 REPL 里 `queue`（[index.ts:360](../packages/cli/src/index.ts#L360)）解决的是同一类问题。
- **readline 归属**：REPL 模式复用外层那个 `rl`（`rl.question()` 会截获下一行，不会再触发 `'line'`
  事件，所以不会和 `queue` 冲突）；一次性模式且 stdin 是 TTY 时按需临时创建、答完即 `close()`。

### 2.3 CLI 接线

`process.stdin.isTTY` 为真时用交互 handler，否则**保持** `nonInteractiveAskHandler`
—— 管道/CI 下行为确定性是可脚本化的前提，不能因为这次改动丢掉。

`rl` 的创建要提到构造 `hooks` 之前（现在在 [index.ts:344](../packages/cli/src/index.ts#L344)，
在 REPL 分支内部）；用一个 `let sharedRl: Interface | undefined` 前置声明、REPL 分支里赋值即可。

提问长这样：

```
? Bash requires approval in ask mode
    npm test
  [y] 允许一次   [n] 拒绝   [a] 本会话一直允许 Bash
>
```

- `y` → allow
- `a` → `engine.addAllowRule('Bash')`，回显 `+ allow Bash (this session)`，再 allow
- `n` → 追问一句可选的理由，拼进 `{ decision: 'deny', reason }`，模型能看到为什么被拒绝并改道
- signal 触发 → 按 deny 收尾，reason 写"用户中断"

`a` 这一档先做**整工具粒度**（`Bash` 而不是 `Bash(npm test:*)`）：从一次具体调用反推安全的
specifier 前缀本身是个容易出错的判断，先做诚实的粗粒度、并在回显里明说加了哪条规则。
更细的粒度留作后续。

渲染细节：弹问前要先收掉 `thinkingOpen` 那个未闭合的 dim 块（[index.ts:263-278](../packages/cli/src/index.ts#L263)），
否则提示语会带着灰色转义。

---

## Step 3 — Plan Mode（完整版）

> **状态：已完成（2026-09-06）。** 偏差：
> - `runToolCalls` 返回值从 `ToolResultBlock[]` 改成 `{ blocks, endsRun }`（`ToolResultBlock` 不带 `endsRun`，loop 需要另一条通道知道"该停了"）。
> - `AgentControl.mode` 声明为 `readonly`；CLI 侧用 getter 实时读 `engine.getMode()`。
> - `.agent/plans/` 前缀判定用 `defaults.ts` 里的 `PLANS_DIR_PREFIX` 常量，engine 不 import config（避免多一条依赖边）。
> - prompt overlay 段 id = `plan_mode`，插在 `conventions` 与 `environment` 之间。测试断言 `segments[0]`/`[1]`（identity + conventions）跨所有模式逐字不变。
> - plan 批准的交互走新增的 `Prompter.approve()`（`confirm()` 的 `[a] always` 档对"批准一个计划"没意义）。
> - 非交互 `--mode plan` 实测是"管道喂一行到 REPL"（stdin 非 TTY 即触发 `endsRun`），与 `--mode plan "prompt"` 一次性路径等价；两条都验证过。
> - `mergeSettings` 里补了 `planApprovedMode` 的透传（原来显式重建 `permissions` 对象会把它吃掉）。

### 3.1 loop 需要的两处最小扩展

- `ToolContext` 增加 `control?: AgentControl`（新建 `packages/core/src/agent/control.ts`）：

  ```ts
  export interface AgentControl {
    mode: PermissionMode;
    /** 用户批准后离开 plan 模式，返回现在生效的模式。下一个模式由 CLI 决定，不由工具硬编码。 */
    exitPlanMode(): PermissionMode;
    confirm?(req: { title: string; body: string }):
      Promise<{ approved: boolean; feedback?: string }>;
  }
  ```
  （全是 `import type`，与 `permissions/types → agent/hooks → tools/types` 现有的类型环共存无碍。）

- `ToolResult` 增加 `endsRun?: boolean`；loop 在 `runToolCalls` 之后检查，命中则
  `stop(..., 'stopped_by_tool')`。这是非交互场景下"出完计划就停"唯一确定的机制，
  也是以后 `ask_user` 之类工具的通用出口。

`AgentLoopOptions` 加 `control?`，在 `executeOne` 里透传进 `spec.execute` 的 ctx
（[loop.ts:243-247](../packages/core/src/agent/loop.ts#L243)）。

### 3.2 `exit_plan_mode` 工具

新建 `packages/core/src/tools/exit-plan-mode.ts`，`{ readOnly: false, concurrencySafe: false }`，
入参 `{ plan: string; title?: string }`。执行：

1. 写 `<projectRoot>/.agent/plans/<yyyymmdd-hhmm>-<slug>.md`（复用 `findProjectRoot`，
   直接走 fs——这是工具自己的指定产物，不经过 `write` 工具）。
2. 有 `ctx.control.confirm` → 呈现计划并等批准：
   - 批准：`ctx.control.exitPlanMode()`，返回"计划已批准，保存在 `<path>`，当前模式 `<mode>`，开始实施"。
   - 拒绝：返回"用户未批准，反馈：`<feedback>`。修订后重新调用 `exit_plan_mode`，你仍在 plan 模式。"
     —— 模型自然会改，不需要额外的循环机制。
3. 无 `confirm`（非交互）→ `{ content: 'Plan written to <path>.', endsRun: true }`。

`packages/core/src/tools/index.ts` 的 `builtinTools()` **不加它**——只有 plan 模式才注册，
免得普通模式下模型看到一个用不上的工具。

### 3.3 权限引擎

- [defaults.ts](../packages/core/src/permissions/defaults.ts) 的 `KNOWN_TOOLS` 加 `exit_plan_mode`，
  否则 `evaluate()` 第一步就把它当未知工具拒了（[engine.ts:38-40](../packages/core/src/permissions/engine.ts#L38)）。
- `evaluate()` 给它一个分支：仍然尊重 deny 规则，其余一律 allow——真正的把关是那次人工批准。
- **写入牢笼的开口**：`modeDefault` 增加 `rel?: string` 形参，`plan` 分支里
  `write`/`edit` 且 `rel` 落在 `.agent/plans/` 下时放行（[engine.ts:154-177](../packages/core/src/permissions/engine.ts#L154)）。
  `evaluatePathTool` 已经算好了 `rel`，传下去即可。
  > 注意：`rel` 是相对 `workspaceRoot`（即 `--cwd`）的。当 `--cwd` 是项目子目录时 `.agent` 在牢笼外，
  > 这个开口不生效——但 `exit_plan_mode` 自己走 fs 写，主路径不受影响。在代码注释里记下这个边界。

### 3.4 Prompt overlay

`buildAgentSystemPrompt` 增加 `mode` 参数（[prompt.ts:35-45](../packages/core/src/agent/prompt.ts#L35)），
plan 模式时追加一个 `plan_mode` 段落，内容就是"先探索再规划"的那套流程：

1. 先用 read/glob/grep 把要改的代码**真的读一遍**，不要对着假设做计划；
2. 再写计划：解决什么问题、具体动哪些文件和函数、步骤顺序、怎么验证；
3. 调 `exit_plan_mode` 把计划交出去等批准；
4. 写类操作在本模式下被拒绝，唯一可写路径是 `.agent/plans/`。

**这个段落必须放在 `cacheBreakpoint: true` 的 `conventions` 段之后**
（[prompt.ts:39](../packages/core/src/agent/prompt.ts#L39)）——放前面会让随模式变化的文本进入可缓存前缀，
把 prompt cache 命中率打掉。

### 3.5 CLI 接线

现在 `tools` 和 `system` 各构造一次（[index.ts:240](../packages/cli/src/index.ts#L240) /
[:303](../packages/cli/src/index.ts#L303)），
改成在 `buildLoop()` 内按**当前模式**构造——`buildLoop` 本来就每轮调用一次，天然拿到批准后的新模式。
批准后的目标模式取 `settings.permissions.planApprovedMode ?? 'acceptEdits'`，
切换时 stderr 打一行模式变更提示。

一次性 `--mode plan "..."`：非 TTY 时走 `endsRun`，停止后打印计划文件路径（对齐 [PLAN.md](./PLAN.md) Phase 6）。

> 同一次 `run()` 内批准后 system prompt 不会重建（它在 `run()` 开始时就固定了），
> 但工具返回值里已经写明"模式已切换，开始实施"，模型据此继续；下一轮 REPL 消息会重建。这是刻意的取舍。

---

## 验证

**单测**（`vitest`，沿用现有 mock provider 做确定性回放）

| 目标 | 断言 |
| --- | --- |
| `context/tokenizer.ts` | CJK/ASCII 混排计数合理；`flattenRequestText` 与 provider 侧行为一致（重构不改语义） |
| Step 1 loop | 超 `maxTokens` → `'max_tokens'`；构造超窗口的历史 → `'context_limit'`；越过 warn 阈值 → `onContextPressure` 被调用且拿到正确的 ratio；`maxOutputTokens`/`temperature` 出现在 `ModelRequest` 里 |
| settings 接线 | 只在 settings.json 里写 `maxTurns: 2` 时确实 2 轮就停（当前会静默变成 50——这条是回归防线） |
| Step 2 prompter | 用假 prompter 驱动 ask handler：`y`/`n`/`a` 三条路径；`a` 之后同一工具第二次调用不再提问；两个待批准工具**串行**提问而非并发；signal 触发时按 deny 收尾 |
| Step 2 非交互 | 非 TTY 下仍然是 `nonInteractiveAskHandler` 的确定性拒绝 |
| Step 3 引擎 | plan 模式下 `Write(.agent/plans/x.md)` allow、`Write(src/a.ts)` deny 且理由含 "plan mode"；`exit_plan_mode` 未知工具拒绝已解除 |
| Step 3 工具 | 批准 / 拒绝 / 非交互（`endsRun: true`）三条路径的返回文案与副作用（模式是否切换、文件是否落盘） |
| Step 3 prompt | overlay 只在 plan 模式出现，且 `conventions` 段及其之前的文本逐字未变（缓存前缀不变的断言） |
| 红队回归 | Phase 3 那组用例（路径穿越 / symlink / `rm -rf ~` / 读 `.env` / `node -e` 逃逸）全绿 |

**端到端手测**

```bash
pnpm build && pnpm test && pnpm typecheck
```

```bash
node packages/cli/dist/index.js agent --mode plan "给 packages/core/src/tools/read.ts 的分页加边界处理并补测试"
```

依次确认：① 它先 read/grep 探索而不是直接动手；② 中途让它改源文件必须被拒且理由写明 plan mode；
③ `exit_plan_mode` 弹出计划等批准；④ 批准后模式变成 `acceptEdits` 并真的开始实施；
⑤ 拒绝并给反馈时它会修订计划重新呈现；⑥ 每轮 stderr 有 `ctx x/y (z%)`；
⑦ `--max-tokens 500` 能在中途以 `max_tokens` 停下；⑧ 一次性非 TTY（`echo ... | hc --mode plan`）
不弹问、输出计划路径后退出。

## 收尾

在 [PLAN.md](./PLAN.md) 的**偏差记录表**追加一行（按既有约定，只追加不重写计划正文）：
Phase 4 的 token 预算/上下文可见性与 Phase 6 的 Plan Mode 被提前到 Phase 3.5，
原因是 REPL 落地后"没人能回答 ask"的前提消失、且长会话撞窗口是日常可用性的硬门槛；
真正的压缩（compactor / ledger / 项目记忆）仍留在 Phase 4。

## 明确不在本里程碑范围

- 上下文压缩 `compactor.ts` / 文件账本 `ledger.ts` / `AGENTS.md` 项目记忆（Phase 4）
- `ask_user` 这类模型主动提问的工具、write/edit 的 diff 预览（本次问询中未选）
- 探索子 agent（Phase 7）；本里程碑的"先探索"靠 prompt overlay + 只读权限实现，不做上下文隔离
- `js-tiktoken` 精确计数——先用现成的启发式计数器，等 Phase 4 用真实 usage 做回归校准时再评估
