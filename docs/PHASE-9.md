# Phase 9 — CLI 打磨 + Ink TUI

## Context

`harness-code` 已完成 Phase 0–8（provider 兼容层、agent loop、权限沙箱、上下文工程、MCP、
Skills、子 Agent、Telemetry + Eval）。剩 Phase 9（CLI/TUI）与 Phase 10（文档）。

Phase 9 的目标是把 agent loop 变成一个真正好用的日常工具：

1. **CLI 更可脚本化、体验向 Claude Code 靠拢** —— 加 `-p/--print`、`--output-format`、
   `--no-mcp`、stdin 管道输入，`hc <prompt>` 一次性执行、`hc` 无参进 TUI。
2. **一个真正的 Ink TUI**（`packages/tui` 目前只是 `export const TUI_PLACEHOLDER = true`）——
   流式 markdown、可折叠工具卡片、权限/计划弹窗、模式条、token/成本实时计量、斜杠命令、
   Esc 打断、双 Ctrl+C 退出。
3. **验证**：录一段 GIF 进 README。

**核心障碍**：`packages/cli/src/index.ts` 的 `agent` action 里焊死了约 470 行 loop 组装逻辑
（settings/provider/memory/skills/agents/MCP/recorder/trace/permission/control/compactor/
task-tool/onEvent 渲染/per-turn buildLoop/REPL）。`evals/src/harness.ts` 已经被迫重写了一份
"~80 行无头蒸馏"。Phase 9 第一步必须把这坨抽成一个**渲染器无关的会话引擎**，让 CLI 一次性
路径、REPL、TUI（以及可选的 evals）共用。

用户已确认的取向：
- CLI 体验向 Claude Code 靠拢。
- TUI 配色：**Apple 系统蓝**单强调色，背景用终端自身，文字近黑/近白，极简、细分隔线、留白大。
- 字体：终端程序无法设字体 —— 落到**布局 CJK 宽度安全**（`string-width` + `cli-truncate`
  贯穿所有测量/截断/画框），外加一份简短的推荐终端字体说明 + GIF 录制锁字体。**不做**大篇幅
  字体文档。
- 范围：**v1 核心 + 明确延后清单**。
- 旧 readline REPL：**保留为 fallback**（非 TTY / dumb terminal / `--no-tui` / 旧版 Windows
  console 走它），引擎抽出后维护成本已很低。

---

## 1. 会话引擎抽取（`packages/core`）

### 新文件 `packages/core/src/agent/session-runner.ts` —— `class AgentSession`

`AgentLoop` 保持每轮无状态；`AgentSession` 是有状态、多轮、持有资源的编排器。文件头注明三者
区分：`SessionState`=读账本+todo；`SessionRecorder`=落盘 jsonl；`AgentSession`=活的编排器。

经 `packages/core/src/agent/index.ts` 导出。

**API 形状**（详见设计，关键点）：

```ts
class AgentSession {
  static async create(config: AgentSessionConfig): Promise<AgentSession>;
  readonly id: string;                    // == recorder.id == trace id
  get mode(): PermissionMode;
  get activeSkills(): readonly ActiveSkill[];
  get contextSnapshot(): ContextSnapshot | undefined;
  get sessionUsage(): Usage | undefined;
  get messages(): readonly Message[];
  get engine(): PermissionEngine;         // interactiveAskHandler 的 addAllowRule 需要
  get mcpStatus(): McpServerStatus[];
  listSlashCommands(): SlashCommandInfo[]; // MCP prompts
  runTurn(input: string, opts?: { signal?: AbortSignal }): Promise<AgentRunResult>;
  abort(): void;                          // 不碰 process 信号
  setMode(mode: PermissionMode): void;    // 触发 onNotice mode-changed
  compactNow(): Promise<{ tokensBefore: number; tokensAfter: number } | null>;
  expandSlash(text: string): Promise<string | null>;
  close(): Promise<void>;                 // hub.closeAll + trace flush，幂等
}
```

