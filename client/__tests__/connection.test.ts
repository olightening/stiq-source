import {
  connectionLabel,
  describeConnection,
  isOnline,
  phaseAwareLabel,
} from '../src/connection';
import {AUTO_LADDER, describePhase} from '../src/tor/ladder';

describe('connection state model', () => {
  it('only reports online for a live Tor circuit', () => {
    expect(isOnline('connected')).toBe(true);
    expect(isOnline('disconnected')).toBe(false);
    expect(isOnline('starting-tor')).toBe(false);
    expect(isOnline('connecting-bridge')).toBe(false);
    expect(isOnline('offline')).toBe(false);
  });

  it('labels every state', () => {
    expect(describeConnection('connected')).toMatch(/Tor/);
    expect(describeConnection('offline')).toMatch(/Offline/);
    expect(describeConnection('disconnected')).toBe('Disconnected');
  });
});

describe('phaseAwareLabel (T2 guided ladder)', () => {
  // A realistic stiq-authored phase for the obfs4 rung hitting its ceiling.
  const phase = describePhase(AUTO_LADDER[1]!, 'ceiling-exceeded');

  it('surfaces the phase plainLabel for connecting/offline states when a phase is supplied', () => {
    expect(phaseAwareLabel('starting-tor', phase)).toBe(phase.plainLabel);
    expect(phaseAwareLabel('connecting-bridge', phase)).toBe(phase.plainLabel);
    expect(phaseAwareLabel('offline', phase)).toBe(phase.plainLabel);
  });

  it('does NOT hijack the connected state (feed-gate label stays honest)', () => {
    // 'connected' is not a connecting/offline state, so the phase must never override it.
    expect(phaseAwareLabel('connected', phase)).toBe(connectionLabel('connected'));
    expect(phaseAwareLabel('connected', phase)).toBe('Connected via Tor');
  });

  it('falls back to connectionLabel(state, percent) when no phase is supplied', () => {
    expect(phaseAwareLabel('starting-tor', null, 45)).toBe(connectionLabel('starting-tor', 45));
    expect(phaseAwareLabel('starting-tor', null, 45)).toBe('Connecting through Tor · 45%');
    expect(phaseAwareLabel('offline', undefined)).toBe(connectionLabel('offline'));
    expect(phaseAwareLabel('offline', undefined)).toBe(describeConnection('offline'));
  });
});
