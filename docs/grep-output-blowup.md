# 事故记录 — `grep` 单次调用撑爆上下文窗口

> 一次工具输出把上下文推到窗口的 6 倍，主 Agent 和子 Agent 都在下一轮预检时
> 直接 `context_limit` 停掉。
>
> **状态：已修复（2026-09-08）** —— commit [`e20cc6d`](../packages/core/src/tools/grep.ts)
> （grep/read 输出封边界）+ [`68ef450`](../packages/core/src/provider/capabilities.ts)
> （DeepSeek V4 窗口修正，独立问题，见文末）。`pnpm build && pnpm test && pnpm typecheck` 全绿（367 单测，+4）。

## 现象

Phase 7 子 Agent 手测时，让 `explore` 子 Agent 回答"权限引擎在哪些文件、被谁构造"。
子 Agent 在 **turn 1** 就 `context_limit` 停了，看起来像子 Agent 机制坏了。实际是它跑了一个
无范围的 `grep "[Pp]ermission"`：

```
context 765.7k/119.8k (639%)  ·  hist 747.2k
stopped: context window nearly full
```

一次 grep 调用产生约 **80 万 token** 的工具结果。主 Agent 直接搜同样的东西也一样炸。

## 根因（三个因素叠加）

### 1. 实际走的是 JS fallback，而它的忽略列表只有两项

[`grep.ts`](../packages/core/src/tools/grep.ts) 优先 `spawn('rg', …)`，`ENOENT` 时回退到
`grepWithJs`。本机（以及任何没有装真正 ripgrep 二进制的机器）上 `rg` 只是一个 shell 函数
（Claude Code 的包装器），`spawn` 用 `execvp` 找不到它 → **永远走 JS fallback**。

而 fallback 当时的忽略列表是：

```js
ignore: ['**/node_modules/**', '**/.git/**']
```

它**不读 `.gitignore`**，所以会搜项目已经忽略掉的一切：`.agent/sessions/`、`.agent/traces/`、
`dist/`、`coverage/`、`pnpm-lock.yaml`、`*.tsbuildinfo` …… 真正的 `rg` 默认尊重 `.gitignore`，
回退路径和它行为不一致。

### 2. 没有单行长度上限

每个匹配拼成 `${file}:${行号}:${整行内容}`，整行原样返回。`truncateList`
（[`truncate.ts`](../packages/core/src/context/truncate.ts)）只限制**匹配条数**
（`MAX_MATCHES = 200`），从不限制**单行长度**，也没有总字节上限。

### 3. `.agent/sessions/*.jsonl` 里有几百万字符的单行

这些是 Agent 自己的会话记录，JSONL 格式（一行一个 JSON 对象）。**压缩快照**事件
（`recordCompaction`，见 [`session.ts`](../packages/core/src/agent/session.ts)）会把整个压缩后的
消息列表序列化到**一行**。本仓库实测最大的 session 文件有一条 **3,204,844 字符**的单行。

三者相乘：fallback 扫进 `.agent/sessions/` → 命中那条 320 万字符的行 → 整行原样进结果 →
≈ 80 万 token 一次性灌进上下文。

### 附带：`read` 工具同类隐患

[`read.ts`](../packages/core/src/tools/read.ts) 纯按 `\n` 切行、逐行渲染，同样没有单行上限。
读一个多 MB 单行的文件（minified bundle、JSONL 日志）会把整行吐出来。

## 修复（commit `e20cc6d`）

### grep

| 措施 | 位置 |
| --- | --- |
| 每行匹配截断到 500 字符，尾部标 `… +N chars` | `clampLine`，rg / JS 两条路径都用 |
| 整体结果封顶 100k 字符（`truncateHeadTail` 头尾保留），独立于 200 行上限 | `capTotal` |
| JS fallback 换上真正的默认忽略列表：`.agent`、`dist`、`build`、`coverage`、`.next`、`.cache`、`*.min.js/css`、`*.map`、`*.tsbuildinfo` | `DEFAULT_IGNORE` |
| JS fallback best-effort 读 `.gitignore`：从搜索目录向上找第一个 `.gitignore`，把常见形式的行转成 glob（不支持 `!` 取反和更细的语义） | `gitignoreGlobs` / `gitignoreLineToGlobs` |
| rg 路径加对应 `--glob '!…'` 排除（rg 本就读 `.gitignore`，这是双保险） | `grepWithRipgrep` |
| JS fallback 增加运行时总字符预算，够了就停并标记 `totalIsFloor` | `grepWithJs` 的 `totalChars` |

### read

每行渲染前 `clampLine` 到 2000 字符（比 grep 宽松，因为 read 是"我确实要看这个文件"的
主动行为），尾部标 `… +N chars on this line`。

### 效果

原来会炸的那次无范围 `grep permission`（不区分大小写）：

| | 之前 | 之后 |
| --- | --- | --- |
| 结果大小 | ≈ 80 万 token | 24,852 字符（≈ 7k token） |
| 是否扫 `.agent/sessions` | 是 | 否 |

## 测试（`grep.test.ts` / `read.test.ts`，+4）

- grep：3,000,000 字符单行的匹配被截断，结果 < 2k 字符
- grep：不下探 `.agent/` 和 `dist/`
- grep：尊重搜索树里的 `.gitignore`（`generated/`、`*.bundle.js`）
- read：500,000 字符单行被截断，短行仍完整返回

## 已知未覆盖 / 后续

- `.gitignore` 解析是启发式的：不处理 `!` 取反、`[]` 字符类、`**` 之外的锚定细节。
  真要完整语义得引 `ignore` 这个包（一个新依赖），当前收益不值。
- rg 路径的 `--max-count 50` 仍是 per-file 的；总字节上限现在兜住了这一层。
- 没有装真 ripgrep 的机器一直走 JS fallback —— 性能不如 rg，但正确性现在一致了。

## 附：一个在排查中发现的独立问题（commit `68ef450`）

排查时注意到上下文窗口显示 `119.8k` 太小。查证：[能力表](../packages/core/src/provider/capabilities.ts)
里 `deepseek-v4-pro` / `deepseek-v4-flash` 还写着 V3 时代的 `contextWindow: 128_000` /
`maxOutputTokens: 64_000`，而 DeepSeek V4 官方是 **1M 上下文 / 384k 输出**；内置默认模型
[`settings.ts`](../packages/core/src/config/settings.ts) 还是已退役的 `deepseek/deepseek-chat`。

一并修了：能力表两处数字、默认模型改 `deepseek-v4-flash`，并把 loop 里"输出预留"和
"输出上限"解耦（窗口预留取 `min(maxOutputTokens, 64k)`，否则 384k 预留会吃掉 1M 窗口的一大半）。

注意：**这个修正不能替代上面的 grep 修复** —— 320 万字符 ≈ 80 万 token 仍然会撑爆哪怕
是修正后 936k 的可用窗口。两件事都得做。
