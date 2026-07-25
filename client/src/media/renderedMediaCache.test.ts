import {
  getRenderedMedia,
  putRenderedMedia,
  renderedMediaSize,
  renderedMediaGeneration,
  subscribeRenderedMedia,
  clearRenderedMedia,
} from './renderedMediaCache';

// The cache is a process-global; clear it before each test so cases don't leak into one another.
beforeEach(() => {
  clearRenderedMedia();
});

describe('renderedMediaCache', () => {
  it('stores and reads back a rendered data URI by key', () => {
    expect(getRenderedMedia('url:a')).toBeUndefined();
    putRenderedMedia('url:a', 'data:image/png;base64,AAA');
    expect(getRenderedMedia('url:a')).toBe('data:image/png;base64,AAA');
    expect(renderedMediaSize()).toBe(1);
  });

  it('clearRenderedMedia empties the cache and returns the number of entries dropped', () => {
    putRenderedMedia('url:a', 'x');
    putRenderedMedia('sha:b', 'y');
    expect(renderedMediaSize()).toBe(2);
    expect(clearRenderedMedia()).toBe(2);
    expect(renderedMediaSize()).toBe(0);
    expect(getRenderedMedia('url:a')).toBeUndefined();
  });

  it('bumps the generation counter on every clear', () => {
    const g0 = renderedMediaGeneration();
    clearRenderedMedia();
    clearRenderedMedia();
    expect(renderedMediaGeneration()).toBe(g0 + 2);
  });

  it('notifies subscribers on clear, and stops after unsubscribe', () => {
    const fn = jest.fn();
    const off = subscribeRenderedMedia(fn);
    clearRenderedMedia();
    clearRenderedMedia();
    expect(fn).toHaveBeenCalledTimes(2);
    off();
    clearRenderedMedia();
    expect(fn).toHaveBeenCalledTimes(2); // no further calls once unsubscribed
  });

  it('a throwing subscriber never blocks the clear or other subscribers', () => {
    const good = jest.fn();
    subscribeRenderedMedia(() => {
      throw new Error('boom');
    });
    subscribeRenderedMedia(good);
    putRenderedMedia('url:a', 'x');
    expect(() => clearRenderedMedia()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(renderedMediaSize()).toBe(0); // the cache was still emptied despite the throwing listener
  });
});
