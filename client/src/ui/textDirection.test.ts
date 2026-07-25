import {firstStrongDir, hasRtl, splitParagraphs, dirAlign, paragraphAlign, rtlVerticalFix} from './textDirection';

describe('textDirection', () => {
  describe('firstStrongDir', () => {
    it('detects Arabic as rtl', () => {
      expect(firstStrongDir('مرحبا بالعالم')).toBe('rtl');
    });

    it('detects Hebrew as rtl', () => {
      expect(firstStrongDir('שלום עולם')).toBe('rtl');
    });

    it('detects English as ltr', () => {
      expect(firstStrongDir('Hello world')).toBe('ltr');
    });

    it('skips leading neutrals (digits) and uses first strong letter — Arabic', () => {
      expect(firstStrongDir('123 مرحبا')).toBe('rtl');
    });

    it('skips leading neutrals (mention/symbol) and uses first strong letter — English', () => {
      expect(firstStrongDir('@user hello')).toBe('ltr');
      expect(firstStrongDir('#tag English text')).toBe('ltr');
    });

    it('decides a mixed paragraph by its FIRST strong character', () => {
      expect(firstStrongDir('مرحبا hello')).toBe('rtl');
      expect(firstStrongDir('hello مرحبا')).toBe('ltr');
    });

    it('treats emoji/URL-leading neutral-only content as ltr', () => {
      expect(firstStrongDir('🔥🎉')).toBe('ltr');
      expect(firstStrongDir('')).toBe('ltr');
      expect(firstStrongDir('   ')).toBe('ltr');
      expect(firstStrongDir('https://example.com')).toBe('ltr');
    });

    it('emoji before Arabic still resolves rtl', () => {
      expect(firstStrongDir('🔥 مرحبا')).toBe('rtl');
    });
  });

  describe('hasRtl', () => {
    it('is true when any RTL char is present', () => {
      expect(hasRtl('hello مرحبا')).toBe(true);
      expect(hasRtl('plain english')).toBe(false);
    });
  });

  describe('splitParagraphs', () => {
    it('splits on \\n and \\r\\n', () => {
      expect(splitParagraphs('a\nb\r\nc')).toEqual(['a', 'b', 'c']);
    });
    it('keeps empty lines', () => {
      expect(splitParagraphs('a\n\nb')).toEqual(['a', '', 'b']);
    });
  });

  describe('dirAlign / paragraphAlign', () => {
    it('maps directions to alignment styles', () => {
      expect(dirAlign('rtl')).toEqual({writingDirection: 'rtl', textAlign: 'right'});
      expect(dirAlign('ltr')).toEqual({writingDirection: 'ltr', textAlign: 'left'});
    });
    it('paragraphAlign resolves text straight to a style', () => {
      expect(paragraphAlign('مرحبا')).toEqual({writingDirection: 'rtl', textAlign: 'right'});
      expect(paragraphAlign('hello')).toEqual({writingDirection: 'ltr', textAlign: 'left'});
    });
  });

  describe('rtlVerticalFix', () => {
    it('centres the glyph vertically for RTL text (Android tall-line-box fix)', () => {
      expect(rtlVerticalFix('قال ايليا ابو ماضي')).toEqual({textAlignVertical: 'center'});
    });
    it('pulls the RTL title up by the surrounding margin to cancel the leading gap', () => {
      expect(rtlVerticalFix('قال ايليا ابو ماضي', 12)).toEqual({textAlignVertical: 'center', marginTop: -12});
    });
    it('ignores pullUp for LTR text (stays a no-op)', () => {
      expect(rtlVerticalFix('Hello world', 12)).toEqual({});
    });
    it('is a no-op for LTR/neutral text', () => {
      expect(rtlVerticalFix('Hello world')).toEqual({});
      expect(rtlVerticalFix('123 🔥')).toEqual({});
    });
  });
});
