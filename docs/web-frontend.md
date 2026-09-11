# Web 前端搭建计划（protocol + server + web，端到端）

2026-09-10 · 状态：计划，未开始实现。协议设计见 [web.md](web.md)。

## Context

`docs/web.md` 已经把 `hc web` 的服务端协议设计好了（单 WebSocket 承载 RPC + 事件流、seq 断线重连、host 持有 pending ask、localhost token），但一行代码都还没写。现在正式开始做 Web 前端。借鉴两个项目（浅克隆、只读，未执行）：

- **t3code**（`pingdotgg/t3code` @ `f814983c`）：`apps/web` 用 React 19、Vite、TanStack Router、Tailwind 4 + shadcn（base-ui）、zustand、LegendList、react-markdown + Shiki。WS RPC，每个 thread 的事件带 sequence，订阅时返回 snapshot 或增量事件，服务端 50ms 合并 delta，逻辑都放在纯函数 `*.logic.ts` 里单测。
- **opencode**（`anomalyco/opencode` @ `b7ca4f9`）：`packages/app` 用 SolidJS。传输是 REST + 全局 SSE，客户端 16ms 批量合并 delta，store 是规范化结构。消息渲染在 `session-ui`：按工具名注册渲染器，带 Generic 兜底。权限和问题做成 composer 上方的 dock，不用弹窗。用一个 `Platform` 接口给 Electron 留缝。

**已定的决策**：端到端推进（先 protocol 和 server，再 web）；shadcn/ui + Tailwind 4；v1 只做浏览器，只留 Platform 缝，不做 Electron。

**明确不抄**：
- t3code：Effect RPC/atoms、Lexical 编辑器、多环境/relay/Clerk、几千行的大组件、atoms + zustand 两套状态并存。
- opencode：v1/v2 双协议、contenteditable 输入框、多 server/多目录、60 种语言。

## 架构总览

```
packages/protocol  帧/事件/方法类型 + zod 校验 + 共享 fold 逻辑（从 tui 移过来），无 node 依赖
packages/server    SessionHost、WS RPC、auth、静态文件服务（依赖 core、protocol、ws）
packages/web       React 19 + Vite + Tailwind 4 + shadcn + zustand（依赖 protocol）
packages/cli       新增 `hc web [--port] [--no-open] [--dev-origin <url>]`
```

---

## M0：core 的准备工作（小改动，只做加法）

1. **`loadTranscript(agentDir, id)`**，放在 `packages/core/src/agent/session.ts`。基于已有的私有函数 `readSessionEvents`（L129）重放所有 `message` 事件，遇到 `compaction` 事件转成分隔标记，返回 `TranscriptItem[]`。
2. **`readSessionSummary(agentDir, id)`**：取第一条用户消息作为标题，读文件时尽早停止（返回 `{id, mtimeMs, title}`）。和 `listSessionIds`（L276）配合使用。
3. **抽出 `buildSessionConfig()`**：把 `packages/cli/src/index.ts` 的 L250-267（`loadSettings` → `ProviderRegistry.resolve` → `resolveBudgets`）和 L280-296（`AgentSessionConfig` 字面量）搬到 core 的 helper 里。CLI 改成调用它，server 复用。
4. **core 新增 `./browser` 子路径导出**，只重导出无 node 依赖的纯函数：`describeToolInput`（`tools/util.ts`）、`fmtTokens`/`fmtUSD`（`util/format.ts`），外加类型。加一个测试，用 esbuild `platform:'browser'` 打包这个入口，保证不会混进 node 模块。
5. 测试：给 `loadTranscript` 和 `readSessionSummary` 写单测（含压缩前后的情况），CLI 现有测试全部保持通过。

## M1：`packages/protocol`

- `src/frames.ts`：`ClientFrame`、`ServerFrame`、`ErrorCode`，照搬 `docs/web.md`。
- `src/events.ts`：`WireEvent`。`AgentEvent`、`Notice`、`Message`、`Usage` 等用 `import type` 从 core 引入，避免类型重复定义后漂移。
- `src/methods.ts`：用 `{ method: { params: zodSchema, result: Type } }` 形式的映射表生成类型安全的 `call<M>()` 签名。server 用同一份 schema 校验参数。
- `src/fold/`：把 `packages/tui/src/state/eventBuffer.ts` 和 `reducer.ts` 里的共享部分挪过来（实测它们只 import core 的类型，没有 Ink/React 依赖）。
  - 同时把 `tui/src/app.tsx` L67-70 的 batch-commit 规则一起抽过来。
  - TUI 专属字段（`overlay`、`expandedOutput`、`cwd`）留在 TUI，TUI 改为 import protocol。
  - `eventBuffer.test.ts` 和 `reducer.test.ts` 跟着迁移。
