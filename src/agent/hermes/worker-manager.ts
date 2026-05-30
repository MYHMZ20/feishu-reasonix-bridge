import { randomUUID } from 'node:crypto';
import type { ChildProcessByStdio } from 'node:child_process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Readable } from 'node:stream';
import { log } from '../../core/logger';
import type { AgentEvent, AgentRun, AgentRunOptions } from '../types';

// Worker 响应类型（来自 Python stdout NDJSON）
interface WorkerResponse {
  id?: string;
  type: 'ready' | 'system' | 'text' | 'done' | 'error' | 'shutdown';
  delta?: string;
  message?: string;
  session_id?: string;
  model?: string;
}

// 每个请求的事件队列
interface RequestQueue {
  events: AgentEvent[];
  resolvers: Array<() => void>;
  done: boolean;
  error: Error | null;
}

export class HermesWorkerManager {
  private worker: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readonly queues = new Map<string, RequestQueue>();

  constructor(
    private readonly pythonCmd: string,
    private readonly scriptPath: string,
  ) {
    // 进程退出时自动清理 worker
    process.on('exit', () => {
      this.killWorker();
    });
  }

  /**
   * 确保 worker 进程正在运行且已就绪
   */
  async ensureRunning(): Promise<void> {
    if (this.worker && this.worker.exitCode === null) {
      return; // 已在运行
    }
    await this.spawn();
  }

  /**
   * 启动 worker 进程并等待 ready 事件
   */
  private async spawn(): Promise<void> {
    this.killWorker();

    this.ready = false;
    this.readyPromise = new Promise<void>((resolve) => {
      this.readyResolve = resolve;
    });

    log.info('hermes-worker', 'spawning', {
      python: this.pythonCmd,
      script: this.scriptPath,
    });

    this.worker = spawn(this.pythonCmd, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });

    // 处理 stdout（NDJSON 事件）
    let lineBuffer = '';
    this.worker.stdout.on('data', (chunk: Buffer) => {
      lineBuffer += chunk.toString();
      const lines = lineBuffer.split('\n');
      lineBuffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const resp: WorkerResponse = JSON.parse(trimmed);
          this.handleResponse(resp);
        } catch {
          // 非 JSON 输出，忽略（Python 启动时的警告等）
        }
      }
    });

    // 处理 stderr（日志）
    this.worker.stderr.on('data', (chunk: Buffer) => {
      log.info('hermes-worker', 'stderr', {
        data: chunk.toString().slice(0, 200),
      });
    });

    // 处理进程退出
    this.worker.on('exit', (code) => {
      log.info('hermes-worker', 'exit', { code });
      this.worker = null;
      this.ready = false;

      // 拒绝所有待处理请求
      for (const [, queue] of this.queues) {
        if (!queue.done) {
          queue.error = new Error(`worker exited with code ${code}`);
          queue.done = true;
          for (const resolve of queue.resolvers) {
            resolve();
          }
        }
      }
      this.queues.clear();
    });

    // 等待 ready 事件
    await this.readyPromise;
  }

  /**
   * 分派 worker 响应到对应请求队列
   */
  private handleResponse(resp: WorkerResponse): void {
    // ready 事件
    if (resp.type === 'ready') {
      this.ready = true;
      this.readyResolve?.();
      return;
    }

    // shutdown 事件
    if (resp.type === 'shutdown') {
      this.ready = false;
      return;
    }

    // 需要 request ID 的事件
    const requestId = resp.id;
    if (!requestId) return;

    // 获取或创建请求队列（防止事件先于 consumer 到达）
    let queue = this.queues.get(requestId);
    if (!queue) {
      queue = { events: [], resolvers: [], done: false, error: null };
      this.queues.set(requestId, queue);
    }

    switch (resp.type) {
      case 'system':
        queue.events.push({ type: 'system', model: resp.model });
        break;
      case 'text':
        queue.events.push({ type: 'text', delta: resp.delta ?? '' });
        break;
      case 'done':
        queue.events.push({ type: 'done', sessionId: resp.session_id ?? undefined });
        queue.done = true;
        break;
      case 'error':
        queue.error = new Error(resp.message ?? 'unknown worker error');
        queue.events.push({ type: 'error', message: resp.message ?? 'unknown worker error' });
        queue.done = true;
        break;
    }

    // 唤醒等待的 consumer
    for (const r of queue.resolvers) {
      r();
    }
    queue.resolvers = [];
  }

  /**
   * 发送命令到 worker（仅在已就绪时发送）
   */
  private sendCommand(cmd: object): void {
    if (!this.worker || this.worker.exitCode !== null) {
      throw new Error('worker not running');
    }
    this.worker.stdin.write(JSON.stringify(cmd) + '\n');
  }

  /**
   * 执行一次 run，返回 AgentRun
   */
  run(opts: AgentRunOptions): AgentRun {
    const requestId = randomUUID();
    const sessionId = opts.sessionId ?? 'default';
    const self = this; // capture for closures in returned object

    // 异步确保 worker 就绪后再发送命令
    this.ensureRunning()
      .then(() => {
        this.sendCommand({
          cmd: 'chat',
          id: requestId,
          prompt: opts.prompt,
          session_id: sessionId,
          model: opts.model,
        });
      })
      .catch((err: Error) => {
        log.error('hermes-worker', 'send-command-failed', {
          requestId,
          err: err.message,
        });
        // 推入错误事件
        let queue = self.queues.get(requestId);
        if (!queue) {
          queue = { events: [], resolvers: [], done: false, error: null };
          self.queues.set(requestId, queue);
        }
        queue.error = err;
        queue.events.push({ type: 'error', message: `worker not ready: ${err.message}` });
        queue.done = true;
        for (const r of queue.resolvers) {
          r();
        }
        queue.resolvers = [];
      });

    return {
      events: self.createEventStream(requestId),
      async stop() {
        // 持久 worker 不杀进程，仅记录
        log.info('hermes-worker', 'stop-requested', { requestId });
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        // 等待 done 或 error 事件
        const queue = self.queues.get(requestId);
        if (!queue) return true;
        if (queue.done) return true;

        return new Promise<boolean>((resolve) => {
          const check = (): void => {
            if (queue!.done) {
              clearTimeout(timer);
              resolve(true);
              return;
            }
            queue!.resolvers.push(check);
          };
          const timer = setTimeout(() => {
            const idx = queue!.resolvers.indexOf(check);
            if (idx !== -1) queue!.resolvers.splice(idx, 1);
            resolve(false);
          }, timeoutMs);
          check();
        });
      },
    };
  }

  /**
   * 创建事件流：从请求队列消费 AgentEvent
   */
  private async *createEventStream(requestId: string): AsyncGenerator<AgentEvent> {
    const getQueue = (): RequestQueue => {
      let queue = this.queues.get(requestId);
      if (!queue) {
        queue = { events: [], resolvers: [], done: false, error: null };
        this.queues.set(requestId, queue);
      }
      return queue;
    };

    const queue = getQueue();

    // 先消费已有事件
    while (queue.events.length > 0) {
      yield queue.events.shift()!;
    }

    // 再等待后续事件
    while (!queue.done) {
      if (queue.events.length > 0) {
        yield queue.events.shift()!;
      } else {
        // 等待有新事件到达
        await new Promise<void>((resolve) => {
          queue.resolvers.push(resolve);
        });
      }
    }

    // 消费剩余事件
    while (queue.events.length > 0) {
      yield queue.events.shift()!;
    }

    // 清理队列
    this.queues.delete(requestId);
  }

  /**
   * 关闭 worker 进程
   */
  async shutdown(): Promise<void> {
    if (!this.worker || this.worker.exitCode !== null) {
      return;
    }

    try {
      this.sendCommand({ cmd: 'shutdown' });
    } catch {
      // 发送失败直接杀进程
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.killWorker();
        resolve();
      }, 3000);

      this.worker?.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  /**
   * 强制杀死 worker
   */
  private killWorker(): void {
    if (this.worker && this.worker.exitCode === null) {
      this.worker.kill('SIGTERM');
    }
    this.worker = null;
    this.ready = false;
  }
}
