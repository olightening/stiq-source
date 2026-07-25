// Reliability/security tests for one-shot invite issuance.
// Run: node invite-issuance_test.mjs
import {issueInviteCredential, summarizeInvite, normalizeEntry} from './invite-issuance.mjs';

let failures = 0;
function check(label, condition) {
  console.log((condition ? '  ok   ' : '  FAIL ') + label);
  if (!condition) failures += 1;
}
async function rejects(label, fn, pattern) {
  try {
    await fn();
    check(label, false);
  } catch (e) {
    check(label, pattern.test(e?.message || String(e)));
    return e;
  }
}
function memoryStore(initial) {
  let value = structuredClone(initial);
  return {
    load: () => structuredClone(value),
    save: next => {
      value = structuredClone(next);
    },
    read: () => structuredClone(value),
  };
}

// The exact blinded request is idempotent and returns the persisted signature without signing twice.
{
  const store = memoryStore({'STIQ-AAAA-BBBB': {createdAt: 'before'}});
  let signs = 0;
  const opts = {
    inviteCode: 'STIQ-AAAA-BBBB',
    blindedBytes: Buffer.from('first blinded request'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => {
      signs += 1;
      return Buffer.from('signature one');
    },
    now: () => 'now',
  };
  const first = await issueInviteCredential(opts);
  const retry = await issueInviteCredential(opts);
  const saved = store.read()['STIQ-AAAA-BBBB'];
  check('first issuance returns the blind signature', Buffer.from(first).toString() === 'signature one');
  check('same blinded request replays the same signature', Buffer.from(retry).equals(Buffer.from(first)));
  check('same blinded request is signed only once', signs === 1);
  check(
    'invite records the exact request hash and signature',
    saved.usesCount === 1 && !!saved.uses && Object.values(saved.uses).every(s => s.blindSignature),
  );
  await rejects(
    'same invite cannot mint a different blinded credential',
    () => issueInviteCredential({...opts, blindedBytes: Buffer.from('different request')}),
    /already used/i,
  );
}

// A signer failure rolls back only its own reservation, so a valid retry is not permanently bricked.
{
  const store = memoryStore({'STIQ-CCCC-DDDD': {}});
  let fail = true;
  const opts = {
    inviteCode: 'STIQ-CCCC-DDDD',
    blindedBytes: Buffer.from('request'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => {
      if (fail) throw new Error('signer unavailable');
      return Buffer.from('recovered signature');
    },
  };
  await rejects('signer failure is surfaced', () => issueInviteCredential(opts), /signer unavailable/);
  check('failed signing does not leave the invite consumed', summarizeInvite(store.read()['STIQ-CCCC-DDDD']).usesCount === 0);
  fail = false;
  const recovered = await issueInviteCredential(opts);
  check('the same invite can recover after signer failure', Buffer.from(recovered).toString() === 'recovered signature');
}

// Reservation happens before asynchronous signing, closing the two-different-credentials race.
{
  const store = memoryStore({'STIQ-EEEE-FFFF': {}});
  let release;
  const gate = new Promise(resolve => {
    release = resolve;
  });
  const first = issueInviteCredential({
    inviteCode: 'STIQ-EEEE-FFFF',
    blindedBytes: Buffer.from('winner'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => {
      await gate;
      return Buffer.from('winner signature');
    },
  });
  await Promise.resolve();
  await rejects(
    'a concurrent different request loses to the reservation',
    () =>
      issueInviteCredential({
        inviteCode: 'STIQ-EEEE-FFFF',
        blindedBytes: Buffer.from('loser'),
        loadInvites: store.load,
        saveInvites: store.save,
        signBlinded: async () => Buffer.from('loser signature'),
      }),
    /already used/i,
  );
  release();
  await first;
}

// Unknown random codes remain drop-eligible for the mailbox anti-amplification policy.
{
  const store = memoryStore({});
  const error = await rejects(
    'unknown invite is rejected',
    () =>
      issueInviteCredential({
        inviteCode: 'STIQ-NOT-FOUND',
        blindedBytes: Buffer.from('request'),
        loadInvites: store.load,
        saveInvites: store.save,
        signBlinded: async () => Buffer.from('nope'),
        dropInvalid: true,
      }),
    /not found/i,
  );
  check('unknown invite remains silently droppable', error?.drop === true);
}

// Feature 4: an expired-but-unused invite is rejected (single funnel — same path the mailbox and
// the manual HTTP sign both call), and the error is loud (not drop-eligible) like 'already used'.
{
  const store = memoryStore({'STIQ-EXPI-RED0': {expiresAt: new Date(Date.now() - 60_000).toISOString()}});
  const error = await rejects(
    'an expired invite is rejected',
    () =>
      issueInviteCredential({
        inviteCode: 'STIQ-EXPI-RED0',
        blindedBytes: Buffer.from('request'),
        loadInvites: store.load,
        saveInvites: store.save,
        signBlinded: async () => Buffer.from('nope'),
        dropInvalid: true,
      }),
    /expired/i,
  );
  check('an expired invite is NOT silently droppable (surfaces like already-used)', error?.drop !== true);
  check('the expired invite was never reserved', summarizeInvite(store.read()['STIQ-EXPI-RED0']).usesCount === 0);
}

// A future expiresAt (or none at all) does not block issuance.
{
  const store = memoryStore({'STIQ-FUTU-RE00': {expiresAt: new Date(Date.now() + 60_000).toISOString()}});
  const sig = await issueInviteCredential({
    inviteCode: 'STIQ-FUTU-RE00',
    blindedBytes: Buffer.from('request'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => Buffer.from('future signature'),
  });
  check('a not-yet-expired invite still issues', Buffer.from(sig).toString() === 'future signature');
}
{
  const store = memoryStore({'STIQ-NEVR-0000': {}});
  const sig = await issueInviteCredential({
    inviteCode: 'STIQ-NEVR-0000',
    blindedBytes: Buffer.from('request'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => Buffer.from('no-expiry signature'),
  });
  check('an invite with no expiresAt (Never) still issues', Buffer.from(sig).toString() === 'no-expiry signature');
}

// An already-minted credential can be RE-FETCHED even after the invite expires (recover a lost Tor
// response). Expiry blocks issuing a NEW credential, never replaying one already earned.
{
  const store = memoryStore({'STIQ-RPLY-EXPD': {}});
  const opts = {
    inviteCode: 'STIQ-RPLY-EXPD',
    blindedBytes: Buffer.from('earned request'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => Buffer.from('earned signature'),
  };
  const first = await issueInviteCredential(opts); // mint while unexpired
  const rec = store.read()['STIQ-RPLY-EXPD'];
  rec.expiresAt = new Date(Date.now() - 60_000).toISOString(); // then expire it
  store.save({'STIQ-RPLY-EXPD': rec});
  const replay = await issueInviteCredential(opts); // same blinded request -> replay branch
  check('an already-minted credential replays even after expiry', Buffer.from(replay).equals(Buffer.from(first)));
}

// A present-but-unparseable expiresAt fails CLOSED (treated as expired) at the funnel, so a
// corrupted/hand-edited record never silently means "live forever".
{
  const store = memoryStore({'STIQ-GARB-AGE0': {expiresAt: 'not-a-date'}});
  await rejects(
    'an unparseable expiresAt is treated as expired (fail-closed)',
    () => issueInviteCredential({
      inviteCode: 'STIQ-GARB-AGE0',
      blindedBytes: Buffer.from('request'),
      loadInvites: store.load,
      saveInvites: store.save,
      signBlinded: async () => Buffer.from('sig'),
    }),
    /expired/i,
  );
  check('the garbage-expiry invite was never reserved', summarizeInvite(store.read()['STIQ-GARB-AGE0']).usesCount === 0);
}

// Multi-use: a maxUses:N invite mints N distinct credentials, then the (N+1)th is rejected. Each of
// the N is an independent blinded request producing its own signature.
{
  const store = memoryStore({'STIQ-MULT-IUS3': {maxUses: 3, usesCount: 0, uses: {}}});
  const mint = body =>
    issueInviteCredential({
      inviteCode: 'STIQ-MULT-IUS3',
      blindedBytes: Buffer.from(body),
      loadInvites: store.load,
      saveInvites: store.save,
      signBlinded: async b => Buffer.concat([Buffer.from('sig:'), b]),
    });
  const a = await mint('member-a');
  const b = await mint('member-b');
  const c = await mint('member-c');
  check('three distinct members each get a signature', a.length && b.length && c.length);
  check(
    'each of the three credentials is distinct',
    !a.equals(b) && !b.equals(c) && !a.equals(c),
  );
  check('usesCount reaches the cap', summarizeInvite(store.read()['STIQ-MULT-IUS3']).usesCount === 3);
  check('the invite reports exhausted with 0 remaining', (() => {
    const s = summarizeInvite(store.read()['STIQ-MULT-IUS3']);
    return s.exhausted && s.remaining === 0 && s.status === 'exhausted';
  })());
  await rejects('the fourth distinct member is rejected once the cap is reached', () => mint('member-d'), /already used/i);
  // Any earlier member's exact request still replays idempotently after the cap fills.
  let resigns = 0;
  const replayB = await issueInviteCredential({
    inviteCode: 'STIQ-MULT-IUS3',
    blindedBytes: Buffer.from('member-b'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async x => {
      resigns += 1;
      return Buffer.concat([Buffer.from('sig:'), x]);
    },
  });
  check('an earlier member replays its own signature after the cap fills', replayB.equals(b));
  check('replaying an already-issued slot does not re-sign', resigns === 0);
}

// Unlimited (maxUses:null) never fills — every distinct member is admitted.
{
  const store = memoryStore({'STIQ-UNLI-M1T3': {maxUses: null, usesCount: 0, uses: {}}});
  const mint = i =>
    issueInviteCredential({
      inviteCode: 'STIQ-UNLI-M1T3',
      blindedBytes: Buffer.from('member-' + i),
      loadInvites: store.load,
      saveInvites: store.save,
      signBlinded: async b => Buffer.concat([Buffer.from('sig:'), b]),
    });
  for (let i = 0; i < 12; i += 1) await mint(i);
  const s = summarizeInvite(store.read()['STIQ-UNLI-M1T3']);
  check('an unlimited invite admits every distinct member', s.usesCount === 12);
  check('an unlimited invite never reports exhausted', !s.exhausted && s.remaining === null && s.status === 'active');
}

// Expiry composes with uses: capacity remaining does NOT override an expired window.
{
  const store = memoryStore({
    'STIQ-CAP0-EXPD': {maxUses: 5, usesCount: 0, uses: {}, expiresAt: new Date(Date.now() - 60_000).toISOString()},
  });
  await rejects(
    'an expired invite is rejected even with uses remaining',
    () =>
      issueInviteCredential({
        inviteCode: 'STIQ-CAP0-EXPD',
        blindedBytes: Buffer.from('late member'),
        loadInvites: store.load,
        saveInvites: store.save,
        signBlinded: async () => Buffer.from('nope'),
      }),
    /expired/i,
  );
  check('the expired-with-capacity invite was never reserved', summarizeInvite(store.read()['STIQ-CAP0-EXPD']).usesCount === 0);
}

// Backward compatibility: a legacy single-use record ({used:true, credentialRequestHash, blindSignature})
// still replays its exact request and rejects any different request — it stays capacity-1.
{
  const earnedHash = (await import('crypto')).createHash('sha256').update(Buffer.from('legacy request')).digest('hex');
  const store = memoryStore({
    'STIQ-LEGA-CY00': {used: true, usedAt: 'then', credentialRequestHash: earnedHash, blindSignature: Buffer.from('legacy sig').toString('base64')},
  });
  const replay = await issueInviteCredential({
    inviteCode: 'STIQ-LEGA-CY00',
    blindedBytes: Buffer.from('legacy request'),
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async () => Buffer.from('should not re-sign'),
  });
  check('a legacy used invite replays its stored signature', replay.toString() === 'legacy sig');
  await rejects(
    'a legacy used invite rejects a different request (stays capacity-1)',
    () =>
      issueInviteCredential({
        inviteCode: 'STIQ-LEGA-CY00',
        blindedBytes: Buffer.from('different request'),
        loadInvites: store.load,
        saveInvites: store.save,
        signBlinded: async () => Buffer.from('nope'),
      }),
    /already used/i,
  );
  check('a legacy record normalizes to maxUses:1', summarizeInvite(store.read()['STIQ-LEGA-CY00']).maxUses === 1);
}

// Backward compatibility: a legacy record RESERVED before a crash (used:true, hash, but NO signature)
// re-signs the exact request and finalizes, while a different request is still rejected.
{
  const reqBytes = Buffer.from('crash request');
  const reservedHash = (await import('crypto')).createHash('sha256').update(reqBytes).digest('hex');
  const store = memoryStore({'STIQ-CRSH-REC0': {used: true, usedAt: 'then', credentialRequestHash: reservedHash}});
  const recovered = await issueInviteCredential({
    inviteCode: 'STIQ-CRSH-REC0',
    blindedBytes: reqBytes,
    loadInvites: store.load,
    saveInvites: store.save,
    signBlinded: async b => Buffer.concat([Buffer.from('resigned:'), b]),
  });
  check('a reserved-but-unsigned legacy slot re-signs and finalizes', recovered.toString().startsWith('resigned:'));
  check('the recovered slot now stores its signature', Object.values(store.read()['STIQ-CRSH-REC0'].uses)[0].blindSignature);
}

// Capacity holds under concurrency: three concurrent DISTINCT requests on a maxUses:2 invite admit
// exactly two; the loser is rejected before it can reserve a third slot.
{
  const store = memoryStore({'STIQ-CONC-CAP2': {maxUses: 2, usesCount: 0, uses: {}}});
  let release;
  const gate = new Promise(r => (release = r));
  const gated = body =>
    issueInviteCredential({
      inviteCode: 'STIQ-CONC-CAP2',
      blindedBytes: Buffer.from(body),
      loadInvites: store.load,
      saveInvites: store.save,
      signBlinded: async b => {
        await gate;
        return Buffer.concat([Buffer.from('sig:'), b]);
      },
    });
  const p1 = gated('c-1');
  const p2 = gated('c-2');
  await rejects('the third concurrent request loses the last slot', () => gated('c-3'), /already used/i);
  release();
  const [r1, r2] = await Promise.all([p1, p2]);
  check('the two winners each get a distinct signature', r1.length && r2.length && !r1.equals(r2));
  check('exactly two slots were consumed', summarizeInvite(store.read()['STIQ-CONC-CAP2']).usesCount === 2);
}

// summarizeInvite is pure and shape-agnostic (never mutates the entry it reads).
{
  const legacy = {used: true, credentialRequestHash: 'h', blindSignature: 's'};
  const sLegacy = summarizeInvite(legacy);
  check('summarizeInvite reads a legacy record without mutating it', sLegacy.usesCount === 1 && sLegacy.maxUses === 1 && legacy.uses === undefined);
  check('summarizeInvite reports an unlimited entry', (() => {
    const s = summarizeInvite({maxUses: null, usesCount: 40, uses: {}});
    return s.maxUses === null && s.remaining === null && !s.exhausted;
  })());
  // normalizeEntry is the mutating counterpart used only on the write path.
  const up = normalizeEntry({used: true, credentialRequestHash: 'h', blindSignature: 's', createdAt: 'c'});
  check('normalizeEntry upgrades a legacy record in place', up.uses && up.uses.h.blindSignature === 's' && up.maxUses === 1 && up.usesCount === 1 && up.used === undefined);
}

console.log(failures === 0 ? '\nall invite issuance tests passed' : `\n${failures} invite issuance test(s) FAILED`);
if (failures > 0) process.exit(1);
