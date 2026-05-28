import type { AgentEvent } from '../types';

/**
 * Translate a parsed NDJSON line from `reasonix run --output-format stream-json`
 * into one or more AgentEvents.
 *
 * Reasonix event schema:
 *   { type: "text", delta: "..." }
 *   { type: "tool_start", id: "...", name: "..." }
 *   { type: "tool_result", id: "...", name: "...", output: "...", isError: false }
 *   { type: "usage", model: "...", inputTokens: N, outputTokens: N, costUsd: N }
 *   { type: "done" }
 *   { type: "error", message: "..." }
 *   { type: "warning", message: "...", severity: "low"|"high" }
 */
export function* translateReasonixEvent(raw: unknown): Generator<AgentEvent> {
  if (!raw || typeof raw !== 'object') return;
  const evt = raw as Record<string, unknown>;

  switch (evt.type) {
    case 'text':
      if (typeof evt.delta === 'string' && evt.delta) {
        yield { type: 'text', delta: evt.delta };
      }
      break;

    case 'tool_start':
      // bridge doesn't have a tool_start equivalent in AgentEvent;
      // tool_use arrives when the result comes back. Skip.
      break;

    case 'tool_result':
      if (typeof evt.id === 'string') {
        yield {
          type: 'tool_use',
          id: evt.id,
          name: typeof evt.name === 'string' ? evt.name : 'unknown',
          input: undefined,
        };
        yield {
          type: 'tool_result',
          id: evt.id,
          output: typeof evt.output === 'string' ? evt.output : JSON.stringify(evt.output),
          isError: evt.isError === true,
        };
      }
      break;

    case 'usage':
      yield {
        type: 'usage',
        inputTokens: typeof evt.inputTokens === 'number' ? evt.inputTokens : undefined,
        outputTokens: typeof evt.outputTokens === 'number' ? evt.outputTokens : undefined,
        costUsd: typeof evt.costUsd === 'number' ? evt.costUsd : undefined,
      };
      break;

    case 'done':
      yield { type: 'done' };
      break;

    case 'error':
      yield {
        type: 'error',
        message: typeof evt.message === 'string' ? evt.message : JSON.stringify(evt),
      };
      break;

    case 'warning':
      // Map warnings to text so they appear in the chat
      if (typeof evt.message === 'string' && evt.message) {
        yield { type: 'text', delta: `[warning] ${evt.message}\n` };
      }
      break;
  }
}
