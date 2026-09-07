# 实施计划

> 本文件是项目的施工蓝图，与代码同仓库维护。
>
> **当前进度：Phase 5 / 10 已完成**（Phase 0 骨架 + Phase 1 provider 兼容层 + Phase 2 agent loop /
> 工具集 + Phase 3 权限与沙箱 + Phase 3.5 token 预算/交互确认/Plan Mode + Phase 4 上下文工程 +
> Phase 5 MCP 接入）。
> 每个 Phase 完成后在下方对应小节标注状态，不要事后重写计划本身 ——
> 计划和实际的偏差本身就是有价值的记录。
>
> ## 与原计划的偏差记录
>
> | 日期 | 原计划 | 实际做法 | 原因 |
> | --- | --- | --- | --- |
> | 2026-09-06 | 用 tsup 构建 | 直接用 `tsc -b` 项目引用 | TypeScript 7 原生编译器够快，少一层工具链 |
> | 2026-09-06 | 能力位用户覆盖放 `models.yaml` | 并入 `.agent/settings.json` 的 `capabilities` 字段 | 少一个配置文件和一条 YAML 解析路径；改能力位时通常同时在改 provider baseUrl，同文件更顺手。**此项待确认，如需独立 yaml 改动成本很低** |
> | 2026-09-06 | Phase 1 依赖 `zod-to-json-schema` | 不需要，zod 4 自带 `z.toJSONSchema()` | 依赖解析出来是 zod 4.5 |
> | 2026-09-06 | Phase 2 工具声明权限等级字段 | 只保留 `readOnly`/`concurrencySafe`，不加 `permission` 字段 | 权限等级是安装时的策略决定（Phase 3 规则引擎按工具名匹配），不是工具自身的属性；提前加字段没有消费者 |
> | 2026-09-06 | Phase 2 "先读后改"用完整文件账本 | 用 `SessionState` 里一个 `Map<path, mtimeMs>` 存在性判断即可 | 完整的 mtime 失效检测是 Phase 4 文件账本的职责；Phase 2 只需要"读过没有"这一个布尔量 |
> | 2026-09-06 | Phase 3 bash 审查完全用 AST | 命令替换（`$(...)`/反引号）的硬拒绝用了一个字符串正则前置检查，其余复合命令拆分和高危规则判定才是 `shell-quote` AST | `shell-quote` 本身不会对命令替换报错或拒绝解析，AST 遍历不到"这里有命令替换"这个事实，正则前置检查更直接；不影响"逐段 AST 判定"的核心设计 |
> | 2026-09-06 | Phase 3 CLI 权限模式选择 | `hc agent` 非交互场景下固定用 `nonInteractiveAskHandler`（ask 一律 deny），交互式 ask handler 留空 | 目前只有一次性 CLI，没有人可以回答"是否允许"；交互式 handler 等 Phase 9 TUI 落地后再接，`AskHandler` 接口已经预留好 |
> | 2026-09-06 | macOS `sandbox-exec` profile 标为 stretch，先不做 | 提前做完：`permissions/macos-sandbox.ts`，workspace 读写、其余只读，`(allow default)` 不动读/网络/进程 | 真实跑通 `hc agent` 后发现纯文本审查（AST + 黑名单）拦不住"合法工具的普通用法"，比如 `echo x > /tmp/y` 这种重定向——不在任何硬拒绝规则里，也不该被枚举式加规则去堵；OS 级沙箱是唯一能兜住"审查漏判"的层。手动实测：workspace 外写入被内核拒绝（`Operation not permitted`），workspace 内写入正常。同一次实测也发现 `Bash(node:*)` 这类允许规则会被 `node -e` 逃逸成近乎无限制执行，顺带把 `python/perl/ruby/node` 的内联求值旗标改成无条件硬拒绝 |
> | 2026-09-06 | Phase 4 的 token 预算 / 上下文可见性、Phase 6 的 Plan Mode 按原顺序做 | 提前到中间里程碑 **Phase 3.5**（见 [PHASE-3.5.md](./PHASE-3.5.md)）：token 计量 + 阈值告警 + 优雅停止、`ask` 真正弹问、完整 Plan Mode（探索→出计划→批准→切换执行） | f63eb8c 落地 REPL 后"没人能回答 ask"的前提消失；长会话撞 provider 400 是日常可用性硬门槛，只做可见性成本很低。真正的压缩（`compactor.ts` / `ledger.ts` / `AGENTS.md` 项目记忆）仍留在 Phase 4 |
> | 2026-09-07 | Phase 4 一次做完（compactor + ledger + 项目记忆） | 拆成 **Phase 4a（本次，只做 `compactor.ts`）** 与 Phase 4b（`ledger.ts` + `AGENTS.md`/`CLAUDE.md`）。4a：`onContextPressure` 之外新增 `onCompact` hook，`≥0.92` 自动触发；机制学 Claude Code（阈值→整段摘要→用结果继续），digest 内容学 Manus（任务状态 + "协作/代码/工具/输出"风格备忘，以 `AGENT_CONVENTIONS` 为基线只记偏差）；摘要走主模型（`smallModel` 可选覆盖）；`--no-compact` 关闭；会话 `.jsonl` 存压缩后快照，`--resume` 尊重压缩边界 | compactor 是四块里最能量化的、也最影响日常可用性，先单独跑通并验证；ledger 与压缩协同（压缩时判断哪些文件内容可安全丢）留到 4b 一起做 |
> | 2026-09-07 | Phase 4b：`ledger.ts` 独立模块，含"重复读折叠成指针" | **不做重复读折叠**；ledger 收窄为 `SessionState.readMtime()` + `edit`/`write` 的 mtime 失效检查（读之后文件被外部改动 → 拒绝并提示重新 read）。外加 `context/memory.ts`：`AGENTS.md`/`CLAUDE.md` 从项目根到 cwd 逐层加载（+ `~/.agent`），作为 `project_memory` 段插在 `conventions`（cacheBreakpoint）之后 | 模型重复 read 未改动文件多是合理的上下文刷新（lost-in-the-middle），给指针 stub 恰在最该帮忙时帮不上；compactor 落地后重复副本会在压缩时被整段摘要掉；未到阈值就折叠得回写活动历史、打断 KV-cache。失效检查和项目记忆才是没争议的价值 |
> | 2026-09-07 | Phase 4 收尾：`truncate.ts` / `cache.ts` / `budget.ts` | `truncate.ts`：`truncateHeadTail`（行对齐头尾截断，从 bash 提取）+ `truncateList`（grep 现在报 "showing 200 of N" 而非静默截断）。`cache.ts`：`SYSTEM_SEGMENT_ORDER` + `orderSystemSegments`（前缀顺序从隐性约定变成 `buildAgentSystemPrompt` 收尾强制的契约）+ `cacheHitRate`（每轮 `cached N (P%)`、会话结束 `cache P% of Nk input`）。`budget.ts`：**只做分类占用核算**（`analyzeStableParts` + `context` 事件带 `breakdown`，CLI 显示 `sys/mem/tools/hist`）—— **不做配额器** | 现在唯一真实降级杠杆是压缩历史（已有），项目记忆有上限、工具输出有截断，配额器没有实际分支可做；真正需要配额是 skills 渐进式披露落地后（清单 token 是核心输入）。降级逻辑推到 Phase 6。`cacheBreakpoint` 字段对当前 OpenAI-compat 面是死配置，留给 Phase 7 原生 Anthropic provider |
> | 2026-09-07 | Phase 5：远程 HTTP server 支持 OAuth | 只做**静态 token**：`.mcp.json` 里 `headers` / `env` 值支持 `${ENV_VAR}` 插值，把 `Bearer ${TOKEN}` 写进 header 即可。OAuth 流程延后 | 静态 token 覆盖绝大多数自建 / 公开 server；OAuth 需要交互式回调，和 Phase 9 TUI 一起做成本更低 |
> | 2026-09-07 | Phase 5b：把上一行延后的 OAuth + SSE transport 补齐（用户要求，接 Linear/Gmail 这类托管 server） | `mcp/oauth.ts`（`FileOAuthStore` → `~/.agent/mcp-auth/<slug>/`、`createOAuthProvider` 实现 SDK `OAuthClientProvider`、`openBrowser`）+ `mcp/oauth-login.ts`（`loginToServer`：本地回调 `http.Server` + `finishAuth` + 验证）。`hc mcp login/logout`。`client.ts` 加 SSE transport + http→sse 降级 + consume-mode provider（静默 refresh，不弹浏览器）。授权时机：交互式只 stderr 提示跑 `hc mcp login`（不中途弹浏览器）；OAuth 分支自动进入（无 `Authorization` header 即挂 authProvider）。测试：进程内 mock「OAuth AS + MCP server」跑通 discovery/DCR/token/authed-MCP 全链路，无网络。306 tests（+8）| Phase 9 才做的前提是"没有交互场景"，但 REPL 已经落地、`hc mcp login` 本身就是个独立交互命令，不依赖 TUI；SDK 自带 `OAuthClientProvider` + 两个 transport 的 `authProvider`，我们只写 provider 实现 + 回调 server |
> | 2026-09-07 | Phase 5：MCP 工具复用现有 `ToolSpec`（zod schema） | `ToolSpec` 加可选 `rawInputSchema?: JSONSchema`：MCP tool 的契约是 server 自己的 raw JSON Schema，`schema` 字段只留一个 `z.record` 透传守卫，真正校验交给 server。`toolDefinition()` 优先用 `rawInputSchema` | zod schema 只是 harness 内部把 "校验" 和 "发给模型的 JSON Schema" 统一到一处的手段；MCP 的 schema 天然就是 JSON Schema，硬转成 zod 再转回去既丢信息又没意义 |
> | 2026-09-07 | Phase 5：MCP 工具声明 `readOnly` / `concurrencySafe` | 一律写死 `false`（串行 + 按 "非只读" 过权限引擎，和 `bash` 同档）| 无法自省任意 MCP 工具是否有副作用；保守串行 + 默认 `ask` 是唯一安全的默认。将来可让 `.mcp.json` 逐工具覆盖，但现在没有消费者 |
> | 2026-09-08 | Phase 7：子 Agent 与并行 | `packages/core/src/subagents/`：`validate.ts` / `discover.ts`（`.agent/agents/*.md` 扁平文件，project > user > builtin，非法跳过；frontmatter `name/description/tools/model`）、`run.ts`（`runSubagent` = 薄封装 `AgentLoop` + 全新 `SessionState`；`subagentToolSpecs` = 父工具 ∩ `def.tools` 且永远去掉 `task`）、`task-tool.ts`（`createTaskTool(deps)`，schema `{subagent_type, prompt, description?}`，`concurrencySafe:true`，结果 = 报告 + 一行 footer）。子 Agent system prompt = `buildSubagentSystemPrompt`（`identity`+`conventions` 与主 prompt 逐字节一致 → 命中前缀缓存；加 `agent_role` 段，无 skills / plan_mode）。loop 并行判定放宽为 `spec.concurrencySafe`（见下）。权限引擎加 `evaluateWholeTool`（`todo`/`skill`/`task` 共用），`task` 按写类工具档：ask/acceptEdits 弹问、plan/readOnly 拒、yolo 放行、`Allow(Task)`/`Deny(Task)` 生效。CLI：`discoverAgents` + `task` 工具（`--no-subagents` 关）+ `hc agents` 子命令 + `subagentMaxTurns`（默认 20）+ 子 Agent 用量并入会话显示总额。内置 `explore` / `plan`（均 `tools: read glob grep`）。+25 tests（362 total）。实测：`task→explore` 两次 grep 在独立窗口（3.1k token），父 `hist` 停在 4.1k，报告是唯一进入父上下文的东西。 |
> | 2026-09-08 | Phase 7：并行派发 loop 改动 | loop 的并行工具判定从 `spec.readOnly && spec.concurrencySafe` 放宽为 `spec.concurrencySafe`。`concurrencySafe` 本就表示"可与其它并发安全调用同跑"，`readOnly &&` 是冗余；现有写类工具（write/edit/bash/所有 MCP）都是 `concurrencySafe:false` 不受影响，只有 `task` 因此能并行（受 loop 现有 concurrency=4 上限约束）。 |
> | 2026-09-08 | Phase 7：子 Agent 独立成本上限 / ask 冒泡 | v1 不做：子 Agent 无独立 `--max-cost`（用量并入父的显示总额但不进父 loop 的成本闸门，留 Phase 8）；子 Agent 内 `ask` 一律 deny（`nonInteractiveAskHandler`）—— 子 Agent 天然无人值守。子 Agent 运行不写父 session `.jsonl`（只有 `task` 结果消息写），`--resume` 不受影响。 |
> | 2026-09-08 | Phase 7：验收用无范围搜索 | `explore` 的验收 prompt 需限定子目录。发现 `grep` 工具对超长单行匹配（`.agent/sessions/*.jsonl` 有 300 万字符单行）会一次性撑爆上下文窗口 —— 这是 grep 工具的既有缺陷（JS fallback 不读 `.gitignore`、无逐行长度上限），已单独开 task 跟踪，不在 Phase 7 范围内修。 |
> | 2026-09-08 | Phase 6：Skills + Plan Mode | Plan Mode 已在 Phase 3.5（c2ae764）做完，本 Phase 只做 **Skills**。`packages/core/src/skills/`：`validate.ts`（spec frontmatter 校验）、`discover.ts`（project `.agent/skills` > user `~/.agent/skills` > builtin `packages/core/skills`，同名高优先级 shadow，非法跳过不 fatal）、`catalog.ts`（`SkillCatalog` + `<available_skills>` manifest + `MAX_MANIFEST_TOKENS=1500` 上界）、`skill-tool.ts`（`skill` 工具，只读，返回 SKILL.md 正文 = 渐进式披露第二层）、`narrow.ts`（`allowed-tools` 收窄）。system 段新增 `available_skills`（排在 `conventions` 后、`project_memory` 前）。权限引擎加 `evaluateSkill`（只读，plan/readOnly 放行，`Deny(Skill)` 仍生效）。CLI 加 `hc skills` + `--no-skills` + `control.activateSkill`。内置 `code-review`（带 `references/checklist.md` 演示第三层）+ `writing-tests`（带 `allowed-tools` 演示收窄）。+31 tests（337 total）。 |
> | 2026-09-08 | Phase 6：`allowed-tools` 与权限引擎按 specifier 逐调用取交集 | 只做 **注册表层收窄**：`narrowToolSpecs` 按工具名过滤「给模型看到的工具集」，多个激活 skill 取交集，`skill`/`todo` 恒保留；激活状态持续到会话结束。不在权限引擎里按 specifier 判定（如 `Bash(git:*)` 只放行 git 段）—— 引擎自身的 allow/deny 规则仍是那件事的归属地。字段本身在 spec 里也标 experimental，够用即可。 |
> | 2026-09-08 | Phase 6：上下文降级做「多桶优先级配额器」 | 只做 **manifest token 上界**（`MAX_MANIFEST_TOKENS`，超限的 skill 不进 manifest 但仍可按名加载）+ 断言。渐进式披露落地后，skills 清单是唯一新增的「既可变又可舍」的桶，且天然很小（2 skill ≈ 172 token）；真正的多桶配额器没有更多消费者，不做。 |
> | 2026-09-07 | Phase 5：MCP 权限默认档 | 与 Claude Code 对齐：`mcp__server__tool`（精确）/ `mcp__server`（整个 server）/ `mcp`（所有 MCP）三种粒度的 allow/ask/deny 规则，无规则时按 `modeDefault(tool, readOnly=false)` —— `ask`/`acceptEdits` 弹问、`plan`/`readOnly` 拒、`yolo` 放行、`deny` 永远赢。engine 里 `mcp__` 前缀在 `KNOWN_TOOLS` 检查前分流到 `evaluateMcp` | MCP 工具是运行时发现的，进不了静态 `KNOWN_TOOLS`；但没有理由让它绕开规则引擎 —— 复用同一套 allow/ask/deny 列表和同一条 `onBeforeToolCall` hook |

