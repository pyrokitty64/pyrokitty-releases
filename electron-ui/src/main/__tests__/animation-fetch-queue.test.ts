import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-app' },
}));

// Mock fs.promises — vi.hoisted ensures the object exists before vi.mock's hoisted factory runs
const mockFsPromises = vi.hoisted(() => ({
  access: vi.fn<() => Promise<void>>(() => Promise.reject(new Error('ENOENT'))),
  readFile: vi.fn(() => Promise.resolve('{}')),
  mkdir: vi.fn(() => Promise.resolve(undefined)),
  writeFile: vi.fn(() => Promise.resolve(undefined)),
}));
vi.mock('fs', () => ({
  promises: mockFsPromises,
}));

// Mock mesh-converter deps used by convertAnimation
vi.mock('../assets/mesh-converter', () => ({
  getSkeletonHierarchy: () => {
    const m = new Map();
    m.set('mPelvis', { name: 'mPelvis' });
    m.set('mTorso', { name: 'mTorso' });
    return m;
  },
  getAttachmentPoints: () => new Map(),
}));

// Mock LLAnimation — hoisted so we can change behavior per test.
// Must use `function` (not arrow) so it can be called with `new`.
const mockLLAnimationData = vi.hoisted(() => ({
  current: {
    length: 2.0, loop: 1, inPoint: 0.0, outPoint: 2.0,
    easeInTime: 0.3, easeOutTime: 0.3, priority: 4,
    joints: [{
      name: 'mPelvis', priority: 4,
      rotationKeyframes: [{ time: 0, transform: { x: 0, y: 0, z: 0 } }],
      positionKeyframes: [{ time: 0, transform: { x: 0.1, y: 0.2, z: 0.3 } }],
    }],
  },
}));
vi.mock('../../../node-metaverse/dist/lib/classes/LLAnimation', () => ({
  LLAnimation: function LLAnimation() {
    Object.assign(this, mockLLAnimationData.current);
  },
}));

// Mock node-metaverse AssetType
vi.mock('../../../node-metaverse/dist/lib', () => ({
  AssetType: { Animation: 20 },
}));

import { AnimationFetchQueue, type AnimationData, type AnimationReadyCallback } from '../assets/animation-fetch-queue';

// ── Helpers ──────────────────────────────────────────────────────

function makeAnimData(uuid: string): AnimationData {
  return {
    uuid,
    duration: 2.0,
    loop: true,
    loopInPoint: 0,
    loopOutPoint: 2.0,
    easeInTime: 0.3,
    easeOutTime: 0.3,
    priority: 4,
    joints: [],
  };
}

