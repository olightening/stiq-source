/**
 * RichEditor — the RN wrapper around the sandboxed WebView editor (richEditorHtml.ts). These tests
 * exercise the host<->page bridge itself (RichEditor.tsx), not the page's own markdown dialect (see
 * richEditorHtml.test.ts) or the renderer (RichText.test.tsx).
 *
 * Uses the shared react-native-webview jest mock (__mocks__/react-native-webview.js, wired via
 * moduleNameMapper), upgraded to actually forward a ref exposing postMessage/injectJavaScript/
 * requestFocus — the real package does this at runtime even though it's typed as a plain
 * FunctionComponent. Every `postMessage` call the component makes
 * lands in the mock's module-level `__posted` array, read here via `require` (untyped, since the real
 * package's .d.ts doesn't declare it).
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {WebView} from 'react-native-webview';
import {RichEditor, type RichEditorHandle} from './RichEditor';

const webViewMock = require('react-native-webview') as {__posted: string[]; __resetPosted: () => void};

/** Simulate a message arriving FROM the page (the WebView's own bridge callback). */
function fireMessage(tree: renderer.ReactTestRenderer, payload: Record<string, unknown>): void {
  const web = tree.root.findByType(WebView as unknown as React.ComponentType<Record<string, unknown>>);
  act(() => {
    (web.props as {onMessage: (e: {nativeEvent: {data: string}}) => void}).onMessage({
      nativeEvent: {data: JSON.stringify(payload)},
    });
  });
}

/** The exact postMessage payload a `send({...})` call produces — for equality checks against __posted. */
function wire(msg: Record<string, unknown>): string {
  return JSON.stringify(msg);
}

beforeEach(() => { webViewMock.__resetPosted(); });

describe('RichEditor: commands issued before "ready" are queued, not silently dropped (Bug 4)', () => {
  // The user-reported "Add link says click to add and it won't do anything" bug: send() checked
  // `ready.current` and, if the page hadn't announced 'ready' yet (WebView still loading — the
  // composer's very first render, or after a reload), just returned — no queue, no retry, no error.
  // An eager tap right as the composer opens vanished with no trace.

  it('insertLink issued before "ready" posts nothing yet, then lands the instant "ready" arrives', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    act(() => { edRef.current!.insertLink('example', 'https://example.com'); });
    expect(webViewMock.__posted).toEqual([]); // queued, not sent — the page isn't listening yet

    fireMessage(tree, {type: 'ready'});
    expect(webViewMock.__posted).toEqual([wire({type: 'insertLink', text: 'example', url: 'https://example.com'})]);
  });

  it('flushes MULTIPLE queued commands in the order they were issued', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    act(() => {
      edRef.current!.insertToken('nostr:note1abc');
      edRef.current!.cmd('bold');
    });
    expect(webViewMock.__posted).toEqual([]);

    fireMessage(tree, {type: 'ready'});
    expect(webViewMock.__posted).toEqual([
      wire({type: 'insertToken', token: 'nostr:note1abc'}),
      wire({type: 'cmd', name: 'bold'}),
    ]);
  });

  it('once ready, a command sends immediately — no queueing needed', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    fireMessage(tree, {type: 'ready'});
    webViewMock.__resetPosted();
    act(() => { edRef.current!.insertLink('t', 'https://example.com'); });
    expect(webViewMock.__posted).toEqual([wire({type: 'insertLink', text: 't', url: 'https://example.com'})]);
  });
});

