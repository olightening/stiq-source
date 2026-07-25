/**
 * Handle suggestions — a combinatorial generator for the onboarding "🎲 Suggest a handle" button.
 *
 * This replaces a flat list of ten hardcoded strings. Ten candidates is not "random": in any
 * community above a handful of members, tapping suggest lands on a name someone else was already
 * shown, and a member who taps it twice sees the list repeat immediately. Since a display name is a
 * *contended* namespace (only the earliest claimant renders it — see ./displayName), a small
 * candidate space is not merely a cosmetic annoyance: it manufactures the exact collisions that
 * leave later claimants silently rendering as a bare npub.
 *
 * Two disjoint wordlists give {@link HANDLE_CANDIDATE_SPACE} = 120 × 160 = 19,200 candidates. The
 * lists are deliberately kept in the app's existing quiet/natural register (the ten originals were
 * 'Quiet River', 'Slate Wren', 'Maple Ward'…): muted colours, weather, trees, landforms, birds and
 * animals. Words are chosen so that NO pair can read as a slur, and so that no word points at a
 * real-world referent — no personal names, no places, no ethnicities, nothing that could narrow down who a
 * member is. Nouns are strictly non-human for the same reason.
 *
 * The two lists are disjoint and free of near-duplicates across roles ('Misty Mist', 'Drifting
 * Drift') so no draw can produce a stuttering handle — `handleWords.test.ts` pins both invariants.
 */
import {randomFloat} from '../util/random';

/**
 * Modifiers: muted colours, weather, seasons, trees, temperament, direction. Disjoint from
 * {@link HANDLE_NOUNS} (asserted in tests) so a draw can never produce e.g. 'Cedar Cedar'.
 * Longest entry is 9 characters — see the length invariant on {@link randomHandle}.
 */
export const HANDLE_ADJECTIVES: readonly string[] = [
  'Quiet', 'Silent', 'Still', 'Calm', 'Soft', 'Gentle', 'Mild', 'Patient',
  'Steady', 'Humble', 'Modest', 'Plain', 'Simple', 'Spare', 'Lone', 'Wild',
  'Wandering', 'Drifting', 'Roaming', 'Passing', 'Waiting', 'Watchful', 'Hidden', 'Distant',
  'Deep', 'Wide', 'Open', 'Narrow', 'Low', 'Upper', 'Outer', 'Inner',
  'Northern', 'Southern', 'Eastern', 'Western', 'Coastal', 'Inland', 'Upland', 'Lowland',
  'Pale', 'Faint', 'Dim', 'Dusk', 'Dawn', 'Morning', 'Evening', 'Night',
  'Winter', 'Autumn', 'Summer', 'Spring', 'First', 'Last', 'Elder', 'Young',
  'Grey', 'Slate', 'Ashen', 'Amber', 'Umber', 'Ochre', 'Russet', 'Auburn',
  'Copper', 'Bronze', 'Pewter', 'Silver', 'Golden', 'Ivory', 'Linen', 'Chalk',
  'Jade', 'Olive', 'Moss', 'Fern', 'Sage', 'Laurel', 'Myrtle', 'Thistle',
  'Cedar', 'Maple', 'Birch', 'Willow', 'Alder', 'Hazel', 'Rowan', 'Aspen',
  'Heather', 'Clover', 'Bramble', 'Juniper', 'Larch', 'Spruce', 'Holly', 'Nettle',
  'Misty', 'Foggy', 'Hazy', 'Cloudy', 'Rainy', 'Snowy', 'Frosty', 'Icy',
  'Windy', 'Sunlit', 'Moonlit', 'Starlit', 'Shaded', 'Quartz', 'Flint', 'Onyx',
  'Glass', 'Stone', 'Iron', 'Salt', 'Sand', 'Clay', 'Peat', 'Velvet',
];

/**
 * Subjects: birds, animals, landforms, water and weather — never a human, a place or a group.
 * Disjoint from {@link HANDLE_ADJECTIVES}. Longest entry is 9 characters ('Guillemot').
 */
