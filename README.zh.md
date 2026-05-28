# feishu-reasonix-bridge

在飞书/Lark 聊天中运行本地 **Reasonix**（DeepSeek）CLI，支持会话、附件和后台服务。

> **平台：Windows** — 本项目在 Windows 上测试和优化。Reasonix 二进制解析支持 `pnpm` 和 `npm` 全局安装（解析 `.CMD` 包装器以避免 `cmd.exe` shell 转义问题）。macOS/Linux 理论可用但未测试。

本项目参考 [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) 构建，感谢原项目的设计与实现。

[English README](./README.md)

## 功能

- 飞书 / Lark 消息（私聊或群内 `@bot`）转发到本地 `reasonix` CLI
- **流式回复**：Reasonix 输出实时更新到飞书卡片
- **多代理路由**：通过 `agentRoutes` 配置不同聊天使用不同代理（Claude / Reasonix）
- **会话管理**：每个聊天独立会话，断点续聊
- **消息合并**：快速连续消息合并为一次请求
- **工作空间**：`/ws` 切换项目目录
- **访问控制**：支持用户白名单、聊天白名单、管理员列表

## 环境要求

- Node.js **>= 20**
- `reasonix` CLI — 参见 [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
- 飞书 / Lark **PersonalAgent** 应用（首次运行扫码创建）

## 安装

```bash
npm i -g feishu-reasonix-bridge
# 或
pnpm add -g feishu-reasonix-bridge
```

## 首次运行

```bash
feishu-reasonix-bridge run
```

首次运行会打开扫码向导：

1. 终端显示二维码
2. 用飞书 / Lark 扫码
3. 选择或创建 PersonalAgent 应用
4. 凭据保存到 `~/.lark-channel/config.json`

## 命令

### 宿主 CLI

```
feishu-reasonix-bridge run [-c <config>]     前台运行
feishu-reasonix-bridge ps                    查看运行中的进程
feishu-reasonix-bridge kill <id|#>           终止进程
feishu-reasonix-bridge --help                查看所有命令
```

### 后台服务

```
feishu-reasonix-bridge start                 安装并启动后台服务
feishu-reasonix-bridge stop                  停止服务
feishu-reasonix-bridge restart               重启服务
feishu-reasonix-bridge status                查看服务状态
```

### 飞书 / Lark 内斜杠命令

| 命令 | 功能 |
|---|---|
| `/new`, `/reset` | 清除当前会话 |
| `/resume [N]` | 列出并恢复最近会话 |
| `/cd <path>` | 切换工作目录（重置会话） |
| `/ws list` | 列出命名工作空间 |
| `/ws save <name>` | 保存当前目录为工作空间 |
| `/ws use <name>` | 切换工作空间 |
| `/ws remove <name>` | 删除命名工作空间 |
| `/status` | 查看当前 cwd / 会话 / 代理 |
| `/config` | 调整配置（回复模式、超时、访问控制等） |
| `/stop` | 停止当前运行 |
| `/timeout [N\|off\|default]` | 设置空闲超时；`off` 关闭；`default` 清除会话覆盖 |
| `/ps` | 查看运行中的 bridge 进程 |
| `/exit <id\|#>` | 终止 bridge 进程 |
| `/account` | 查看/更换飞书应用凭据 |
| `/reconnect` | 强制重连 WebSocket |
| `/doctor [description]` | 将最近日志发给代理进行诊断 |
| `/help` | 帮助卡片 |

## 配置

配置文件：`~/.lark-channel/config.json`

### 多代理路由

```json
{
  "preferences": {
    "defaultAgent": "reasonix",
    "agentRoutes": {
      "oc_xxx": "claude",
      "oc_yyy": "reasonix"
    }
  }
}
```

- `defaultAgent`：默认代理，可选 `claude` 或 `reasonix`
- `agentRoutes`：按 `chat_id` 路由到不同代理

### 访问控制

```json
{
  "preferences": {
    "access": {
      "allowedUsers": ["ou_xxx"],
      "allowedChats": ["oc_xxx"],
      "admins": ["ou_xxx"]
    }
  }
}
```

## 数据目录

| 路径 | 内容 |
|---|---|
| `~/.lark-channel/config.json` | 应用凭据 |
| `~/.lark-channel/sessions.json` | 会话映射 |
| `~/.lark-channel/workspaces.json` | 工作空间 |
| `~/.lark-channel/media/<chatId>/` | 下载的文件（24h 后清理） |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | 运行日志 |

## 常见问题

**Bot 没有回复**：检查 `reasonix` CLI 是否已安装并登录。发送 `/status` 查看状态。

**回复卡住**：发送 `/stop` 终止当前运行，或用 `/config` 设置空闲超时。

## License

[MIT](./LICENSE)
