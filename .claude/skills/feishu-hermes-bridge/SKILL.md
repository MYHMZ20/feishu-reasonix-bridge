# Feishu Hermes Bridge — Claude Code Skill

Start and manage the Feishu-Lark bridge with **Hermes Agent** (Nous Research's CLI agent).

## Usage

```
/skill feishu-hermes-bridge <action>
```

### Actions

| Action | Description |
|--------|-------------|
| `start` | Start the Hermes bridge |
| `start -- [args]` | Start with extra lark-channel-bridge args |
| `check` | Check Hermes CLI + project status |
| `build` | Build the bridge project |
| `help` | Show this help |

### Examples

```
/skill feishu-hermes-bridge start
/skill feishu-hermes-bridge check
/skill feishu-hermes-bridge build
```

## Prerequisites

- Project at `C:\Users\QWE\feishu-claude-code-bridge`
- Hermes CLI installed (`pip install hermes-agent`)
- Node.js >= 20 + pnpm installed

## Hermes CLI 路径

Hermes 安装在 `C:\Users\QWE\.hermes\`，CLI 二进制在 venv 中：
- Windows: `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe`
- 或 `%USERPROFILE%\.hermes\hermes-agent\venv\Scripts\hermes.exe`

如果不在 PATH 中，bridge 的 HermesAdapter 会自动搜索上述路径。

## Implementation Details

### Architecture

```
飞书/Lark → lark-channel-bridge → HermesAdapter → Hermes CLI (chat -q -Q)
                                  → ClaudeAdapter → Claude CLI (default)
                                  → ReasonixAdapter → Reasonix CLI
```

The bridge supports multiple agent backends. The Hermes adapter:

1. Resolves the Hermes binary via `resolveHermesBinary()` (PATH → LOCALAPPDATA → HOME)
2. Runs `hermes chat -q "<prompt>" -Q` — quiet, non-interactive, plain text output
3. Collects all stdout, emits it as a single `{ type: 'text' }` AgentEvent
4. Hermes does NOT support `--output-format stream-json` — plain text only

### Files

| File | Purpose |
|------|---------|
| `src/agent/hermes/adapter.ts` | HermesAdapter class — resolves binary, spawns process, collects output |
| `src/agent/hermes/stream-json.ts` | Plain text → AgentEvent translator (structural parallel) |
| `scripts/hermes_stream.py` | Python streaming wrapper (uses AIAgent internally for token deltas) |
| `scripts/start-hermes-bridge.ps1` | PowerShell launcher for Hermes bridge |
| `scripts/start-reasonix-bridge.ps1` | PowerShell launcher for Reasonix bridge |
| `src/agent/index.ts` | Exports HermesAdapter |
| `src/cli/commands/start.ts` | Registers hermes in adapters Map |

### Key Differences from ClaudeAdapter

| Aspect | ClaudeAdapter | HermesAdapter |
|--------|---------------|---------------|
| Output format | stream-json (NDJSON) | Plain text |
| Binary type | npm package → .CMD wrapper | Python venv → .exe |
| Events parsed | Per-line NDJSON | One blob → one text event |
| Session support | `--resume` | `--resume` (basic) |
| Model flag | `--model` | `-m` |