export const HANDLE_NOUNS: readonly string[] = [
  'Heron', 'Wren', 'Lark', 'Tern', 'Finch', 'Sparrow', 'Swift', 'Swallow',
  'Plover', 'Curlew', 'Snipe', 'Egret', 'Ibis', 'Crane', 'Stork', 'Bittern',
  'Grebe', 'Teal', 'Pintail', 'Eider', 'Kestrel', 'Harrier', 'Osprey', 'Owl',
  'Wheatear', 'Warbler', 'Thrush', 'Dipper', 'Wagtail', 'Pipit', 'Bunting', 'Linnet',
  'Siskin', 'Redpoll', 'Crossbill', 'Nuthatch', 'Jay', 'Magpie', 'Rook', 'Raven',
  'Chough', 'Starling', 'Oriole', 'Shrike', 'Vireo', 'Junco', 'Towhee', 'Dove',
  'Redshank', 'Dunlin', 'Turnstone', 'Avocet', 'Godwit', 'Whimbrel', 'Guillemot', 'Puffin',
  'Razorbill', 'Fulmar', 'Petrel', 'Gannet', 'Skua', 'Kittiwake', 'Quail', 'Grouse',
  'Fox', 'Otter', 'Hare', 'Marten', 'Stoat', 'Weasel', 'Badger', 'Deer',
  'Roe', 'Elk', 'Lynx', 'Vole', 'Shrew', 'Marmot', 'Beaver', 'Ermine',
  'Ibex', 'Chamois', 'Bison', 'Boar', 'Mole', 'Dormouse', 'Ptarmigan', 'Bracken',
  'River', 'Marsh', 'Vale', 'Ward', 'Fen', 'Moor', 'Dell', 'Glen',
  'Combe', 'Cove', 'Bay', 'Inlet', 'Strand', 'Shoal', 'Reef', 'Cape',
  'Bluff', 'Ridge', 'Crag', 'Scree', 'Fell', 'Meadow', 'Hollow', 'Basin',
  'Delta', 'Ford', 'Weir', 'Brook', 'Burn', 'Beck', 'Rill', 'Creek',
  'Bend', 'Reach', 'Verge', 'Sound', 'Strait', 'Firth', 'Tarn', 'Mere',
  'Pool', 'Wold', 'Lea', 'Croft', 'Garth', 'Holt', 'Copse', 'Grove',
  'Thicket', 'Hedge', 'Furrow', 'Hillock', 'Knoll', 'Ravine', 'Gorge', 'Gully',
  'Rime', 'Thaw', 'Gloaming', 'Twilight', 'Ripple', 'Eddy', 'Current', 'Tide',
  'Wake', 'Lull', 'Hush', 'Cairn', 'Sleet', 'Squall', 'Breeze', 'Ember',
];

/**
 * How many distinct handles {@link randomHandle} can produce (19,200). Exported so the onboarding
 * copy and the tests both quote ONE number rather than drifting apart.
 */
export const HANDLE_CANDIDATE_SPACE = HANDLE_ADJECTIVES.length * HANDLE_NOUNS.length;

/**
 * The length budget a draw must stay inside: the onboarding handle input's own `maxLength={24}`
 * (also well under MAX_DISPLAY_NAME's 40), so a suggestion is never silently truncated on its way
 * into the identity header. The actual worst case is 19 ('Wandering Guillemot'); a test pins that
 * the lists keep honouring the budget, so a longer word added later fails loudly.
 */
export const MAX_SUGGESTED_HANDLE = 24;

/** Draw one entry, clamped so a `rand` that ever returns exactly 1 can't index off the end. */
function pick(list: readonly string[], rand: () => number): string {
  return list[Math.min(list.length - 1, Math.floor(rand() * list.length))]!;
}

/**
 * A fresh two-word handle, e.g. 'Quiet River'.
 *
 * `rand` defaults to {@link randomFloat} (the CSPRNG) rather than `Math.random`, which Hermes seeds
 * weakly — two phones must not be steered onto the same suggestion. Tests inject a deterministic
 * `rand` instead, matching the convention `randomGradient` already established.
 *
 * This is a SUGGESTION, not a reservation: names are claimed by use and arbitrated locally
 * (./displayName), and at onboarding time the phonebook is empty, so nothing here can promise the
 * result is unclaimed. The large candidate space is what makes a clash unlikely; DisplayNameStore
 * .nameConflict is what surfaces one honestly, later, once it is actually knowable.
 */
export function randomHandle(rand: () => number = randomFloat): string {
  return `${pick(HANDLE_ADJECTIVES, rand)} ${pick(HANDLE_NOUNS, rand)}`;
}