---

# 自建 Coding Agent（Claude Code 同类）实施计划

## Context

用户要从零构建一个属于自己的 coding agent，既要能日常辅助编程，也要作为简历上的核心项目。目标不是"套一个 LLM 包装器"，而是把 **harness engineering**（真正决定 agent 好用与否的那一层工程）做扎实并且可讲、可量化。

当前目录 `/Users/m/Desktop/MyClaudeCode` 为空，全新项目。本机环境：Node v22.23.1、pnpm 10.33.0、Python 3.14.2、uv 0.6.12。

已确认的关键决策（来自用户）：

| 决策 | 选择 |
| --- | --- |
| 技术栈 | TypeScript + Node 22（pnpm workspace） |
| 交互形态 | CLI（一次性/可脚本化）+ TUI（交互式）**双形态，同一个二进制** |
| 模型接入 | OpenAI 兼容优先，目标是"尽量多的 API 都能接"（LiteLLM 风格路由） |
| 必做能力 | MCP 接口、Skills、Plan Mode |
| Harness 重点 | 上下文工程 / 权限与沙箱 / 子 Agent 与并行 / 可观测与评测（四块全做） |
| Play Mode | 笔误，不做 |

**成功标准**：能用它给自己修真实 bug；`README` 里有架构图 + 一段 TUI 演示 GIF + 一张 eval 基准表；四块 harness 能力每一块都有可指向的代码模块和可量化的数字（token 节省率、pass@k、平均 turn 数）。

