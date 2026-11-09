# pi-chameleon

Pi 扩展：使用你自己的中转 API key，将 Pi 的真实对话适配为 **Claude Code** 或 **Codex CLI** 请求格式。

**配置完全使用 Pi 原生的 `settings.json`、`models.json` 和凭据机制**

| Provider | 线格式 | 默认认证 | 已适配 CLI |
|---|---|---|---|
| `chameleon-claude` | Anthropic Messages | `x-api-key` | Claude Code UA `2.1.274`（组合兼容策略） |
| `chameleon-codex` | OpenAI Responses | `Authorization: Bearer` | Codex CLI `0.166.0` |

中转站要求两者都使用 Bearer 时，可以使用 Pi 原生的 `authHeader: true`，见下方示例。

## 快速开始

### 1. 加载扩展

已验证宿主为 Pi **1.5.0**；对应 Node.js 要求为 **22.19.0 或更高版本**。API 模型发现已通过真实 Pi 1.5.0 的离线集成验收；真实中转站兼容性和未测试平台不在此结论内，详见“开发与验证”。在本项目目录中执行：

```bash
npm ci
pi -e .
```

`-e .` 只为这次启动加载扩展。长期使用可以执行：

```bash
pi install /absolute/path/to/pi-chameleon
```

或者把本项目的绝对路径加入 Pi 的 `settings.json`：

```json
{
  "packages": ["path/to/pi-chameleon"],
  "defaultProvider": "chameleon-codex",
  "defaultModel": "gpt-5.3-codex",
  "defaultThinkingLevel": "medium"
}
```

Windows 路径在 JSON 中可直接使用 `/`；macOS/Linux 改为自己的绝对路径。请将示例字段**合并**到已有配置，不要覆盖其他 packages 或设置。完整示例：[examples/settings.json](examples/settings.json)。

### 2. 在 Pi 的 models.json 中配置中转站

默认配置位置：

| 文件 | macOS / Linux | Windows |
|---|---|---|
| 扩展与默认模型 | `~/.pi/agent/settings.json` | `$HOME\.pi\agent\settings.json` |
| 中转地址、key、模型覆盖 | `~/.pi/agent/models.json` | `$HOME\.pi\agent\models.json` |

如果使用 Pi 原生的 `PI_CODING_AGENT_DIR`，这些文件位于该目录下，而不是本项目目录。`examples/` 中的文件只是模板，插件不会自动加载它们。

**同一中转站支持 Claude 和 Codex、共用同一个 key：**

```json
{
  "providers": {
    "chameleon-claude": {
      "baseUrl": "https://relay.example.com",
      "apiKey": "replace-with-your-relay-api-key"
    },
    "chameleon-codex": {
      "baseUrl": "https://relay.example.com/v1",
      "apiKey": "replace-with-your-relay-api-key"
    }
  }
}
```

将两处 `apiKey` 替换为同一个真实 key，将域名换成你的中转站。完整示例：[examples/models.json](examples/models.json)。

两个 provider 独立配置，这是 Pi 原生语义；**没有**额外的共享 key、继承或自动回退字段。不预设模型成员，自动成员仅来自完整发现结果或经身份核验的成功快照。最小配置仍无需重复填写 `api` 或 `models`；显式添加模型的退路见下方示例。

### 3. 选择模型

保存配置后重新启动 Pi；启动和 `/reload` 都发起后台更新，优先显示适用且未停用的缓存或用户显式模型，`/reload` 不是网络发现完成屏障。首次无适用缓存、也无用户显式模型时，目录可能暂时为空，并提示加载或失败；发现完成后由用户通过 `/model` 选择，不自动换模型。

以下 ID 仅为选模语法示例，必须由你的中转站公布或通过原生 `models` 显式添加。默认模型既未发现也未显式添加时，按提示刷新或添加；扩展不自动改写 `settings.json`、`models.json` 或 `auth.json`，也不偷偷替换默认选择：

```text
/model chameleon-claude/claude-opus-4-6
/model chameleon-codex/gpt-5.3-codex
```

也可以从项目目录查看当前候选目录（命令输出不承诺等待后台发现完成）：

```bash
pi -e . --list-models chameleon
```

模型出现只表示它进入了候选目录或用户显式配置，**不代表真实中转站已接受该指纹或模型可用**。

## 配置示例

### A. 两种协议都使用 Bearer 认证