- tsconfig 沿用 base（NodeNext），不加 `types:["node"]`，只用 `lib: ES2023`，这样 node API 一用就会编译报错。
- 在根 `tsconfig.json` 的 references 里加上它。

## M2：`packages/server`

- **`SessionHost`**（`src/host.ts`），包住一个 `AgentSession`：
  - 事件：每个事件分配递增的 `seq`，放进 ring buffer（5000 条）。
  - 合并：约 30ms 合并一次 delta，遇到非 delta 事件立即 flush（同 `EventBuffer` 的规则）。
  - 状态：`busy` 标志；`send` 进来时如果正在跑，直接回 `busy` 错误。
  - 生成 `run_start`/`run_end`/`run_error` 事件。
  - pending ask/plan 带 id，谁先回答算谁的，然后广播 `resolved`；abort 时按 deny 结算。这部分是参考 `tui/src/state/bridges.ts` 的 `UiStore` 重写的多客户端版。
  - slash 输入在服务端处理：`/compact`、`/plan`、MCP prompt → `expandSlash`。
- **`SessionRegistry`**：`list`（`listSessionIds` + `readSessionSummary` + 内存里活跃 host 的状态）、`create`、`open`（有 `resumeId` 就从磁盘恢复）、`close`、`shutdown`。
- **`src/ws.ts`**：
  - 握手：upgrade 之前校验 `Origin`/`Host`；第一帧必须是 `auth`，用 `timingSafeEqual` 比对 token。
  - RPC：按方法名 dispatch，参数走 zod 校验。
  - 订阅：`subscribe` 带 `sinceSeq`，buffer 还覆盖得到就补发缺口，否则返回 `{reset, snapshot}`。
- **`src/http.ts`**：`node:http` 提供静态文件服务（`web/dist`），支持 SPA fallback，带 CSP，静态资源不需要 token。
- **`src/index.ts`**：`startServer({ cwd, port, devOrigin? })`，只绑定 `127.0.0.1`，返回 `{ url, token, close }`。
- **CLI**：新增 `hc web` 命令，启动 server，打印并打开 `http://127.0.0.1:<port>/#token=…`。`--dev-origin http://localhost:5173` 用来放行 Vite 开发服的 Origin。
- **打包**：`scripts/bundle-hc.mjs` 里，server 和 CLI 一起打进 bundle（纯 JS）；web 的 dist 作为静态目录复制到 `dist-bundle/web/`。静态目录的查找顺序参考 t3code 的 `resolveStaticDir`：先找同级的 `./web`，再找 `packages/web/dist`。
- **测试**：
  - host 单测：用 core 已导出的 `ScriptedProvider`（`core/src/provider/mock.ts:67`）驱动真实的 `AgentSession`，覆盖 seq 递增、delta 合并、busy 拒绝、ask 先答先得、abort 结算为 deny、断线后补发和 reset。
  - ws 集成测：真实启动 server，用 `ws` 客户端连接，测 auth 失败、错误的 Origin、完整的一轮 send。
- **mock 模式**：`hc web --mock` 用 `ScriptedProvider` 播放一段固定剧本，覆盖文本、thinking、bash/edit 工具、权限询问、plan。前端开发和演示不用花 API 费用，也方便截图验收。

## M3：`packages/web` 脚手架

- Vite + React 19 + TypeScript，`@tailwindcss/vite`，`shadcn init`（组件拷贝到 `src/components/ui/`）；图标用 `lucide-react`。
- tsconfig 单独配置：`moduleResolution: Bundler`、`lib: DOM`、不加 composite。typecheck 用 `tsc --noEmit`，接入根 `pnpm typecheck`；构建用 `vite build`，接入根 `pnpm build`。
- **开发流程**：终端 1 跑 `pnpm hc web --no-open --port 4317 --dev-origin http://localhost:5173 [--mock]`，终端 2 跑 `pnpm --filter @harness-code/web dev`。`vite.config.ts` 把 `/ws` 代理到 server 端口（默认 4317，`HC_WEB_PORT` 可改；`ws: true` + `changeOrigin: true`，否则 server 的 Host 校验会 403）。token 在 dev 模式下由 server 打印 Vite 地址带 hash 的 URL（`dev: http://localhost:5173/#token=…`）。
  - 实现备注：shadcn CLI 在 TS 7（无 `baseUrl`）下解析不了 `@/` 别名，`shadcn add` 后要检查 `cn` 的 import 是否被写成了 `"cn"` 包。本仓库 node_modules 用的是仓库内 `.pnpm-store`，`pnpm install` 需带 `--store-dir .pnpm-store`（shadcn 内部安装用 `npm_config_store_dir` 环境变量）。
