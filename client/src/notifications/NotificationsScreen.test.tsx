/**
 * NotificationsScreen — component tests for the redesigned notification center
 * (design_handoff_notifications). Focus: the behavioral contract of the list pane —
 *   - rows render the structured actor / action / target line + preview;
 *   - filter chips filter the list and carry per-type unread counts;
 *   - a row tap marks read (onMarkRead) AND navigates (onSelect);
 *   - ✓✓ Mark-all-read reports up (onMarkAllRead) and zeroes the chip counts;
 *   - the empty state appears when the active filter has no rows.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';

import {NotificationsScreen} from './NotificationsScreen';
import type {NotifItem} from './notifications';
import {DEFAULT_PREFS, type NotificationPrefs} from './prefs';

jest.setTimeout(20000);

const NOW = Math.floor(Date.now() / 1000);

function item(over: Partial<NotifItem> & {id: string; kind: NotifItem['kind']}): NotifItem {
  return {
    ts: NOW - 60,
    target: {kind: 'post', rootId: 'root1'},
    read: false,
    actor: 'Someone',
    action: 'did something',
    avatar: {shape: 'circle', seed: 'npub1seed'},
    ...over,
  };
}

const ITEMS: NotifItem[] = [
  item({
    id: 'n1',
    kind: 'dm',
    actor: 'Quiet Harbor',
    action: 'sent you a message',
    preview: '“did you see the new bridge list?”',
    target: {kind: 'dm', peer: 'peer1'},
  }),
  item({
    id: 'n2',
    kind: 'reply',
    actor: 'Pale Signal',
    action: 'commented on your post',
    targetText: '“Staying reachable”',
    preview: '“Does this hold up though?”',
  }),
  item({
    id: 'n3',
    kind: 'channel',
    read: true,
    ts: NOW - 2 * 86400,
    actor: 'Stiq Team',
    action: 'posted in',
    targetText: '#announcements',
    target: {kind: 'channel', channelId: 'ch1', channelType: 'public'},
    avatar: {shape: 'square', seed: 'ch1'},
  }),
  item({
    id: 'n4',
    kind: 'post',
    actor: 'Marta K.',
    action: 'posted publicly',
    preview: 'Threat modeling for normal people',
    target: {kind: 'post', rootId: 'p1'},
  }),
];

function textOf(node: renderer.ReactTestInstance): string {
  return node
    .findAll(() => true)
    .flatMap(n => (Array.isArray(n.children) ? n.children : []))
    .filter((c: any): c is string | number => typeof c === 'string' || typeof c === 'number')
    .map(String)
    .join('');
}

function pressByLabel(tree: renderer.ReactTestRenderer, label: string): void {
  const matches = tree.root.findAll(
    n => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === label,
  );
  if (matches.length === 0) throw new Error(`no pressable labelled "${label}"`);
  act(() => {
    matches[0]!.props.onPress();
  });
}

function render(over: Partial<React.ComponentProps<typeof NotificationsScreen>> = {}) {
  const onSelect = jest.fn();
  const onMarkRead = jest.fn();
  const onMarkAllRead = jest.fn();
  const onSetPrefs = jest.fn();
  let tree!: renderer.ReactTestRenderer;
  act(() => {
    tree = renderer.create(
      <NotificationsScreen
        visible
        onClose={jest.fn()}
        items={ITEMS}
        prefs={DEFAULT_PREFS}
        onSetPrefs={onSetPrefs}
        onSelect={onSelect}
        onMarkRead={onMarkRead}
        onMarkAllRead={onMarkAllRead}
        channels={[]}
        subscribedChannelIds={[]}
        {...over}
      />,
    );
  });
  return {tree, onSelect, onMarkRead, onMarkAllRead, onSetPrefs};
}

/**
 * Finds a ToggleRow's Switch by its row label. Matches nodes by the Switch prop signature (value +
 * onValueChange), same "find by props, not by type identity" style as pressByLabel/rowPressable
 * above, then disambiguates duplicates (composite vs. host instances both carry those props) by
 * requiring the immediate JSX parent's rendered text to start with the label — ToggleRow always
 * renders <View row><View rowBody><Text label/>{sub}</View><Switch/></View>, so only the true
 * top-level <Switch/> instance's direct parent is that row and starts with the label text.
 */
