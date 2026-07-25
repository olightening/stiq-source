import {Pressable, Text, TextInput} from 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {ProfileScreen} from './ProfileScreen';
import type {Profile} from '../profile';

/** Serialize the rendered tree to a searchable string (drops circular refs). */
function serialize(tree: renderer.ReactTestRenderer): string {
  return JSON.stringify(
    tree.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
}

const profile: Profile = {
  pubkey: 'a'.repeat(64),
  npub: 'npub1example',
  name: 'Ada',
  about: 'builder',
  channels: [{id: 'c1', name: 'Ada News'}],
  posts: [],
  ideaCount: 0,
  ideas: [],
};

it('renders a profile with its channels', () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<ProfileScreen profile={profile} onOpenChannel={() => undefined} />);
  });
  const text = JSON.stringify(
    tree!.toJSON(),
    (seen => (_k: string, v: unknown) => {
      if (v && typeof v === 'object') {
        if (seen.has(v)) return undefined;
        seen.add(v);
      }
      return v;
    })(new WeakSet<object>()),
  );
  expect(text).toContain('Ada');
  expect(text).toContain('Ada News');
});

// ── Fix 3: the header re-derives the shown name from the live identity ─────────────────────────────
it('reflects a live name change when the profile prop refreshes (re-derive on emit / reopen)', () => {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(<ProfileScreen profile={profile} onOpenChannel={() => undefined} />);
  });
  expect(serialize(tree!)).toContain('Ada');

  // The runtime emits a fresh profile for the SAME identity with an updated name — the header must
  // re-derive from it rather than keep the stale captured name.
  act(() => {
    tree!.update(<ProfileScreen profile={{...profile, name: 'Ada Lovelace'}} onOpenChannel={() => undefined} />);
  });
  expect(serialize(tree!)).toContain('Ada Lovelace');
});

it('reflects a just-saved name immediately on the own profile, without waiting for a prop refresh', () => {
  const onSaveName = jest.fn();
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ProfileScreen profile={profile} editable onSaveName={onSaveName} onOpenChannel={() => undefined} />,
    );
  });

  // Enter edit mode via the "Edit profile" button.
  const editBtn = tree!.root
    .findAllByType(Pressable)
    .find(p => p.findAll(n => n.type === Text && n.props.children === 'Edit profile').length > 0)!;
  act(() => { editBtn.props.onPress(); });

  // Type a new name and submit — the Save path whose result previously stayed stale until reopen.
  const input = tree!.root.findByType(TextInput);
  act(() => { input.props.onChangeText('Grace'); });
  act(() => { input.props.onSubmitEditing(); });

  expect(onSaveName).toHaveBeenCalledWith('Grace');
  // The header shows the saved name even though the `profile` prop still says 'Ada' (the parent
  // hasn't re-passed it) — exactly the "stays stale until reopened" symptom this fixes.
  expect(serialize(tree!)).toContain('Grace');
});

// ── Bug 9: the name clash that used to fail silently ──────────────────────────────────────────────

const CONFLICT = {name: 'Ada', owner: 'b'.repeat(64), ownerSince: 100};
const clashed: Profile = {...profile, nameConflict: CONFLICT};

/** Find a Pressable by the exact label text it renders. */
function pressableLabelled(tree: renderer.ReactTestRenderer, label: string) {
  return tree.root
    .findAllByType(Pressable)
    .find(p => p.findAll(n => n.type === Text && n.props.children === label).length > 0);
}

const WARNING = 'Someone claimed this name first';

it('warns on the own profile when the name has definitively been lost to an earlier claimant', () => {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ProfileScreen profile={clashed} editable onSaveName={() => undefined} onOpenChannel={() => undefined} />,
    );
  });
  const text = serialize(tree!);
  expect(text).toContain(WARNING);
  // The consequence must be spelled out — this is the whole point: the member's own screens keep
  // showing their name, so nothing else tells them the community sees an npub.
  expect(text).toContain('npub');
});

it('shows NO warning when there is no known clash', () => {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ProfileScreen profile={profile} editable onSaveName={() => undefined} onOpenChannel={() => undefined} />,
    );
  });
  expect(serialize(tree!)).not.toContain(WARNING);
});

it('never warns on someone ELSE\'s profile (only the viewer can act on it)', () => {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    // Not editable → not the viewer's own profile. A peer who lost their name already renders as a
    // bare npub via nameFor(); there is nothing for this viewer to fix.
    tree = renderer.create(<ProfileScreen profile={clashed} onOpenChannel={() => undefined} />);
  });
  expect(serialize(tree!)).not.toContain(WARNING);
});

it('opens the name editor from the warning, so the fix is one tap away', () => {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ProfileScreen profile={clashed} editable onSaveName={() => undefined} onOpenChannel={() => undefined} />,
    );
  });
  expect(tree!.root.findAllByType(TextInput)).toHaveLength(0);

  act(() => { pressableLabelled(tree!, 'Pick a different name')!.props.onPress(); });

  // The editor is open, seeded with the current name, and the banner steps aside for it.
  expect(tree!.root.findByType(TextInput).props.value).toBe('Ada');
  expect(serialize(tree!)).not.toContain(WARNING);
});

it('drops the warning once the member renames away from the clashed name', () => {
  const onSaveName = jest.fn();
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ProfileScreen profile={clashed} editable onSaveName={onSaveName} onOpenChannel={() => undefined} />,
    );
  });

  act(() => { pressableLabelled(tree!, 'Pick a different name')!.props.onPress(); });
  const input = tree!.root.findByType(TextInput);
  act(() => { input.props.onChangeText('Grace'); });
  act(() => { input.props.onSubmitEditing(); });

  expect(onSaveName).toHaveBeenCalledWith('Grace');
  // The stale `profile` prop still carries the OLD name's conflict; the warning must not survive it
  // and start reading as a claim about 'Grace', which nothing here knows anything about.
  expect(serialize(tree!)).not.toContain(WARNING);
  expect(serialize(tree!)).toContain('Grace');
});

it('restores the warning if a fresh snapshot says the NEW name is also lost', () => {
  let tree: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <ProfileScreen profile={profile} editable onSaveName={() => undefined} onOpenChannel={() => undefined} />,
    );
  });
  expect(serialize(tree!)).not.toContain(WARNING);

  // The runtime re-answers after the rename (identityVersion bumped → getProfile recomputed).
  act(() => {
    tree!.update(
      <ProfileScreen
        profile={{...profile, name: 'Grace', nameConflict: {...CONFLICT, name: 'Grace'}}}
        editable
        onSaveName={() => undefined}
        onOpenChannel={() => undefined}
      />,
    );
  });
  expect(serialize(tree!)).toContain(WARNING);
});