---

## 命名与仓库结构

包名 `harness-code`，CLI 二进制 `hc`（可改）。pnpm workspace：

```
harness-code/
├── packages/
│   ├── core/          # 全部内核：provider/agent/tools/context/permissions/mcp/skills/telemetry
│   ├── cli/           # commander 入口，一次性模式 + 转交 TUI
│   └── tui/           # Ink 交互界面
├── evals/             # 评测任务集 + fixtures（微型 git 仓库）
├── .agent/            # 运行时目录（skills / agents / plans / sessions / traces / settings.json / .mcp.json）
└── docs/architecture.md
```

运行时配置有意对齐 Claude Code 的文件形态（`.mcp.json`、`settings.json`、`SKILL.md` frontmatter），这样生态里的 MCP server 和 skill 可以直接复用，也是简历上的加分点（"兼容既有生态"而非自造格式）。

依赖：`@modelcontextprotocol/sdk`、`ink` + `react`、`commander`、`zod` + `zod-to-json-schema`、`js-tiktoken`、`shell-quote`、`yaml`、`gray-matter`、`fast-glob`、`vitest`、`tsup`。

---

## 分阶段实施

### Phase 0 — 骨架（0.5 天）✅ 已完成
pnpm workspace + tsup + vitest + tsconfig references；`hc --version` 跑通。CI（GitHub Actions：typecheck + test）先立起来，后面每个 phase 都不欠账。