describe('RichEditor: the push-back effect never pushes a value stale relative to a newer page report (Bug 3)', () => {
  // Root cause: RichEditor.tsx's onMessage 'change' handler writes `lastMd.current` SYNCHRONOUSLY the
  // instant a message arrives, then calls onChange (a setState, applied later on commit). The
  // push-back effect — `useEffect(() => { if (value !== lastMd.current) pushValue(value) }, [value])`
  // — can run for an OLDER render (closed over a stale `value`) AFTER a NEWER 'change' message has
  // already advanced `lastMd.current` — useEffect is a PASSIVE effect, scheduled to run AFTER commit,
  // not synchronously with it, so there is a real gap in which a bridge message can land. The naive
  // comparison then reads as "the parent wants to push something new" for the wrong reason (render
  // lag, not a real external change) and overwrites the page's newer content — and everything typed
  // since — with stale text.
  //
  // React guarantees layout effects (useLayoutEffect) for a commit run BEFORE any passive effects
  // (useEffect) for that SAME commit — that ordering is the one lever available to reproduce the race
  // deterministically under `act()` (which otherwise settles render+effects as one atomic unit,
  // exactly to keep tests from depending on real scheduler timing): a sibling `Injector` fires a raw
  // 'change' message from a useLayoutEffect, landing AFTER RichEditor's render (so its `value` prop is
  // fixed at "external value") but BEFORE RichEditor's own push-back useEffect for that same commit —
  // precisely the gap the real bug lives in.
  function Injector({armed, onFire}: {armed: boolean; onFire: () => void}): null {
    React.useLayoutEffect(() => {
      if (armed) onFire();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- fire exactly once, when `armed` flips true
    }, [armed]);
    return null;
  }

  it('does not postMessage a stale setMarkdown when a newer "change" lands before the effect flushes', () => {
    let tree!: renderer.ReactTestRenderer;
    const findWeb = (): renderer.ReactTestInstance =>
      tree.root.findByType(WebView as unknown as React.ComponentType<Record<string, unknown>>);
    act(() => {
      tree = renderer.create(
        <>
          <RichEditor value="" onChange={() => {}} />
          <Injector armed={false} onFire={() => {}} />
        </>,
      );
    });
    fireMessage(tree, {type: 'ready'});
    fireMessage(tree, {type: 'change', md: 'settled'}); // establishes a baseline the page + RN agree on
    webViewMock.__resetPosted();

    act(() => {
      tree.update(
        <>
          <RichEditor value="external value" onChange={() => {}} />
          {/* Fires from a layout effect on THIS SAME commit — strictly before RichEditor's own
              (passive) push-back effect for value="external value" gets a chance to run. */}
          <Injector
            armed
            onFire={() => {
              (findWeb().props as {onMessage: (e: {nativeEvent: {data: string}}) => void}).onMessage({
                nativeEvent: {data: JSON.stringify({type: 'change', md: 'page raced ahead'})},
              });
            }}
          />
        </>,
      );
    });

    expect(webViewMock.__posted).not.toContain(wire({type: 'setMarkdown', md: 'external value'}));
  });

  it('sanity: WITHOUT a race, a genuinely new external value still pushes through', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    fireMessage(tree, {type: 'ready'});
    fireMessage(tree, {type: 'change', md: 'settled'});
    webViewMock.__resetPosted();

    // No race this time — value changes and settles with nothing else happening in between.
    act(() => {
      tree.update(<RichEditor ref={edRef} value="a fresh draft loaded" onChange={() => {}} />);
    });
    expect(webViewMock.__posted).toContain(wire({type: 'setMarkdown', md: 'a fresh draft loaded'}));
  });
});

describe('RichEditor.requestMarkdown: bounded retry, not a single 250ms race (Bug 5, incidental/bad)', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('does NOT resolve with a stale value at 250ms — a slow phone gets more time before falling back', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    fireMessage(tree, {type: 'ready'});
    fireMessage(tree, {type: 'change', md: 'typed so far'});
    webViewMock.__resetPosted();

    const cb = jest.fn();
    act(() => { edRef.current!.requestMarkdown(cb); });
    expect(webViewMock.__posted).toEqual([wire({type: 'flush'})]);

    // The old code raced a single fixed setTimeout(…, 250) that resolved with lastMd.current here —
    // that must be gone.
    act(() => { jest.advanceTimersByTime(250); });
    expect(cb).not.toHaveBeenCalled();
  });

  it('retries the flush request on a bounded interval while waiting for the real ack', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    fireMessage(tree, {type: 'ready'});
    webViewMock.__resetPosted();

    act(() => { edRef.current!.requestMarkdown(jest.fn()); });
    act(() => { jest.advanceTimersByTime(1000); }); // several retry intervals, still short of the bound
    const flushCount = webViewMock.__posted.filter(m => m === wire({type: 'flush'})).length;
    expect(flushCount).toBeGreaterThanOrEqual(2); // the initial ask PLUS at least one retry
  });

  it('the real "flushed" ack — even a slow one — wins over the fallback and carries the final keystrokes', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    fireMessage(tree, {type: 'ready'});
    fireMessage(tree, {type: 'change', md: 'stale'});

    const cb = jest.fn();
    act(() => { edRef.current!.requestMarkdown(cb); });
    act(() => { jest.advanceTimersByTime(700); }); // past 250ms AND past one retry — still no answer
    expect(cb).not.toHaveBeenCalled();

    // The page finally answers, slow but real, with content the 250ms-race would have missed.
    fireMessage(tree, {type: 'flushed', md: 'the real content including the last keystrokes'});
    expect(cb).toHaveBeenCalledWith('the real content including the last keystrokes');
    expect(cb).toHaveBeenCalledTimes(1);

    // A retry firing AFTER the real answer must not call back a second time.
    act(() => { jest.advanceTimersByTime(3000); });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('still falls back to the last known value if the page never answers at all — bounded, not indefinite', () => {
    const edRef = React.createRef<RichEditorHandle>();
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<RichEditor ref={edRef} value="" onChange={() => {}} />);
    });
    fireMessage(tree, {type: 'ready'});
    fireMessage(tree, {type: 'change', md: 'last known'});

    const cb = jest.fn();
    act(() => { edRef.current!.requestMarkdown(cb); });
    act(() => { jest.advanceTimersByTime(10000); }); // well past the retry bound
    expect(cb).toHaveBeenCalledWith('last known');
    expect(cb).toHaveBeenCalledTimes(1);
  });
});