`AgentSessionConfig`：`cwd` / `model: ResolvedModel` / `summarizerModel?` / `settings` /
`budgets: ResolvedBudgets` / `mode` / `planApprovedMode?` / `allow/ask/deny?` / 子系统开关
`skills? subagents? mcp? compact? recorder? trace?`（默认全 true，evals 传 `recorder:false`）/
`resumeId?` / `platform?`（默认 `process.platform`，evals 钉 `'linux'`）/
`projectMemory?: {text,sources}|null` / `loopOverrides?: Partial<AgentLoopOptions>`（evals 消融
逃生口）/ **注入的 seam**：`ask?: AskHandler`（默认 `nonInteractiveAskHandler`）、
`confirm?`（计划审批；缺省时 `exit_plan_mode` 写计划文件并结束 run，即今日非交互行为）、
`onEvent?(e: AgentEvent)`（热路径，逐 token）、`onNotice?(n: Notice)`（冷路径，结构化状态）。

**`Notice`**：把今天所有 `process.stderr.write('\x1b[2m…')` 变成
`onNotice({ kind, level: 'info'|'warn'|'error', text, data? })`。`kind` 覆盖
`session-start / project-memory / skills-discovered / agents-discovered / mcp-status /
permission-mode / mode-changed / skill-loaded / sandbox-warn / compaction / context-warn /
resource / subagent / stop / error`。

### `create()` 吸收（逐字从今日 action 搬）

`loadProjectMemory`（除非注入）· `discoverSkills` + `new SkillCatalog` · `discoverAgents` ·
`loadMcpConfig` + `new McpHub` + `hub.toolSpecs()` + `hub.prompts()` → `mcpPrompts` map ·
`new SessionRecorder` · `new TraceRecorder` · `loadSession` / `rebuildSessionState` ·
`createPermissionEngine` · `AgentControl` 对象（`activateSkill`/`exitPlanMode`/`confirm`
接到 `config.confirm`）· `createCompactor` hook · `createTaskTool` 闭包（整个 ~60 行子 Agent
`run` 块）· `mergeHooks(createPermissionHooks(engine, ask), compactHook)`。

### `runTurn()` 内部

`resolveResources(hub, input)`（hub 非空时，逐 note 发 `onNotice`）→ 记录 user message +
`trace run_start` → 内部 `AbortController`（link `opts.signal`，`session.abort()` 触发同一个）→
私有 `#buildLoop(signal)`**逻辑不变**（读 `engine.getMode()`，装
`builtinTools + exitPlanModeTool(plan 时) + skillTool + taskTool + mcpToolSpecs`，
`narrowToolSpecs`，`buildAgentSystemPrompt`，`new AgentLoop({...loopOverrides})`）→
`loop.run([...#messages, userMessage])` → 更新 `#messages / #sessionUsage(addUsage) /
#lastContext` + `trace run_end`。**core 里绝不出现 `process.on('SIGINT')`** —— 信号 100% 前端职责。

### 顺带搬动（同一 commit，旧路径 re-export 不破坏调用方）

- `resolveBudgets` + 类型：`packages/cli/src/budgets.ts` → `packages/core/src/config/budgets.ts`
  （只依赖 `Settings`）。
- `describeToolInput`：`packages/cli/src/prompter.ts` → `packages/core/src/tools/util.ts`
  （TUI 工具卡片和 prompter 共用）。
- 新增 `listSessionIds(agentDir)` 到 `packages/core/src/agent/session.ts`（镜像 `listTraceIds`，
  给 `/resume` 用）。
- `packages/core/src/config/settings.ts`：`Settings` 加可选 `tui?: { theme?: 'dark'|'light'|'auto' }`。

### AskHandler / confirm —— 调用方注入

引擎 `ask` 默认 `nonInteractiveAskHandler`（evals 和管道 CLI 正确）。CLI TTY 注入
`interactiveAskHandler(session.engine, prompter, …)`；TUI 注入 React 桥接的 promise handler
（见 §3）；evals 用默认。`confirm` 同理。

---

## 2. CLI 改动（`packages/cli`）

### 新 flag（挂在默认 `agent` 命令）

| flag | 效果 |
| --- | --- |
| `-p, --print` | 强制非交互一次性；永不进 TUI/REPL |
| `--output-format <text\|json\|stream-json>`（默认 `text`） | 选输出 sink；非 `text` 隐含 `-p`。**v1 只做 `text` + `json`，`stream-json` 延后** |
| `--no-mcp` | `mcp: false`，跳过全部 MCP 发现 |

