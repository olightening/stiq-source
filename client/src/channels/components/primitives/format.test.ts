import {referencedLabel} from './format';

describe('referencedLabel', () => {
  it('labels a kind-1111 (NIP-22 comment) reference as REFERENCED COMMENT', () => {
    expect(referencedLabel(1111)).toBe('REFERENCED COMMENT');
  });

  it('labels every other kind as REFERENCED POST', () => {
    expect(referencedLabel(1)).toBe('REFERENCED POST');
    expect(referencedLabel(30311)).toBe('REFERENCED POST');
    expect(referencedLabel(undefined)).toBe('REFERENCED POST');
  });
});
