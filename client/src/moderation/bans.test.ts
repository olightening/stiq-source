import {generateSecretKey, getPublicKey, type Event} from 'nostr-tools/pure';
import {nip19} from 'nostr-tools';
import {InMemoryEventStore} from '../nostr/store';
import {bannedAuthors} from './bans';

const modPub = getPublicKey(generateSecretKey());
const modNpub = nip19.npubEncode(modPub);
const mods = [modNpub];
const VICTIM = 'victim-pubkey';

function banEvent(pubkey: string, createdAt: number, message: string, untilSec?: number, by = modPub): Event {
  const tags: string[][] = [['p', pubkey], ['stiq-action', 'ban']];
  if (untilSec) tags.push(['ban-until', String(untilSec)]);
  return {id: `ban-${createdAt}`, pubkey: by, created_at: createdAt, kind: 1984, tags, content: message, sig: 's'};
}
function unbanEvent(pubkey: string, createdAt: number, by = modPub): Event {
  return {
    id: `unban-${createdAt}`,
    pubkey: by,
    created_at: createdAt,
    kind: 1984,
    tags: [['p', pubkey], ['stiq-action', 'unban']],
    content: '',
    sig: 's',
  };
}
function storeWith(...events: Event[]): InMemoryEventStore {
  const s = new InMemoryEventStore();
  for (const e of events) s.save(e);
  return s;
}

describe('bannedAuthors', () => {
  it('records an active ban with its message', () => {
    const s = storeWith(banEvent(VICTIM, 1000, 'repeated spam'));
    const bans = bannedAuthors(s, mods, 2000);
    expect(bans.get(VICTIM)?.message).toBe('repeated spam');
    expect(bans.get(VICTIM)?.since).toBe(1000);
  });

  it('lifts a ban when the latest action is an unban', () => {
    const s = storeWith(banEvent(VICTIM, 1000, 'spam'), unbanEvent(VICTIM, 2000));
    expect(bannedAuthors(s, mods, 3000).has(VICTIM)).toBe(false);
  });

  it('re-bans when a ban is the latest action', () => {
    const s = storeWith(banEvent(VICTIM, 1000, 'a'), unbanEvent(VICTIM, 2000), banEvent(VICTIM, 3000, 'again'));
    expect(bannedAuthors(s, mods, 4000).get(VICTIM)?.message).toBe('again');
  });

  it('drops an expired (time-limited) ban', () => {
    const s = storeWith(banEvent(VICTIM, 1000, 'temp', 1500));
    expect(bannedAuthors(s, mods, 2000).has(VICTIM)).toBe(false); // now > until
    expect(bannedAuthors(s, mods, 1200).has(VICTIM)).toBe(true); // still active
  });

  it('ignores a ban from a non-moderator', () => {
    const stranger = getPublicKey(generateSecretKey());
    const s = storeWith(banEvent(VICTIM, 1000, 'spam', undefined, stranger));
    expect(bannedAuthors(s, mods, 2000).has(VICTIM)).toBe(false);
  });
});
