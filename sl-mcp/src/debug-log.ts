/**
 * Simple append-only file logger for MCP server debugging.
 * Writes to sl-mcp/debug.log with timestamps and tags.
 *
 * Uses sync writes so lines aren't lost on crash — the perf cost
 * is negligible for debug logging at this volume.
 */

import { appendFileSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_PATH = join(__dirname, '..', 'debug.log');

function ts(): string {
  return new Date().toISOString();
}

/** Append a single timestamped line. */
export function log(tag: string, message: string): void {
  try {
    appendFileSync(LOG_PATH, `${ts()} [${tag}] ${message}\n`);
  } catch {
    // If we can't write the log, don't crash the server
  }
}

/** Write a session separator so you can tell runs apart. */
export function logSessionStart(): void {
  try {
    appendFileSync(
      LOG_PATH,
      `\n${'='.repeat(72)}\n${ts()} === MCP SESSION START ===\n${'='.repeat(72)}\n`,
    );
  } catch {}
}

/** Delete the log file. */
export function logClear(): void {
  try { unlinkSync(LOG_PATH); } catch {}
}

/** Log an error with its stack trace if available. */
export function logError(tag: string, message: string, err?: unknown): void {
  const errMsg = err instanceof Error
    ? `${err.message}\n${err.stack || ''}`
    : err != null ? String(err) : '';
  log(tag, errMsg ? `${message}: ${errMsg}` : message);
}