如果中转站要求 Claude 和 Codex 都发送 `Authorization: Bearer <key>`，为两个 provider 设置 Pi 原有的 `authHeader: true`：

```json
{
  "providers": {
    "chameleon-claude": {
      "baseUrl": "https://relay.example.com",
      "apiKey": "replace-with-your-relay-api-key",
      "authHeader": true
    },
    "chameleon-codex": {
      "baseUrl": "https://relay.example.com/v1",
      "apiKey": "replace-with-your-relay-api-key",
      "authHeader": true
    }
  }
}
```

完整示例：[examples/models-bearer.json](examples/models-bearer.json)。扩展保留 Pi 根据当前 key 生成的 Bearer 认证，Claude 不会再同时发送 `x-api-key`。

`apiKey` 表示凭据，`authHeader` 控制 Pi 是否显式生成 Bearer 头；不要填写自定义的 `authKey` 字段。Codex 自身默认就使用 Bearer，不设置 `authHeader` 也不会变成 `x-api-key` 认证。

### B. Claude 和 Codex 使用不同中转站或 key

两个条目的 `baseUrl`、`apiKey` 分别填写即可，不影响彼此。示例同时展示模型输出上限覆盖：

```json
{
  "providers": {
    "chameleon-claude": {
      "baseUrl": "https://claude-relay.example.com",
      "apiKey": "replace-with-your-claude-api-key",
      "modelOverrides": {
        "claude-opus-4-6": { "maxTokens": 8192 }
      }
    },
    "chameleon-codex": {
      "baseUrl": "https://codex-relay.example.com/v1",
      "apiKey": "replace-with-your-codex-api-key",
      "modelOverrides": {
        "gpt-5.3-codex": {
          "maxTokens": 8192,
          "samplingParams": { "max_output_tokens": 8192 }
        }
      }
    }
  }
}
```

完整示例：[examples/models-separate.json](examples/models-separate.json)。仅使用一种协议时，只保留对应 provider 条目；另一种没有其他已存凭据时不会列为可用模型。

`modelOverrides` 修改既有模型，不替换整个目录。Codex 默认省略 SDK 推导出的 `max_output_tokens`；需要明确发送输出上限时，像上例一样使用 Pi 原生的 `samplingParams.max_output_tokens`。

### C. 添加私有别名或没有列表 API 的模型

未知家族、私有别名、未适配命名空间，或没有标准列表 API 的中转站，都可通过 Pi 原生 `models` 显式添加，不要求先发现。以下是可复制的完整配置，与 [examples/models-custom.json](examples/models-custom.json) 一致；将字段合并到已有配置，不要覆盖其他 provider。

**仅为合成样例**：`private-codex-alias`、地址、key、协议、推理、输入、窗口、输出上限和费用都必须按你获授权服务的实际模型填写。这里的费率数字不是报价，也不是能力证明；`cost` 各项以每百万 token 为单位。

```json title="models-custom.json"
{
  "providers": {
    "chameleon-codex": {
      "baseUrl": "https://relay.example.com/v1",
      "apiKey": "replace-with-your-relay-api-key",
      "models": [
        {
          "id": "private-codex-alias",
          "name": "Private alias (synthetic example)",
          "api": "openai-responses",
          "reasoning": false,
          "input": ["text"],
          "contextWindow": 32768,
          "maxTokens": 4096,
          "cost": {
            "input": 1,
            "output": 2,
            "cacheRead": 0.1,
            "cacheWrite": 1.25
          }
        }
      ]
    }
  }
}
```

同名 `models` 条目按 Pi 原生语义替换模型；只调整已有模型的字段，优先使用 `modelOverrides`。Claude 模型使用 `anthropic-messages`，Codex 模型使用 `openai-responses`；改成其他协议不属于本扩展的伪装范围。不新增共享凭据或发现专属认证配置；原生显式模型不会因列表获取失败而被删除。

### baseUrl 如何填写

扩展不再补 `/v1`，不猜测中转站地址；路径拼接遵循对应 Pi 原生协议：

| Provider | `baseUrl` 示例 | 最终请求 |
|---|---|---|
| Claude | `https://relay.example.com` | `/v1/messages`（query 由原生 SDK / 配置决定） |
| Codex | `https://relay.example.com/v1` | `/v1/responses` |
| Codex，自定义网关前缀 | `https://relay.example.com/gateway/openai` | `/gateway/openai/responses` |

