import {fetchFreshBridges} from './bridgeFetch';

/**
 * A fetch stub that never settles on its own — it only rejects (like a real aborted fetch
 * would) once the RequestInit's AbortSignal fires. Lets us prove the moat attempts are
 * properly wired to an AbortController instead of racing a detached timeout that leaves the
 * losing fetch running in the background.
 */
function abortableFetchMock(): jest.Mock {
  return jest.fn((_url: string, opts?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
  });
}

describe('fetchFreshBridges abort hygiene', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('aborts each losing moat attempt via its own AbortController instead of leaking it', async () => {
    jest.useFakeTimers();
    const fetchMock = abortableFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = fetchFreshBridges('webtunnel');

    // The direct attempt has fired but must not be aborted before its timeout elapses.
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstOpts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstSignal = firstOpts.signal as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    // Once the 15s per-attempt budget elapses, the direct attempt's own controller aborts it
    // (rather than a detached `timeout()` promise racing ahead while the fetch keeps running),
    // and the code falls through to the domain-fronted attempt.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(firstSignal.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondSignal = secondOpts.signal as AbortSignal;
    expect(secondSignal.aborted).toBe(false);

    // Same for the fronted attempt.
    await jest.advanceTimersByTimeAsync(15_000);
    expect(secondSignal.aborted).toBe(true);

    // webtunnel has no github fallback, so both moat attempts failing means an empty result.
    await expect(promise).resolves.toEqual([]);
  });

  it('passes a Host override header on the fronted attempt without disturbing abort wiring', async () => {
    jest.useFakeTimers();
    const fetchMock = abortableFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = fetchFreshBridges('webtunnel');
    await jest.advanceTimersByTimeAsync(15_000); // fail the direct attempt
    await jest.advanceTimersByTimeAsync(0);

    const frontedOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((frontedOpts.headers as Record<string, string>)['Host']).toBe(
      'bridges.torproject.org',
    );

    await jest.advanceTimersByTimeAsync(15_000); // fail the fronted attempt too
    await expect(promise).resolves.toEqual([]);
  });
});

/**
 * A moat API response shaped exactly as moatPost() parses it
 * (json.data[0].settings.bridges.bridge_strings).
 */
const moatOk = {
  data: [{settings: {bridges: {bridge_strings: ['obfs4 1.2.3.4:443 ABC cert=x iat-mode=0']}}}],
};

function mockFetch(seen: string[]): void {
  global.fetch = jest.fn(async (url: string) => {
    seen.push(url);
    return {ok: true, json: async () => moatOk} as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('fetchFreshBridges — hop selection (audit #50)', () => {
  beforeEach(() => {
    // Fake timers so the per-attempt abort setTimeout never lingers as a real handle; the
    // fetch mock resolves via microtasks, so no timer advance is needed.
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('frontedOnly uses ONLY the domain-fronted CDN hop — never the non-fronted direct or GitHub hops', async () => {
    const seen: string[] = [];
    mockFetch(seen);

    const bridges = await fetchFreshBridges('obfs4', {frontedOnly: true});

    expect(bridges.length).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('cdn77'); // the CDN77 front
    expect(seen.some(u => u.includes('bridges.torproject.org'))).toBe(false); // no direct hop
    expect(seen.some(u => u.includes('githubusercontent.com'))).toBe(false); // no GitHub hop
  });

  it('default (no opts) still tries the non-fronted direct hop first', async () => {
    const seen: string[] = [];
    mockFetch(seen);

    await fetchFreshBridges('obfs4');

    expect(seen[0]).toContain('bridges.torproject.org');
  });
});