保留全部现有 flag。

### 新文件 `packages/cli/src/dispatch.ts`

```ts
decideFrontend({ hasPromptArg, print, outputFormat, stdinIsTty, stdoutIsTty, env }): 'tui'|'oneshot'|'repl'
```
- `hasPromptArg || print || outputFormat !== 'text' || !stdinIsTty` → `oneshot`
- 否则 `stdinIsTty && stdoutIsTty && env.HC_NO_TUI !== '1' && env.TERM !== 'dumb' &&
  !(win32 && !WT_SESSION)` → `tui`，否则 `repl`

`readStdin()`（仅 `!stdin.isTTY` 时）；`buildPrompt(promptArg, stdin)`：两者都有 →
`` `${promptArg}\n\n<stdin>\n${stdin}\n</stdin>` ``（指令在前，管道内容作带标签块 —— 文档里
说明这个选择），仅 stdin → stdin 即 prompt，仅 arg → arg。

`agent` action 收缩为：resolve model/settings/budgets → 建 `AgentSessionConfig` →
`decideFrontend` → `await import('./repl.js' | './oneshot.js' | '@harness-code/tui')`。动态
`import('@harness-code/tui')` 把 Ink/React 挡在脚本快路径外。

### 新文件 `packages/cli/src/output.ts` —— `OutputSink`

- **`TextSink`** = 今日 ANSI 渲染器（`index.ts` 569–625 的 `onEvent` switch + `printUsage` +
  `describeStop`），逐字搬出，仍无 `chalk`，仍裸 `\x1b[…m`。Notice 打成 `\x1b[2m<text>\x1b[0m`。
- **`JsonSink`** = 缓冲助手文本，`finish` 时打一个 snake_case 对象
  `{ type, session_id, stop_reason, turns, result, is_error, usage{...}, context{...} }`
  （刻意贴近 Claude Code，jq 片段可迁移）。内部仍 camelCase，一个 `toResultJSON` 翻译。
- **`StreamJsonSink`** = NDJSON 逐事件 + 末尾 `result` 对象。**v1.1 延后**，v1 出 stub。

### 新文件 `packages/cli/src/oneshot.ts` / `packages/cli/src/repl.ts`

- `oneshot.ts`：`AgentSession` + 一个 sink，跑一轮，退出。
- `repl.ts`（~60 行）：readline 循环 → `session.runTurn` → `TextSink`。`queue` promise 链
  序列化 + `sharedRl` 借用给 ask prompter 保留（确实需要）；`buildLoop` / resource 展开 /
  per-turn SIGINT 交换 / `mcpPrompts` 处理全进了 `AgentSession`。装一个
  `process.on('SIGINT')`：turn 运行中 → `session.abort()`，idle → `rl.close()`。

### `hc eval` —— **不做**

`evals` 是 `private` 且非 `packages/cli` 依赖，import 会把 fixture/cassette/baseline 工具及
其依赖塞进 `hc` 二进制。`pnpm eval` 已存在。计划里 `… | hc eval` 是口号式简写。计划中明确
标注为**有意省略**（真要，日后加一个 `child_process.spawn node evals/dist/cli.js` 的薄命令，
不 import）。

---

## 3. TUI 架构（`packages/tui`，Ink + React）

### 入口 `packages/tui/src/index.ts`

```ts
export async function runTui(config: AgentSessionConfig & { onExit?: () => void }): Promise<void>
```
建一个 mitt 式 emitter，`onEvent`/`onNotice` 转发进 emitter 后传给
`AgentSession.create`，把 `session` + `emitter` 交给 `<App>`。`render(<App/>, { exitOnCtrlC: false })`。

### 组件树

