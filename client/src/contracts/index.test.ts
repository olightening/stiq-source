/**
 * Contract-registry guard. Two jobs:
 *  1. Pin the on-wire VALUES so a refactor of the registry can never silently change a tag string,
 *     token width, mailbox TTL, kind number, or feed/ingest list — anything the relay/organizer also
 *     hard-codes. These are the values the call sites used BEFORE consolidation.
 *  2. Prove the SINGLE SOURCE: the constants each de-duplicated module now re-exports must be the
 *     exact same value as the contract module's, so the "declared once" guarantee actually holds.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  TOKEN_BYTES,
  MAILBOX_TTL_SECONDS,
  EPOCH_SECONDS,
  currentEpoch,
  TAG_TOKEN,
  TAG_SIG,
  TAG_ATTR,
  TAG_ENC,
  ENC_NIP44,
  TAG_KE,
  ATTR_BIND,
  ATTR_NAME,
  ATTR_GRAD,
  KIND_ATTESTATION,
  KIND_MEMBERSHIP_BINDING,
  KIND_ENROLL_REQUEST,
  KIND_ENROLL_RESPONSE,
  KIND_DRAW_REQUEST,
  KIND_DRAW_RESPONSE,
  KIND_UNLOCK_REQUEST,
  KIND_UNLOCK_RESPONSE,
  KIND_READ_AUTH,
  KIND_VOICE_MESSAGE,
  KIND_VOICE_COMMENT,
  KIND_SPEND_WITNESS,
  KIND_EVENT,
  KIND_EVENT_RSVP,
  Kind,
  PostState,
  FEED_KINDS,
  FEED_STORE_READ_KINDS,
  SUBSCRIBED_KINDS,
  isSubscribedKind,
  GROUP_KINDS,
  Purpose,
  FingerprintKey,
  StiqDom,
  SPACE_CONTENT_KINDS,
  isSpaceContentKind,
} from './index';

// Re-export sites — must resolve to the SAME value as the contract (single source of truth).
import {TAG_TOKEN as PROTO_TAG_TOKEN, TAG_SIG as PROTO_TAG_SIG, EPOCH_SECONDS as PROTO_EPOCH} from '../blind/protocol';
import {TOKEN_BYTES as ENROLL_TOKEN_BYTES, KIND_MEMBERSHIP_BINDING as ENROLL_BINDING} from '../onboarding/enrollment';
import {TOKEN_BYTES as SOURCE_TOKEN_BYTES} from '../blind/blindTokenSource';
import {KIND_DRAW_REQUEST as DRAW_REQ, KIND_DRAW_RESPONSE as DRAW_RESP} from '../blind/drawExchange';
import {KIND_UNLOCK_REQUEST as UNLOCK_REQ, KIND_UNLOCK_RESPONSE as UNLOCK_RESP} from '../blind/readUnlock';
import {KIND_ENROLL_REQUEST as ENROLL_REQ, KIND_ENROLL_RESPONSE as ENROLL_RESP} from '../onboarding/exchange';
import {SUBSCRIBED_KINDS as EVENTS_SUBSCRIBED, GROUP_KINDS as EVENTS_GROUP} from '../nostr/events';
import {FEED_KINDS as PLAN_FEED_KINDS} from '../nostr/subscriptionPlan';

describe('contract scalars — no value change', () => {
  it('pins the token width, mailbox TTL, and epoch length', () => {
    expect(TOKEN_BYTES).toBe(32);
    expect(MAILBOX_TTL_SECONDS).toBe(48 * 3600); // 172_800
    expect(EPOCH_SECONDS).toBe(86_400);
  });

  it('currentEpoch is a whole-day index of the given time', () => {
    expect(currentEpoch(0)).toBe(0);
    expect(currentEpoch(86_400 * 1000 - 1)).toBe(0);
    expect(currentEpoch(86_400 * 1000)).toBe(1);
    expect(currentEpoch(10 * 86_400 * 1000 + 5)).toBe(10);
  });
});

describe('contract tag vocabulary — no value change', () => {
  it('pins the stiq_* tag names and encryption markers', () => {
    expect(TAG_TOKEN).toBe('stiq_token');
    expect(TAG_SIG).toBe('stiq_sig');
    expect(TAG_ATTR).toBe('stiq_attr');
    expect(TAG_ENC).toBe('encrypted');
    expect(ENC_NIP44).toBe('nip44');
    expect(TAG_KE).toBe('ke');
    expect(ATTR_BIND).toBe('bind');
    expect(ATTR_NAME).toBe('nm');
    expect(ATTR_GRAD).toBe('g');
  });
});

describe('contract kind numbers — no value change', () => {
  it('pins the attestation, voice, and mailbox kinds', () => {
    expect(KIND_ATTESTATION).toBe(27_555);
    expect(KIND_VOICE_MESSAGE).toBe(1222);
    expect(KIND_VOICE_COMMENT).toBe(1244);
    expect(KIND_MEMBERSHIP_BINDING).toBe(9011);
    expect(KIND_ENROLL_REQUEST).toBe(9020);
    expect(KIND_ENROLL_RESPONSE).toBe(9023);
    expect(KIND_DRAW_REQUEST).toBe(9024);
    expect(KIND_DRAW_RESPONSE).toBe(9025);
    expect(KIND_UNLOCK_REQUEST).toBe(9026);
    expect(KIND_UNLOCK_RESPONSE).toBe(9027);
    expect(PostState).toBe(39005);
  });

  it('pins the core feed/content kind numbers', () => {
    expect(Kind.Post).toBe(1);
    expect(Kind.Reaction).toBe(7);
    expect(Kind.Comment).toBe(1111);
    expect(Kind.Report).toBe(1984);
    expect(Kind.GiftWrap).toBe(1059);
    expect(Kind.Article).toBe(30023);
    expect(Kind.Poll).toBe(1068);
    expect(Kind.PollResponse).toBe(1018);
    expect(Kind.LiveChat).toBe(1311);
    expect(Kind.LiveActivity).toBe(30311);
    expect(Kind.AppData).toBe(30078);
    expect(Kind.SpaceKeyDelivery).toBe(30079);
    expect(Kind.MuteList).toBe(10000);
  });
});

describe('contract kind lists — pinned membership (feed REQ + ingest gate + store-read set)', () => {
  it('FEED_KINDS pins the feed-content list (the pre-consolidation set + the P4 witness 1986)', () => {
    // 1986 (KIND_SPEND_WITNESS) is added so the feed REQ pulls the double-spend witness and the
    // firehose ingest accepts it; it rides the firehose but is never rendered (see FEED_STORE_READ_KINDS).
    // 1987 (DraftAccessRequest, Phase 5§D): sealed to its owner, so — same posture as 1986/1111 — it
    // rides the open firehose and is never rendered as a feed item either.
    // 31923/31925 (events surface): the event doc + interested RSVP ride the firehose exactly like
    // the channel-definition kind (an embed must upgrade live for members who merely SEE it) but,
    // like 1986/1987/1311/30311, are NEVER in the store-read set — an event is an embed, not a feed item.
    expect(FEED_KINDS).toEqual([1, 7, 1111, 1984, 1986, 1987, 30023, 1068, 1018, 1222, 1244, 1311, 30311, 31923, 31925]);
  });

  it('SUBSCRIBED_KINDS = FEED_KINDS plus the firehose-only kinds (DMs, config, key delivery)', () => {
    // Same SET as the original hand-written events.ts list, order-independent (+ the P4 witness 1986
    // + the events surface's 31923/31925 + the draft-access request 1987 [via FEED_KINDS] and
    // delivery 30500 [a firehose-only extra, `#p == me`-scoped exactly like SpaceKeyDelivery]).
    expect([...SUBSCRIBED_KINDS].sort((a, b) => a - b)).toEqual(
      [1, 7, 1018, 1059, 1068, 1111, 1222, 1244, 1311, 1984, 1986, 1987, 30023, 30078, 30079, 30311, 30500, 31923, 31925],
    );
    // Every feed kind is admitted by the ingest gate, plus exactly the four firehose extras.
    for (const k of FEED_KINDS) {
      expect(isSubscribedKind(k)).toBe(true);
    }
    expect(isSubscribedKind(Kind.GiftWrap)).toBe(true);
    expect(isSubscribedKind(Kind.AppData)).toBe(true);
    expect(isSubscribedKind(Kind.SpaceKeyDelivery)).toBe(true);
    expect(isSubscribedKind(Kind.DraftDelivery)).toBe(true);
    expect(isSubscribedKind(Kind.ChannelMessage)).toBe(false); // scoped-discovery kind, never firehose
    expect(SUBSCRIBED_KINDS.length).toBe(FEED_KINDS.length + 4);
  });

  it('GROUP_KINDS is exactly the pre-consolidation group ingest allow-list + raw 9021', () => {
    // 9021 (join request) joined the ingest allow-list with the membership handoff: 39004 carries
    // pending PUBKEYS only, so the sealed intro note + request time must arrive on the raw 9021
    // pulled back by subscribeGroup's `#h`-scoped filter.
    expect(GROUP_KINDS).toEqual([9, 11, 12, 39000, 39001, 39002, 39003, 39004, 9021, 7, 9009, 39005]);
  });

  it('FEED_STORE_READ_KINDS === AppRuntime.FEED_KINDS old literal (C9 store-read set, unchanged)', () => {
    // Byte-identical MEMBERSHIP to the historical private AppRuntime.FEED_KINDS literal that this
    // export replaced: [Post, Article, Poll, VoiceMessage, Reaction, Comment, PollResponse, Report, MuteList].
    expect(FEED_STORE_READ_KINDS).toEqual([1, 30023, 1068, 1222, 7, 1111, 1018, 1984, 10000]);
  });

  it('FEED_STORE_READ_KINDS = FEED_KINDS + MuteList − {voice-reply 1244, LiveChat 1311, LiveActivity 30311, witness 1986, draft-access request 1987, events 31923/31925}', () => {
    // The store-read set is a DIFFERENT job from the feed REQ: it ADDS MuteList and OMITS the NIP-53
    // live kinds, the voice reply, the P4 double-spend witness, the draft-access request, and the
    // events surface's doc + RSVP (all ride the firehose but are not rendered from the store scan —
    // an event is an EMBED inside a post, never a feed item; events/eventsStore.ts reads 31923/31925
    // itself, and feed/draftAccess.ts's AppRuntime helpers read 1987 directly). Prove that
    // relationship as a set so it can't silently drift into (or out of) the feed REQ list.
    const set = new Set(FEED_STORE_READ_KINDS);
    expect(set.has(Kind.MuteList)).toBe(true); // added vs FEED_KINDS
    const omittedFromStoreRead = [
      KIND_VOICE_COMMENT,
      Kind.LiveChat,
      Kind.LiveActivity,
      KIND_SPEND_WITNESS,
      Kind.DraftAccessRequest,
      KIND_EVENT,
      KIND_EVENT_RSVP,
    ];
    for (const omitted of omittedFromStoreRead) {
      expect(set.has(omitted)).toBe(false); // 1244 / 1311 / 30311 / 1986 / 31923 / 31925 omitted from the store-read scan
      expect(FEED_KINDS).toContain(omitted); // ...but each IS on the feed REQ list
    }
    const expected = new Set([...FEED_KINDS, Kind.MuteList]);
    for (const omitted of omittedFromStoreRead) expected.delete(omitted);
    expect([...set].sort((a, b) => a - b)).toEqual([...expected].sort((a, b) => a - b));
  });
});

describe('single source of truth — re-exports resolve to the contract value', () => {
  it('tags / scalars re-exported by blind/protocol match the contract', () => {
    expect(PROTO_TAG_TOKEN).toBe(TAG_TOKEN);
    expect(PROTO_TAG_SIG).toBe(TAG_SIG);
    expect(PROTO_EPOCH).toBe(EPOCH_SECONDS);
  });

  it('TOKEN_BYTES is one value across enrollment, blindTokenSource, and the contract', () => {
    expect(ENROLL_TOKEN_BYTES).toBe(TOKEN_BYTES);
    expect(SOURCE_TOKEN_BYTES).toBe(TOKEN_BYTES);
  });

  it('mailbox kinds re-exported by each exchange module match the contract', () => {
    expect(ENROLL_BINDING).toBe(KIND_MEMBERSHIP_BINDING);
    expect(ENROLL_REQ).toBe(KIND_ENROLL_REQUEST);
    expect(ENROLL_RESP).toBe(KIND_ENROLL_RESPONSE);
    expect(DRAW_REQ).toBe(KIND_DRAW_REQUEST);
    expect(DRAW_RESP).toBe(KIND_DRAW_RESPONSE);
    expect(UNLOCK_REQ).toBe(KIND_UNLOCK_REQUEST);
    expect(UNLOCK_RESP).toBe(KIND_UNLOCK_RESPONSE);
  });

  it('kind lists re-exported by nostr/events and subscriptionPlan are the contract arrays', () => {
    expect(EVENTS_SUBSCRIBED).toBe(SUBSCRIBED_KINDS);
    expect(EVENTS_GROUP).toBe(GROUP_KINDS);
    expect(PLAN_FEED_KINDS).toBe(FEED_KINDS);
  });
});

// ── T4.1/F13: the wire vocabularies previously scattered as bare literals (purpose/domain strings,
// NIP-11 fingerprint keys, stiq_dom values, KIND_READ_AUTH, the space-content kind set) — now
// declared once here. See TOKEN_FIXING_PLAN.md Appendix A / TOKEN_PATHWAY_ANALYSIS.md F13. ──

describe('token wire contract (T4.1/F13) — no value change from the pre-consolidation literals', () => {
  it('pins KIND_READ_AUTH (must match issuer/organizer-server.mjs KIND_READ_AUTH verbatim)', () => {
    expect(KIND_READ_AUTH).toBe(9028);
  });

  it('pins the Purpose vocabulary (client draw / issuer signing-key selection, drawExchange.ts:329)', () => {
    expect(Purpose).toEqual({
      Enroll: 'enroll',
      Post: 'post',
      Read: 'read',
      PictureWrite: 'picture-write',
      PictureRead: 'picture-read',
      AudioWrite: 'audio-write',
      AudioRead: 'audio-read',
      SpaceWrite: 'space-write',
    });
  });

  it('pins the FingerprintKey vocabulary (relay NIP-11 issuer_key_fingerprints/issuer_keys) — posting ≠ post', () => {
    expect(FingerprintKey).toEqual({
      Enroll: 'enroll',
      Posting: 'posting',
      Binding: 'binding',
      SpaceWrite: 'space_write',
      Picture: 'picture',
      Audio: 'audio',
      Read: 'read',
    });
    // The one place the two vocabularies collide in spelling closely enough to confuse (Appendix A).
    expect(FingerprintKey.Posting).not.toBe(Purpose.Post);
  });

  it('pins the StiqDom vocabulary (stiq_dom tag values, relay membership.go:94-95)', () => {
    expect(StiqDom).toEqual({Picture: 'picture', Audio: 'audio'});
  });

  it('SPACE_CONTENT_KINDS pins the relay spaceContentKinds set (policy/membership.go:206)', () => {
    expect(SPACE_CONTENT_KINDS).toEqual([42, 1311, 9, 11, 12]);
  });

  it('isSpaceContentKind matches every SPACE_CONTENT_KINDS member plus the h-tagged-kind-7 rule', () => {
    for (const k of SPACE_CONTENT_KINDS) {
      expect(isSpaceContentKind({kind: k})).toBe(true);
    }
    expect(isSpaceContentKind({kind: Kind.Reaction, tags: [['h', 'space1']]})).toBe(true);
    // An UNTAGGED kind-7 is a blind feed vote, not space content (ratelimit.go's isAttributedSpaceContent).
    expect(isSpaceContentKind({kind: Kind.Reaction})).toBe(false);
    expect(isSpaceContentKind({kind: Kind.Reaction, tags: [['e', 'x']]})).toBe(false);
    expect(isSpaceContentKind({kind: Kind.Post})).toBe(false);
  });
});

describe('T4.1/F13 regression guard — no bare wire-vocabulary literal outside this module', () => {
  // Same walk-the-source-tree idiom as media/networkGuards.test.ts.
  const SRC = path.join(__dirname, '..');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        out.push(...walk(full));
      } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/');
  const read = (f: string): string => fs.readFileSync(f, 'utf8');
  // Every non-test source file except the contract module itself — the one legitimate home for
  // these literals (their `export const` declarations).
  const FILES = walk(SRC).filter(f => rel(f) !== 'contracts/index.ts');

  it('no bare 9028 outside contracts/index.ts', () => {
    const offenders = FILES.filter(f => /\b9028\b/.test(read(f))).map(rel);
    expect(offenders).toEqual([]);
  });

  it('no bare purpose/fingerprint-key/stiq_dom string literal outside contracts/index.ts', () => {
    // The 5 unambiguous hyphenated purpose/domain strings, plus the 3 NIP-11 fingerprint keys that
    // cannot collide with any other vocabulary in this codebase (verified: zero hits anywhere but
    // contracts/index.ts before this guard existed). Deliberately EXCLUDED: bare `post` / `read` /
    // `enroll` / `picture` / `audio` — each collides with an unrelated vocabulary elsewhere
    // (PendingWrite's `type: 'post'`, notifications/readState's read/unread marks, the
    // notification-kind helper's 'picture', OnboardingScreen's `mode: 'enroll'`) and would
    // false-positive here; those call sites were reviewed by hand instead (see T4.1 report).
    const NEEDLES = [
      "'picture-write'", '"picture-write"',
      "'picture-read'", '"picture-read"',
      "'audio-write'", '"audio-write"',
      "'audio-read'", '"audio-read"',
      "'space-write'", '"space-write"',
      "'posting'", '"posting"',
      "'binding'", '"binding"',
      "'space_write'", '"space_write"',
    ];
    const offenders = FILES.filter(f => {
      const text = read(f);
      return NEEDLES.some(n => text.includes(n));
    }).map(rel);
    expect(offenders).toEqual([]);
  });
});