**验证**：`pnpm build && pnpm test && node packages/cli/dist/index.js --version`

---

### Phase 1 — Provider 兼容层（2 天）✅ 已完成
**这是"兼容尽量多 API"的核心，先做，因为所有东西都建在它上面。**

`packages/core/src/provider/`：

- `types.ts` — 归一化的内部消息模型：`Message{role, content: ContentBlock[]}`，`ContentBlock = text | tool_use | tool_result | thinking`；`StreamEvent` 联合类型；`Usage{input, output, cachedInput, cost}`。**内部只认这一套，provider 负责翻译。**
- `openai-compat.ts` — OpenAI Chat Completions 为统一底座（覆盖 DeepSeek / Kimi / 通义 / vLLM / Ollama / OpenRouter / LiteLLM proxy / Azure）。要处理的真实坑：
  - 流式 `tool_calls` 的 delta 按 `index` 累积拼装（各家实现不一致，有的一次给全、有的按字符切）
  - `finish_reason` 各家不统一（`tool_calls` / `function_call` / `stop`）→ 归一
  - `reasoning_content`（DeepSeek R1 类）映射到 `thinking` block
  - 空 `content` + 仅 tool_calls、以及 `content` 与 tool_calls 同时出现两种形态
- `capabilities.ts` — 每个模型的能力位：`nativeTools / parallelToolCalls / streaming / jsonMode / promptCache / contextWindow / pricing`。来自内置表 + `models.yaml` 用户覆盖。
- `prompt-tools.ts` — **降级路径**：目标端点没有原生 function calling 时，把工具 schema 渲染进 system prompt，用带标签的块解析模型输出的调用（含容错：截断修复、单引号 JSON、多余散文）。这让本地小模型也能跑，是很好的工程叙事。
- `router.ts` — LiteLLM 风格 `provider/model` 字符串解析 + 按 provider 读 base_url/api_key（`.agent/settings.json` 与环境变量分层，key 永不写日志）。
- `anthropic.ts` — 原生 Anthropic 适配（可选，Phase 7 补；接口已留好）。
- `mock.ts` — **录制/回放 provider**：真实跑一次存成 fixture，之后测试与 eval 全部确定性重放。测试基建，必须现在做。