```
<ThemeProvider>
 <App session emitter>              app.tsx — reducer + 桥 + 键处理
  ├ <Static items={history}>        已提交转录，永不重绘
  │   └ <HistoryEntry>              UserMessage / AssistantMessage(→<Markdown>) / ThinkingBlock / ToolCard(折叠) / NoticeLine
  ├ <LiveRegion>                    在途一轮（流式 assistant / running ToolCard / streaming thinking）
  ├ <Rule/>                         细 faint ─（仅此一处）
  ├ <ModeBar/>                      ● plan(accent) · ask(dim) · acceptEdits(warning) · readOnly(dim) · yolo(error) + dim: model · cwd basename
  ├ <MeterBar/>                     ↑12.3k ↓3.1k $0.0042 ctx34%▕▎（ctx gauge: dim→warning≥0.8→error≥0.92）
  ├ <Input/> └ <SlashAutocomplete/>
  ├ <PermissionModal/>  (pendingAsk)
  ├ <PlanModal/>        (pendingPlan)
  └ <Overlay/>          (/mcp /skills /resume /model /help)
```

`<Static>`（Ink 原生，渲一次留在原生 scrollback，无闪烁无高度上限）承载已完成内容；
在途只重绘小 live region。每条 assistant message / tool card 完成时，或 `turn_end`/`stop` 时，
reducer 把节点从 `live` 移入 `history[]`。

### 推 → 拉 事件桥（防撕裂）—— **本阶段最关键**

`AgentSession.onEvent` 同步、逐 token。**绝不逐 delta `setState`**。
- `state/eventBuffer.ts`：可变纯对象 `{ assistantText, thinkingText, tools: Map<id,…>, usage,
  context?, notices[] }`，`emitter.on` 同步廉价 mutate。
- `<App>` 一个 flush 循环 `setInterval(flush, 33)`（~30fps），`flush` = `dispatch({type:'FLUSH',
  snapshot})`。
- **立即强制 flush**：`tool_call_start/end`、`turn_end`、`compaction`、`stop`、`pendingAsk/
  pendingPlan` 出现时 —— 重要事件不等定时器，末尾 token 不丢。
- `state/reducer.ts`：纯 `sessionReducer(state, action)`。Actions：`FLUSH / COMMIT_TURN /
  SET_MODE / PENDING_ASK|RESOLVE_ASK / PENDING_PLAN|RESOLVE_PLAN / PUSH_NOTICE /
  OPEN_OVERLAY|CLOSE_OVERLAY / RESET_LIVE / NEW_SESSION`。零 Ink 单测。

### 流式 markdown —— `markdown/render.tsx`

