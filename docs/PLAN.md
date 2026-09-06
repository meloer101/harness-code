# 实施计划

> 本文件是项目的施工蓝图，与代码同仓库维护。
>
> **当前进度：Phase 3 / 10 已完成**（Phase 0 骨架 + Phase 1 provider 兼容层 + Phase 2 agent loop /
> 工具集 + Phase 3 权限与沙箱）。
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

### Phase 4 — 上下文工程（3 天，重头戏）⬅ 下一步

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

### Phase 5 — MCP 接入（2 天）

`mcp/`：
- 基于 `@modelcontextprotocol/sdk` 的客户端，支持 **stdio** 与 **streamable HTTP** 两种 transport。
- 配置读 `.mcp.json`（沿用 Claude Code 形态，生态 server 直接可用）。
- 工具命名空间 `mcp__<server>__<tool>`，**懒连接**（首次用到才起进程）、连接超时、失败降级为"该 server 工具不可用"而不是整体崩。
- 支持 MCP **resources**（`@server:uri` 引用注入上下文）与 **prompts**（暴露成斜杠命令）。
- **反向：同时把自己做成 MCP server**（`hc mcp serve`），把内置工具集通过 MCP 暴露给别的 agent。工具 schema 已是现成的，成本很低，但"既是 client 又是 server"的双向叙事很值。

**验证**：接一个真实公开 MCP server（如 filesystem/fetch）跑通调用；`hc mcp serve` 用官方 inspector 验证；断言 server 启动失败时主流程不受影响。

---

### Phase 6 — Skills + Plan Mode（2 天）

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

### Phase 7 — 子 Agent 与并行（2 天）

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
