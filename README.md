# Pi Webhook

独立、通用的 Pi / pi-web 通知扩展，接收端实现 HTTP JSON POST 即可。没有运行时第三方依赖，不启动 HTTP 服务，不提供远程执行或审批能力。

## 安装

需要 Node.js >= 22.18，Pi 提供 `agent_settled`、`agent_before_settle`、`ui_prompt_start/end` 事件（已使用 Pi 1.5.0 类型和生命周期验证）。

```bash
pi install git:github.com/YHQY-Dev/pi-webhook
```

在已有会话执行 `/reload`，或重启会话。使用同一个 Pi agent 配置目录的 Pi CLI 和 pi-web 共用安装与配置。若 pi-web 使用另一用户或 `PI_CODING_AGENT_DIR`，需在对应环境安装；远程 pi-web 的 localhost 指向服务器，不是浏览器所在电脑。

使用 `pi remove git:github.com/YHQY-Dev/pi-webhook` 可移除安装，通知配置需按需自行删除。尚未发布 npm 包。开发时也可使用 `pi install /absolute/path/to/pi-webhook` 安装本地目录，安装后不要移动或删除该目录。

**默认目标 `http://127.0.0.1:24527/` 是接收端地址，不是扩展监听端口。** 缺少配置文件时使用内置默认配置并开始发送；接收端没启动会有限重试，失败仅计数，不弹窗、不阻塞 Agent。接收端需实现下文定义的通用 JSON 协议。

## 配置和命令

全局配置：`~/.pi/agent/webhook.json`；设置 `PI_CODING_AGENT_DIR` 后使用该目录下的 `webhook.json`。不加载项目配置，避免不可信仓库改变外发目标。初次可使用 `/webhook config` 保存配置，或复制 `config.example.json` 到上述位置。

| 命令 | 作用 |
| --- | --- |
| `/webhook` 或 `/webhook status` | 显示启用状态、订阅、失败/丢弃计数及配置路径，不显示 URL 或鉴权信息 |
| `/webhook config` | 编辑完整 JSON；保存前校验，取消不保存 |
| `/webhook on` / `/webhook off` | 持久化启用/禁用 |
| `/webhook events default completed,error,waiting` | 设置指定接收端的事件列表 |
| `/webhook events default none` | 清空该接收端事件列表 |
| `/webhook test [接收端名称]` | 给启用的接收端发送 `test` 事件，显示 HTTP 结果；不受事件订阅过滤，最长等待约 10 秒 |
| `/webhook reload` | 重新读取配置 |

命令反馈通过 Pi UI 输出；配置编辑使用标准 editor UI，可由支持它的 RPC 客户端（包括 pi-web）展示。`json`/`print` 等无 UI 模式请直接编辑配置文件。配置编辑器不会触发自身的等待通知。

每个会话独立读取配置。保存只更新当前会话，其他会话执行 `/webhook reload` 或重启。无效配置在加载时停止发送，不静默回退到旧目标；无效编辑不会覆盖文件。禁用只阻止后续入队，已入队请求仍可能送达。配置不覆盖 Pi 的 `settings.json` 或其他扩展。

### 可订阅事件

| 事件 | 默认订阅 | 含义 |
| --- | --- | --- |
| `completed` | 是 | 整次运行真正结束，不再自动重试、压缩续跑或处理队列 |
| `error` | 是 | 最终以错误结束；恢复成功的临时错误不会误报 |
| `waiting` | 是 | 扩展 UI 开始阻塞等待用户（select / confirm / input / editor / custom） |
| `resumed` | 否 | UI 等待结束；不表示批准，也不保证 Agent 开始运行 |
| `started` | 否 | 一次完整运行开始；自动续跑不重复发送 |
| `cancelled` | 否 | 用户取消或运行中止，不再发送 completed |
| `tool_error` | 否 | 单个工具失败，不等于整次任务失败 |
| `session_started` | 否 | 会话加载，也可能来自切换或扩展重载 |
| `session_closed` | 否 | 会话退出、切换或扩展重载，尽力发送 |

