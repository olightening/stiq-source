import {fetchFreshBridges, githubBridgeLines} from './bridgeFetch';

/**
 * A fetch stub that never settles on its own — it only rejects (like a real aborted fetch
 * would) once the RequestInit's AbortSignal fires. Lets us prove the moat/GitHub attempts are
 * properly wired to an AbortController — including the one fetchFreshBridges fires when a
 * DIFFERENT source group wins its concurrent race — instead of racing a detached timeout that
 * leaves the losing fetch running in the background.
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

describe('fetchFreshBridges — concurrent source race with stagger', () => {
  const realFetch = global.fetch;

  afterEach(() => {
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  it('runs all three source groups concurrently on independent staggers and independent per-attempt timeouts (not sequentially)', async () => {
    jest.useFakeTimers();
    const fetchMock = abortableFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = fetchFreshBridges('webtunnel');

    // t=0: only the direct attempt has fired — the mildly-preferred source starts first.
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const directSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit).signal as AbortSignal;
    expect(directSignal.aborted).toBe(false);

    // t=2s: the fronted stagger elapses and it fires too, CONCURRENTLY with direct (which is
    // still running — nobody has won yet, so nothing was cancelled).
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(directSignal.aborted).toBe(false);
    const frontedSignal = (fetchMock.mock.calls[1]?.[1] as RequestInit).signal as AbortSignal;
    expect(frontedSignal.aborted).toBe(false);

    // t=4s: the GitHub collector's stagger elapses; its first mirror fires too. All three
    // source groups are now in flight at once — direct and fronted have not been touched.
    await jest.advanceTimersByTimeAsync(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[0]).toContain('bridges-webtunnel');
    const github1Signal = (fetchMock.mock.calls[2]?.[1] as RequestInit).signal as AbortSignal;
    expect(github1Signal.aborted).toBe(false);

    // t=14s: the GitHub attempt's OWN 10s budget (started at t=4s) elapses and aborts it, even
    // though direct and fronted are still well inside their own 15s budgets — proving each
    // source's timeout is independent, not a shared or detached one. It falls through to the
    // second (master-branch) mirror.
    await jest.advanceTimersByTimeAsync(10_000);
    expect(github1Signal.aborted).toBe(true);
    expect(directSignal.aborted).toBe(false);
    expect(frontedSignal.aborted).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const github2Signal = (fetchMock.mock.calls[3]?.[1] as RequestInit).signal as AbortSignal;
    expect(github2Signal.aborted).toBe(false);

    // t=15s: direct's OWN 15s budget (started at t=0) elapses.
    await jest.advanceTimersByTimeAsync(1_000);
    expect(directSignal.aborted).toBe(true);
    expect(frontedSignal.aborted).toBe(false);

    // t=17s: fronted's OWN 15s budget (started at t=2s) elapses.
    await jest.advanceTimersByTimeAsync(2_000);
    expect(frontedSignal.aborted).toBe(true);

    // t=24s: the second GitHub mirror's own 10s budget (started at t=14s) elapses too. Every
    // source has now failed, so — exactly as before this change — the whole thing resolves to
    // an empty array rather than throwing.
    await jest.advanceTimersByTimeAsync(7_000);
    await expect(promise).resolves.toEqual([]);
  });

  it('passes a Host override header on the fronted attempt without disturbing abort wiring', async () => {
    jest.useFakeTimers();
    const fetchMock = abortableFetchMock();
    global.fetch = fetchMock as unknown as typeof fetch;

    const promise = fetchFreshBridges('webtunnel');
    await jest.advanceTimersByTimeAsync(2_000); // the fronted stagger elapses and it fires

    const frontedOpts = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect((frontedOpts.headers as Record<string, string>)['Host']).toBe(
      'bridges.torproject.org',
    );

    // Drain every remaining per-attempt timeout (and the GitHub mirror retry) so the promise
    // settles, keeping the test hygienic.
    await jest.advanceTimersByTimeAsync(30_000);
    await expect(promise).resolves.toEqual([]);
  });

  // (a) On a censored network, moat-direct is blocked BY DEFINITION — that's what "censored"
  // means here — so a real client sees exactly this: direct hangs/fails while fronted still
  // works. Sequentially, that cost the full 15s direct timeout (worst case 40-50s total, see
  // fetchFreshBridges' doc comment) before fronted was even tried. Concurrently, fronted starts
  // at its +2s stagger regardless of direct's fate and wins on its own schedule.
  it('when moat-direct hangs, moat-fronted (staggered at +2s) wins well before the 15s moat timeout', async () => {
    jest.useFakeTimers();
    const frontedJson = {
      data: [
        {settings: {bridges: {bridge_strings: ['obfs4 5.6.7.8:443 FRONTEDWINS cert=x iat-mode=0']}}},
      ],
    };
    global.fetch = jest.fn((url: string, opts?: RequestInit) => {
      if (url.includes('cdn77')) {
        return Promise.resolve({ok: true, json: async () => frontedJson} as unknown as Response);
      }
      // Direct never settles on its own, exactly like a censored network silently dropping the
      // connection instead of refusing it outright.
      return new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    const promise = fetchFreshBridges('obfs4');
    await jest.advanceTimersByTimeAsync(0); // direct fires, hangs
    await jest.advanceTimersByTimeAsync(2_000); // fronted's stagger elapses and it resolves

    // Resolved at ~2s of virtual time — nowhere near moat's 15s per-attempt timeout, let alone
    // the 40-50s worst case the old sequential ordering paid on exactly this kind of network.
    await expect(promise).resolves.toEqual(['obfs4 5.6.7.8:443 FRONTEDWINS cert=x iat-mode=0']);
  });

  // (b) Unchanged failure behavior: if every source fails (or comes back empty), the function
  // still resolves to [] rather than throwing, exactly as it did when the sources were tried
  // sequentially.
  it('returns [] when every source fails, exactly like the old sequential behavior', async () => {
    jest.useFakeTimers();
    global.fetch = jest.fn(async () => {
      throw new Error('network unreachable');
    }) as unknown as typeof fetch;

    const promise = fetchFreshBridges('obfs4');
    // Let direct, fronted, and the GitHub stagger (with both its mirrors) all fire and fail.
    await jest.advanceTimersByTimeAsync(4_000);
    await expect(promise).resolves.toEqual([]);
  });

  // (c) The concurrent race must have exactly one resolution point: a source that already
  // started before losing, and only succeeds LATE (after a different source already won and the
  // race was cancelled), must not be able to change what fetchFreshBridges resolved to. This is
  // what keeps a caller like syncTask.ts's bridge-cache write single — it reads the resolved
  // value exactly once, so if that value could still change afterwards the cache could end up
  // holding whichever source happened to finish last instead of the one that actually won.
  it('a losing source that already started and succeeds late cannot override an earlier winner (no double cache write)', async () => {
    jest.useFakeTimers();
    const winnerJson = {
      data: [
        {settings: {bridges: {bridge_strings: ['obfs4 2.2.2.2:443 FRONTEDWINS cert=f iat-mode=0']}}},
      ],
    };
    const loserJson = {
      data: [
        {settings: {bridges: {bridge_strings: ['obfs4 9.9.9.9:443 SLOWDIRECT cert=s iat-mode=0']}}},
      ],
    };

    global.fetch = jest.fn((url: string) => {
      if (url.includes('cdn77')) {
        // Fronted answers right when it fires, at t=2s.
        return Promise.resolve({ok: true, json: async () => winnerJson} as unknown as Response);
      }
      // Direct started at t=0 but its response only lands at t=9s — long after fronted already
      // won and the race was cancelled. Models a response that was already fully in flight off
      // the wire when the abort fired, so the abort couldn't stop it from resolving anyway.
      return new Promise(resolve => {
        setTimeout(
          () => resolve({ok: true, json: async () => loserJson} as unknown as Response),
          9_000,
        );
      });
    }) as unknown as typeof fetch;

    const promise = fetchFreshBridges('obfs4');
    await jest.advanceTimersByTimeAsync(2_000); // fronted fires and wins
    await expect(promise).resolves.toEqual(['obfs4 2.2.2.2:443 FRONTEDWINS cert=f iat-mode=0']);

    // Let direct's late response land too, well after the promise above already settled.
    await jest.advanceTimersByTimeAsync(7_000);
    await expect(promise).resolves.toEqual(['obfs4 2.2.2.2:443 FRONTEDWINS cert=f iat-mode=0']);
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

// T-refresh (2026-07-27): rdsys's actual Go source declares the moat response's `settings` as an
// ARRAY (`CircumventionSettings.Settings []Settings`, each holding one `Bridges BridgeSettings`) —
// confirmed via pkg.go.dev, since gitlab.torproject.org doesn't resolve from this dev sandbox. This
// file's parsing previously assumed a flat `settings.bridges` object. These tests pin both shapes so
// neither a real rdsys server nor a differently-shaped one can silently make every fetch return [].
describe('fetchFreshBridges — moat settings shape (rdsys Settings is an array)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('parses bridge_strings when settings is an ARRAY of {bridges} (the real rdsys Go shape)', async () => {
    const arrayShaped = {
      data: [
        {
          settings: [
            {
              bridges: {
                type: 'obfs4',
                source: 'bridgedb',
                bridge_strings: ['obfs4 9.9.9.9:443 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA cert=y iat-mode=0'],
              },
            },
          ],
        },
      ],
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => arrayShaped,
    })) as unknown as typeof fetch;

    const bridges = await fetchFreshBridges('obfs4', {frontedOnly: true});
    expect(bridges).toEqual([
      'obfs4 9.9.9.9:443 AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA cert=y iat-mode=0',
    ]);
  });

  it('concatenates bridge_strings across multiple settings array entries', async () => {
    const multiShaped = {
      data: [
        {
          settings: [
            {bridges: {bridge_strings: ['obfs4 1.1.1.1:443 A cert=a iat-mode=0']}},
            {bridges: {bridge_strings: ['obfs4 2.2.2.2:443 B cert=b iat-mode=0']}},
          ],
        },
      ],
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => multiShaped,
    })) as unknown as typeof fetch;

    const bridges = await fetchFreshBridges('obfs4', {frontedOnly: true});
    expect(bridges).toEqual([
      'obfs4 1.1.1.1:443 A cert=a iat-mode=0',
      'obfs4 2.2.2.2:443 B cert=b iat-mode=0',
    ]);
  });

  // T-refresh follow-up: the array-shape fix above concatenated bridge_strings across EVERY settings
  // entry with no regard for which transport each one actually belonged to, so a moat response
  // recommending more than one transport at once (nothing about the array shape rules that out) could
  // mix e.g. snowflake lines into an obfs4 request. moat's own `type` discriminator (rdsys
  // BridgeSettings.BridgeType, `json:"type"`) is what tells entries apart; these tests pin that a
  // mismatched entry is dropped while an untyped (legacy-shaped) entry is still trusted.
  it('drops entries whose type names a DIFFERENT transport than the one requested', async () => {
    const mixed = {
      data: [
        {
          settings: [
            {
              bridges: {
                type: 'snowflake',
                bridge_strings: ['snowflake 192.0.2.9:80 F cert=should-not-appear'],
              },
            },
            {
              bridges: {
                type: 'obfs4',
                bridge_strings: ['obfs4 4.4.4.4:443 D cert=d iat-mode=0'],
              },
            },
          ],
        },
      ],
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => mixed,
    })) as unknown as typeof fetch;

    const bridges = await fetchFreshBridges('obfs4', {frontedOnly: true});
    expect(bridges).toEqual(['obfs4 4.4.4.4:443 D cert=d iat-mode=0']);
  });

  it('still trusts an entry with no type discriminator (legacy/undocumented shape) even alongside a mismatched one', async () => {
    const untypedPlusMismatched = {
      data: [
        {
          settings: [
            // No `type` at all — the pre-existing flat shape never carried one; treated as a match.
            {bridges: {bridge_strings: ['obfs4 5.5.5.5:443 E cert=e iat-mode=0']}},
            {bridges: {type: 'snowflake', bridge_strings: ['snowflake 192.0.2.10:80 G cert=g']}},
          ],
        },
      ],
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => untypedPlusMismatched,
    })) as unknown as typeof fetch;

    const bridges = await fetchFreshBridges('obfs4', {frontedOnly: true});
    expect(bridges).toEqual(['obfs4 5.5.5.5:443 E cert=e iat-mode=0']);
  });

  it('returns [] rather than throwing when every entry is for a different transport', async () => {
    const allWrongType = {
      data: [{settings: [{bridges: {type: 'snowflake', bridge_strings: ['snowflake 192.0.2.11:80 H']}}]}],
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => allWrongType,
    })) as unknown as typeof fetch;

    await expect(fetchFreshBridges('obfs4', {frontedOnly: true})).resolves.toEqual([]);
  });

  it('still parses the pre-existing flat (non-array) settings.bridges shape', async () => {
    const flatShaped = {
      data: [{settings: {bridges: {bridge_strings: ['obfs4 3.3.3.3:443 C cert=c iat-mode=0']}}}],
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => flatShaped,
    })) as unknown as typeof fetch;

    const bridges = await fetchFreshBridges('obfs4', {frontedOnly: true});
    expect(bridges).toEqual(['obfs4 3.3.3.3:443 C cert=c iat-mode=0']);
  });

  it('returns [] (never throws) when settings is present but every bridges/bridge_strings is missing', async () => {
    const empty = {data: [{settings: []}]};
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => empty,
    })) as unknown as typeof fetch;

    await expect(fetchFreshBridges('obfs4', {frontedOnly: true})).resolves.toEqual([]);
  });
});

/**
 * WEBTUNNEL is the transport that still evades the DPI obfs4 no longer does, and until 2026-07-27
 * it had exactly ONE source in this file (moat) — which is blocked on precisely the networks that
 * need webtunnel — plus no bundled fallback set at all (bridges.ts::DEFAULT_WEBTUNNEL_BRIDGES is
 * empty, and Tor Project publishes no builtin webtunnel set to copy). The GitHub collector hop was
 * skipped for it on the mistaken belief that its lines were anonymised; a webtunnel line's address
 * is a PLACEHOLDER by design (the client dials `url=`), which is what BridgeDB itself hands out.
 * These tests pin the hop, the placeholder-address shape, and the collector-only hardening.
 */
