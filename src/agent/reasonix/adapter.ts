import type { ChildProcessByStdio } from 'node:child_process';
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentAdapter, AgentEvent, AgentRun, AgentRunOptions } from '../types';
import { translateReasonixEvent } from './stream-json';

export interface ReasonixAdapterOptions {
  binary?: string;
}

type ReasonixChild = ChildProcessByStdio<null, Readable, Readable>;

interface StdoutBuffer {
  lines: string[];
  ended: boolean;
  waiter: (() => void) | null;
}

function resolveReasonixBinary(binary: string): { cmd: string; args: string[]; shell: boolean } {
  if (process.platform !== 'win32' || binary !== 'reasonix') return { cmd: binary, args: [], shell: false };
  // pnpm installs a .CMD wrapper that breaks with shell:true + special chars in prompt.
  // Parse the wrapper to extract the real .js entry point, then invoke node directly.
  const pnpmBin = join(process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Local'), 'pnpm', 'bin');
  const cmdFile = join(pnpmBin, 'reasonix.CMD');
  try {
    const content = readFileSync(cmdFile, 'utf-8');
    // CMD file contains lines like: node  "%~dp0\..\global\v11\...\reasonix\dist\cli\index.js" %*
    const match = content.match(/node\s+"([^"]+\.js)"/i);
    if (match?.[1]) {
      // %~dp0 resolves to the CMD file's directory (with trailing backslash)
      const entryPath = match[1].replace(/%~dp0[\\\/]?/gi, pnpmBin + '\\');
      const abs = resolve(entryPath);
      try {
        if (statSync(abs).isFile()) return { cmd: 'node', args: [abs], shell: false };
      } catch { /* file doesn't exist at resolved path */ }
    }
  } catch { /* CMD file not found */ }
  // Fallback: search pnpm global store directories
  const localAppData = process.env.LOCALAPPDATA ?? join(process.env.HOME ?? '', 'AppData', 'Local');
  const pnpmGlobal = join(localAppData, 'pnpm', 'global');
  try {
    for (const ver of readdirSync(pnpmGlobal)) {
      const verDir = join(pnpmGlobal, ver);
      const direct = join(verDir, 'node_modules', 'reasonix', 'dist', 'cli', 'index.js');
      try { if (statSync(direct).isFile()) return { cmd: 'node', args: [direct], shell: false }; } catch { /* not here */ }
      try {
        for (const hash of readdirSync(verDir)) {
          const candidate = join(verDir, hash, 'node_modules', 'reasonix', 'dist', 'cli', 'index.js');
          try { if (statSync(candidate).isFile()) return { cmd: 'node', args: [candidate], shell: false }; } catch { /* not here */ }
        }
      } catch { /* ver dir not readable */ }
    }
  } catch { /* pnpm global dir doesn't exist */ }
  // Last resort: shell mode (will break with special chars in prompt)
  return { cmd: binary, args: [], shell: true };
}

export class ReasonixAdapter implements AgentAdapter {
  readonly id = 'reasonix';
  readonly displayName = 'Reasonix';

  private readonly binary: string;
  private readonly baseArgs: string[];
  private readonly shell: boolean;

