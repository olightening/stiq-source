/**
 * torSocket listener-lifecycle tests. The native StiqSocket module emits 'StiqSocket' events on a
 * global NativeEventEmitter channel; each createTorRelaySocket() adds one listener. If a listener
 * is not removed when its socket dies, App.tsx's reconnect spins up a fresh socket + listener on
 * the SAME channel, and every stale listener re-dispatches each incoming frame — so after N
 * reconnects a single relay frame is processed N+1×. These tests assert the listener is removed on
 * EVERY death path (remote 'close', 'error'/onFailure, and local close()).
 */
import type {TorManager} from '../tor';

// ── Mock react-native so NativeEventEmitter is a controllable in-memory dispatcher. ──
// State lives on globalThis (jest.mock factories are hoisted above imports and may only reference
// `mock`-prefixed outer variables; a global sidesteps that restriction cleanly).
type Handler = (event: unknown) => void;
interface MockState {
  listeners: Set<Handler>;
  removeCalls: number;
  socketIds: string[];
}
const mockGlobal = globalThis as unknown as {__stiqSocketMock: MockState};
mockGlobal.__stiqSocketMock = {listeners: new Set(), removeCalls: 0, socketIds: []};

jest.mock('react-native', () => {
  // Read the shared state lazily (per call) — the factory is hoisted and may run before the
  // top-level assignment below, so capturing it once here would grab `undefined`.
  const getState = (): MockState =>
    (globalThis as unknown as {__stiqSocketMock: MockState}).__stiqSocketMock;
  return {
    NativeModules: {
      StiqSocket: {
        connect: jest.fn((socketId: string) => {
          getState().socketIds.push(socketId);
          return Promise.resolve();
        }),
        send: jest.fn().mockResolvedValue(undefined),
        close: jest.fn().mockResolvedValue(undefined),
      },
    },
    NativeEventEmitter: class {
      addListener(_event: string, handler: (e: unknown) => void): {remove: () => void} {
        const state = getState();
        state.listeners.add(handler);
        return {
          remove: () => {
            state.removeCalls++;
            state.listeners.delete(handler);
          },
        };
      }
    },
  };
});

import {createTorRelaySocket, type IsolatingRelaySocket} from './torSocket';

const state = mockGlobal.__stiqSocketMock;

/** Fire a native 'StiqSocket' event to every registered listener (what the emitter would do). */
function emitNative(
  event: Record<string, unknown>,
  socketId = state.socketIds[state.socketIds.length - 1]!,
): void {
  for (const h of [...state.listeners]) h({socketId, ...event});
}

const fakeManager = {
  getSocksProxy: () => ({host: '127.0.0.1', port: 9050}),
} as unknown as TorManager;

// A valid Tor v3 onion host: exactly 56 base32 (a-z, 2-7) chars + .onion.
const ONION = `ws://${'a'.repeat(56)}.onion`;

beforeEach(() => {
  state.listeners.clear();
  state.removeCalls = 0;
  state.socketIds.length = 0;
  jest.clearAllMocks();
});