不要将完整的 `/v1/messages` 或 `/v1/responses` 请求地址当成 `baseUrl`。例如 Codex 配置根地址时会请求 `/responses`，**不会自动改成 `/v1/responses`**。

### 凭据与覆盖顺序

- `apiKey` 可以直接填字符串；也可以使用 Pi 原生支持的 `$NAME` / `${NAME}` 或 `!command`。这些由 Pi 解析，扩展没有额外的环境变量约定或 `.env` 加载器。
- `auth.json` 中已保存的凭据可能优先于 `models.json.apiKey`，运行时 key 也可覆盖它；遵循 Pi 自身的凭据优先级。修改 key 后未生效时，先检查是否存在旧凭据。
- 普通 `headers` 由 Pi 解析后透传。CLI 指纹头和凭据安全规则仍由扩展强制执行；其他身份令牌、cookie、代理认证等不会随请求混发。
- 扩展只注册行为与模型目录。没有 key 时由 Pi 判断不可用；有 key 但缺少 `baseUrl` 时请求会明确报错，不会落到猜测的官方上游。
- 不要提交含真实 key 的 `models.json`，也不要将 key 写在 URL、日志或截图中。示例文件只包含占位值。

## 模型发现

没有内置固定模型名单。每个供应商只从当前配置的中转站获取模型目录，复用 Pi 解析的供应商级鉴权与 headers，不借用某个模型的专属认证头，也不发送聊天内容、会话标识或 CLI 伪装字段。

| Provider | 固定列表路径 | 带前缀的完整地址示例 |
|---|---|---|
| `chameleon-claude` | `baseUrl` + `/v1/models` | `https://relay.example.com/gateway/v1/models`（base 为 `/gateway`） |
| `chameleon-codex` | `baseUrl` + `/models` | `https://relay.example.com/v1/models`（base 为 `/v1`） |
| `chameleon-codex`，网关前缀 | `baseUrl` + `/models` | `https://relay.example.com/gateway/openai/models` |

保留配置中的路径前缀；不自动探测备用端点、不猜版本、不回退官方上游。聊天地址仍按上方“baseUrl 如何填写”的规则拼接。列表必须符合标准 `data` 数组；Claude 完成全部游标分页后才发布，Codex 不套用未声明的分页规则。结构错误、分页异常或冲突 ID 都使整次获取失败，不发布部分目录。

家族前缀只是候选筛选的**启发式**，不是协议兼容或真实聊天验证：Claude 回退范围为 `claude-*`；Codex 为 `gpt-*`、`chatgpt-*`、`codex-*` 和 `o<数字>` 系列。分类可忽略大小写，但保留原始 ID 的拼写、大小写、别名和命名空间，不改成推测的官方名称。排除明确的图像生成、音频、实时、嵌入等非聊天用途，不排除支持图像输入的聊天模型。第一版没有已适配的私有协议扩展，不猜 `api`、`type` 等字段的含义；未知家族、私有别名或未适配命名空间请用原生 `models` 显式添加。

## 目录刷新与缓存

目录刷新与恢复遵循以下规则。手动刷新可直接复制下列任一命令：

```text
/chameleon-models-refresh
/chameleon-models-refresh claude
/chameleon-models-refresh codex
```

- 启动和 `/reload` 后台更新；打开 `/model` 时，距上次成功更新**超过一小时**才进行新鲜度获取。一小时是刷新门槛，不是缓存有效期；不在每次聊天前获取目录，失败后不循环自动重试。
- 手动使用 `/chameleon-models-refresh [claude|codex]`：不带参数刷新两个已配置供应商；`claude` 或 `codex` 只刷新对应一种。跳过一小时门槛，分别报告结果，不自动切模型。
- 每个供应商一次完整获取只有 **15 秒总网络预算**，覆盖所有分页，不为每页重置；两个供应商独立。同供应商普通并发刷新合并，强制刷新或配置变化取消旧任务，迟到结果不得覆盖新状态。预算不承诺强杀 Pi 凭据解析命令或已开始的 OAuth 保存。
- 每个供应商仅保留**单份最近完整成功快照**，不累积历史名单。完整成功整体替换，合法空目录或筛选后无候选也替换并提示“未发现候选模型”；获取失败保留成功快照。同身份且未停用的快照**不设年龄硬过期**，临时网络错误、超时、429 或服务端错误可使用它并显示成功时间；没有退路时只保留用户显式模型，不造默认名单。
- 地址、有效凭据或影响访问权限的供应商级认证配置变化后不复用旧目录；身份未确认或不匹配时不恢复旧自动候选，两个供应商独立隔离。列表 **401/403** 暂停旧自动候选及缓存退路，停用状态**跨重启**，直到成功刷新才解除；可以保留最近成功快照，但不能靠重启重新公开它。
- 缓存读取失败或损坏按无缓存处理，不删除用户显式模型或其他供应商数据。API 获取成功但写入失败时更新本会话目录与成功时间，提示“**新目录未保存**”；不能宣称已落盘，也不能损坏磁盘旧快照。重启只恢复实际保存且通过身份与停用校验的数据。
- 成功快照不等于当前公开的自动候选目录。当前模型被移除或目录停用时，提示并移除后续自动候选，但保留当前会话选择，不自动换模型、不打断已发起请求；继续尝试不保证成功，也不允许保留旧凭据绕过新身份边界。同 ID 能力变化在会话空闲时重绑，不中途改变已发起请求的预算。

