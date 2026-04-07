/**
 * pk-debug.ts — Tag-based debug logging, matching godot-viewer/src/debug_log.gd.
 * Set PK_DEBUG env var: PK_DEBUG=texperf,materials  or  PK_DEBUG=all
 */

const _enabledTags = new Set<string>();
let _all = false;

const env = process.env.PK_DEBUG ?? '';
for (const raw of env.split(',')) {
  const tag = raw.trim().toLowerCase();
  if (tag === 'all') _all = true;
  else if (tag) _enabledTags.add(tag);
}

export function pkDebugEnabled(tag: string): boolean {
  return _all || _enabledTags.has(tag);
}

export function pkDebug(tag: string, msg: string): void {
  if (_all || _enabledTags.has(tag)) {
    console.log(`[${tag}] ${msg}`);
  }
}