describe('webtunnel bridge supply', () => {
  // Real-shaped lines: RFC 3849 documentation IPv6 in brackets, 40-hex fingerprint, url=, ver=.
  const WT_A =
    'webtunnel [2001:db8:1b75:cd28:36c7:1347:3eda:a01e]:443 ' +
    '2852538D49D7D73C1A6694FC492104983A9C4FA2 url=https://example.net/IfuJ9KsjkEk6462QblGNI0pR ver=0.0.3';
  const WT_A_OLD = WT_A.replace('ver=0.0.3', 'ver=0.0.1');
  const WT_B =
    'webtunnel 10.0.0.2:443 F76C85011FD8C113AA00960BD9FC7F5B66F726A2 ' +
    'url=https://example.org/vM8i19mU4gvHOzRm33DaBNuM';

  describe('githubBridgeLines', () => {
    it('keeps real webtunnel lines, including placeholder IPv6 and RFC1918 addresses', () => {
      expect(githubBridgeLines(`${WT_A}\n${WT_B}\n`, 'webtunnel')).toEqual([WT_A, WT_B]);
    });

    it('collapses one bridge repeated at several ver= values to its NEWEST line', () => {
      // Same fingerprint twice — the collector records a bridge's history, not two bridges.
      expect(githubBridgeLines(`${WT_A_OLD}\n${WT_A}\n`, 'webtunnel')).toEqual([WT_A]);
      // Order-independent: the newest wins even when it comes first.
      expect(githubBridgeLines(`${WT_A}\n${WT_A_OLD}\n`, 'webtunnel')).toEqual([WT_A]);
    });

    it('drops lines belonging to another transport, and malformed ones', () => {
      const mixed = [
        WT_A,
        'obfs4 1.2.3.4:443 0000000000000000000000000000000000000000 cert=x iat-mode=0',
        'webtunnel not-a-bridge',
        '',
        '# a comment the collector may prepend',
      ].join('\n');
      expect(githubBridgeLines(mixed, 'webtunnel')).toEqual([WT_A]);
    });

    it('still filters the obfs4 list by transport', () => {
      const obfs4 =
        'obfs4 1.2.3.4:443 0000000000000000000000000000000000000000 cert=x iat-mode=0';
      expect(githubBridgeLines(`${obfs4}\n${WT_A}\n`, 'obfs4')).toEqual([obfs4]);
    });
  });

  describe('fetchFreshBridges — GitHub collector hop for webtunnel', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
      jest.restoreAllMocks();
    });

    it('falls back to the collector when BOTH moat hops fail, and returns webtunnel lines', async () => {
      const seen: string[] = [];
      global.fetch = jest.fn(async (url: string) => {
        seen.push(url);
        if (url.includes('bridges-webtunnel')) {
          return {ok: true, text: async () => `${WT_A}\n${WT_A_OLD}\n${WT_B}\n`} as unknown as Response;
        }
        throw new Error('moat blocked');
      }) as unknown as typeof fetch;

      const promise = fetchFreshBridges('webtunnel');
      // Direct and fronted fail immediately once they fire; let the GitHub stagger (+4s) elapse
      // too so its (winning) attempt actually starts — the three source groups run concurrently
      // now, so nothing here happens without advancing past every earlier source's stagger.
      await jest.advanceTimersByTimeAsync(4_000);
      const bridges = await promise;

      expect(seen).toHaveLength(3); // direct moat, fronted moat, collector (first mirror wins)
      expect(seen[2]).toContain('bridges-webtunnel');
      // Both bridges survive (order is shuffled per client), with WT_A collapsed to its newest ver.
      expect([...bridges].sort()).toEqual([WT_A, WT_B].sort());
    });

    it('NEVER uses the non-fronted collector hop in frontedOnly mode (audit #50)', async () => {
      const seen: string[] = [];
      global.fetch = jest.fn(async (url: string) => {
        seen.push(url);
        throw new Error('moat blocked');
      }) as unknown as typeof fetch;

      await expect(fetchFreshBridges('webtunnel', {frontedOnly: true})).resolves.toEqual([]);
      expect(seen).toHaveLength(1);
      expect(seen.some(u => u.includes('githubusercontent.com'))).toBe(false);
    });

    it('has no collector hop for snowflake (its reachability comes from the bundled broker)', async () => {
      const seen: string[] = [];
      global.fetch = jest.fn(async (url: string) => {
        seen.push(url);
        throw new Error('moat blocked');
      }) as unknown as typeof fetch;

      const promise = fetchFreshBridges('snowflake');
      // snowflake has no GitHub collector hop, but fronted still needs its +2s stagger to fire
      // (direct and fronted are the only two source groups, running concurrently).
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(promise).resolves.toEqual([]);
      expect(seen).toHaveLength(2); // the two moat hops only
    });
  });
});
