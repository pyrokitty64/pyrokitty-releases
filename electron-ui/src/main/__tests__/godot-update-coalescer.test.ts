import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GodotUpdateCoalescer, type UpdateCoalescerDeps } from '../bridge/godot-update-coalescer';

function makeDeps(overrides?: Partial<UpdateCoalescerDeps>) {
  return {
    isTracked: vi.fn((_uuid: string) => true),
    isAvatarTracked: vi.fn((_id: string) => true),
    getLightInfo: vi.fn((_obj: any) => null as any),
    send: vi.fn((_msg: object) => {}),
    resendObject: vi.fn((_obj: any) => {}),
    trySendObject: vi.fn((_obj: any) => {}),
    ...overrides,
  } satisfies UpdateCoalescerDeps;
}

describe('GodotUpdateCoalescer', () => {
  let deps: ReturnType<typeof makeDeps>;
  let coalescer: GodotUpdateCoalescer;

  beforeEach(() => {
    vi.useFakeTimers();
    deps = makeDeps();
    coalescer = new GodotUpdateCoalescer(deps);
  });

  afterEach(() => {
    coalescer.cleanup();
    vi.useRealTimers();
  });

  describe('light tracking', () => {
    it('tracks objects with lights', () => {
      expect(coalescer.hasLight('obj-1')).toBe(false);
      coalescer.trackLight('obj-1');
      expect(coalescer.hasLight('obj-1')).toBe(true);
    });
  });

  describe('animesh tracking', () => {
    it('stores animesh state', () => {
      coalescer.trackAnimesh('obj-1', true);
      coalescer.trackAnimesh('obj-2', false);
      // No direct getter, but it's used internally for state change detection
    });
  });

  describe('sequence numbers', () => {
    it('returns -1 for unknown objects', () => {
      expect(coalescer.getSeq('unknown')).toBe(-1);
    });

    it('stores and retrieves sequence numbers', () => {
      coalescer.setSeq('obj-1', 42);
      expect(coalescer.getSeq('obj-1')).toBe(42);
    });

    it('updates sequence numbers', () => {
      coalescer.setSeq('obj-1', 10);
      coalescer.setSeq('obj-1', 20);
      expect(coalescer.getSeq('obj-1')).toBe(20);
    });
  });

  describe('subscribe — terse object updates', () => {
    function makeTerseEvent(uuid: string, seq: number, opts?: { pos?: any; rot?: any; vel?: any; PCode?: number }) {
      return {
        object: {
          FullID: { toString: () => uuid },
          PCode: opts?.PCode ?? 9, // default: not avatar
          Position: opts?.pos ?? { x: 1, y: 2, z: 3 },
          Rotation: opts?.rot ?? { x: 0, y: 0, z: 0, w: 1 },
          Scale: { x: 1, y: 1, z: 1 },
          Velocity: opts?.vel ?? null,
          Acceleration: null,
          AngularVelocity: null,
        },
        sequenceNumber: seq,
      };
    }

    function makeEvents() {
      const terseSubs: ((e: any) => void)[] = [];
      const fullSubs: ((e: any) => void)[] = [];
      return {
        onObjectUpdatedTerseEvent: {
          subscribe: (cb: any) => { terseSubs.push(cb); return { unsubscribe: vi.fn() }; },
        },
        onObjectUpdatedEvent: {
          subscribe: (cb: any) => { fullSubs.push(cb); return { unsubscribe: vi.fn() }; },
        },
        emitTerse: (e: any) => terseSubs.forEach(fn => fn(e)),
        emitFull: (e: any) => fullSubs.forEach(fn => fn(e)),
      };
    }

    it('coalesces terse updates and flushes after 16ms', () => {
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitTerse(makeTerseEvent('obj-1', 1));
      events.emitTerse(makeTerseEvent('obj-2', 1));

      // Not flushed yet
      expect(deps.send).not.toHaveBeenCalled();

      // Advance timer
      vi.advanceTimersByTime(16);

      // Should batch both into one message
      expect(deps.send).toHaveBeenCalledOnce();
      const call = vi.mocked(deps.send).mock.calls[0][0] as any;
      expect(call.type).toBe('object_update_batch');
      expect(call.objects).toHaveLength(2);
    });

    it('drops stale terse updates (lower seq)', () => {
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitTerse(makeTerseEvent('obj-1', 10));
      events.emitTerse(makeTerseEvent('obj-1', 5)); // stale
      events.emitTerse(makeTerseEvent('obj-1', 15)); // newer

      vi.advanceTimersByTime(16);

      // Should only have one update (last wins due to map key)
      expect(deps.send).toHaveBeenCalledOnce();
      const call = vi.mocked(deps.send).mock.calls[0][0] as any;
      expect(call.objects).toHaveLength(1);
    });

    it('ignores untracked objects', () => {
      (deps.isTracked as any).mockReturnValue(false);
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitTerse(makeTerseEvent('obj-1', 1));
      vi.advanceTimersByTime(16);

      expect(deps.send).not.toHaveBeenCalled();
    });

    it('separates physics updates (with velocity) from statics', () => {
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitTerse(makeTerseEvent('obj-static', 1));
      events.emitTerse(makeTerseEvent('obj-moving', 1, { vel: { x: 1, y: 0, z: 0 } }));

      vi.advanceTimersByTime(16);

      // Should send two messages: physics and statics
      expect(deps.send).toHaveBeenCalledTimes(2);
      const types = vi.mocked(deps.send).mock.calls.map((c: any) => c[0].type).sort();
      expect(types).toEqual(['object_update_batch', 'object_update_physics']);
    });
  });

  describe('subscribe — avatar terse updates', () => {
    function makeAvatarTerseEvent(avatarId: string) {
      return {
        object: {
          FullID: { toString: () => avatarId },
          PCode: 47, // avatar
          Position: { x: 128, y: 128, z: 30 },
          Rotation: { x: 0, y: 0, z: 0, w: 1 },
          Velocity: { x: 1, y: 0, z: 0 },
          ParentID: 0,
          region: null,
        },
        sequenceNumber: 1,
      };
    }

    function makeEvents() {
      const terseSubs: ((e: any) => void)[] = [];
      return {
        onObjectUpdatedTerseEvent: {
          subscribe: (cb: any) => { terseSubs.push(cb); return { unsubscribe: vi.fn() }; },
        },
        onObjectUpdatedEvent: {
          subscribe: () => ({ unsubscribe: vi.fn() }),
        },
        emitTerse: (e: any) => terseSubs.forEach(fn => fn(e)),
      };
    }

    it('buffers avatar updates separately and flushes as avatar_update_batch', () => {
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitTerse(makeAvatarTerseEvent('avatar-1'));
      events.emitTerse(makeAvatarTerseEvent('avatar-2'));

      vi.advanceTimersByTime(16);

      const avatarCall = vi.mocked(deps.send).mock.calls.find((c: any) => c[0].type === 'avatar_update_batch');
      expect(avatarCall).toBeDefined();
      expect((avatarCall![0] as any).avatars).toHaveLength(2);
    });

    it('ignores untracked avatars', () => {
      (deps.isAvatarTracked as any).mockReturnValue(false);
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitTerse(makeAvatarTerseEvent('avatar-unknown'));
      vi.advanceTimersByTime(16);

      expect(deps.send).not.toHaveBeenCalled();
    });
  });

  describe('subscribe — full object updates', () => {
    function makeEvents() {
      const terseSubs: ((e: any) => void)[] = [];
      const fullSubs: ((e: any) => void)[] = [];
      return {
        onObjectUpdatedTerseEvent: {
          subscribe: (cb: any) => { terseSubs.push(cb); return { unsubscribe: vi.fn() }; },
        },
        onObjectUpdatedEvent: {
          subscribe: (cb: any) => { fullSubs.push(cb); return { unsubscribe: vi.fn() }; },
        },
        emitTerse: (e: any) => terseSubs.forEach(fn => fn(e)),
        emitFull: (e: any) => fullSubs.forEach(fn => fn(e)),
      };
    }

    it('detects animesh state change and triggers resend', () => {
      const events = makeEvents();
      coalescer.subscribe(events);
      coalescer.trackAnimesh('obj-1', false);

      events.emitFull({
        object: {
          FullID: { toString: () => 'obj-1' },
          PCode: 9,
          Position: { x: 1, y: 2, z: 3 },
          Rotation: { x: 0, y: 0, z: 0, w: 1 },
          Scale: { x: 1, y: 1, z: 1 },
          Velocity: null,
          Acceleration: null,
          AngularVelocity: null,
          extraParams: { extendedMeshData: { flags: 0x1 } },
        },
        sequenceNumber: 1,
      });

      expect(deps.resendObject).toHaveBeenCalledOnce();
    });

    it('detects light removal and sends null light', () => {
      const events = makeEvents();
      coalescer.subscribe(events);
      coalescer.trackLight('obj-1');

      // Full update with no light
      events.emitFull({
        object: {
          FullID: { toString: () => 'obj-1' },
          PCode: 9,
          Position: { x: 1, y: 2, z: 3 },
          Rotation: { x: 0, y: 0, z: 0, w: 1 },
          Scale: { x: 1, y: 1, z: 1 },
          Velocity: null,
          Acceleration: null,
          AngularVelocity: null,
          extraParams: {},
        },
        sequenceNumber: 1,
      });

      vi.advanceTimersByTime(16);

      const call = vi.mocked(deps.send).mock.calls[0][0] as any;
      const obj = call.objects[0];
      expect(obj.light).toBeNull();
    });

    it('includes light info when present', () => {
      const lightData = { color: [1, 1, 1], radius: 10 };
      (deps.getLightInfo as any).mockReturnValue(lightData);
      const events = makeEvents();
      coalescer.subscribe(events);

      events.emitFull({
        object: {
          FullID: { toString: () => 'obj-1' },
          PCode: 9,
          Position: { x: 1, y: 2, z: 3 },
          Rotation: { x: 0, y: 0, z: 0, w: 1 },
          Scale: { x: 1, y: 1, z: 1 },
          Velocity: null,
          Acceleration: null,
          AngularVelocity: null,
          extraParams: {},
        },
        sequenceNumber: 1,
      });

      vi.advanceTimersByTime(16);

      const call = vi.mocked(deps.send).mock.calls[0][0] as any;
      expect(call.objects[0].light).toEqual(lightData);
    });
  });

  describe('cleanup', () => {
    it('clears all internal state', () => {
      coalescer.trackLight('obj-1');
      coalescer.setSeq('obj-1', 10);
      coalescer.trackAnimesh('obj-1', true);

      coalescer.cleanup();

      expect(coalescer.hasLight('obj-1')).toBe(false);
      expect(coalescer.getSeq('obj-1')).toBe(-1);
    });

    it('cancels pending timers', () => {
      const events = {
        onObjectUpdatedTerseEvent: {
          subscribe: (cb: any) => {
            // Fire an event to start the timer
            cb({
              object: {
                FullID: { toString: () => 'obj-1' },
                PCode: 9,
                Position: { x: 1, y: 2, z: 3 },
                Rotation: { x: 0, y: 0, z: 0, w: 1 },
                Scale: { x: 1, y: 1, z: 1 },
                Velocity: null,
                Acceleration: null,
                AngularVelocity: null,
              },
              sequenceNumber: 1,
            });
            return { unsubscribe: vi.fn() };
          },
        },
        onObjectUpdatedEvent: {
          subscribe: () => ({ unsubscribe: vi.fn() }),
        },
      };
      coalescer.subscribe(events);

      coalescer.cleanup();
      vi.advanceTimersByTime(100);

      // send should not have been called after cleanup
      expect(deps.send).not.toHaveBeenCalled();
    });
  });
});