缓存只保存安全 ID、必要元数据、成功时间、非秘密身份校验信息和停用标记，不保存真实 key、敏感 headers、原始响应或聊天内容。身份隔离、权限停用屏障、原子替换、Windows ACL 与跨进程迟到提交保护已有合成回归验证；不安全的文件链接、junction 或访问权限会使缓存校验失败。掉电持久性、POSIX 平台及所有介质均不可写的环境未验证；无法保存验证屏障时不发起新的目录检查，不承诺这些环境具有无条件的跨重启停用保证。

## 能力与费用

模型能力资料逐字段补全：**用户显式配置 → 已适配且有效的 API 元数据 → Pi 本地目录精确原始 ID 与当前协议匹配的参考资料 → 未知默认值**。有效 `false` 与零值不能被低优先级资料覆盖；本地目录只补能力，不决定中转站成员，不模糊匹配别名，也不带入官方地址、凭据或路由身份。

- 未知上下文暂用 **32,768（32768）token**，未知最大输出暂用 **4,096（4096）token**；缺失输出的临时预算不超过已知窗口。这些是客户端预算，不是服务端能力证明或成功保证。
- 未知输入默认 `input: ["text"]`，未知推理默认 `reasoning: false`，关闭自动 thinking；这不等于服务端明确不支持，也不承诺拦截直接 SDK 显式传入的 thinking。不要依据家族名称宣称图像或推理能力；不是所有 Claude 都用 adaptive，也不是所有 Codex 都使用同一 effort 映射。
- 资料不全的候选仍可选，名称与选模提示标注“能力未确认”，可用原生 `modelOverrides` 补正，模型 ID 不变。
- 用户或已适配服务的有效价格按字段优先级生效。本地官方价格仅作**参考费用**，不是中转站实际账单；完全未知费率用 **0 占位**满足 Pi 数值字段，标注“费用未知”，与有效零价格区分。
- 第一版不修改 Pi 原生费用栏；原生统计可能显示零估算，**不代表免费**。请依据中转站实际账单判断支出，而不是候选目录、参考估算或未知占位。

## Claude 兼容诊断

```text
/chameleon-diagnostics on
/chameleon-diagnostics status
/chameleon-diagnostics off
```

- 默认关闭，显式开启只在当前会话/运行实例生效；关闭、切换会话或 `/reload` 会清空进行中与最近完成摘要，晚到结果不会恢复旧记录。
- 最多保留 8 个进行中摘要和最近 1 个完成摘要。并发请求独立编号；容量不足或归属不明确时显示 `incomplete`，不混合数据。
- 摘要只含固定规则/版本、阶段、工具与块数量、缓存状态、身份一致性、HTTP 状态及安全结果类别；不保存提示、参数/结果、schema、任意 headers、URL、凭据、自定义模型名或线上身份。诊断编号独立生成，不是 session/device 的哈希。
- `adapted` 仅表示 hook 入口已看到适配；`final-observed` 是安全规范化后的出站边界。只有收到响应才确认 `dispatched` / `http`；HTTP 200 不等于流成功，错误码不自动归因于 UA/Beta 或触发降级重试。
- 无落盘、导出、上传或遥测。诊断失败不阻断本来合法的请求；诊断关闭也不会绕过协议/安全校验。摘要仍可能有数量/时序关联信息，**不承诺匿名或可无条件公开**。

## Claude 伪装

