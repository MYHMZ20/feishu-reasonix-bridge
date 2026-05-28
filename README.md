# feishu-reasonix-bridge

Run local **Reasonix** (DeepSeek) CLI from Feishu / Lark chat, with sessions, attachments, and background service support.

This project is built with reference to [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge), with thanks for the original design and implementation.

[中文文档](./README.zh.md)

## Features

- Forwards Feishu / Lark messages (DM or `@bot` in groups) to your local `reasonix` CLI
- **Streaming reply**: Reasonix output updates on a Lark card in real time
- **Multi-agent routing**: configure `agentRoutes` to route different chats to different agents (Claude / Reasonix)
- **Per-chat sessions**: each chat keeps its own session
- **Preempt + batch**: new messages interrupt the running run; rapid-fire messages get coalesced
- **Workspaces**: `/ws` switches between named project directories
- **Access control**: user allowlist, chat allowlist, admin list

## Prerequisites

- Node.js **>= 20**
- `reasonix` CLI — see [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)
- A Lark / Feishu **PersonalAgent** app (the QR-code wizard on first launch can create one for you)

## Install

```bash
npm i -g feishu-reasonix-bridge
# or
pnpm add -g feishu-reasonix-bridge
```

## First run

```bash
feishu-reasonix-bridge run
```

The first run opens a QR-code wizard:

1. A QR code renders in your terminal
2. Scan it with the Feishu / Lark app
3. Pick or create a PersonalAgent app
4. Credentials are saved to `~/.lark-channel/config.json`

## Commands

### Host CLI

```
feishu-reasonix-bridge run [-c <config>]     Run the bridge in the foreground
feishu-reasonix-bridge ps                    List running bridge processes
feishu-reasonix-bridge kill <id|#>           Kill a bridge process
feishu-reasonix-bridge --help                List all commands
```

### Background service

```
feishu-reasonix-bridge start                 Install and start the daemon
feishu-reasonix-bridge stop                  Stop the daemon
feishu-reasonix-bridge restart               Restart the daemon
feishu-reasonix-bridge status                Show daemon status
```

### Slash commands inside Feishu / Lark

| Command | Effect |
|---|---|
| `/new`, `/reset` | Clear the current session |
| `/cd <path>` | Switch working directory |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save current cwd as a workspace |
| `/ws use <name>` | Switch to a workspace |
| `/status` | Show current status |
| `/config` | Adjust preferences |
| `/stop` | Stop the running agent |
| `/timeout [N\|off]` | Set idle timeout (minutes) |
| `/help` | Help card |

## Configuration

Config file: `~/.lark-channel/config.json`

### Multi-agent routing

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

- `defaultAgent`: fallback agent (`claude` or `reasonix`)
- `agentRoutes`: route by `chat_id` to a specific agent

### Access control

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

## Data directories

| Path | Content |
|---|---|
| `~/.lark-channel/config.json` | App credentials |
| `~/.lark-channel/sessions.json` | Session mappings |
| `~/.lark-channel/workspaces.json` | Named workspaces |
| `~/.lark-channel/media/<chatId>/` | Downloaded files (cleaned after 24h) |
| `~/.lark-channel/logs/YYYY-MM-DD.log` | Structured run logs |

## FAQ

**Bot stays silent**: check if `reasonix` CLI is installed and logged in. Send `/status` to inspect.

**Reply stuck**: send `/stop` to terminate, or use `/config` to set an idle timeout.

## License

[MIT](./LICENSE)
