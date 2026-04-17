/**
 * mesh-convert-worker.ts — Runs in a worker thread.
 * Parses LLMesh from raw asset bytes, converts to GLB, writes to disk cache.
 */
import { parentPort, workerData } from 'worker_threads';
import { setCacheDir, ensureMeshCached, initSkeletonData } from './mesh-converter';
import { LLMesh } from '../../../node-metaverse/lib';

setCacheDir(workerData.cacheDir);
const _ready = initSkeletonData();

parentPort!.on('message', async (msg: { id: number; meshUuid: string; rawBuffer: Buffer }) => {
  await _ready;
  try {
    // postMessage structured clone converts Buffer → Uint8Array; restore it
    const buf = Buffer.isBuffer(msg.rawBuffer) ? msg.rawBuffer : Buffer.from(msg.rawBuffer);
    const llmesh = await LLMesh.from(buf);
    const result = await ensureMeshCached(msg.meshUuid, llmesh);
    parentPort!.postMessage({
      id: msg.id,
      cachePath: result.cachePath,
      isRigged: result.isRigged,
      jointNames: result.jointNames,
      jointOverrides: result.jointOverrides,
    });
  } catch (err) {
    parentPort!.postMessage({
      id: msg.id,
      error: (err as Error).message || String(err),
    });
  }
});