- 仅强制 `claude-cli/2.1.274 (external, cli)`、`x-app: cli` 和动态 session header。不硬编码 Windows/Node/Stainless/SDK 版本、不额外生成 trace ID，也不额外添加 `beta=true`。原生 SDK 的协议字段仍正常保留。
- Beta 由 Pi 按有效模型能力与请求选项生成，保持原生顺序，最后只补缺 `context-1m-2025-08-07`；不再固定 11 项，也不把 Beta 当作能力或中转可用性证明。原始 header、大小写/null 变体及 payload hook 不能覆盖这套生成规则。
- `metadata.user_id.session_id` 与 `x-claude-code-session-id` 在 hook 后及最终出站保持一致；device 是运行实例内稳定的随机 64 位 hex，account_uuid 保持空字符串。其他合法 metadata 保留，无法安全处理的结构在发送前失败。
- 显式 UUID 原样保留，其他显式 session 输入按既有确定性规则转成 UUID。没有 session 的独立 Claude 请求各用一个临时 UUID；需要多轮连续性时由调用方提供稳定 session。不会读取机器名/用户名或保存身份文件，也不承诺标识匿名化。
- 顶层 system 保留两块身份/core 封装，完整 Pi 初始指令仍放在第一条 system 消息；后续更新保持角色、文本、空白、顺序和时机。不添加 billing、合成 assistant 确认或虚构 token 余额，仅精确迁移已知 SDK/项目包装。
- 工具采用当前真实集合，出站映射、回程还原，不添加诱饵或执行替代。不同真实名称映射到相同大小写无关 wire 名时发送前报错；schema、参数和嵌套结果保持普通数据。保留非 strict/eager/deferred 序列化边界；要求 strict 的工具明确报不支持，不降低约束。
- 缓存开关与时长遵循 Pi 原生 `cacheRetention` 及环境/能力协商：`none` 无协议标记；默认/short 使用 ephemeral；long 在能力允许时保留 `ttl: "1h"`，显式不支持 long 时沿用原生短缓存结果。工具缓存能力禁用时不标记工具。
- 启用缓存后，在最终布局选择两块顶层 system、最后真实工具、最后 user 的末个合法块，最多四处，不补虚构内容。hook 前后使用同一有效设置，执行一次；不能以缓存修复为由改变指令/历史/工具权限，危险替换发送前失败，schema/参数/嵌套结果中的同名键不递归改写。
- 模型 ID 保留原始后缀、大小写和别名；显示名称不改变 ID，不剥离 `[1m]` / `[1M]`，错误不触发换 ID、UA、Beta 或预算重试。
- Thinking、effort、预算、display、block_binding、context_management 和历史转换交给当前 Pi 原生 raw/simple 入口。取消请求入口的精确 ID adaptive 补缺，已有目录/模型/显式能力声明不丢失；缺少 adaptive 资料的显式模型按原生 budget 分支处理。使用原生 `models` / `modelOverrides` 声明中转别名的实际能力。
- 不伪造签名、历史、记忆、环境、技能清单或 Claude 专属工具；正常 SSE、usage、取消和错误语义保持，包装层异常会终止 result 而非悬挂。

这是经批准的组合策略：保留原 System/真实工具布局，采用参考最小 headers、native + 1M Beta 与原生 thinking 委托。**不宣称完整复刻任一 Claude Code 版本或已经认证所有中转。**

协议转换、SSE、usage 和取消继续委托 Pi 原生 `anthropic-messages`。离线回归包含连续三轮真实历史传递，以及执行本地 `read` 后回传原始文件内容的工具链路。

以下是旧策略下已授权的历史验证记录，不是本轮组合策略的真实中转认证：

| 驱动方式与任务 | 实际结果 |
|---|---|
| Pi SDK 同会话三轮对话 | 第一轮 200 并回答 `1+1 = 2`；第二轮 HTTP 200 但流中返回 `Cyber safeguards flagged this message`，停止，第三轮未发送 |
| Pi SDK 读取并分析 `src/relay-transport.ts` | 两次 HTTP 200，实际读取和工具结果回传成功；210 秒测试总时限到达后主动取消，未收到最终分析 |
| 真正 Pi CLI 以 `-e` 加载本项目插件执行文件分析 | 首轮返回 429 `Service Unavailable`，未触发 `Read`；只发起一次任务，无自动重试 |