`waiting` 只表示 Pi 真实发出的 UI 等待事件，不分析普通文本中的问句；没有调用阻塞 UI 的权限插件、普通助手提问、浏览器断连不一定产生这个事件。不通过 Webhook 接收用户的批准响应。

### 多目标与鉴权

```json
{
  "enabled": true,
  "timeoutMs": 3000,
  "retries": 2,
  "webhooks": [
    {
      "name": "local",
      "url": "http://127.0.0.1:24527/",
      "enabled": true,
      "events": ["completed", "error", "waiting", "resumed"],
      "headers": {},
      "includeMessage": false,
      "includeCwd": false
    },
    {
      "name": "service",
      "url": "https://example.com/pi-events",
      "events": ["error"],
      "headers": { "Authorization": "Bearer ${PI_WEBHOOK_TOKEN}" }
    }
  ]
}
```

请求头中的 `${ENV_NAME}` 在发送时从 Pi 服务进程环境读取；变量缺失则该目标发送失败。不要把令牌直接放进 URL。支持本机/内网 HTTP 与 HTTPS；跨机器建议 HTTPS + Authorization。禁止重定向，避免把敏感头转发到其他地址。服务应自行鉴权，不要在公网裸露无鉴权接收端。

配置严格校验未知字段。最多 16 个目标；名字唯一，只含字母、数字、`_`、`.`、`-`，最长 64 字符。`timeoutMs` 为 100–30000；`retries` 为 0–5。`enabled` 默认 true；两个 include 选项默认 false。`webhooks: []` 合法，不发送任何通知。

## HTTP 协议 v1

```http
POST / HTTP/1.1
Content-Type: application/json
X-Pi-Event-Id: <UUID>
X-Pi-Event-Type: completed
```

```json
{
  "schemaVersion": 1,
  "id": "a-unique-event-uuid",
  "type": "completed",
  "timestamp": "2026-11-06T00:00:00.000Z",
  "source": "pi",
  "session": { "id": "pi-session-id" },
  "data": { "runId": "a-run-uuid", "durationMs": 1234 }
}
```

- `session.id` 区分同一个 pi-web 进程下的多会话；不要用 PID 识别会话。
- 运行相关事件包含 `data.runId`，方便关联 started / waiting / completed；非运行中事件可不包含。
- completed / error / cancelled 包含 `durationMs`；waiting 包含 `reason: "ui_prompt"`、`kind`；tool_error 包含 `toolName`、`toolCallId`。
- `includeCwd: true` 时额外发送 `session.cwd`；`includeMessage: true` 时最终运行通知可附带 `data.message`，内容为最后一条助手回复的纯文本（最多 2000 字符）。不保证错误时有回复正文。
- 默认不发送提示词、回复正文、思考、工具参数/结果、错误堆栈、会话文件路径、UI 标题。开启正文或目录后可能泄露敏感信息，请谨慎配置。
- 自定义头不能覆盖 Content-Type、Host、Content-Length、Connection、Transfer-Encoding 或 `X-Pi-*`。

这是通用 JSON 协议，不自动转换 Discord / Slack 等专用消息格式；需要相应适配服务。

## 可靠性边界

每个会话对每个目标维护独立顺序队列（最多 100 个含正在发送的事件，超量丢弃新事件）。不同目标并行；Agent 事件处理只入队，不等待网络。网络错误、429、5xx 有限指数退避重试，其他非 2xx 不重试。超时按每次请求计算。

同一个事件的重试保持相同 ID，接收端应按 `id` 去重；由于超时可能发生在接收成功后，可能重复送达。配置保存在事件入队时的快照中。此扩展是内存中的尽力通知，不保证进程崩溃、强制结束、系统休眠期间的送达，不持久化消息；正常关闭最多等待 2 秒再取消剩余请求。失败和丢弃计数可通过 status 查看，不记录响应正文或凭据。

## 开发

```bash
npm ci
npm run check
npm test
npm pack --dry-run
```

职责划分：`src/config.ts` 配置/校验/存储；`src/delivery.ts` 协议、隐私裁剪、HTTP 和有界队列；`src/index.ts` Pi 生命周期和命令桥接。宿主 SDK 仅作为 peer/dev 依赖，不打包为运行时副本。