**验证**：`hc --model deepseek/deepseek-chat -p "1+1"` 出流式输出；单测覆盖三种 tool_calls delta 拼装形态 + 降级解析器的 5 个畸形输入。

---

### Phase 2 — Agent Loop + 工具集（3 天）✅ 已完成

`agent/loop.ts` 状态机：`组装请求 → 流式接收 → 收集 tool_use → 权限闸门 → 并行执行 → 回填 tool_result → 循环`，直到 stop / 超预算 / 被打断。

设计要点（决定后面几个 phase 好不好接）：
- **策略以 hook 注入，不写 if 分支**：`onBeforeTurn / onBeforeToolCall / onAfterToolCall / onContextPressure`。Plan Mode、权限、遥测、压缩都是这些 hook 的消费者。
- `AbortSignal` 贯穿全链路（Esc 打断要能真正 kill 掉子进程）。
- 预算：`maxTurns / maxTokens / maxCostUSD`，超限优雅收尾并汇报。
- 并行执行：只对 `concurrencySafe` 的工具并发（读类），写类串行；并发上限可配。

`tools/`：`read`（带行号、分页）、`write`、`edit`（精确字符串替换 + **"必须先读过才能改"不变式**）、`glob`、`grep`（优先 ripgrep，无则 JS 回退）、`bash`（spawn + 超时 + 输出截断）、`todo`（任务清单，给长任务用）。每个工具声明 `{ readOnly, concurrencySafe, permission }` 元数据——权限与 Plan Mode 直接吃这些元数据。Zod schema 一次定义，同时导出 OpenAI JSON Schema 和 MCP schema。

会话持久化：`.agent/sessions/<id>.jsonl`，支撑 `--resume` 与后面的 trace 回看。

**验证**：在一个临时 git 仓库里让它完成"给 `add()` 加参数校验并补一个测试"，全程无人工干预；`pnpm test` 覆盖 edit 的先读不变式与 bash 超时。

---

### Phase 3 — 权限与沙箱（2 天）✅ 已完成