- 暂不上路由库：v1 只有「会话列表 + 会话视图」，用 `#/s/<id>` 这种 hash 状态就够了，以后接 Electron 也兼容。
- `src/platform.ts`：定义 `Platform` 接口（`openExternal`、`notify`、`storage`），v1 只有浏览器实现。
- vitest：给 web 的测试文件加 `// @vitest-environment jsdom`，或者在 `vitest.config.ts` 里用 `projects` 拆分；组件测试用 `@testing-library/react`。

## M4：传输层和状态（`src/lib/`，纯逻辑，重点单测）

- **`rpc.ts`**：`RpcClient`
  - 连接：发 auth 首帧，维护 `id → Promise` 映射，提供 `call<M>(method, params)`，事件通过 `onEvent` 回调派发。
  - 重连：退避 0.5/1/2/4/8s；`visibilitychange` 和 `online` 事件触发时立即重连（t3code 的 wakeups 做法）。
  - 恢复：重连后对每个已订阅的会话按 `lastSeq` 重新 `subscribe`，收到 `reset` 就用 snapshot 重建。
- **`token.ts`**：从 `location.hash` 读出 token，存进 `sessionStorage`，再清掉 hash。
- **store（zustand）**：
  - `serverStore`：server info 和连接状态。
  - `sessionsStore`：侧边栏列表，带 running/pending 徽标。
  - `sessionStore(id)`：直接复用 protocol 的 fold reducer；丢弃 `seq ≤ lastSeq` 的事件（t3code 的去重做法）。
- **批量应用**：事件先进队列，每个 `requestAnimationFrame` 统一 fold 一次，再 `setState`（对应 opencode 的 16ms flush）。
- **结构共享**：没变的消息和条目保持对象引用不变，`React.memo` 的行组件就不会重渲染（t3code 的 `useStableRows` 思路）。

**实现备注（M4 已完成）**：
- 纯逻辑层没有照原计划拆成 `serverStore`/`sessionsStore`/`sessionStore(id)` 三个 store，而是一个 zustand store（`lib/store.ts`：status、info、sessions、views）加一个 `SessionSync`（`lib/sync.ts`）：它持有 `RpcClient` 和每个会话的 `SessionModel`（`lib/sessionModel.ts`，包 protocol 的 `EventBuffer` + `foldReducer`），事件立即进 model，每帧把脏会话一次性 `setState`。
- 打开过的会话一直保持订阅（不 unsubscribe），侧边栏徽标靠 `session.list` 在 run/ask/plan 事件后防抖刷新。
- 中途打开的会话：tool 的 `tool_use` 在 ask 之前就落盘，但 `tool_call_start` 在 ask 之后才发——`SessionModel` 对已在 snapshot 里的 tool 做原地更新，避免重复卡片。
- `sync.e2e.test.ts` 用真实 `startServer({ mock: true })` + `ws` 驱动 `SessionSync`，覆盖两个 tab 抢答、中途打开看到 pending ask 和已有 transcript。
- 顺带修的 server 问题：无参方法客户端不能发 `params: null`（`z.void()` 只收 undefined）；`index.html` 加 `no-cache`、`assets/` 加 `immutable`；plan 批准后 session 自己切 mode 只发 notice，host 现在把 `mode-changed` notice 转成 `mode` 事件；`--mock` 会话录到临时目录（关服时删），这样中途 snapshot 能看到当前轮。

## M5：UI（按优先级分批）

**第一批已完成**（另外提前做了极简版 `PendingDock`：ask 的 once/always/deny 和 plan 的 approve/reject，不然 mock 剧本会卡在第一个 ask；反馈输入、y/a/n 快捷键、markdown 渲染留给第二批）。

**第一批：跑通一轮对话**
- `AppShell`：左侧 `SessionSidebar`（新建会话、列表、徽标、当前选中），右侧 `SessionView`。
- `SessionHeader`：显示 model、mode 选择（`setMode`）、`UsageMeter`（↑in ↓out、费用、上下文占比，80%/92% 两档变色，对齐 TUI 的 `MeterBar`）。
- `Transcript`：
  - 用户消息、assistant 消息、notice 行、压缩分隔线（依赖 `TranscriptItem`）。
  - 滚动：贴底自动滚动，用户上滚后停止，并显示「回到底部」按钮。
  - 暂不虚拟化，先用 CSS `content-visibility: auto`；长会话卡了再上 `@tanstack/react-virtual`。
- `Composer`：`textarea`，Enter 发送、Shift+Enter 换行；running 时切换成 Stop 按钮（`abort`）；草稿按会话存在 `localStorage`。

**第二批：人工介入环节**
- `PermissionDock`：放在 composer 上方，显示工具名，参数用 `describeToolInput` 展示，按钮为 once/always/deny，可附反馈；快捷键 y/a/n，和 TUI 一致。
- `PlanCard`：渲染 markdown，approve/reject 附反馈。
- 断线横幅：显示连接状态，`reset` 时静默重建。