**`marked` (`^14`，纯 ESM 带类型)**：`marked.lexer(text)` → token 流 → Ink 元素。
heading（粗体 `text`，**不**用 accent）/ paragraph（`<Text wrap="wrap">`）/ list（`•`/`1.` 沟槽）/
blockquote（faint `│` 沟槽）/ code fence → `<CodeBlock>` / hr → `<Rule/>`。inline：strong→bold、
em→italic、codespan→faint/inverse、link→accent+下划线。**流式**：每次 flush 重新 lex 累积串
（<10KB 很廉价），未闭合 ```` ``` ```` 当代码块渲染。**table v1.1 延后**（先当纯文本）。

**代码高亮**：**v1 不做**（代码块只 dim 等宽）。v1.1 加 `cli-highlight` (`^2.1`)。
不用 `ink-markdown`（React 16 peer，废弃）/ `marked-terminal`（吐 ANSI 串非 Ink 节点，丢布局）。

宽度：`<Markdown columns={useTerminalSize()}>`，Ink 原生 wrap；手动截断处用 `cli-truncate`。

### 权限 / 计划弹窗 —— AskHandler seam 作为受控 promise

`hooks/useAskBridge.ts`：`ask: AskHandler` 返回一个 promise，`resolver` 存 ref，
`dispatch(PENDING_ASK)`；`answer(v)` resolve + `dispatch(RESOLVE_ASK)`。`ask` 传进
`AgentSession.create({ ask })`。`runTurn` 被 `await`，loop 在 `hooks.onBeforeToolCall` 内自然
挂起 → 无撕裂。

`<PermissionModal>`：居中 `borderStyle="round"` `borderColor=accent`，显示 `reason` +
`describeToolInput(name,input)`；键 `y`=允许一次 / `a`=`session.engine.addAllowRule(label)` 后允许 /
`n`|`Esc`=拒绝 / `d`=拒绝+一行反馈 `<TextInput>`。

`hooks/usePlanBridge.ts` + `<PlanModal>`：同构，body 走 `<Markdown>`，`y`=批准
（`exitPlanMode` 切换在 core 内发生）/ `e`=带反馈修订。

### 输入编辑器

**依赖 `@inkjs/ui` (`^2`，Ink 作者维护，ESM 带类型)** 取 `TextInput / Spinner / Select / Badge`。
`Input.tsx` 包 `TextInput` 加：行尾 `\` 或 `Shift+Enter` → 换行，裸 `Enter` → 提交；
空行 `↑`/`↓` 循环历史提交；`value` 以 `/` 开头且无空格 → 上方渲 `<SlashAutocomplete>`。
**手写多行编辑器（缓冲内光标移动）v1.1 延后**。

### 斜杠命令 —— `hooks/useSlashCommands.ts`

内置 merge `session.listSlashCommands()`（MCP prompts）。`Tab` 补全，`Enter` 执行。
v1：`/help`（overlay：键位 + 命令表）、`/clear`（`NEW_SESSION` → 重新 `create`，同进程）、
`/quit`、`/compact`（`session.compactNow()` → notice）、`/cost`（详细用量进转录）、
`/resume`（overlay，`listSessionIds`）、`/plan`（`session.setMode('plan')`）、
`mcp:*`（`session.expandSlash` → body 作 turn 输入）。
**v1.1 延后**：`/model` 实时切换（v1 只读展示）、丰富 `/mcp` `/skills` overlay、`/theme` 持久化。

### 键位 `keys.ts`（`useInput` + raw mode，仅 `runTui` 内进入）

`Esc` → turn 运行中 `session.abort()`，否则关 overlay / 清输入。
`Ctrl+C` → 运行中 abort；idle 首次 → footer "press again to exit"，1.5s 内再次 → 退出。
`Ctrl+D` 空输入 → 退出。`Ctrl+O` → 切换"展开最后一个工具输出"（全局；逐卡片焦点导航延后）。

### resize `hooks/useTerminalSize.ts`

订阅 `process.stdout 'resize'`，Ink 自动重绘 live region + bars。已提交 `<Static>` 行不回流
（可接受，匹配原生 scrollback，文档说明）。

---

## 4. 主题 / 设计系统 —— `packages/tui/src/theme.ts`

```ts
interface Theme { name: 'dark'|'light'; text; dim; faint; accent; success; warning; error;
                  toolBorder; selectionBg; selectionFg; }
```

**DARK**（v1 默认）：`text #E6E6E6` · `dim #9B9B9B` · `faint #5A5A5A` ·
**`accent #0A84FF`（Apple 系统蓝，终端校准）** · `success #3FB950` · `warning #D29922` ·
`error #F85149` · `toolBorder #5A5A5A`。
**LIGHT**（结构就位，v1 不自动切换）：`text #1A1A1A` · `dim #6B6B6B` · `faint #C8C8C8` ·
`accent #0066CC` · `success #1A7F37` · `warning #9A6700` · `error #CF222E`。

- **背景**：绝不设，继承终端。
- **accent 只用于**：聚焦元素、plan 模式圆点、spinner、链接、弹窗边框。标题用粗体 `text` 非
  accent —— 这份克制就是 Apple/OpenAI 感。
- **256/16 色降级**：`theme-256.ts`，`supports-color` level < 3 映射 xterm-256
  （`accent→33 dim→245 faint→240 text→253 success→71 warning→178 error→203`），level < 2 →
  具名色。`themeColor(theme, token)` 返回给 `<Text color=…>`。
- **检测**：`settings.tui?.theme`（`dark|light|auto`）→ `auto` 时 `COLORFGBG` env → 默认 `dark`。
  **OSC 11 查询 + `/theme` 持久化 v1.1 延后**。
- **间距/线**：转录条目间恰好一空行；仅 `<ModeBar>` 上方一条 `faint ─`（长 `min(columns,100)`）；
  工具卡片 2 空格缩进 + 单条 `faint │` body 沟槽，**无框**（框留给弹窗）；输入上方一空行。

**chalk 说明（计划里点明）**：Ink 传递依赖 chalk，`packages/tui` 因此引入 chalk —— 可接受，
"不用 chalk" 的规矩是针对**可脚本化的 `hc` 输出**（`TextSink` 仍裸 `\x1b`）。TUI 纯交互、
从不管道，Ink 独占其配色。写进 `docs/architecture.md`。

