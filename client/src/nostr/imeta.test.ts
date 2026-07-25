import {buildImetaTag, imageMetaFromEvent, parseImetaTag, type ImageMeta} from './imeta';

const SHA = 'a'.repeat(64);

describe('parseImetaTag', () => {
  it('parses a full imeta tag', () => {
    const meta = parseImetaTag([
      'imeta',
      'url https://blossom.example/x.jpg',
      'm image/jpeg',
      'dim 1024x768',
      'blurhash LKO2?U%2Tw=w',
      `x ${SHA.toUpperCase()}`,
      'alt a cat sitting on a wall',
      'size 20480',
    ]);
    expect(meta).not.toBeNull();
    expect(meta).toMatchObject<Partial<ImageMeta>>({
      url: 'https://blossom.example/x.jpg',
      mime: 'image/jpeg',
      dim: {width: 1024, height: 768},
      blurhash: 'LKO2?U%2Tw=w',
      sha256: SHA, // lowercased
      alt: 'a cat sitting on a wall',
      size: 20480,
    });
  });

  it('returns null without a url', () => {
    expect(parseImetaTag(['imeta', 'm image/png'])).toBeNull();
  });

  it('ignores non-imeta tags', () => {
    expect(parseImetaTag(['e', 'abc'])).toBeNull();
  });

  it('tolerates a malformed dim', () => {
    const meta = parseImetaTag(['imeta', 'url https://h/x.png', 'dim notdims']);
    expect(meta?.dim).toBeUndefined();
  });
});

describe('imageMetaFromEvent', () => {
  it('collects all imeta tags', () => {
    const event = {
      tags: [
        ['t', 'topic'],
        ['imeta', 'url https://h/a.jpg'],
        ['imeta', 'url https://h/b.png', 'm image/png'],
      ],
    };
    const metas = imageMetaFromEvent(event);
    expect(metas).toHaveLength(2);
    expect(metas[1]!.mime).toBe('image/png');
  });
});

describe('buildImetaTag round-trips', () => {
  it('serializes then parses back to equivalent metadata', () => {
    const meta: ImageMeta = {
      url: 'https://blossom.example/x.webp',
      mime: 'image/webp',
      dim: {width: 800, height: 600},
      blurhash: 'L6Pj0^jE',
      sha256: SHA,
      size: 4096,
      alt: 'art',
    };
    const tag = buildImetaTag(meta);
    expect(tag[0]).toBe('imeta');
    expect(parseImetaTag(tag)).toMatchObject(meta);
  });
});
