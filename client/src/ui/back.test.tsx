/**
 * The back registry's own contract (ui/back.tsx).
 *
 * These pin the two things the rest of the app's back behaviour is built on and which are easy to
 * break by accident:
 *
 *  1. RESOLUTION ORDER — highest priority first, ties to the most recently registered. It is an
 *     explicit tier rather than mount order because React runs effects CHILD-FIRST, so a parent and
 *     child mounting in the same commit register in the reverse of the order a reader expects.
 *  2. SCOPE ISOLATION — on Android a <Modal> is a separate Dialog window that consumes the back key
 *     itself, so actions registered inside one must be invisible to the root BackHandler, and the
 *     screen underneath must be invisible to that modal's onRequestClose. Getting this wrong is
 *     silent: back simply peels the wrong surface.
 */
import 'react-native';
import React from 'react';
import {Alert, BackHandler, Text} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {BACK_PRIORITY, BackModal, RootBackScope, useBackAction, useBackDismiss} from './back';

/** Captures the single hardwareBackPress listener RootBackScope installs. */
function captureBack(): () => boolean {
  const handlers: Array<() => boolean> = [];
  jest.spyOn(BackHandler, 'addEventListener').mockImplementation(((_e: string, cb: () => boolean) => {
    handlers.push(cb);
    return {remove: jest.fn()};
  }) as unknown as typeof BackHandler.addEventListener);
  return () => handlers[handlers.length - 1]!();
}

/** A leaf that registers one back action — the shape every real caller uses. */
function Action({
  on,
  priority,
  enabled = true,
  consume = true,
}: {
  on: () => void;
  priority?: number;
  enabled?: boolean;
  consume?: boolean;
}): React.JSX.Element {
  useBackAction(
    () => {
      on();
      return consume;
    },
    {enabled, priority},
  );
  return <Text>action</Text>;
}

afterEach(() => jest.restoreAllMocks());

describe('useBackAction — resolution order', () => {
  it('runs the highest priority first, whatever order things mounted in', () => {
    const back = captureBack();
    const calls: string[] = [];
    act(() => {
      renderer.create(
        <RootBackScope>
          {/* Registered FIRST but lowest priority — must still lose to the sheet below. */}
          <Action on={() => calls.push('root')} priority={BACK_PRIORITY.root} />
          <Action on={() => calls.push('sheet')} priority={BACK_PRIORITY.sheet} />
        </RootBackScope>,
      );
    });

    act(() => {
      expect(back()).toBe(true);
    });
    expect(calls).toEqual(['sheet']);
  });

  it('breaks ties LIFO — whatever opened last is on top', () => {
    const back = captureBack();
    const calls: string[] = [];
    act(() => {
      renderer.create(
        <RootBackScope>
          <Action on={() => calls.push('first')} priority={BACK_PRIORITY.page} />
          <Action on={() => calls.push('second')} priority={BACK_PRIORITY.page} />
        </RootBackScope>,
      );
    });

    act(() => { back(); });
    expect(calls).toEqual(['second']);
  });

  it('falls through a handler that declines, and reports unhandled when everything declines', () => {
    const back = captureBack();
    const calls: string[] = [];
    act(() => {
      renderer.create(
        <RootBackScope>
          <Action on={() => calls.push('root')} priority={BACK_PRIORITY.root} consume={false} />
          <Action on={() => calls.push('page')} priority={BACK_PRIORITY.page} consume={false} />
        </RootBackScope>,
      );
    });

    // Contract rule 4: nothing consumed → false, so RN runs the default and the app backgrounds.
    let handled = true;
    act(() => {
      handled = back();
    });
    expect(handled).toBe(false);
    expect(calls).toEqual(['page', 'root']);
  });

  it('skips disabled actions', () => {
    const back = captureBack();
    const calls: string[] = [];
    act(() => {
      renderer.create(
        <RootBackScope>
          <Action on={() => calls.push('root')} priority={BACK_PRIORITY.root} />
          <Action on={() => calls.push('off')} priority={BACK_PRIORITY.sheet} enabled={false} />
        </RootBackScope>,
      );
    });

    act(() => { back(); });
    expect(calls).toEqual(['root']);
  });

  it('unregisters on unmount, so a closed surface never answers a later press', () => {
    const back = captureBack();
    const calls: string[] = [];
    function Host({open}: {open: boolean}): React.JSX.Element {
      return (
        <RootBackScope>
          <Action on={() => calls.push('root')} priority={BACK_PRIORITY.root} />
          {open ? <Action on={() => calls.push('overlay')} priority={BACK_PRIORITY.sheet} /> : null}
        </RootBackScope>
      );
    }
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(<Host open />);
    });
    act(() => { back(); });
    expect(calls).toEqual(['overlay']);

    act(() => {
      tree.update(<Host open={false} />);
    });
    act(() => { back(); });
    expect(calls).toEqual(['overlay', 'root']);
  });

  it('always runs the LATEST closure, never the one captured at registration', () => {
    const back = captureBack();
    const seen: number[] = [];
    function Counting({n}: {n: number}): React.JSX.Element {
      useBackAction(() => {
        seen.push(n);
        return true;
      });
      return <Text>{n}</Text>;
    }
    let tree!: renderer.ReactTestRenderer;
    act(() => {
      tree = renderer.create(
        <RootBackScope>
          <Counting n={1} />
        </RootBackScope>,
      );
    });
    act(() => {
      tree.update(
        <RootBackScope>
          <Counting n={2} />
        </RootBackScope>,
      );
    });

    act(() => { back(); });
    expect(seen).toEqual([2]);
  });
});