`permissions/`：
- **模式**：`ask`（默认）/ `plan` / `acceptEdits` / `readOnly` / `yolo`（需显式 flag）。
- **规则引擎**：`Tool(specifier)` 形态，如 `Bash(git status:*)`、`Read(./src/**)`、`Write(./dist/**)`；`allow / ask / deny` 三列表，用户级与项目级分层合并，deny 永远优先。
- **路径牢笼**：`realpath` 解析后必须落在 workspace 内（防 symlink 逃逸、`../` 穿越）；内置敏感文件黑名单（`.env*`、`.git/config`、`**/id_rsa`、`**/*.pem`、credentials 类）。
- **bash 命令审查**：`shell-quote` 解析成 AST 而非正则匹配；复合命令（`&&`、`|`、`;`、命令替换）逐段判定，任一段不被允许则整条拦截；内置高危规则（`rm -rf /`、`curl | sh`、`chmod 777 /`、写 `~/.ssh`）。
- **执行沙箱**：`cwd` 锁定 workspace、环境变量白名单（不透传 API key 给子进程）、超时、输出上限。macOS `sandbox-exec` profile（workspace 外只读）作为 stretch。

非交互 CLI 下遇到 `ask` 一律拒绝并明确报错（可脚本化的前提是行为确定）。

**验证**：写一组"红队"用例——路径穿越、symlink 逃逸、`git status && rm -rf ~`、读 `.env`——全部必须被拦截，且拦截理由可读。这组测试本身就是简历素材。

---

### Phase 4 — 上下文工程（3 天，重头戏）✅ 已完成（2026-09-07）

> 落地情况见上方偏差记录表的 4a / 4b / 4 收尾三行。`tokenizer.ts` 在 Phase 3.5、
> `compactor.ts` 在 4a、项目记忆 + 失效检查在 4b、`truncate.ts`/`cache.ts`/`budget.ts`
> 在收尾。`budget.ts` 只做核算不做配额器（降级留 Phase 6）；`ledger.ts` 不独立成模块
> （收窄进 `SessionState`）。60+ 轮长会话与"重复读增长近似 0"的原始验收标准按新方向调整。

`context/`：
- `tokenizer.ts` — `js-tiktoken` 计数，非 OpenAI 模型走启发式系数 + 用真实 usage 回归校准。
- `budget.ts` — 预算分配器：system / skills / 项目记忆 / 文件内容 / 历史 各自配额，超额时按优先级降级而不是粗暴截断。
- `compactor.ts` — **压缩**：占用超阈值（默认 80%）时，把最老的若干轮用便宜模型摘要成结构化 digest（`目标 / 已做决策 / 触碰过的文件 / 未决事项 / 关键代码片段`），保留首条用户消息 + 最近 K 轮原文。`/compact` 手动触发，也可自动。
- `ledger.ts` — **文件读取账本**：记录已读文件与 mtime；同一文件重复读时把旧副本折叠成指针（避免同内容占三份 context）；文件被改动后自动标记旧读取失效。
- `truncate.ts` — 工具输出的头尾保留 + 中间省略（标注省略行数并给出继续读的方式），而不是硬切。
- `cache.ts` — **前缀稳定性**：system → skills 摘要 → 项目记忆 → 历史，顺序固定且前缀不可变，最大化各家的自动 prefix caching 命中；命中率进 telemetry。
- 项目记忆：加载 `AGENTS.md` / `CLAUDE.md`（含上级目录继承）。

**这是四块 harness 里最能量化的**：eval 里对比"开压缩/关压缩"的 token 消耗与成功率，直接进简历。

**验证**：构造一个 60+ 轮的长会话 fixture，断言压缩后仍能正确回答"我们最开始的目标是什么/改过哪些文件"；断言重复读同一文件 5 次后 context 增长近似为 0。

---

### Phase 5 — MCP 接入（2 天）✅ 已完成（2026-09-07，含 5b OAuth+SSE）

> `packages/core/src/mcp/`：`config.ts`（`.mcp.json` 两层加载 + `${ENV}` 插值 + `type:sse` / `auth`）、
> `client.ts`（`McpConnection`，懒连接 + 10s 超时 + 失败隔离 + stdio/http/sse + http→sse 降级）、
> `hub.ts`（`McpHub`，跨 server 聚合工具/资源/提示）、`tool-adapter.ts`
> （`mcp__<server>__<tool>` + `rawInputSchema`）、`resources.ts`（`@server:uri` 注入）、
> `serve.ts`（`hc mcp serve` 反向暴露内置工具）、`oauth.ts` + `oauth-login.ts`
> （OAuth：`~/.agent/mcp-auth/` token 落盘 + 本地回调 + 静默 refresh）。权限引擎加
> `evaluateMcp` 分支；CLI 加 `hc mcp list / serve / login / logout` + agent loop 自动挂载
> MCP 工具。306 tests（+29）。偏差见上方记录表 5 行。

