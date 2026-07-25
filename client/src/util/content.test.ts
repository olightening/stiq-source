import {splitContent} from './content';

describe('splitContent', () => {
  it('returns a single text run for plain text', () => {
    expect(splitContent('hello world')).toEqual([{type: 'text', value: 'hello world'}]);
  });
  it('splits text, links, and nostr references in order', () => {
    expect(splitContent('see https://a.com and nostr:note1abc here')).toEqual([
      {type: 'text', value: 'see '},
      {type: 'link', url: 'https://a.com'},
      {type: 'text', value: ' and '},
      {type: 'nostr', uri: 'nostr:note1abc'},
      {type: 'text', value: ' here'},
    ]);
  });
  it('handles content that starts/ends with a match', () => {
    expect(splitContent('https://a.com')).toEqual([{type: 'link', url: 'https://a.com'}]);
  });
  it('returns an empty array for empty input', () => {
    expect(splitContent('')).toEqual([]);
  });
});
