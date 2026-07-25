import {clearRecentLogs, getRecentLogs, log} from './log';

describe('log', () => {
  beforeEach(() => {
    clearRecentLogs();
  });

  it('records info/warn/error entries with ts, level, scope, msg', () => {
    log.info('scopeA', 'hello', 1);
    log.warn('scopeB', 'careful');
    log.error('scopeC', 'boom');

    const entries = getRecentLogs();
    expect(entries).toHaveLength(3);
    const [first, second, third] = entries;

    expect(first?.level).toBe('info');
    expect(first?.scope).toBe('scopeA');
    expect(first?.msg).toContain('hello');
    expect(first?.msg).toContain('1');
    expect(typeof first?.ts).toBe('number');

    expect(second?.level).toBe('warn');
    expect(second?.scope).toBe('scopeB');
    expect(second?.msg).toBe('careful');

    expect(third?.level).toBe('error');
    expect(third?.scope).toBe('scopeC');
    expect(third?.msg).toBe('boom');
  });

  it('serializes non-string args and Error messages', () => {
    log.info('scope', {a: 1});
    log.info('scope', new Error('bad thing'));

    const entries = getRecentLogs();
    const [first, second] = entries;
    expect(first?.msg).toContain('"a":1');
    expect(second?.msg).toBe('bad thing');
  });

  it('bounds the ring buffer to ~200 entries, evicting the oldest first', () => {
    for (let i = 0; i < 250; i++) {
      log.info('scope', `entry-${i}`);
    }
    const entries = getRecentLogs();
    expect(entries).toHaveLength(200);
    // oldest 50 (entry-0..entry-49) were evicted; entry-50 is now the oldest survivor.
    expect(entries[0]?.msg).toBe('entry-50');
    expect(entries[entries.length - 1]?.msg).toBe('entry-249');
  });

  it('getRecentLogs returns a snapshot, not a live reference', () => {
    log.info('scope', 'one');
    const snapshot = getRecentLogs();
    log.info('scope', 'two');
    expect(snapshot).toHaveLength(1);
    expect(getRecentLogs()).toHaveLength(2);
  });

  it('clearRecentLogs empties the buffer', () => {
    log.info('scope', 'one');
    clearRecentLogs();
    expect(getRecentLogs()).toHaveLength(0);
  });
});