`mcp/`（原计划）：
- 基于 `@modelcontextprotocol/sdk` 的客户端，支持 **stdio** 与 **streamable HTTP** 两种 transport。
- 配置读 `.mcp.json`（沿用 Claude Code 形态，生态 server 直接可用）。
- 工具命名空间 `mcp__<server>__<tool>`，**懒连接**（首次用到才起进程）、连接超时、失败降级为"该 server 工具不可用"而不是整体崩。
- 支持 MCP **resources**（`@server:uri` 引用注入上下文）与 **prompts**（暴露成斜杠命令）。
- **反向：同时把自己做成 MCP server**（`hc mcp serve`），把内置工具集通过 MCP 暴露给别的 agent。工具 schema 已是现成的，成本很低，但"既是 client 又是 server"的双向叙事很值。
- （5b 追加）**SSE transport** + **OAuth**：`hc mcp login <server>` 弹浏览器授权，token 落盘
  `~/.agent/mcp-auth/`，之后静默 refresh；未授权时降级为提示，主循环不崩。

**验证**：接一个真实公开 MCP server（如 filesystem/fetch）跑通调用；`hc mcp serve` 用官方 inspector 验证；断言 server 启动失败时主流程不受影响。5b：进程内 mock OAuth server 跑通全链路 + 真实 Linear（SSE+OAuth）手测。

---

### Phase 6 — Skills + Plan Mode（2 天）✅ 已完成（2026-09-08）

> Plan Mode 在 Phase 3.5 已完成，本 Phase 只做 Skills。落地见上方偏差记录表 2026-09-08 三行。
> `packages/core/src/skills/{validate,discover,catalog,skill-tool,narrow}.ts` + 内置
> `packages/core/skills/{code-review,writing-tests}/`。system 段加 `available_skills`，
> 权限引擎加 `evaluateSkill`，CLI 加 `hc skills` / `--no-skills` / `control.activateSkill`。

**Skills** (`skills/`)：
- `SKILL.md` + YAML frontmatter（`name / description / allowed-tools / model`），可带同目录的脚本与资源文件。
- 发现路径：`.agent/skills/**`（项目）、`~/.agent/skills/**`（用户）、内置。
- **渐进式披露**：system prompt 里只放 `name + description` 清单（每个几十 token）；模型决定要用时通过 `Skill` 工具加载正文。这直接呼应 Phase 4 的上下文工程。
- 技能声明的 `allowed-tools` 在执行期间**收窄**权限范围（与 Phase 3 的规则引擎叠加取交集）。
- 自带 2–3 个示例技能（如 `code-review`、`write-tests`）作为演示。

**Plan Mode** (`modes/plan.ts`)：
- 本质是**权限 profile + prompt overlay**，不是新的循环：所有写类工具置为 deny，唯一可写路径是 `.agent/plans/<slug>.md`。
- 提供 `exit_plan_mode` 工具：把计划呈现给用户 → 批准后切换模式，并把计划正文作为高优先级上下文注入后续执行。
- TUI 里有显著的模式指示条；CLI 下 `--mode plan` 输出计划文件路径后退出。

**验证**：Plan Mode 下强行让它改文件，必须被拒绝且给出"当前处于 plan mode"的清晰理由；技能清单在 system prompt 中的 token 占用有断言上界。

---

### Phase 7 — 子 Agent 与并行（2 天）✅ 已完成（2026-09-08）

> 落地见上方偏差记录表 2026-09-08 四行。`packages/core/src/subagents/`
> （`discover` / `validate` / `run` / `task-tool`）+ 内置 `packages/core/agents/{explore,plan}.md`。
> loop 并行判定放宽、子 Agent system prompt、`task` 权限档、`hc agents` 子命令。


`agent/subagent.ts`：
- Agent 定义放 `.agent/agents/*.md`（frontmatter：`name / description / tools / model`），内置 `explore`（只读搜索）与 `plan`（架构设计）两个。
- `task` 工具派发子 agent：**独立的上下文窗口**，跑完只把最终报告回传给主 agent —— 上下文隔离本身就是目的（大量搜索噪音不污染主线）。
- 并行派发 + 并发上限 + 每个子 agent 独立预算；状态流式回传给 TUI 展示。
- 子 agent 继承但只能收窄父级权限，不能扩权。

**验证**：一个需要横跨多目录搜索的任务，对比"用子 agent"与"主 agent 直搜"的主上下文 token 占用差异（这个对比数字放进 README）。

---

### Phase 8 — 可观测与评测（2.5 天）

