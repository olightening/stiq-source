import {setActiveMemberRoll, getActiveMemberRoll, getMemberRollVersion} from './memberRoll';

describe('memberRoll — active-roll holder', () => {
  afterEach(() => setActiveMemberRoll(null));

  it('starts null (defer) and round-trips a set', () => {
    setActiveMemberRoll(null);
    expect(getActiveMemberRoll()).toBeNull();
    const roll = new Set(['a'.repeat(64)]);
    setActiveMemberRoll(roll);
    expect(getActiveMemberRoll()).toBe(roll);
  });

  it('bumps the version on every set, including clears', () => {
    const v0 = getMemberRollVersion();
    setActiveMemberRoll(new Set());
    expect(getMemberRollVersion()).toBe(v0 + 1);
    setActiveMemberRoll(null);
    expect(getMemberRollVersion()).toBe(v0 + 2);
  });
});
