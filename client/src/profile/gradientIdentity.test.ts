import {GradientStore} from './gradientIdentity';
import {encodeGradient, gradientFromSeed, type GradientSpec} from '../media/gradient';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

const SPEC1: GradientSpec = {type: 'linear', angle: 90, stops: ['#112233', '#445566']};
const SPEC2: GradientSpec = {type: 'radial', angle: 135, stops: ['#aa0000', '#00aa00']};
const wire1 = encodeGradient(SPEC1);
const wire2 = encodeGradient(SPEC2);

describe('GradientStore — self gradient is changeable', () => {
  it('starts unset', () => {
    const s = new GradientStore(null);
    expect(s.getMyGradient()).toBeNull();
    expect(s.myWire()).toBe('');
  });

  it('sets and then changes freely', async () => {
    const s = new GradientStore(null);
    expect(await s.setMyGradient(SPEC1)).toBe(true);
    expect(s.getMyGradient()).toEqual(SPEC1);
    expect(s.myWire()).toBe(wire1);
    // Changing it is allowed — the new gradient stands.
    expect(await s.setMyGradient(SPEC2)).toBe(true);
    expect(s.getMyGradient()).toEqual(SPEC2);
    expect(s.myWire()).toBe(wire2);
  });

  it('rejects an invalid spec', async () => {
    const s = new GradientStore(null);
    expect(await s.setMyGradient({type: 'linear', angle: 0, stops: ['#fff']} as GradientSpec)).toBe(false);
    expect(s.getMyGradient()).toBeNull();
  });
});

describe('GradientStore — learned book is latest-wins', () => {
  it('learns a peer gradient and renders it', async () => {
    const s = new GradientStore(null);
    await s.learn(A, wire1, 100);
    expect(s.gradientFor(A)).toEqual(SPEC1);
    expect(s.gradientFor(B)).toBeUndefined();
  });

  it('adopts a more recent change', async () => {
    const s = new GradientStore(null);
    await s.learn(A, wire1, 100);
    await s.learn(A, wire2, 200); // newer — replaces
    expect(s.gradientFor(A)).toEqual(SPEC2);
  });

  it('ignores an older claim learned out of order', async () => {
    const s = new GradientStore(null);
    await s.learn(A, wire2, 200); // newest
    await s.learn(A, wire1, 100); // older, learned second — ignored
    expect(s.gradientFor(A)).toEqual(SPEC2);
  });

  it('ignores malformed wires', async () => {
    const s = new GradientStore(null);
    await s.learn(A, 'not-a-gradient', 100);
    expect(s.gradientFor(A)).toBeUndefined();
  });
});

describe('GradientStore — persistence', () => {
  it('reloads self gradient and book', async () => {
    const mem = new Map<string, string>();
    const storage = {
      getItem: async (k: string) => mem.get(k) ?? null,
      setItem: async (k: string, v: string) => void mem.set(k, v),
      removeItem: async (k: string) => void mem.delete(k),
    };
    const s1 = new GradientStore(storage);
    await s1.load();
    await s1.setMyGradient(SPEC1);
    await s1.learn(A, wire2, 100);
    await s1.flush(); // persist is debounced; force the write before reload

    const s2 = new GradientStore(storage);
    await s2.load();
    expect(s2.getMyGradient()).toEqual(SPEC1);
    expect(s2.gradientFor(A)).toEqual(SPEC2);
  });
});

describe('gradientFromSeed fallback contract', () => {
  it('is what the renderer uses when no claim exists', () => {
    const s = new GradientStore(null);
    expect(s.gradientFor(A)).toBeUndefined();
    // Caller renders gradientFromSeed(A) in this case — just assert it is stable/defined.
    expect(gradientFromSeed(A).stops).toHaveLength(2);
  });
});
