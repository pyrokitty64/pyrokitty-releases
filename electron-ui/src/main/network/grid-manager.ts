import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { XMLParser } from 'fast-xml-parser';
import { Grid, GridAddOrUpdateResult } from '../../shared/types';

const PROBE_TIMEOUT_MS = 5000;
const PROBE_MAX_BYTES = 64 * 1024;

function getSeedGridsPath(): string {
  // In dev mode __dirname is dist/main/, grids.json is at electron-ui/data/
  const dataDir = app.isPackaged
    ? path.join(app.getAppPath(), 'data')
    : path.join(__dirname, '..', '..', 'data');
  return path.join(dataDir, 'grids.json');
}

function getUserGridsPath(): string {
  return path.join(app.getPath('userData'), 'grids.json');
}

function normalizeLoginUri(uri: string): string {
  const u = new URL(uri.trim());
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Login URI must be http or https');
  }
  u.hostname = u.hostname.toLowerCase();
  if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
    u.port = '';
  }
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
    u.pathname = u.pathname.slice(0, -1);
  }
  u.search = '';
  u.hash = '';
  return u.toString();
}

async function fetchGridInfo(loginUri: string, signal: AbortSignal): Promise<Record<string, string>> {
  const origin = new URL(loginUri).origin;
  const infoUrl = `${origin}/get_grid_info`;
  const res = await fetch(infoUrl, { signal, headers: { 'User-Agent': 'PyroKitty' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body?.getReader();
  if (!reader) throw new Error('No response body');
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > PROBE_MAX_BYTES) {
        await reader.cancel();
        throw new Error('Response too large');
      }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf-8');
  const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
  const parsed = parser.parse(text);
  const root = parsed.gridinfo || parsed.GridInfo || parsed;
  if (!root || typeof root !== 'object') throw new Error('Invalid grid info XML');
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(root as Record<string, unknown>)) {
    if (typeof v === 'string') out[k.toLowerCase()] = v;
  }
  if (!out.login && !out.gridname && !out.gridnick) {
    throw new Error('Missing grid info fields');
  }
  return out;
}

function buildGridFromInfo(normalizedUri: string, info: Record<string, string>, existing?: Grid): Grid {
  const host = new URL(normalizedUri).host;
  return {
    id: existing?.id ?? host,
    name: info.gridname || existing?.name || host,
    nick: info.gridnick || existing?.nick || host,
    loginUri: info.login || normalizedUri,
    helperUri: info.economy || info.helperuri || existing?.helperUri,
    webProfileUrl: info.profile || existing?.webProfileUrl,
    slurlBase: existing?.slurlBase,
  };
}

function gridsEqual(a: Grid, b: Grid): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class GridManager {
  private grids: Grid[] = [];

  async initialize(): Promise<void> {
    this.loadGrids();
    console.log(`Loaded ${this.grids.length} grids`);
  }

  private loadGrids(): void {
    try {
      const userFile = getUserGridsPath();
      if (!fs.existsSync(userFile)) {
        const seed = getSeedGridsPath();
        if (fs.existsSync(seed)) {
          fs.mkdirSync(path.dirname(userFile), { recursive: true });
          fs.copyFileSync(seed, userFile);
          console.log(`Seeded grids.json to ${userFile}`);
        }
      }
      if (fs.existsSync(userFile)) {
        const data = fs.readFileSync(userFile, 'utf-8');
        this.grids = JSON.parse(data);
      }
    } catch (error) {
      console.error('Error loading grids:', error);
      this.grids = [];
    }
  }

  private saveGrids(): void {
    const userFile = getUserGridsPath();
    fs.mkdirSync(path.dirname(userFile), { recursive: true });
    fs.writeFileSync(userFile, JSON.stringify(this.grids, null, 2), 'utf-8');
  }

  getAllGrids(): Grid[] {
    return this.grids;
  }

  getGrid(id: string): Grid | undefined {
    return this.grids.find(g => g.id === id);
  }

  async addOrUpdateFromUri(loginUri: string): Promise<GridAddOrUpdateResult> {
    let normalized: string;
    try {
      normalized = normalizeLoginUri(loginUri);
    } catch (e: any) {
      return { status: 'invalid-url', error: e?.message || 'Invalid URL' };
    }

    const existing = this.grids.find(g => {
      try { return normalizeLoginUri(g.loginUri) === normalized; }
      catch { return false; }
    });

    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
    let info: Record<string, string> | null = null;
    let probeError: string | null = null;
    try {
      info = await fetchGridInfo(normalized, ac.signal);
    } catch (e: any) {
      probeError = e?.name === 'AbortError' ? 'Timed out' : (e?.message || 'Probe failed');
    } finally {
      clearTimeout(timeoutId);
    }

    if (existing) {
      if (!info) {
        return { status: 'unchanged-stale', grid: existing, error: probeError ?? undefined };
      }
      const merged = buildGridFromInfo(normalized, info, existing);
      if (gridsEqual(merged, existing)) {
        return { status: 'unchanged', grid: existing };
      }
      const idx = this.grids.indexOf(existing);
      this.grids[idx] = merged;
      this.saveGrids();
      return { status: 'updated', grid: merged };
    }

    if (!info) {
      return { status: 'unreachable', error: probeError ?? "Couldn't reach grid" };
    }

    const candidate = buildGridFromInfo(normalized, info);
    if (this.grids.some(g => g.id === candidate.id)) {
      return { status: 'bad-response', error: `A different grid with id "${candidate.id}" already exists` };
    }
    this.grids.push(candidate);
    this.saveGrids();
    return { status: 'added', grid: candidate };
  }
}

export const gridManager = new GridManager();