**第三批：消息渲染质量**
- `Markdown`：`react-markdown` + `remark-gfm`。流式渲染时先补全未闭合的代码块（参考 opencode 的 `remend` 思路，自己写一个小函数就够），代码块在流结束后才用 Shiki 懒加载高亮，这是 t3code 的做法。
- 工具卡片按工具名注册渲染器（`src/components/tools/registry.ts`，Generic 兜底）：
  - `bash`：命令，输出可折叠，错误时自动展开。
  - `edit`/`write`：diff 视图，用 `diff` 库配合简单的行级渲染。
  - `read`/`grep`/`glob`：一行摘要，可展开。
  - `todo`：清单样式。
  - `task`（子 agent）：折叠显示。
  - `exit_plan_mode`：转给 PlanCard。
- `Thinking`：默认折叠，流式时显示「思考中…」。

**第四批：效率**
- slash 弹层：输入 `/` 时弹出，数据来自 `session.slashCommands`，客户端自己处理 `/help`、`/clear`。
- 快捷键：⌘K 新建会话，Esc 中止。
- 深浅色主题跟随系统。

## M6：收尾

- 更新 `docs/web.md`：Status 改为已实现，记录和设计稿之间的偏差。
- README 里加上 `hc web` 的用法。

---

## 关键文件

- 修改：
  - `packages/core/src/agent/session.ts`
  - `packages/core/package.json`（exports）
  - `packages/cli/src/index.ts`
  - `packages/tui/src/state/*`（改为 import protocol）
  - `packages/tui/src/app.tsx`
  - `tsconfig.json`、`vitest.config.ts`、`scripts/bundle-hc.mjs`、`package.json`（scripts）
- 新增：`packages/protocol/**`、`packages/server/**`、`packages/web/**`
- 复用：
  - `ScriptedProvider`（`core/src/provider/mock.ts`）
  - `listSessionIds`/`readSessionEvents`（`core/src/agent/session.ts`）
  - `UiStore` 的语义（`tui/src/state/bridges.ts`）
  - `EventBuffer`/`sessionReducer`（`tui/src/state/`）
  - `describeToolInput`、`fmtTokens`、`fmtUSD`

## 提交节奏

按工作记忆直接在 `main` 上提交，每个 M 至少一个 commit，动手前先看 `git status`，确认没有其他会话的并发改动。

## 验证

1. **每个 M 完成后**：`pnpm typecheck && pnpm test && pnpm build` 全部通过，TUI 的现有测试保持绿色。
2. **M2 完成后**：`hc web --mock --no-open`，用一个小的 node ws 脚本连接，确认 auth、send 和事件流都正常，同时确认错误的 Origin 或 token 会被拒绝。
3. **M5 每批完成后**：用 in-app Browser pane 打开 `hc web --mock` 的页面，截图检查一轮对话、工具卡片、权限 dock（点 once/always/deny）、plan 审批、中途 abort、刷新页面后 pending ask 仍在、开两个 tab 时先答者生效。
4. **最后一步**：去掉 `--mock`，用真实模型在本仓库里跑一轮带 bash 和 edit 的任务，检查费用和上下文占比显示，再测一次压缩后分隔线是否正确。

**2026-09-11 真实模型冒烟（M5 第一批后提前跑，`deepseek/deepseek-v4-flash`）**：read → bash `git log` → edit → bash `tail` 一轮跑通，约 $0.015、上下文 3%；从磁盘恢复旧会话能正确显示。压缩分隔线还没测。发现并修掉的问题：
- **host 并发 ask 死锁**：模型并行发两个要审批的工具调用时，第二个 ask 覆盖了第一个，第一个的 promise 永远不 resolve，整轮挂住。现在 host 用队列，一次只展示一个，abort 时全部结算。
- **core 的 macOS bash 沙箱挡了 `/dev/null`**：`git` 等以读写方式打开 `/dev/null` 的命令直接失败（TUI 同样受影响）。profile 现在放行 `/dev/null`、`/dev/zero`、`/dev/tty*`、`/dev/fd/*`。
- **启动 notice 丢失**：它们在 `AgentSession.create` 期间发出，那时 host 还不知道 id，帧里 `sessionId` 是空串；`attach` 时回填，新建会话从 seq 0 订阅以重放它们。
- **同一标签页粘贴新 URL 不生效**：只改 hash 不重载，旧 token 还在；现在 `#token=` 的 hashchange 会存 token 并重载。
- **贴底滚动误判**：`content-visibility` 行高落定后内容变高被当成用户上滑；改成只有向上滚才解除贴底，并用 ResizeObserver 跟随内容增长。
- 待办：从磁盘恢复会话要 ~5s（完整建会话含 MCP 连接）；markdown 原样显示；edit 的审批只显示路径看不到改动内容。
