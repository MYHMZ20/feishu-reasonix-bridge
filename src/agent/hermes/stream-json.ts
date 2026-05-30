import type { AgentEvent } from '../types';

/**
 * Hermes adapter event translator.
 *
 * Unlike Claude Code, Hermes CLI does NOT support `--output-format stream-json`.
 * Its `-q -Q` (quiet query) mode outputs plain text to stdout — no structured
 * NDJSON events. This translator wraps the accumulated plain-text response
 * into a single { type: 'text' } event followed by { type: 'done' }.
 *
 * If the text is empty, only { type: 'done' } is emitted.
 *
 * Note: The primary event stream is generated in HermesAdapter's
 * createEventStream() directly. This file exists as:
 *   1. A reference for the plain-text → AgentEvent translation contract
 *   2. A reusable helper if the bridge ever needs to re-parse cached output
 *   3. A structural parallel to claude/stream-json.ts and reasonix/stream-json.ts
 */

export interface HermesOutput {
  /** The raw stdout text from Hermes */
  text: string;
}

/**
 * Translate a completed Hermes plain-text output into one or more AgentEvents.
 */
export function* translatePlainText(output: HermesOutput): Generator<AgentEvent> {
  const trimmed = output.text.trim();
  if (trimmed) {
    yield { type: 'text', delta: trimmed };
  }
  yield { type: 'done' };
}

/**
 * Attempt to extract a session/resume identifier from Hermes stderr or
 * output metadata. Hermes (as of current versions) does not expose a
 * structured session ID in quiet mode — this is a placeholder for future use.
 *
 * Returns `undefined` when no session info is available.
 */
export function extractSessionId(_text: string): string | undefined {
  // Hermes CLI in -q -Q mode doesn't emit session metadata.
  // Future: parse stderr for session resume tokens when Hermes adds them.
  return undefined;
}