function makeMockBot(downloadResult?: () => Promise<Buffer>) {
  return {
    clientCommands: {
      asset: {
        downloadAsset: downloadResult ?? vi.fn(() => Promise.resolve(Buffer.alloc(100))),
      },
    },
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────

describe('AnimationFetchQueue', () => {
  let onReady: ReturnType<typeof vi.fn<AnimationReadyCallback>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFsPromises.access.mockRejectedValue(new Error('ENOENT'));
    onReady = vi.fn<AnimationReadyCallback>();
  });

  describe('initial state', () => {
    it('starts with zero counts', () => {
      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      expect(q.queueDepth).toBe(0);
      expect(q.activeCount).toBe(0);
      expect(q.failedCount).toBe(0);
      expect(q.cachedCount).toBe(0);
    });
  });

  describe('memory cache', () => {
    it('returns null from getCached when not cached', async () => {
      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      expect(await q.getCached('anim-1')).toBeNull();
    });

    it('request calls onReady immediately for memory-cached animation', () => {
      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      // Prime the memory cache by doing a successful fetch first
      const data = makeAnimData('anim-1');
      (q as any).cache.set('anim-1', data);

      q.request('anim-1', 100);
      expect(onReady).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledWith('anim-1', data);
      // Should not have queued anything
      expect(q.queueDepth).toBe(0);
    });
  });

  describe('disk cache', () => {
    it('request loads from disk and calls onReady', async () => {
      const diskData = makeAnimData('anim-disk');
      mockFsPromises.access.mockResolvedValue(undefined);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(diskData));

      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      await q.request('anim-disk', 100);

      expect(onReady).toHaveBeenCalledOnce();
      expect(onReady).toHaveBeenCalledWith('anim-disk', diskData);
      expect(q.cachedCount).toBe(1);
      expect(q.queueDepth).toBe(0);
    });

    it('getCached loads from disk into memory cache', async () => {
      const diskData = makeAnimData('anim-disk');
      mockFsPromises.access.mockResolvedValue(undefined);
      mockFsPromises.readFile.mockResolvedValue(JSON.stringify(diskData));

      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      const result = await q.getCached('anim-disk');

      expect(result).toEqual(diskData);
      expect(q.cachedCount).toBe(1);
    });

    it('handles corrupt disk cache gracefully', async () => {
      mockFsPromises.access.mockResolvedValue(undefined);
      mockFsPromises.readFile.mockRejectedValue(new Error('corrupt'));

      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      const result = await q.getCached('anim-corrupt');
      expect(result).toBeNull();
    });
  });

  describe('queueing and deduplication', () => {
    it('queues a download when not cached', async () => {
      const bot = makeMockBot(() => new Promise(() => {})); // never resolves
      const q = new AnimationFetchQueue(bot, onReady);

      await q.request('anim-1', 100);
      // Active because drain starts immediately
      expect(q.activeCount).toBe(1);
    });

    it('deduplicates same UUID from multiple localIds', async () => {
      const bot = makeMockBot(() => new Promise(() => {}));
      const q = new AnimationFetchQueue(bot, onReady);

      await q.request('anim-1', 100);
      await q.request('anim-1', 200);
      await q.request('anim-1', 300);

      // Should still be just one active fetch
      expect(q.activeCount).toBe(1);
      expect(q.queueDepth).toBe(0);
    });

    it('queues multiple different UUIDs', async () => {
      const bot = makeMockBot(() => new Promise(() => {}));
      const q = new AnimationFetchQueue(bot, onReady);

      for (let i = 0; i < 6; i++) {
        await q.request(`anim-${i}`, i);
      }

      // MAX_CONCURRENT = 4, so 4 active + 2 queued
      expect(q.activeCount).toBe(4);
      expect(q.queueDepth).toBe(2);
    });
  });

  describe('fetch success', () => {
    it('calls onReady after successful download', async () => {
      const bot = makeMockBot();
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-1', 100);
      // Wait for the async fetch to complete
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

      expect(onReady).toHaveBeenCalledOnce();
      const [uuid, data] = onReady.mock.calls[0];
      expect(uuid).toBe('anim-1');
      expect(data.uuid).toBe('anim-1');
      expect(data.duration).toBe(2.0);
      expect(data.loop).toBe(true);
      expect(data.priority).toBe(4);
    });

    it('caches result in memory after successful fetch', async () => {
      const bot = makeMockBot();
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-1', 100);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

      expect(q.cachedCount).toBe(1);
    });

    it('persists result to disk after successful fetch', async () => {
      const bot = makeMockBot();
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-1', 100);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

      expect(mockFsPromises.mkdir).toHaveBeenCalled();
      expect(mockFsPromises.writeFile).toHaveBeenCalled();
    });

    it('converts position keys with 5x scale factor', async () => {
      const bot = makeMockBot();
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-1', 100);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

      const data = onReady.mock.calls[0][1] as AnimationData;
      const pelvis = data.joints.find(j => j.name === 'mPelvis');
      expect(pelvis).toBeDefined();
      expect(pelvis!.positionKeys[0].value[0]).toBeCloseTo(0.5); // 0.1 * 5
      expect(pelvis!.positionKeys[0].value[1]).toBeCloseTo(1.0); // 0.2 * 5
      expect(pelvis!.positionKeys[0].value[2]).toBeCloseTo(1.5); // 0.3 * 5
    });

    it('drains queue after fetch completes', async () => {
      let resolvers: (() => void)[] = [];
      const bot = makeMockBot(() => new Promise<Buffer>(r => {
        resolvers.push(() => r(Buffer.alloc(100)));
      }));
      const q = new AnimationFetchQueue(bot, onReady);

      // Queue 6 items (4 active + 2 waiting)
      for (let i = 0; i < 6; i++) await q.request(`anim-${i}`, i);
      expect(q.activeCount).toBe(4);
      expect(q.queueDepth).toBe(2);

      // Resolve one — should drain one from queue
      resolvers[0]();
      await vi.waitFor(() => expect(q.queueDepth).toBe(1));
    });
  });

  describe('fetch failure', () => {
    it('marks animation as failed on download error', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const bot = makeMockBot(() => Promise.reject(new Error('network error')));
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-fail', 100);
      await vi.waitFor(() => expect(q.failedCount).toBe(1));

      expect(q.hasFailed('anim-fail')).toBe(true);
      expect(onReady).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('skips previously failed animations on re-request', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const bot = makeMockBot(() => Promise.reject(new Error('fail')));
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-fail', 100);
      await vi.waitFor(() => expect(q.hasFailed('anim-fail')).toBe(true));

      // Second request should be ignored
      await q.request('anim-fail', 200);
      expect(q.queueDepth).toBe(0);
      expect(q.activeCount).toBe(0);
      consoleSpy.mockRestore();
      consoleWarn.mockRestore();
    });
  });

  describe('hasFailed', () => {
    it('returns false for unknown animation', () => {
      const q = new AnimationFetchQueue(makeMockBot(), onReady);
      expect(q.hasFailed('unknown')).toBe(false);
    });
  });

  describe('destroy', () => {
    it('prevents new requests from being processed', async () => {
      const bot = makeMockBot(() => new Promise(() => {}));
      const q = new AnimationFetchQueue(bot, onReady);

      q.destroy();
      await q.request('anim-1', 100);

      expect(q.queueDepth).toBe(0);
      expect(q.activeCount).toBe(0);
    });

    it('does not call onReady for in-flight fetches after destroy', async () => {
      let resolver: (v: Buffer) => void;
      const bot = makeMockBot(() => new Promise<Buffer>(r => { resolver = r; }));
      const q = new AnimationFetchQueue(bot, onReady);

      await q.request('anim-1', 100);
      q.destroy();
      resolver!(Buffer.alloc(100));

      // Give it time to process
      await new Promise(r => setTimeout(r, 10));
      expect(onReady).not.toHaveBeenCalled();
    });
  });

  describe('clearPending', () => {
    it('clears queue and failures but keeps cache', () => {
      const bot = makeMockBot(() => new Promise(() => {}));
      const q = new AnimationFetchQueue(bot, onReady);

      // Prime cache
      (q as any).cache.set('cached-1', makeAnimData('cached-1'));
      // Add to failed set
      (q as any).failed.add('failed-1');

      q.clearPending();

      expect(q.queueDepth).toBe(0);
      expect(q.failedCount).toBe(0);
      // Cache should survive
      expect(q.cachedCount).toBe(1);
    });

    it('allows re-requesting previously failed animations', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      let callCount = 0;
      const bot = makeMockBot(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('fail'));
        return Promise.resolve(Buffer.alloc(100));
      });
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-retry', 100);
      await vi.waitFor(() => expect(q.hasFailed('anim-retry')).toBe(true));

      q.clearPending();
      expect(q.hasFailed('anim-retry')).toBe(false);

      q.request('anim-retry', 200);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled());
      consoleSpy.mockRestore();
    });
  });

  describe('scrubs unknown joints', () => {
    it('filters joints not in skeleton or attachment points', async () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Override LLAnimation mock data to include unknown joint
      mockLLAnimationData.current = {
        length: 1.0, loop: 0, inPoint: 0, outPoint: 1.0,
        easeInTime: 0, easeOutTime: 0, priority: 3,
        joints: [
          {
            name: 'mPelvis', priority: 3,
            rotationKeyframes: [{ time: 0, transform: { x: 0, y: 0, z: 0 } }],
            positionKeyframes: [],
          },
          {
            name: 'BOGUS_JOINT', priority: 3,
            rotationKeyframes: [{ time: 0, transform: { x: 0, y: 0, z: 0 } }],
            positionKeyframes: [],
          },
        ],
      };

      const bot = makeMockBot();
      const q = new AnimationFetchQueue(bot, onReady);

      q.request('anim-scrub', 100);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalled());

      const data = onReady.mock.calls[0][1] as AnimationData;
      expect(data.joints).toHaveLength(1);
      expect(data.joints[0].name).toBe('mPelvis');

      consoleSpy.mockRestore();
    });
  });
});