**Telemetry** (`telemetry/`)：
- 每个 session 一份结构化 JSONL trace：每次模型请求/响应、每次工具调用的入参摘要、耗时、token（含缓存命中）、成本、错误。
- `hc trace <session>` 渲染时间线；`hc stats` 汇总跨 session 的 token/成本/平均 turn 数。
- OpenTelemetry exporter 作为 stretch。

**Eval** (`evals/`)：
- 任务集：8–10 个真实小任务，每个 = 一个微型 git 仓库 fixture + 任务描述 + 断言脚本（跑测试/检查 diff）。覆盖：修 bug、加特性、重构、写测试、多文件改动、需要用 MCP 工具的任务、需要拒绝的越权任务。
- Runner：每任务跑 N 次，报告 **pass@1 / pass@k、平均 token、平均成本、平均 turn 数、拒绝正确率**；输出 JSON 基准，与上次结果对比出回归。
- **消融实验**（简历上最硬的部分）：开/关压缩、开/关子 agent、原生 tool calling vs 提示词降级，各跑一轮出对比表。

**验证**：`pnpm eval` 用 mock provider 全绿且确定性；用真实模型跑一轮生成基准表进 README。

---

### Phase 9 — CLI + TUI 打磨（2 天）

**CLI**（`packages/cli`，可脚本化是重点）：
```
hc "修复 login 的空指针"          # 一次性执行
hc -p "总结这个仓库" --output-format json
hc --mode plan "重构鉴权模块"
hc --resume <session-id>
cat error.log | hc "分析这个报错"
hc mcp serve | hc trace <id> | hc stats | hc eval
```
flags：`--model / --mode / --allow / --max-turns / --max-cost / --no-mcp`。

**TUI**（`packages/tui`，Ink）：流式 markdown 渲染、可折叠的工具调用卡片、权限确认弹窗、模式指示条、token/成本实时计量、斜杠命令（`/plan /model /mcp /skills /compact /cost /resume`）、Esc 打断、Ctrl+C 两次退出。

`hc` 无参数进 TUI，带 prompt 参数走 CLI —— 同一个二进制两种形态。

**验证**：录一段 GIF（`asciinema` + `agg`）放进 README。

---

### Phase 10 — 文档与包装（1 天）
`docs/architecture.md`（含数据流图）、README（架构图 + GIF + eval 基准表 + "harness 四大块各自解决什么问题"）、CONTRIBUTING、`npm publish` 可选。README 的叙事按"问题 → 工程解法 → 量化结果"组织，而不是功能罗列。

---

## 总量与顺序

约 **22 个工作日**（业余每天 2–3 小时约 6–8 周）。Phase 1→2→3 是硬依赖必须按序；Phase 4–8 之间耦合较松，可按兴趣调序，但建议 **Phase 4（上下文工程）不要往后拖**——它是四块里最有分量的，也最影响日常可用性。

想更快看到能用的东西：Phase 0→1→2→9(TUI 简版) 大约 6 天就能得到一个"能跑真实任务"的 v0.1，之后再逐块补 harness 能力。

---

## 关键风险与应对

| 风险 | 应对 |
| --- | --- |
| 各家 OpenAI 兼容端点 tool calling 行为不一致 | Phase 1 的 capabilities 表 + 提示词降级路径；每接一家就补一组 mock fixture 进回归测试 |
| 上下文压缩丢关键信息导致 agent "失忆" | 结构化 digest（而非自由摘要）+ 首条消息永久保留 + Phase 4 的长会话断言测试 |
| 权限规则写漏被绕过 | deny 优先、bash 走 AST 而非正则、红队测试集作为 CI 门禁 |
| 范围膨胀做不完 | 每个 phase 结束都是一个可用的 tag；OTel、Anthropic 原生 provider、sandbox-exec 明确标为 stretch |
| 真实模型跑 eval 烧钱 | mock 回放 provider 承担 CI；真实模型只在发版前跑一轮出基准 |

---

## 端到端验证清单（全部完成后）

1. `pnpm build && pnpm test && pnpm typecheck` 全绿
2. `hc "给 src/utils.ts 的 parseConfig 加错误处理并补测试"` 在真实仓库里跑通，且改动通过原有测试
3. `hc --mode plan "..."` 产出计划文件，且期间任何写操作被拒
4. 红队测试集全部拦截通过
5. `.mcp.json` 配一个外部 server → 工具出现在清单且可调用；`hc mcp serve` 被 MCP inspector 正确识别
6. 放一个自定义 skill 到 `.agent/skills/` → 被发现、被按需加载、`allowed-tools` 生效
7. 跨目录搜索任务触发子 agent，主上下文 token 明显低于不用子 agent 的对照组
8. `pnpm eval` 出基准表；消融实验三组对比数字齐全
9. `hc trace <id>` 能完整还原一次会话的每步调用与开销
