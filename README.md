# pi-chameleon

Pi 扩展：使用你自己的中转 API key，将 Pi 的真实对话适配为 **Claude Code** 或 **Codex CLI** 请求格式。

**配置完全使用 Pi 原生的 `settings.json`、`models.json` 和凭据机制**

| Provider | 线格式 | 默认认证 | 已适配 CLI |
|---|---|---|---|
| `chameleon-claude` | Anthropic Messages | `x-api-key` | Claude Code `2.1.302` |
| `chameleon-codex` | OpenAI Responses | `Authorization: Bearer` | Codex CLI `0.166.0` |

中转站要求两者都使用 Bearer 时，可以使用 Pi 原生的 `authHeader: true`，见下方示例。

## 快速开始

### 1. 加载扩展

目标宿主为 Pi **1.5.0**；对应 Node.js 要求为 **22.19.0 或更高版本**。本文描述 API 模型发现的目标行为，**不代表迁移已完成验收**；真实 Pi 集成、安全加固与真实服务验证的边界见“开发与验证”。在本项目目录中执行：

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
| Claude | `https://relay.example.com` | `/v1/messages?beta=true` |
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

以下是目标刷新与恢复契约，不是当前版本已通过全部安全验收的保证。手动刷新可直接复制下列任一命令：

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

缓存只应保存安全 ID、必要元数据、成功时间、非秘密身份校验信息和停用标记，不保存真实 key、敏感 headers、原始响应或聊天内容。身份隔离、权限停用持久性、写入原子性、Windows ACL 与跨进程故障等安全环境边界仍需最终验收；不能因宿主提供缓存接口就视为已加固完成。

## 能力与费用

模型能力资料逐字段补全：**用户显式配置 → 已适配且有效的 API 元数据 → Pi 本地目录精确原始 ID 与当前协议匹配的参考资料 → 未知默认值**。有效 `false` 与零值不能被低优先级资料覆盖；本地目录只补能力，不决定中转站成员，不模糊匹配别名，也不带入官方地址、凭据或路由身份。

- 未知上下文暂用 **32,768（32768）token**，未知最大输出暂用 **4,096（4096）token**；缺失输出的临时预算不超过已知窗口。这些是客户端预算，不是服务端能力证明或成功保证。
- 未知输入默认 `input: ["text"]`，未知推理默认 `reasoning: false`，关闭自动 thinking；这不等于服务端明确不支持，也不承诺拦截直接 SDK 显式传入的 thinking。不要依据家族名称宣称图像或推理能力；不是所有 Claude 都用 adaptive，也不是所有 Codex 都使用同一 effort 映射。
- 资料不全的候选仍可选，名称与选模提示标注“能力未确认”，可用原生 `modelOverrides` 补正，模型 ID 不变。
- 用户或已适配服务的有效价格按字段优先级生效。本地官方价格仅作**参考费用**，不是中转站实际账单；完全未知费率用 **0 占位**满足 Pi 数值字段，标注“费用未知”，与有效零价格区分。
- 第一版不修改 Pi 原生费用栏；原生统计可能显示零估算，**不代表免费**。请依据中转站实际账单判断支出，而不是候选目录、参考估算或未知占位。

## Claude 伪装

- 指纹固定为 `claude-cli/2.1.302 (external, cli)`，不追加 Pi UA；发送用户抓包顺序的 11 项 beta。
- Stainless header 指纹固定为 Windows/x64/node v26.3.0、package 0.128.0、retry count 0、timeout 60000；这是 header 指纹，不代表真实运行环境。实际请求超时由 Pi 的 `timeoutMs` 决定，默认 600 秒。
- `metadata.user_id.session_id` 与 `x-claude-code-session-id` 一致；device ID 为进程级随机值，trace ID 每次请求重新生成，不复用抓包标识。
- 顶层 system 固定两块：Claude Code 身份，以及通用 core + 空的 `# Runtime instructions` 前缀；与用户提供的真实 Aether 出站样本逐字对拍，不添加 billing、合成 assistant 确认或虚构 token 余额。
- 完整 Pi 运行指令放在 `messages[0].role=system`，保留实际工具说明、权限、项目规则、环境与原始空白；原有 user/assistant 历史随后接上，不把 system 降级为 user。只对本项目精确识别的旧模板做迁移。
- 工具仍放在顶层 `tools`。原生序列化禁用 eager/strict/deferred 工具扩展，不再注入 `__pi_deferred_placeholder__`；可选参数仍可省略，不改成必填 nullable。显式要求 strict 的工具会报不支持，不能静默降低约束。
- 每轮以当前真实工具集生成顶层 tools；新增/移除工具和后续 system 更新通过 Pi 原生会话转换处理。工具名称出站映射、回程还原，参数与用户数据不受影响。
- 缓存断点仅位于两块顶层 system、最后一个真实工具和最后一条 user 的末内容块，最多 4 处；调用方 `onPayload` 后再次规范化。schema、工具参数和嵌套结果中的同名键是普通数据，不递归改写。
- adaptive thinking 保留 `display: updates`；effort 仅在顶层发送，随 Pi 当前选择，不再添加空 per-turn effort 消息；不强制 `low`、`max` 或覆盖显式输出上限。
- 不伪造 `/model` 历史、记忆、环境路径、技能清单、token 余额或 Claude 专属工具。

当前对齐目标是用户提供的**实际 Aether 出站抓包**，不是固定 Rust 源码中另一个会添加 billing 和 user/assistant 前缀的分支。没有复制 Aether 源码、抓包中的个人目录、对话、凭据或工具清单；headers 仍沿用用户已核对的 2.1.302 指纹。

协议转换、SSE、usage 和取消继续委托 Pi 原生 `anthropic-messages`。离线回归包含连续三轮真实历史传递，以及执行本地 `read` 后回传原始文件内容的工具链路。

已授权的真实验证需要区分三种结果：

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

本迁移尚未完成最终真实 Pi 1.5.0 端到端验收，也未调用真实中转站验证模型发现；离线通过不能替代真实服务兼容性或安全加固证据。Windows ACL、跨进程故障与全部身份/存储安全边界尚待最终验收；上方 Claude 章节保留的历史聊天结果不是本次模型发现验收。


## 风险提示

仅用于你已获授权的中转服务，并遵守其条款。拒绝跨 origin、重定向、非 HTTP(S) 地址和 URL 内联凭据；不会伪造账号、订阅或 attestation 信息。离线测试不证明中转站接受某个 CLI 指纹，版本变化可能要求同步更新适配。