---

## 5. 依赖 —— `packages/tui/package.json`

```jsonc
"dependencies": {
  "@harness-code/core": "workspace:*",
  "ink": "^5.1.0",              // ESM-only（自 v4）；React 18+ peer
  "react": "^19.0.0",           // 若某 dep peer 卡 18，则本包降 ^18.3
  "@inkjs/ui": "^2.0.0",        // TextInput/Spinner/Select/Badge；ESM 带类型
  "marked": "^14.1.0",          // ESM 带类型
  "string-width": "^7.2.0",     // ESM 带类型
  "cli-truncate": "^4.0.0"      // ESM 带类型
},
"devDependencies": {
  "@types/react": "^19.0.0",    // 唯一需要的 @types
  "ink-testing-library": "^4.0.0"
}
```

- 安装时 `pnpm why react` 确认单份；重复则 root `package.json` 加
  `"pnpm": { "overrides": { "react": "$react" } }`。
- React 18/19 在安装时按 `@inkjs/ui` 的 peer range 定；卡 18 则本包钉 `react@^18.3` +
  `@types/react@^18`，或弃 `@inkjs/ui` 自己搓输入 + 用 `ink-spinner`。
- `cli-highlight` **v1 不加**（高亮延后）。
- `packages/cli/package.json` **不加新依赖**（已有 `@harness-code/tui`），handoff 走动态 `import()`。
- `packages/tui/tsconfig.json`：`exclude` 改 `["src/**/*.test.ts","src/**/*.test.tsx","dist"]`
  （`include: ["src/**/*"]` 已覆盖 `.tsx`）。

---

## 6. CJK / 字体

**宽度安全布局（强制）** —— `packages/tui/src/util/width.ts`：
```ts
width(s) = stringWidth(s)
truncate(s, max, pos='end'|'middle') = cliTruncate(s, max, { position: pos })
pad(s, w, align)
```
所有 padding/裁剪处用 `width()` 非 `.length`、`truncate()` 非 `.slice()`：`ModeBar`/`MeterBar`
右对齐、`ToolCard` header 摘要、overlay 列表、slash 自动补全。code-review 清单加一条：
"`src/components/` 下不得用 `.slice`/`.length` 算显示宽度"。框线字符（`─ │ ▸ ▾ ● ✓ ✗ ↑ ↓`）
与盲文 spinner 均宽度 1；chrome 里不用双宽 emoji。

**`docs/terminal-setup.md`（新，简短）**：
- 推荐终端：WezTerm / iTerm2 / Kitty / Ghostty / Windows Terminal（truecolor + 可配 CJK fallback）。
- 字体栈：英文/等宽 —— "macOS 用 SF Mono 或 Menlo，其他平台 JetBrains Mono"；CJK fallback ——
  **PingFang SC（苹方）**；宋体是衬线，多数终端只认单一 CJK fallback，故 TUI 用苹方、宋体留给
  GIF/宣传渲染。给 iTerm2 / WezTerm 配置片段。
- 歧义宽度字符设为 **narrow**（匹配 `string-width` 默认），否则 `│` 沟槽会漂 1 列。

**GIF 录制** —— `docs/` 段 + `scripts/record-demo.sh`：
```bash
asciinema rec --idle-time-limit 2 --command 'node packages/cli/dist/index.js' demo.cast
agg demo.cast docs/assets/demo.gif \
  --font-family "JetBrains Mono,PingFang SC,Songti SC" \
  --font-size 20 --line-height 1.4 --speed 1.3 --theme "e6e6e6,101010,<16 色匹配 theme.ts DARK>"
```
用便宜/cassette 模型驱动，< 30s，`docs/assets/demo.gif` 入库，README 嵌。

---

## 7. 测试