function switchForLabel(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance {
  const candidates = tree.root.findAll(
    n => typeof n.props?.onValueChange === 'function' && typeof n.props?.value === 'boolean',
  );
  const match = candidates.find(sw => sw.parent && textOf(sw.parent).startsWith(label));
  if (!match) throw new Error(`no Switch found for row "${label}"`);
  return match;
}

describe('NotificationsScreen (redesigned center)', () => {
  it('renders structured rows: actor + action + target + preview, sectioned by recency', () => {
    const {tree} = render();
    const all = textOf(tree.root);
    expect(all).toContain('Quiet Harbor');
    expect(all).toContain('sent you a message');
    expect(all).toContain('“did you see the new bridge list?”');
    expect(all).toContain('Pale Signal');
    expect(all).toContain('“Staying reachable”');
    expect(all).toContain('#announcements');
    // Recency sections: two fresh rows land in TODAY, the 2-day-old channel row in THIS WEEK.
    expect(all).toContain('TODAY');
    expect(all).toContain('THIS WEEK');
  });

  it('chip counts reflect per-type unread (read rows excluded)', () => {
    const {tree} = render();
    const chipFor = (label: string) =>
      tree.root.findAll(
        n => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === `Filter ${label}`,
      )[0]!;
    expect(textOf(chipFor('All'))).toBe('All3'); // n1 + n2 + n4 unread; n3 is read
    expect(textOf(chipFor('DMs'))).toBe('DMs1');
    expect(textOf(chipFor('Comments'))).toBe('Comments1');
    expect(textOf(chipFor('Posts'))).toBe('Posts1');
    expect(textOf(chipFor('Channels'))).toBe('Channels'); // 0 unread → no count badge
  });

  it('post rows show the large in-circle megaphone, not the small corner badge', () => {
    const {tree} = render();
    // The post marker is the 26px megaphone; channel rows keep the 10px corner-badge megaphone.
    const bigMegaphones = tree.root.findAll(n => n.props?.name === '📣' && n.props?.size === 26);
    expect(bigMegaphones).toHaveLength(1);
    // DM rows keep the small envelope corner badge.
    const envelopes = tree.root.findAll(n => n.props?.name === '✉️' && n.props?.size === 10);
    expect(envelopes).toHaveLength(1);
  });

  it('filter chips filter the list', () => {
    const {tree} = render();
    pressByLabel(tree, 'Filter DMs');
    const all = textOf(tree.root);
    expect(all).toContain('Quiet Harbor');
    expect(all).not.toContain('Pale Signal');
    expect(all).not.toContain('#announcements');
  });

  /** The row's actual native pressable (the memoized NotifRow component node also exposes an
   *  onPress prop, but it expects the item argument — filter to the host Press, which (row
   *  variant) still carries Press's default accessibilityRole="button", unlike the NotifRow
   *  wrapper element itself). */
  function rowPressable(tree: renderer.ReactTestRenderer, text: string): renderer.ReactTestInstance {
    const matches = tree.root.findAll(
      n => typeof n.props?.onPress === 'function' && n.props?.accessibilityRole === 'button' && textOf(n).includes(text),
    );
    if (matches.length === 0) throw new Error(`no row containing "${text}"`);
    return matches[0]!;
  }

  it('row tap marks read and navigates to the source', () => {
    const {tree, onSelect, onMarkRead} = render();
    act(() => {
      rowPressable(tree, 'Quiet Harbor').props.onPress();
    });
    expect(onMarkRead).toHaveBeenCalledWith('n1');
    expect(onSelect).toHaveBeenCalledWith({kind: 'dm', peer: 'peer1'});
  });

  it('tapping an already-read row navigates without re-marking', () => {
    const {tree, onSelect, onMarkRead} = render();
    act(() => {
      rowPressable(tree, 'Stiq Team').props.onPress();
    });
    expect(onMarkRead).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith({kind: 'channel', channelId: 'ch1', channelType: 'public'});
  });

  it('✓✓ Mark-all-read reports up and zeroes the chip counts', () => {
    const {tree, onMarkAllRead} = render();
    pressByLabel(tree, 'Mark all read');
    expect(onMarkAllRead).toHaveBeenCalled();
    const chip = tree.root.findAll(
      n => typeof n.props?.onPress === 'function' && n.props?.accessibilityLabel === 'Filter All',
    )[0]!;
    expect(textOf(chip)).toBe('All'); // count badge gone
  });

  it('shows the empty state when the active filter has no rows', () => {
    const {tree} = render({items: [ITEMS[0]!]}); // only a DM row
    pressByLabel(tree, 'Filter Posts');
    const all = textOf(tree.root);
    expect(all).toContain("You're all caught up");
    expect(all).toContain('Nothing new in this filter right now.');
  });

  it('back from the settings pane returns to the list, not out of the center', () => {
    const onClose = jest.fn();
    const {tree} = render({onClose});
    pressByLabel(tree, 'Notification settings'); // gear → settings pane
    expect(textOf(tree.root)).toContain('Notification settings');
    pressByLabel(tree, 'Back'); // chevron → back to the list
    expect(textOf(tree.root)).toContain('TODAY');
    expect(onClose).not.toHaveBeenCalled();
    pressByLabel(tree, 'Back'); // from the list, back closes the center
    expect(onClose).toHaveBeenCalled();
  });

  it('the system back gesture (Modal.onRequestClose) is pane-aware too', () => {
    const onClose = jest.fn();
    const {tree} = render({onClose});
    pressByLabel(tree, 'Notification settings');
    const modal = tree.root.findAll(n => typeof n.props?.onRequestClose === 'function')[0]!;
    act(() => {
      modal.props.onRequestClose();
    });
    expect(onClose).not.toHaveBeenCalled(); // settings → list
    expect(textOf(tree.root)).toContain('TODAY');
    act(() => {
      modal.props.onRequestClose();
    });
    expect(onClose).toHaveBeenCalled(); // list → close
  });
});

describe('Notification settings — In-app / Push tabs (push ⊆ in-app split)', () => {
  it('the settings pane opens on the In-app tab by default', () => {
    const {tree} = render();
    pressByLabel(tree, 'Notification settings');
    const all = textOf(tree.root);
    expect(all).toContain('GENERAL');
    expect(all).not.toContain('Push notifications');
  });

  it('the Push tab shows push category rows plus a qualitative, non-alarming footer note', () => {
    const {tree} = render();
    pressByLabel(tree, 'Notification settings');
    pressByLabel(tree, 'Settings tab Push');
    const all = textOf(tree.root);
    expect(all).toContain('Push notifications');
    expect(all).toContain('Message push');
    expect(all).toContain('Channel push');
    expect(all).toContain('Reply push');
    expect(all).toContain('Background delivery is checked periodically and may be delayed.');
    // Naming-policy + honesty constraints on the footer copy (a separate Tor workstream owns
    // cadence/naming and is actively changing it — the copy must not hardcode either).
    expect(all).not.toMatch(/tor/i);
    expect(all).not.toMatch(/\d+\s*(sec|min)/i);
    expect(all).not.toMatch(/won'?t arrive|doesn'?t work when/i);
  });

  it('a push row whose in-app parent is off renders disabled with "Off in In-app"', () => {
    const prefs: NotificationPrefs = {...DEFAULT_PREFS, dms: {...DEFAULT_PREFS.dms, enabled: false}};
    const {tree} = render({prefs});
    pressByLabel(tree, 'Notification settings');
    pressByLabel(tree, 'Settings tab Push');
    expect(textOf(tree.root)).toContain('Off in In-app');
    const sw = switchForLabel(tree, 'Message push');
    expect(sw.props.disabled).toBe(true);
  });

  it('an in-app-enabled category push row stays enabled and reflects push.dms', () => {
    const {tree} = render();
    pressByLabel(tree, 'Notification settings');
    pressByLabel(tree, 'Settings tab Push');
    const sw = switchForLabel(tree, 'Message push');
    expect(sw.props.disabled).toBeFalsy();
    expect(sw.props.value).toBe(true); // DEFAULT_PREFS.push.dms
  });

  it('the master push.enabled switch off disables every category row underneath it', () => {
    const prefs: NotificationPrefs = {...DEFAULT_PREFS, push: {...DEFAULT_PREFS.push, enabled: false}};
    const {tree} = render({prefs});
    pressByLabel(tree, 'Notification settings');
    pressByLabel(tree, 'Settings tab Push');
    expect(textOf(tree.root)).toContain('Push notifications are off');
    for (const label of ['Message push', 'Channel push', 'Reply push']) {
      expect(switchForLabel(tree, label).props.disabled).toBe(true);
    }
    // The master switch itself is never disabled — it's the one control that recovers everything.
    expect(switchForLabel(tree, 'Push notifications').props.disabled).toBeFalsy();
  });

  it('toggling a push row commits via onSetPrefs without touching the in-app fields', () => {
    const {tree, onSetPrefs} = render();
    pressByLabel(tree, 'Notification settings');
    pressByLabel(tree, 'Settings tab Push');
    act(() => {
      switchForLabel(tree, 'Message push').props.onValueChange(false);
    });
    expect(onSetPrefs).toHaveBeenCalledWith(
      expect.objectContaining({
        push: expect.objectContaining({dms: false}),
        dms: DEFAULT_PREFS.dms, // in-app field untouched
      }),
    );
  });

  it('switching back to the In-app tab shows the unchanged legacy toggles', () => {
    const {tree} = render();
    pressByLabel(tree, 'Notification settings');
    pressByLabel(tree, 'Settings tab Push');
    pressByLabel(tree, 'Settings tab In-app');
    const all = textOf(tree.root);
    expect(all).toContain('Message notifications');
    expect(all).not.toContain('Message push');
  });
});
