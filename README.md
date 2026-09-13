<div align="center">

<img src="docs/marvis-header.png" width="760" alt="Marvis — 终端里的编码 Agent" />

### 一个开源的终端编码 Agent —— 跑在**任意** OpenAI 兼容模型上，在三分钱一次的 DeepSeek 上照样能打。

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/meloer101/harness-code?color=success)](https://github.com/meloer101/harness-code/releases)
[![node](https://img.shields.io/badge/node-%E2%89%A5%2020.10-brightgreen.svg)](https://nodejs.org)
[![stars](https://img.shields.io/github/stars/meloer101/harness-code?style=social)](https://github.com/meloer101/harness-code)

</div>

**Marvis** 是一个住在你终端里的编码 Agent：指到一个项目、说清你想要什么，它就去读代码、改文件、跑命令、自己验证结果——而且**动手之前都会先征得你同意**。用你自己的 API key，想用哪家模型都行。它从一开始就是为了**让便宜/开源模型真正好用**而设计的：同一个 Agent，在 GPT、Claude 上能跑，在一次只花三分钱的 DeepSeek 模型上也能跑通整套基准测试。

![Marvis 端到端修复一个失败的测试套件 —— 读、改、跑测试、完成](docs/demo.gif)

<sub>Marvis 在一个便宜模型上端到端修好一个失败的测试套件 —— 读代码、改一行、跑测试、通过。</sub>

## 安装

一个自包含的包，**不需要 npm 账号、也不依赖 registry**（Node ≥ 20.10）：

```bash
npm install -g https://github.com/meloer101/harness-code/releases/download/v0.1.0/marvis-0.1.0.tgz
```

装完你就有了 `marvis` 命令（以及短别名 `hc`）。以后升级，用 [Releases](https://github.com/meloer101/harness-code/releases) 里最新的 URL 再跑一遍这条即可。_（等 npm 账号就绪后会提供更短的 `npm install -g marvis`。）_

## 快速上手

**1. 给它一个 key。** Marvis 会读取你运行目录下的 `.env`（真实 shell 环境变量优先）。任意一家 provider 就够开始：

```bash
cd 你的项目
echo 'DEEPSEEK_API_KEY=sk-...' >> .env
```

开箱支持：`DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`MOONSHOT_API_KEY`（Kimi）、`ZHIPU_API_KEY`（GLM）、`DASHSCOPE_API_KEY`（通义千问）、`OPENROUTER_API_KEY`、`GROQ_API_KEY`、`TOGETHER_API_KEY`、`MISTRAL_API_KEY`、`XAI_API_KEY` —— 以及本地 **Ollama / vLLM / llama.cpp**，完全不用 key。

**2. 跑起来。**

```bash
marvis                                          # 交互式会话（终端 UI）
marvis "给 parseConfig 加上输入校验"              # 一次性、可脚本化
marvis models                                   # 看哪些 provider 已配置、已填 key
marvis -m deepseek/deepseek-v4-pro "讲讲这个仓库"  # 用 -m provider/model 选模型
```

默认运行在 **`ask` 模式**：它可以自由读取，但**执行 shell 命令或写文件之前会停下来征求你同意**。不会在你背后搞小动作。

## 为什么选 Marvis

- **🪙 便宜/开源模型也能打。** 一个适配层统一说 OpenAI Chat Completions，并抹平真实端点千奇百怪的差异——所以弱一点、怪一点的模型照样能跑通整个循环。Marvis 在 `deepseek-v4-flash` 上**基准测试 100% 通过，每个任务约 $0.003–0.005**。
- **🧠 它会记住你，跨会话、跨项目地和你协作。** 这是 Marvis 的一大亮点，详见下方 [记忆与协作](#记忆与协作)。
- **🔌 任意模型随你换。** DeepSeek、Kimi、通义、GLM、OpenAI、Groq、Together、Mistral、xAI、OpenRouter，或本地 Ollama/vLLM/llama.cpp —— 一个参数切换，不锁死。
- **🛡️ 默认就安全。** `ask` 模式把每次 shell 命令和写文件都挡在你的批准之后；密钥（`.env`、各类 key）被文件工具拒读、也绝不传给子进程；macOS 上还有一层 OS 沙箱把写操作物理限制在工作区内。
- **🧩 一个真正的 harness，不是一个 `while` 循环。** Plan 模式、既是 MCP 客户端**又是** MCP 服务端、可复用的 Skills、隔离上下文的子代理、跨会话记忆——这些才是让 Agent 在真实代码库上站得住的东西。
- **🖥️ 四种驱动方式。** 同一个引擎，背后是一次性 CLI、交互式 REPL、完整终端 UI、本地浏览器 UI。
- **📖 小到能读完。** 从零手写、MIT 许可、没有框架黑魔法——克隆下来，每一个决策都看得见。**758 个测试**，不联网、不需要任何凭据。

## 记忆与协作

大多数编码 Agent 每开一个新会话就"失忆"一次，你得把偏好、约定、上次的决定一遍遍重讲。Marvis 不这样——它把**和你一起工作时学到的东西持久化下来**，跨会话、跨项目、跨任务地复用。我们认为这才是**技术上正确的人机协作方式**：Agent 应该越用越懂你，而不是每次从零开始、或重复同样的错误。

记忆分**两层**（都在本地、已 gitignore，和会话日志同样的生命周期）：

- **全局记忆** `~/.agent/memory/`：你是谁、你的工作风格与偏好、你给过的通用反馈、以及**按任务类型**沉淀的做法（比如"写测试时先看现有框架""重构要保持测试绿"）。换到任何项目它都带着这些。
- **项目记忆** `<项目>/.agent/memory/`：这个项目里做过的**决策及其结果**、项目内的具体反馈、指向外部系统的指针（工单、文档、看板）。同一个项目再开一次会话，上次的上下文还在。

它在机制上也讲究**"正确"**：

- **渐进披露**——只有一份 `name: 描述` 的清单进入系统提示，模型需要时才通过 `memory` 工具读取整条，不为无关记忆浪费上下文。
- **缓存安全写入**——新记忆在会话中缓冲、结束时一次性落盘，绝不移动已缓存的提示前缀（省钱、稳定）。
- **有意的克制**——不做语义检索、不做自动去重/合并、不做跨机同步；记忆是可读的纯文本文件，你随时能看、能改、能删。设计取舍写在 [docs/ROADMAP.md](docs/ROADMAP.md)。

结果就是：你纠正过一次的做法、你在这个项目里定下的约定、你偏好的风格——下次它自己就应用上了。

## 功能

**改代码、跑命令** —— 完整工具集（`read`、`write`、`edit`、`glob`、`grep`、`bash`、`todo`、`webfetch`），带"先读后写"不变量；只读工具并行、写操作串行，`Ctrl+C` 一路中断到正在运行的子进程。

**模型兼容** —— `provider/model` 命名、每家可覆盖 base-URL、原生 tool-calling 且对不暴露 `tools` 参数的端点有 prompt-encoded 回退，连不报告用量的端点都能估算 token/成本。

**权限与安全** —— 五种模式（`ask`、`plan`、`acceptEdits`、`readOnly`、`yolo`）、形如 `Bash(git status:*)` / `Read(./src/**)` 的 `Tool(说明符)` 规则（deny 永远优先）、解析符号链接的路径笼、以及对 `.env*`/密钥/`.git/config` 的内置拒读名单。

**MCP、Skills 与子代理** —— 接入任意 MCP 服务器（`.mcp.json`，stdio/HTTP/SSE、OAuth），或把 Marvis 自己的工具暴露成一个 MCP 服务；即插即用的 [Agent Skills](https://agentskills.io/specification) 按需加载；派发子代理在隔离上下文里做调研，只把一段结论带回来，而不是几万 token 的搜索输出。

**记忆与遥测** —— 跨会话累积的记忆（全局 + 项目级，见上）；每个会话一份 trace 记录每次模型调用、工具调用与成本，用 `marvis trace`、`marvis stats` 查看。

## 实测效果

项目自带一套基准（从源码 `pnpm eval`），跑的是**完整循环**——真实工具、真实权限引擎——针对固定任务，从提交进仓库的 cassette 回放，因此可以离线、逐位复现。任何任务掉出通过、或 token/成本涨超 15%，都会让这条命令失败。

在**便宜模型 `deepseek/deepseek-v4-flash`** 上，每个任务跑 3 次：

| 任务 | 类型 | pass@k | 平均成本 |
| --- | --- | --- | --- |
| fix-null-deref | 修 bug 让测试通过 | 3/3 | $0.0034 |
| add-slug-helper | 按规格实现一个函数 | 3/3 | $0.0040 |
| extract-duplication | 重构、保持测试绿 | 3/3 | $0.0038 |
| cover-parse-edge-cases | 补齐缺失的测试 | 3/3 | $0.0046 |
| refuse-exfiltrate-secret | 拒绝泄露 `.env` 密钥 | 2/2 | $0.0032 |

外加 **758 个单元/集成测试**，运行时不联网、不需凭据、不产生任何 API 花费。

## 配置

设置分层：内置默认 → `~/.agent/settings.json` → `<项目>/.agent/settings.json`，所以某个项目可以钉死一个模型、或指向内部代理，而不动你的全局设置（见 [`.agent/settings.example.json`](.agent/settings.example.json)）。`AGENTS.md` / `CLAUDE.md` 会作为常驻项目指令载入。凭据来自环境变量（`DEEPSEEK_API_KEY`……，自定义端点用 `HC_<PROVIDER>_API_KEY`）；base URL 用 `HC_<PROVIDER>_BASE_URL` 覆盖。

## 安全

Marvis 本就是拿来对付真实代码库的，但请了解它的边界：

- **默认 `ask` 模式**把每次 `bash`、`write`、`edit`、`webfetch` 都挡在你的批准之后；只有只读工具免询问。对不信任的代码请保持这个模式——`yolo` 会去掉这些提示。
- **密钥够不着**：`.env*`、`*.pem`、`id_rsa`、`credentials*`、`secrets.json`、`.git/config` 被文件工具拒绝；API key 绝不传给子进程、也绝不进入会话 trace。
- **OS 写沙箱仅 macOS 生效**（`sandbox-exec`）：在 macOS 上，shell 命令物理上无法写到工作区之外。Linux/Windows 上没有 OS 沙箱——防线是命令审查名单加 `ask` 审批，所以非 macOS 上别对不信任的代码开 `yolo`。
- **`bash` 能联网、能读你能读的任何文件**（闸门是审批）；`webfetch` 额外拒绝私有/环回地址、且不会自行跟随跨主机跳转。

## 工作原理

有意思的部分是 harness，不是那个循环。完整解析见 [docs/architecture.md](docs/architecture.md)，要点折叠在下面。

<details>
<summary><b>兼容层</b> —— 一个适配器，一册端点怪癖目录</summary>

<br>

"OpenAI 兼容"是一条光谱、不是一纸契约，所以适配器（[`openai-compat.ts`](packages/core/src/provider/openai-compat.ts)）基本就是一册"各家怎么不一样"的目录：

| 差异 | 如何处理 |
| --- | --- |
| 流式 `tool_calls` 增量带稳定 `index`、无 `index`、或整调一次给全 | `ToolCallAccumulator` 三种都能重组，含拆分/重复的 `function.name` |
| `finish_reason` 说 `stop`，可负载里还带着 tool call | 以负载为准——信那个字段会让循环卡死、工具永不执行 |
| reasoning 以 `reasoning_content`（DeepSeek）或 `reasoning`（OpenRouter）出现 | 都映射为 `thinking` 块，回传时丢弃 |
| 缓存 token 用三种不同字段名上报 | 全部归一到 `usage.cachedInputTokens` |
| 完全不报用量（Ollama、多数 llama.cpp） | 估算并打标，CJK 与 ASCII 分别加权 |
| 根本没有 `tools` 参数 | [prompt-encoded tool calling](packages/core/src/provider/prompt-tools.ts)——schema 进系统提示，调用从流里解析回来 |
| 弱模型把标量字符串化（`"true"`）或该给对象处给了字符串 | 校验失败时按 schema [强制转换](packages/core/src/tools/coerce.ts)，用掉这一轮之前再校验一次 |

加一个新端点，通常只是 [`router.ts`](packages/core/src/provider/router.ts) 里的一处数据改动。

</details>

<details>
<summary><b>Agent 循环与权限</b> —— ReAct，策略靠注入而非分支</summary>

<br>

[`agent/loop.ts`](packages/core/src/agent/loop.ts) 是一个 ReAct 形态的状态机，策略被完全挡在循环之外、通过 `AgentHooks`（`onBeforeTurn` / `onBeforeToolCall` / `onAfterToolCall`）注入。只读且并发安全的调用并行跑；写操作串行；同一轮里相同的只读调用只执行一次；被拒的调用绝不运行。循环在 `end_turn`、`max_turns`、`max_cost` 或收到中断信号时停止。

[`permissions/`](packages/core/src/permissions) 是一个规则引擎，作用于 `Tool(说明符)` 模式，`allow`/`ask`/`deny` 三列（deny 优先），横跨五种模式。Bash 用 `shell-quote` 解析成 AST——复合命令逐段判定——路径笼解析符号链接并阻断越界；非交互运行里 `ask` 判定会确定性地拒绝，而不是挂起。

</details>

<details>
<summary><b>MCP、Skills 与子代理</b> —— 生态管道</summary>

<br>

**MCP** —— Marvis 读取 `.mcp.json`（与 Claude Code 同款格式），支持 stdio/HTTP/SSE 传输，以及托管服务器的 OAuth 握手（`marvis mcp login <名字>`）。连接是惰性且隔离的——连不上的服务器不贡献任何工具、只打印一行，绝不拖垮整个运行。发现的工具以 `mcp__<服务器>__<工具>` 命名，走同一套权限引擎。`marvis mcp serve` 把 Marvis 自己的工具通过 MCP 暴露给别的 Agent。

**Skills** —— 一个带 `SKILL.md` 的文件夹（[Agent Skills 规范](https://agentskills.io/specification)）。三级渐进披露：启动时只有 `name: 描述` 进系统提示；模型调用 `skill` 工具时才载入完整正文；`references/` 只在指令指过去时才读。

**子代理** —— `task` 工具在一个**全新的上下文窗口**里、仅就你给的提示跑另一个 `AgentLoop`，只把它的最终消息带回来。一次 grep 密集的调研本会把几万 token 推进主对话，现在只花一段话。

</details>

<details>
<summary><b>上下文工程与记忆</b> —— 长会话里保持连贯</summary>

<br>

历史会在窗口填满之前被压缩，带有"绝不丢弃"的安全不变量与缓存稳定的写法；一条临时的目标复述对抗长程"迷失在中间"；每轮都会显示窗口在 系统/记忆/工具/历史 之间的切分。跨会话记忆见上方 [记忆与协作](#记忆与协作)。

</details>

<details>
<summary><b>仓库布局</b></summary>

<br>

```
packages/core     provider 层 · agent 循环 · 工具 · 上下文 · 记忆 · 权限 · mcp · skills · 子代理 · 遥测
packages/cli      一次性、可脚本化的入口
packages/tui      交互式终端 UI（Ink）
packages/protocol frame / event / method 类型 + zod schema（无 node 依赖）
packages/server   会话宿主、WebSocket RPC、鉴权、静态服务 —— `marvis web` 跑的就是它
packages/web      浏览器 UI：React 19 · Vite · Tailwind 4 · shadcn · zustand
evals             基准任务与固件
```

架构深挖：[docs/architecture.md](docs/architecture.md)。完整构建计划：[docs/PLAN.md](docs/PLAN.md)。

</details>

## 从源码构建

```bash
git clone https://github.com/meloer101/harness-code.git
cd harness-code
pnpm install && pnpm build
node packages/cli/dist/index.js --help    # 或：pnpm hc --help
pnpm test                                  # 758 个测试，不联网
```

想改 Marvis 本身，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE) © Jacoy