describe('createTorRelaySocket listener lifecycle', () => {
  it('notifies an onOpen subscriber that registers after a fast native handshake', () => {
    const socket = createTorRelaySocket(fakeManager, ONION);
    emitNative({type: 'open'});

    let opened = 0;
    socket.onOpen(() => opened++);

    expect(opened).toBe(1);
  });

  it('notifies an onClose subscriber that registers after an early onion failure', () => {
    const socket = createTorRelaySocket(fakeManager, ONION);
    emitNative({type: 'error', data: 'SOCKS connect failed'});

    let closed = 0;
    socket.onClose(() => closed++);

    expect(closed).toBe(1);
  });

  it('removes the native listener on a remote close (the routine flaky-Tor drop)', () => {
    const socket = createTorRelaySocket(fakeManager, ONION);
    let closed = false;
    socket.onClose(() => (closed = true));
    expect(state.listeners.size).toBe(1);

    emitNative({type: 'close'});

    expect(closed).toBe(true);
    expect(state.removeCalls).toBe(1);
    expect(state.listeners.size).toBe(0); // no leaked listener
  });

  it('a frame delivered AFTER a remote close is processed exactly once, not once per past socket', () => {
    const received: string[] = [];

    // First socket connects, receives one frame, then the remote side drops it.
    const s1 = createTorRelaySocket(fakeManager, ONION);
    s1.onMessage(d => received.push(`s1:${d}`));
    emitNative({type: 'open'});
    emitNative({type: 'message', data: 'frame-a'});
    emitNative({type: 'close'}); // remote close — its listener MUST be removed here

    // Reconnect: a fresh socket on the same global channel.
    const s2 = createTorRelaySocket(fakeManager, ONION);
    s2.onMessage(d => received.push(`s2:${d}`));
    emitNative({type: 'open'});
    emitNative({type: 'message', data: 'frame-b'});

    // frame-b must reach ONLY the live socket. If s1's listener leaked, it would re-dispatch
    // frame-b too (the N+1 processing bug).
    expect(received).toEqual(['s1:frame-a', 's2:frame-b']);
    expect(state.listeners.size).toBe(1); // only the live socket's listener remains
  });

  it('removes the native listener on an error/onFailure event', () => {
    const socket = createTorRelaySocket(fakeManager, ONION);
    let closed = false;
    socket.onClose(() => (closed = true));

    emitNative({type: 'error', data: 'boom'});

    expect(closed).toBe(true);
    expect(state.listeners.size).toBe(0);
  });

  it('removes the native listener on a local close()', () => {
    const socket = createTorRelaySocket(fakeManager, ONION);
    socket.close();
    expect(state.listeners.size).toBe(0);
  });

  it('passes a per-session SOCKS credential so each socket gets its own Tor circuit (audit #49)', () => {
    const native = jest.requireMock('react-native').NativeModules.StiqSocket as {connect: jest.Mock};
    const s1 = createTorRelaySocket(fakeManager, ONION);
    const s2 = createTorRelaySocket(fakeManager, ONION);

    // connect(socketId, url, socksHost, socksPort, socksUser, socksPass)
    const [id1, , , , user1, pass1] = native.connect.mock.calls[0]!;
    const [id2, , , , user2, pass2] = native.connect.mock.calls[1]!;
    // Username/password == the unique socketId engages Tor's IsolateSOCKSAuth per session.
    expect(user1).toBe(id1);
    expect(pass1).toBe(id1);
    expect(user2).toBe(id2);
    expect(pass2).toBe(id2);
    // Distinct logical sessions → distinct credentials → distinct circuits (feed vs enroll vs draw).
    expect(user1).not.toBe(user2);

    s1.close();
    s2.close();
  });

  it('keeps the feed socket alive while a dedicated token-draw socket opens and closes', () => {
    const native = jest.requireMock('react-native').NativeModules.StiqSocket as {
      send: jest.Mock;
      close: jest.Mock;
    };
    const received: string[] = [];

    const feed = createTorRelaySocket(fakeManager, ONION);
    const feedId = state.socketIds[0]!;
    feed.onMessage(data => received.push(`feed:${data}`));
    emitNative({type: 'open'}, feedId);

    const draw = createTorRelaySocket(fakeManager, ONION);
    const drawId = state.socketIds[1]!;
    draw.onMessage(data => received.push(`draw:${data}`));
    emitNative({type: 'open'}, drawId);

    emitNative({type: 'message', data: 'draw-response'}, drawId);
    feed.send('feed-publish');
    draw.send('draw-request');
    draw.close();

    emitNative({type: 'message', data: 'feed-event'}, feedId);
    expect(received).toEqual(['draw:draw-response', 'feed:feed-event']);
    expect(native.close).toHaveBeenCalledWith(drawId);
    expect(native.close).not.toHaveBeenCalledWith(feedId);
    expect(native.send).toHaveBeenCalledWith(feedId, 'feed-publish');
    expect(native.send).toHaveBeenCalledWith(drawId, 'draw-request');
    expect(state.listeners.size).toBe(1);
  });

  // ── Anonymity finding #1: with publish-circuit isolation enabled, the feed socket can spawn a
  //    dedicated sibling socket (its own socketId ⇒ its own Tor circuit) for a blind-post publish. ──
  it('does not expose openPublishCircuit when isolation is disabled', () => {
    // Explicit override so the test pins the disabled behaviour regardless of the module default
    // (ISOLATE_BLIND_PUBLISH_CIRCUIT is enabled by default now, under on-device validation).
    const socket = createTorRelaySocket(fakeManager, ONION, {isolatePublishCircuit: false});
    expect((socket as Partial<IsolatingRelaySocket>).openPublishCircuit).toBeUndefined();
    socket.close();
  });

  it('opens a dedicated sibling circuit with its own SOCKS credential when isolation is enabled', () => {
    const native = jest.requireMock('react-native').NativeModules.StiqSocket as {
      connect: jest.Mock;
      close: jest.Mock;
    };
    const socket = createTorRelaySocket(fakeManager, ONION, {
      isolatePublishCircuit: true,
    }) as IsolatingRelaySocket;
    const mainId = state.socketIds[0]!;

    const sibling = socket.openPublishCircuit();
    expect(sibling).not.toBeNull();
    const sibId = state.socketIds[1]!;
    expect(sibId).not.toBe(mainId); // a distinct native socket

    // Each socket passes its unique socketId as SOCKS user/pass → IsolateSOCKSAuth → its own circuit.
    const [id0, , , , user0, pass0] = native.connect.mock.calls[0]!;
    const [id1, , , , user1, pass1] = native.connect.mock.calls[1]!;
    expect([user0, pass0]).toEqual([id0, id0]);
    expect([user1, pass1]).toEqual([id1, id1]);
    expect(user1).not.toBe(user0); // the blind-publish circuit is distinct from the feed circuit

    sibling!.close();
    expect(native.close).toHaveBeenCalledWith(sibId);
    expect(native.close).not.toHaveBeenCalledWith(mainId); // closing the sibling leaves the feed up
    socket.close();
  });

  // ── Warm pool: a pre-opened spare publish circuit is kept ready after the main socket opens, so a
  //    blind post rides an already-established Tor circuit instead of waiting out a cold rendezvous. ──
  it('warms a spare circuit shortly after the main socket opens', () => {
    jest.useFakeTimers();
    try {
      const socket = createTorRelaySocket(fakeManager, ONION, {
        isolatePublishCircuit: true,
      }) as IsolatingRelaySocket;
      socket.onOpen(() => {}); // registers the warm-on-open composed callback (as RelayClient does)
      emitNative({type: 'open'}, state.socketIds[0]!); // main socket up

      expect(state.socketIds.length).toBe(1); // warming is scheduled, not immediate
      jest.advanceTimersByTime(250); // WARM_INITIAL_DELAY_MS elapses → the spare circuit is opened
      expect(state.socketIds.length).toBe(2); // exactly one spare — the pool is capped at 1

      socket.close();
    } finally {
      jest.useRealTimers();
    }
  });

  it('close() disposes the warm pool: tears down the held spare and opens no further circuits', () => {
    jest.useFakeTimers();
    try {
      const native = jest.requireMock('react-native').NativeModules.StiqSocket as {close: jest.Mock};
      const socket = createTorRelaySocket(fakeManager, ONION, {
        isolatePublishCircuit: true,
      }) as IsolatingRelaySocket;
      socket.onOpen(() => {});
      emitNative({type: 'open'}, state.socketIds[0]!); // main socket up → schedules the first warm

      jest.advanceTimersByTime(250); // warm attempt opens the spare
      const spareId = state.socketIds[1]!;
      emitNative({type: 'open'}, spareId); // spare finishes its handshake → held ready in the pool
      expect(state.socketIds.length).toBe(2);

      socket.close();
      expect(native.close).toHaveBeenCalledWith(spareId); // the held spare is torn down, not leaked

      // No further circuit ever opens after close — a persistently-failing warm loop can't keep
      // firing openTorSocket() on the orphaned onion (the frequent-reconnect leak this guards).
      jest.advanceTimersByTime(10_000);
      expect(state.socketIds.length).toBe(2); // still just main + the (now-closed) spare
      expect(state.listeners.size).toBe(0); // main + spare native listeners both removed
    } finally {
      jest.useRealTimers();
    }
  });

  it('disposes the warm pool on a GENUINE REMOTE death too, not only local close()', () => {
    // The remote-death path reaches the caller through base.onClose (onRelayDown), which nulls the
    // socket ref WITHOUT calling close() — so without wrapping onClose the pool would be orphaned.
    jest.useFakeTimers();
    try {
      const native = jest.requireMock('react-native').NativeModules.StiqSocket as {close: jest.Mock};
      const socket = createTorRelaySocket(fakeManager, ONION, {
        isolatePublishCircuit: true,
      }) as IsolatingRelaySocket;
      let downCalls = 0;
      socket.onOpen(() => {});
      socket.onClose(() => downCalls++); // the caller's onRelayDown-style handler (App.tsx wires this)
      const mainId = state.socketIds[0]!;
      emitNative({type: 'open'}, mainId); // main socket up → schedules the first warm

      jest.advanceTimersByTime(250); // warm attempt opens the spare
      const spareId = state.socketIds[1]!;
      emitNative({type: 'open'}, spareId); // spare finishes its handshake → held ready in the pool
      expect(state.socketIds.length).toBe(2);

      // A GENUINE remote death — native 'close' on the MAIN socket (flaky-Tor drop), NOT socket.close().
      emitNative({type: 'close'}, mainId);
      expect(downCalls).toBe(1); // the caller's handler still ran...
      expect(native.close).toHaveBeenCalledWith(spareId); // ...AND the held spare was disposed first

      // The orphaned-pool leak this guards: no warm attempt / retry keeps firing after the drop.
      jest.advanceTimersByTime(10_000);
      expect(state.socketIds.length).toBe(2); // no further circuit opened after the remote death
      expect(state.listeners.size).toBe(0); // both native listeners removed — nothing left alive
    } finally {
      jest.useRealTimers();
    }
  });

  it('a warm circuit still mid-rendezvous at close() is closed on open, never promoted to spare', () => {
    jest.useFakeTimers();
    try {
      const native = jest.requireMock('react-native').NativeModules.StiqSocket as {close: jest.Mock};
      const socket = createTorRelaySocket(fakeManager, ONION, {
        isolatePublishCircuit: true,
      }) as IsolatingRelaySocket;
      socket.onOpen(() => {});
      emitNative({type: 'open'}, state.socketIds[0]!);

      jest.advanceTimersByTime(250); // warm attempt opens the spare — but it has NOT opened yet
      const pendingSpareId = state.socketIds[1]!;
      expect(state.socketIds.length).toBe(2);

      socket.close(); // disposed while that sibling is still rendezvousing

      // The sibling later completes its handshake: it must close itself and drop, never promote.
      emitNative({type: 'open'}, pendingSpareId);
      expect(native.close).toHaveBeenCalledWith(pendingSpareId);

      jest.advanceTimersByTime(10_000);
      expect(state.socketIds.length).toBe(2); // no post-close circuit opened
    } finally {
      jest.useRealTimers();
    }
  });
});