  constructor(opts: ReasonixAdapterOptions = {}) {
    const resolved = resolveReasonixBinary(opts.binary ?? 'reasonix');
    this.binary = resolved.cmd;
    this.baseArgs = resolved.args;
    this.shell = resolved.shell;
  }

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.binary, [...this.baseArgs, '--version'], { stdio: 'ignore', shell: this.shell });
      child.on('error', () => resolve(false));
      child.on('exit', (code) => resolve(code === 0));
    });
  }

  run(opts: AgentRunOptions): AgentRun {
    const args = [
      ...this.baseArgs,
      'run',
      opts.prompt,
      '--output-format',
      'stream-json',
    ];
    if (opts.model) args.push('--model', opts.model);

    const child = spawn(this.binary, args, {
      cwd: opts.cwd,
      env: { ...process.env, LARK_CHANNEL: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: this.shell,
    });

    log.info('reasonix', 'spawn', {
      pid: child.pid ?? null,
      cwd: opts.cwd ?? process.cwd(),
      promptChars: opts.prompt.length,
      model: opts.model,
    });

    // Collect stderr for diagnostics
    const stderrChunks: Buffer[] = [];
    let stderrBuffer = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
      stderrBuffer += chunk.toString('utf8');
      let nl = stderrBuffer.indexOf('\n');
      while (nl !== -1) {
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (line.trim()) {
          log.warn('reasonix', 'stderr', { line });
        }
        nl = stderrBuffer.indexOf('\n');
      }
    });

    let runtimeError: Error | null = null;
    child.on('error', (err) => {
      runtimeError = err;
    });
    child.on('exit', (code, signal) => {
      log.info('reasonix', 'exit', { pid: child.pid ?? null, code, signal });
    });

    const stopGraceMs = opts.stopGraceMs ?? 5000;

    // Attach stdout readline synchronously
    const stdoutBuffer: StdoutBuffer = { lines: [], ended: false, waiter: null };
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line: string) => {
      stdoutBuffer.lines.push(line);
      stdoutBuffer.waiter?.();
    });
    rl.on('close', () => {
      stdoutBuffer.ended = true;
      stdoutBuffer.waiter?.();
    });

    return {
      events: createEventStream(child, stderrChunks, () => runtimeError, stdoutBuffer),
      async stop() {
        if (child.exitCode !== null || child.signalCode !== null) return;
        log.info('reasonix', 'stop-sigterm', { pid: child.pid ?? null, graceMs: stopGraceMs });
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              log.warn('reasonix', 'stop-sigkill', {
                pid: child.pid ?? null,
                graceMs: stopGraceMs,
                reason: 'grace-period-expired',
              });
              child.kill('SIGKILL');
            }
            resolve();
          }, stopGraceMs);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve();
          });
        });
      },
      waitForExit(timeoutMs: number): Promise<boolean> {
        if (child.exitCode !== null || child.signalCode !== null) {
          return Promise.resolve(true);
        }
        return new Promise<boolean>((resolve) => {
          const onExit = (): void => {
            clearTimeout(timer);
            resolve(true);
          };
          const timer = setTimeout(() => {
            child.removeListener('exit', onExit);
            resolve(false);
          }, timeoutMs);
          child.once('exit', onExit);
        });
      },
    };
  }
}

async function* createEventStream(
  child: ReasonixChild,
  stderrChunks: Buffer[],
  getError: () => Error | null,
  buf: StdoutBuffer,
): AsyncGenerator<AgentEvent> {
  if (!child.pid) {
    const err = getError();
    yield {
      type: 'error',
      message: err ? `failed to spawn reasonix: ${err.message}` : 'spawn returned no pid',
    };
    return;
  }

  // Emit a system event so bridge knows this is a reasonix run
  yield { type: 'system', model: 'reasonix' };

  while (true) {
    while (buf.lines.length > 0) {
      const line = buf.lines.shift()!;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        // Non-JSON line (e.g. MCP lifecycle banner on stderr mixed to stdout) — skip
        continue;
      }
      yield* translateReasonixEvent(parsed);
    }
    if (buf.ended) break;
    await new Promise<void>((resolve) => { buf.waiter = resolve; });
    buf.waiter = null;
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(child.exitCode);
    } else {
      child.once('exit', (code) => resolve(code));
    }
  });

  const runtimeError = getError();
  if (exitCode !== 0 && exitCode !== null) {
    const raw = Buffer.concat(stderrChunks);
    // On Windows, child process stderr may be in GBK (CP936), not UTF-8.
    // Try UTF-8 first; if it contains replacement chars, try GBK via TextDecoder.
    let stderr = raw.toString('utf8').trim();
    if (stderr.includes('�')) {
      try {
        stderr = new TextDecoder('gbk').decode(raw).trim();
      } catch { /* TextDecoder may not support GBK; keep the UTF-8 attempt */ }
    }
    const detail = stderr ? `: ${stderr.slice(0, 500)}` : '';
    yield { type: 'error', message: `reasonix exited with code ${exitCode}${detail}` };
  } else if (runtimeError) {
    yield { type: 'error', message: `reasonix runtime error: ${runtimeError.message}` };
  }
}