- **会话引擎** `packages/core/src/agent/session-runner.test.ts`（用现有 scripted/replay provider
  helper）：`runTurn` 事件序列；多轮 `messages` 累积 + 读账本跨轮持久；`abort()` 中途 →
  `stopReason === 'aborted'`；plan → 注入 `confirm` 批准 → 下轮 loop 去掉 `exit_plan_mode`、
  `mode === planApprovedMode`、发 `mode-changed` notice；`mcp/skills/trace/recorder:false` 无
  发现/无工具/无落盘；`expandSlash` 命中/未命中；`@file` 资源展开；注入 deny-all `ask` →
  命中 ask 的工具被拒 loop 继续；`compactNow()` 换历史报节省。
- **CLI** `packages/cli/src/output.test.ts`（喂事件断言精确 json / NDJSON / ANSI 子串）、
  `dispatch.test.ts`（表驱动 `decideFrontend`、`buildPrompt` 有/无 stdin）。
- **TUI** `packages/tui/src/**/*.test.tsx`，`ink-testing-library`（假 stdin/stdout，**绝不**碰真
  `process.stdout`，CI 无 TTY）：`sessionReducer` 纯测；`<ToolCard>` 折叠/展开/错误保持展开；
  `<MeterBar>` 格式；`<PermissionModal>` `stdin.write('y')` → resolver 得 allow；`<Markdown>`
  结构；`width.ts` `width('你好world') === 9`；集成 —— 假 `AgentSession` 挂进 `<App>`，输入
  prompt+Enter → 转录出现响应，`Esc` 调 `abort`。
- **配置**：`vitest.config.ts` glob 加 `.{ts,tsx}`；`tsconfig.test.json` include 加 `.tsx`；
  `environment: 'node'` 不变。

---

## 8. Commit 划分（conventional commits）

1. **`refactor(core): extract AgentSession session-runner`** —— 新 `agent/session-runner.ts`
   (+test)、`config/budgets.ts`、`session.ts` 加 `listSessionIds`、`tools/util.ts` 加
   `describeToolInput`、`settings.ts` 加 `tui?.theme`、`agent/index.ts` 导出；`cli/budgets.ts`
   与 `cli/prompter.ts` re-export/改 import。**先落且测试绿**再动 CLI。
2. **`refactor(cli): one-shot + REPL on AgentSession; add --print/--output-format/--no-mcp`** ——
   新 `dispatch.ts` / `output.ts` / `oneshot.ts` / `repl.ts` (+tests)；`index.ts` 的 `agent`
   action 塌缩为 config-build + dispatch，删约 470 行。行为对比今日 REPL（管道爆发输入、多行
   粘贴测试）。
3. **`feat(tui): Ink shell — transcript, streaming markdown, input, meters`** —— `package.json`
   依赖、tsconfig/vitest glob；`index.ts` `runTui`、`app.tsx`、`state/{eventBuffer,reducer}`
   (+test)、`theme.ts`/`theme-256.ts`/`hooks/{useTheme,useTerminalSize}`、`util/width.ts`
   (+test)、`markdown/{render,code}` (+test)、`components/{Transcript,LiveRegion,HistoryEntry,
   UserMessage,AssistantMessage,ThinkingBlock,ToolCard,NoticeLine,ModeBar,MeterBar,Input,Rule}`
   (+关键 test)。
4. **`feat(tui): permission + plan modals, slash commands, key handling`** ——
   `hooks/{useAskBridge,usePlanBridge,useSlashCommands}`、`keys.ts`、
   `components/{PermissionModal,PlanModal,SlashAutocomplete,Overlay}`、`app.tsx` 接线、
   `session-runner.ts` 补 `setMode/compactNow/expandSlash/listSlashCommands`、`app.test.tsx`。
5. **`docs: terminal setup, TUI design notes, demo GIF`** —— `docs/terminal-setup.md`、
   `docs/tui.md`、`docs/assets/demo.gif`、`scripts/record-demo.sh`；README（GIF + "一个二进制
   两种形态" + flag 表）；`docs/PLAN.md` Phase 9 偏差记录条目 + Roadmap 状态。
6. **（可选）`refactor(evals): run harness on AgentSession`** —— `evals/src/harness.ts` 换成
   `AgentSession.create({ recorder:false, skills:false, mcp:false, platform:'linux',
   loopOverrides })`。**风险**：cassette 按指纹化请求（含 system prompt）keying，`AgentSession`
   必须逐字节同参同段序调用 `buildAgentSystemPrompt`（`{cwd,mode,platform:'linux'}`，无 memory
   无 skills manifest），否则全部 cassette 需重录。最后落、隔离、`pnpm eval` 绿 + 确定性为门；
   漂了单独 revert 这个 commit，CLI/TUI 不依赖它。

