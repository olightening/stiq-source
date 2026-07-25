import assert from 'assert';
import {isSealedPost, recordIfSealed, CONTENT_KINDS} from './contentEpochWatcher.mjs';
import {createContentKeyCustody} from './contentEpochKeys.mjs';

// isSealedPost: only a ['ke', ...] tag marks a sealed post.
assert.equal(isSealedPost({tags: [['ke', '0']]}), true);
assert.equal(isSealedPost({tags: [['encrypted', 'nip44'], ['ke', '2']]}), true);
assert.equal(isSealedPost({tags: [['t', 'general']]}), false);
assert.equal(isSealedPost({tags: []}), false);
assert.equal(isSealedPost({}), false);
assert.equal(isSealedPost(null), false);

// Reactions (7) are deliberately not counted for rotation.
assert.ok(!CONTENT_KINDS.includes(7), 'reactions must not pace rotation');
assert.ok(CONTENT_KINDS.includes(1) && CONTENT_KINDS.includes(1111), 'notes+comments counted');

// recordIfSealed against a real custody (in-memory), rotateEvery=3.
let saved = null;
const custody = createContentKeyCustody({
  rotateEvery: 3,
  load: () => saved,
  save: s => { saved = JSON.parse(JSON.stringify(s)); },
  verifyToken: async () => true,
});
const seen = new Set();
const markNew = id => { if (seen.has(id)) return false; seen.add(id); return true; };
const sealed = id => ({id, tags: [['encrypted', 'nip44'], ['ke', '0']]});
const plain = id => ({id, tags: [['t', 'general']]});

// Unsealed posts never advance the epoch.
assert.equal(recordIfSealed(plain('a'), markNew, custody), null);
assert.equal(custody.currentEpoch(), 0);

// Malformed (no id) is ignored.
assert.equal(recordIfSealed({tags: [['ke', '0']]}, markNew, custody), null);

// A new sealed post is counted.
let r = recordIfSealed(sealed('s1'), markNew, custody);
assert.deepEqual(r, {epoch: 0, rotated: false});

// A duplicate id is not double-counted.
assert.equal(recordIfSealed(sealed('s1'), markNew, custody), null);

// The rotateEvery-th distinct sealed post rotates the epoch.
recordIfSealed(sealed('s2'), markNew, custody);
r = recordIfSealed(sealed('s3'), markNew, custody);
assert.deepEqual(r, {epoch: 1, rotated: true});
assert.equal(custody.currentEpoch(), 1);

// Rotation minted (and retained) a fresh key for the new epoch, keeping the old one unlockable.
assert.ok(custody.keyFor(0) && custody.keyFor(1) && custody.keyFor(0) !== custody.keyFor(1));

console.log('PASS contentEpochWatcher_test');
