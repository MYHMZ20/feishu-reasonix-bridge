import { execFileSync, spawn } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentAdapter, AgentRunOptions } from '../types';
import { HermesWorkerManager } from './worker-manager';

export interface HermesAdapterOptions {
  binary?: string;
}

/**
 * Resolve the Python executable from Hermes venv.
 * Hermes is a Python package installed in a venv — we need its Python
 * to access the installed modules (run_agent, hermes_cli, etc.).
 */
function resolveHermesPython(): string {
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  // Try known venv locations (same order as resolveHermesBinary)
  const candidates = [
    localAppData ? join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe') : '',
    localAppData ? join(localAppData, 'hermes', 'hermes-agent', 'venv', 'bin', 'python3') : '',
    home ? join(home, '.hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe') : '',
    home ? join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'python3') : '',
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* not here */ }
  }

  // Fallback to system python
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * Resolve the Hermes binary path with the following priority:
 *
 *   1. `hermes` in PATH (via `where hermes` on Windows, `which hermes` on POSIX)
 *   2. `%LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe` (Windows)
 *   3. `%LOCALAPPDATA%\hermes\hermes-agent\venv\bin/hermes` (Linux/MSYS)
 *   4. `%HOME%\.hermes\hermes-agent\venv\Scripts\hermes.exe`
 *   5. `%HOME%\.hermes\hermes-agent\venv\bin/hermes`
 *
 * Hermes is a Python venv package — its binary lives in `Scripts/` (Windows)
 * or `bin/` (POSIX). Unlike npm packages, no .CMD wrapper resolution needed.
 */
function resolveHermesBinary(): string {
  // 1. Check PATH: try `where hermes` (Windows) or `which hermes` (POSIX)
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const result = execFileSync(cmd, ['hermes'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 3000,
    });
    const first = result.trim().split('\n')[0]?.trim();
    if (first) return first;
  } catch {
    // not in PATH — fall through
  }

  const localAppData = process.env.LOCALAPPDATA ?? '';
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';

  // 2. %LOCALAPPDATA%\hermes\hermes-agent\venv\Scripts\hermes.exe
  if (localAppData) {
    const candidate = join(localAppData, 'hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe');
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }

  // 3. %LOCALAPPDATA%\hermes\hermes-agent\venv\bin/hermes (Linux/MSYS)
  if (localAppData) {
    const candidate = join(localAppData, 'hermes', 'hermes-agent', 'venv', 'bin', 'hermes');
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }

  // 4. %HOME%\.hermes\hermes-agent\venv\Scripts\hermes.exe
  if (home) {
    const candidate = join(home, '.hermes', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe');
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }

  // 5. %HOME%\.hermes\hermes-agent\venv\bin/hermes
  if (home) {
    const candidate = join(home, '.hermes', 'hermes-agent', 'venv', 'bin', 'hermes');
    try { if (statSync(candidate).isFile()) return candidate; } catch { /* not here */ }
  }

  // Last resort: let spawn fail naturally
  return 'hermes';
}

export class HermesAdapter implements AgentAdapter {
  readonly id = 'hermes';
  readonly displayName = 'Hermes';

  private readonly binary: string;
  private readonly manager: HermesWorkerManager;

  constructor(opts: HermesAdapterOptions = {}) {
    this.binary = opts.binary ?? resolveHermesBinary();

    // 解析 worker 脚本路径（编译后 import.meta.url 在 dist/cli.js，需向上一级）
    const scriptPath = fileURLToPath(
      new URL('../scripts/hermes_worker.py', import.meta.url),
    );
    // 使用 Hermes venv 的 Python，确保能导入 run_agent 等模块
    const pythonCmd = resolveHermesPython();

    this.manager = new HermesWorkerManager(pythonCmd, scriptPath);
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, ['--version'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    // 委托给 HermesWorkerManager — 利用持久 Worker 避免每次 25s 初始化开销
    return this.manager.run(opts);
  }

  /**
   * 关闭持久 Worker 进程（供 bridge shutdown 时调用）
   */
  async shutdown(): Promise<void> {
    await this.manager.shutdown();
  }
}