---

## 9. 风险与取舍

- **`tsc -b` composite + Ink/React 类型**：`skipLibCheck` 已开。真实风险是 `@inkjs/ui` 的
  NodeNext / `verbatimModuleSyntax` interop —— `esModuleInterop` 已开，预留半天模块解析磨合。
- **React 18 vs 19**：安装时按 `@inkjs/ui` peer 定；最坏本包钉 18。
- **推→拉批处理是关键**：错了就闪烁或丢末尾 token。缓解：每个终结事件强制 flush；`<Static>`
  承载已提交内容只重绘小 live region；reducer 单测。
- **`<Static>` resize 不回流**：接受（匹配原生 scrollback），文档说明。
- **SIGINT 归属**：core 绝不 `process.on('SIGINT')`；CLI one-shot/REPL 装 → `session.abort()`；
  TUI 用 `useInput` 接 Ctrl+C。这条边界理清顺带修掉今日 `index.ts` per-turn 换 handler 的味道。
- **回归现有 REPL**：抽取把 queue 序列化 / resource 展开 / buildLoop / SIGINT 交换搬进 core。
  缓解：commit 1 带测试先落；commit 2 REPL 行为对比今日；旧路径保留可达直到 commit 2 测试绿。
- **Windows**：raw mode + 框线在 Windows Terminal OK；旧 console 经 `WT_SESSION` 检查回落 REPL；
  cmd.exe TUI 标不支持。
- **范围 vs 2 天预算**：清单大。**v1 必交**：引擎抽取 + one-shot + `-p/--print` +
  `--output-format json|text` + `--no-mcp` + stdin 管道（commit 1–2）；TUI 含 `<Static>` 转录、
  流式 markdown（无表格、代码块只 dim、无高亮）、工具卡片 + 全局展开切换、模式条、计量、
  `@inkjs/ui` 输入 + `\` 续行、权限/计划弹窗、`Esc` 打断、双 Ctrl+C、斜杠
  `/help /clear /quit /compact /cost /resume /plan` + MCP prompts、**仅 dark 主题**（light 结构
  就位）、docs + GIF（commit 3–5）。
  **v1.1 延后**：`stream-json`、OSC-11 light 自动检测 + `/theme` 持久化、手写多行编辑器 + 输入
  历史、逐卡片焦点导航、`cli-highlight` 语法高亮、`/model` 实时切换、丰富 `/mcp` `/skills`
  overlay、markdown 表格、evals 移植（commit 6）、Windows 打磨。

---

## 验证

1. `pnpm build && pnpm typecheck && pnpm test` 全绿；`pnpm eval` 仍绿 + 确定性。
2. **CLI 脚本化**：
   - `node packages/cli/dist/index.js -p "总结这个仓库" --output-format json | jq .result` 出最终文本。
   - `cat some-error.log | node packages/cli/dist/index.js -p "分析这个报错"` 把 stdin 作为上下文。
   - `hc --mode plan "..."` 产计划文件后退出（无交互审批者）。
   - `hc --resume <id>` 续接会话。
   - `hc --no-mcp "..."` 跳过 MCP 发现（对比无 `--no-mcp` 时的 `mcp:` notice）。
3. **TUI**（真 TTY 手测）：`node packages/cli/dist/index.js`（无参）进 TUI；发一条会触发工具的
   prompt → 看到流式 markdown、running 工具卡片、`ask` 模式下权限弹窗（`y`/`a`/`n`）、模式条、
   计量随 `turn_end` 更新；`Esc` 打断在途 turn；idle 双 `Ctrl+C` 退出；`/help` `/compact`
   `/resume` `/cost` 生效；`TERM=dumb node …/index.js` 回落到 readline REPL。
4. **CJK**：TUI 内发中英混排消息 + 长中文工具入参，`│` 沟槽和右对齐计量不错位。
5. `ink-testing-library` 组件测试在 CI（无 TTY）通过。
6. README 有可复现的 demo GIF（`scripts/record-demo.sh`）。