210 秒只是当次 SDK 测试的总时限，不是插件默认超时。HTTP 200 或 CLI 退出码 0 都不等于模型任务完成，应同时检查消息的 `stopReason`、工具结果和最终文本。以上结果不能证明完整上游兼容，不会通过换 key、改安全提示或重复请求绕过拦截。

## Codex 伪装

- 固定官方 `rust-v0.166.0` 请求格式：`originator: codex_cli_rs`、`version: 0.166.0`、同一会话的 `session-id` / `thread-id` / `x-client-request-id`。
- UA 按官方格式组合真实本机 OS、架构和可检测到的终端信息，缺失终端信息用 `unknown`。移除 TS SDK 的 `x-stainless-*` 及 Claude/OAuth 痕迹头。
- `store:false`，保留 `reasoning.encrypted_content` 以支持多轮；默认自动工具选择和并行工具调用，保留调用方显式设置。
- 新版基础指令放在 developer input；旧顶层 `instructions` 会被迁移而不丢失。仅使用公开身份句，其余为 Pi 真实运行指令，不搬运完整 CLI 环境或工具清单。
- 移除不属于固定 CLI 请求格式的 `temperature` 和 prompt-cache 扩展字段；显式输出上限保留，SDK 推导的默认上限不发送。
- 工具名不改写，历史 tool call ID、reasoning 签名、SSE、usage 和取消由 Pi 原生 `openai-responses` 处理；不走 ChatGPT OAuth backend。

## 常见问题

| 现象 | 检查项 |
|---|---|
| `/model` 找不到 chameleon 模型 | 扩展是否加载；`models.json` 是否放在当前 Pi agent 目录；provider 名与 key 是否正确 |
| `configure ... baseUrl in Pi models.json` | 对应 provider 缺少 `baseUrl`；扩展不会猜测端点 |
| 404 或 endpoint 错误 | 检查 Claude 根地址、Codex `/v1` 及网关前缀；不要填完整请求路径 |
| Claude 返回 401，但同一 key 的 Codex 正常 | 中转站可能只接受 Bearer；尝试该站要求的原生 `authHeader: true` |
| 改 key 后仍使用旧 key | 检查 Pi 已保存的 `auth.json` 凭据和运行时 key，再 `/reload` / `/model` |
| 设置了 `CHAMELEON_*` 但没有生效 | 自定义环境变量配置已移除；按本文迁移到 Pi 原生 `models.json` |
| 返回 429 或指纹校验失败 | 可能是模型配额、限流或中转站私有规则；模型注册成功不等于服务端兼容 |

## 开发与验证

```bash
npm ci
npm test
npm run check
```

离线测试使用真实 Pi **1.5.0** 的公开接口、合成 key 与临时配置；模型发现用受控 GET、时间和存储故障验证，文档契约测试校验可复制 JSON 与原生字段。既有扩展加载、原生配置/覆盖、凭据优先级、双协议认证、SSE 和多轮工具回归仍需保留，不因只改文档而跳过检查。

此前模型发现改造通过真实 Pi 1.5.0 的离线集成验收：类型检查、149 项测试、完整提交差异检查，以及 Standards／Spec 双轴审查后的回归均已验证。测试覆盖真实 reload、空目录显式模型的 CLI 路由、并发与跨进程提交、Windows ACL、权限停用和会话空闲更新。测试命令串行运行测试文件，避免本机 ACL 子进程争用；不会放宽目录获取的 15 秒总网络预算。并行运行时曾出现跨进程测试的 20 秒超时，串行完整套件连续两次通过，仍不宣称在任意资源负载下均已验证稳定性。

本轮 Claude 组合策略的实现与最终验收记录见 [兼容策略验收](.scratch/claude-compatibility-policy/implementation/acceptance.md)，与上述历史模型发现验收区分。验证采用真实 native delegate、最终 fetch、受控 SSE 与真实扩展会话；未进行新策略的真实中转认证。

未调用真实中转站验证模型发现；离线通过不证明中转站接受 CLI 指纹或模型真实可用。POSIX、掉电和所有持久介质不可写等物理故障未验证；上方 Claude 章节保留的历史聊天结果不是本次目录 API 验收。


## 风险提示

仅用于你已获授权的中转服务，并遵守其条款。拒绝跨 origin、重定向、非 HTTP(S) 地址和 URL 内联凭据；不会伪造账号、订阅或 attestation 信息。离线测试不证明中转站接受某个 CLI 指纹，版本变化可能要求同步更新适配。