describe('BackModal — one scope per window', () => {
  it('a modal action is invisible to the root BackHandler (the Dialog owns that key)', () => {
    const back = captureBack();
    const calls: string[] = [];
    act(() => {
      renderer.create(
        <RootBackScope>
          <Action on={() => calls.push('screen')} priority={BACK_PRIORITY.root} />
          <BackModal visible onClose={() => calls.push('close')}>
            <Action on={() => calls.push('inModal')} priority={BACK_PRIORITY.sheet} />
          </BackModal>
        </RootBackScope>,
      );
    });

    // The real key never reaches here while a Modal is up; if it somehow did, it must NOT reach
    // into the modal's scope.
    act(() => { back(); });
    expect(calls).toEqual(['screen']);
  });

  it('onRequestClose resolves children first, then onBack, then onClose', () => {
    const calls: string[] = [];
    let tree!: renderer.ReactTestRenderer;
    function Host({deep}: {deep: boolean}): React.JSX.Element {
      return (
        <BackModal
          visible
          onClose={() => calls.push('close')}
          onBack={() => {
            calls.push('onBack');
            return deep; // consume only while the inner page is open
          }}>
          {deep ? <Action on={() => calls.push('child')} priority={BACK_PRIORITY.sheet} /> : null}
        </BackModal>
      );
    }
    act(() => {
      tree = renderer.create(<Host deep />);
    });
    const requestClose = (): void => {
      const modal = tree.root.findAll(n => typeof n.props?.onRequestClose === 'function')[0]!;
      act(() => modal.props.onRequestClose());
    };

    requestClose();
    expect(calls).toEqual(['child']); // deepest wins; onBack/onClose untouched

    act(() => {
      tree.update(<Host deep={false} />);
    });
    requestClose();
    // No child left, and onBack declines → the modal closes.
    expect(calls).toEqual(['child', 'onBack', 'close']);
  });
});

describe('useBackDismiss — typed work is never lost silently', () => {
  function Form({dirty, onDiscard}: {dirty: boolean; onDiscard: () => void}): React.JSX.Element {
    const dismiss = useBackDismiss(dirty, onDiscard);
    useBackAction(() => {
      dismiss();
      return true;
    });
    return <Text>form</Text>;
  }

  it('closes a pristine form immediately, with no dialog', () => {
    const back = captureBack();
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => undefined);
    const discard = jest.fn();
    act(() => {
      renderer.create(
        <RootBackScope>
          <Form dirty={false} onDiscard={discard} />
        </RootBackScope>,
      );
    });

    act(() => { back(); });
    expect(discard).toHaveBeenCalledTimes(1);
    expect(alert).not.toHaveBeenCalled();
  });

  it('asks before discarding a dirty one, and only discards on the destructive button', () => {
    const back = captureBack();
    const discard = jest.fn();
    let buttons: Array<{text?: string; style?: string; onPress?: () => void}> = [];
    jest.spyOn(Alert, 'alert').mockImplementation(((_t: string, _m?: string, b?: unknown) => {
      buttons = (b ?? []) as typeof buttons;
    }) as unknown as typeof Alert.alert);
    act(() => {
      renderer.create(
        <RootBackScope>
          <Form dirty onDiscard={discard} />
        </RootBackScope>,
      );
    });

    act(() => { back(); });
    expect(discard).not.toHaveBeenCalled();

    // The cancel button must be the SAFE one — pressing it keeps the work.
    const cancel = buttons.find(x => x.style === 'cancel')!;
    act(() => { cancel.onPress?.(); });
    expect(discard).not.toHaveBeenCalled();

    act(() => { buttons.find(x => x.style === 'destructive')!.onPress!(); });
    expect(discard).toHaveBeenCalledTimes(1);
  });
});
