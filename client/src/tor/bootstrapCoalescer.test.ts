import {createBootstrapCoalescer} from './bootstrapCoalescer';

describe('createBootstrapCoalescer', () => {
  afterEach(() => jest.useRealTimers());

  it('flushes the FIRST push immediately (the bar is never blank for throttleMs)', () => {
    jest.useFakeTimers();
    const flush = jest.fn();
    const c = createBootstrapCoalescer(flush, 150);
    c.push({percent: 5});
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith({percent: 5});
    c.dispose();
  });

  it('coalesces a burst within the window to ONE trailing flush carrying the LATEST value', () => {
    jest.useFakeTimers();
    const flush = jest.fn();
    const c = createBootstrapCoalescer(flush, 150);
    c.push({percent: 5}); // first → immediate
    flush.mockClear();
    c.push({percent: 20});
    c.push({percent: 35});
    c.push({percent: 50});
    expect(flush).not.toHaveBeenCalled(); // throttled within the window
    jest.advanceTimersByTime(150);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith({percent: 50}); // the latest, never an earlier one
    c.dispose();
  });

  it('force-flushes at percent>=100 mid-window and cancels the pending trailing flush', () => {
    jest.useFakeTimers();
    const flush = jest.fn();
    const c = createBootstrapCoalescer(flush, 150);
    c.push({percent: 5}); // first → immediate
    flush.mockClear();
    c.push({percent: 60}); // schedules a trailing flush
    c.push({percent: 100}); // terminal → immediate flush AND cancels the pending 60%
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith({percent: 100});
    jest.advanceTimersByTime(150);
    expect(flush).toHaveBeenCalledTimes(1); // the 60% trailing flush was cancelled
    expect(jest.getTimerCount()).toBe(0);
    c.dispose();
  });

  it('reset() drops a pending flush without flushing, and re-arms first-push-immediate', () => {
    jest.useFakeTimers();
    const flush = jest.fn();
    const c = createBootstrapCoalescer(flush, 150);
    c.push({percent: 5}); // first → immediate
    c.push({percent: 40}); // pending (scheduled)
    flush.mockClear();
    c.reset(); // disconnect: drop the queued 40% so it can't flash back
    jest.advanceTimersByTime(150);
    expect(flush).not.toHaveBeenCalled();
    // A new attempt's first push flushes immediately again.
    c.push({percent: 2});
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith({percent: 2});
    c.dispose();
  });

  it('dispose() cancels a pending flush', () => {
    jest.useFakeTimers();
    const flush = jest.fn();
    const c = createBootstrapCoalescer(flush, 150);
    c.push({percent: 5});
    flush.mockClear();
    c.push({percent: 30}); // pending
    c.dispose();
    jest.advanceTimersByTime(150);
    expect(flush).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });
});
