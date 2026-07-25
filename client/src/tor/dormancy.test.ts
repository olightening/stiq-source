import {torActive, torDormant} from './dormancy';

describe('tor dormancy wrappers', () => {
  it('torDormant() calls the injected setDormant exactly once and reports success', () => {
    const setDormant = jest.fn();
    const setActive = jest.fn();
    // Returns true only when the native signal was actually delivered — the caller's cue that the
    // daemon was idled (rather than needing the teardown fallback).
    expect(torDormant({setDormant, setActive})).toBe(true);
    expect(setDormant).toHaveBeenCalledTimes(1);
    // Only the dormant transition fires — active is left untouched.
    expect(setActive).not.toHaveBeenCalled();
  });

  it('torActive() calls the injected setActive exactly once and reports success', () => {
    const setDormant = jest.fn();
    const setActive = jest.fn();
    expect(torActive({setDormant, setActive})).toBe(true);
    expect(setActive).toHaveBeenCalledTimes(1);
    expect(setDormant).not.toHaveBeenCalled();
  });

  it('returns false (no throw) when the injected native object is undefined', () => {
    // A false return is what drives App.tsx to fall back to a force-kill teardown.
    expect(torDormant(undefined)).toBe(false);
    expect(torActive(undefined)).toBe(false);
  });

  it('returns false (no throw) when the native object lacks the method', () => {
    expect(torDormant({})).toBe(false);
    expect(torActive({})).toBe(false);
  });

  it('returns false (no throw) when a present method throws', () => {
    const boom = () => {
      throw new Error('control socket unavailable');
    };
    expect(torDormant({setDormant: boom})).toBe(false);
    expect(torActive({setActive: boom})).toBe(false);
  });

  it('returns false with the default param when the native module is absent (jest/non-Android)', () => {
    // NativeModules.StiqTor is undefined under jest, so the default-arg path must be a safe no-op.
    expect(torDormant()).toBe(false);
    expect(torActive()).toBe(false);
  });
});
