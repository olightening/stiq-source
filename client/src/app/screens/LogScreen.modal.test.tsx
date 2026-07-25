import 'react-native';
import React, {useState} from 'react';
import {Modal} from 'react-native';
import renderer, {act} from 'react-test-renderer';
import {LogScreen} from './LogScreen';
import type {ModLogEntry} from '../../moderation/modlog';

/**
 * Regression guard for the Android Modal-presentation bug: the Log tab's detail sheet must stay
 * MOUNTED at all times and be driven by its `visible` prop (false→true), NOT be conditionally
 * mounted with a hardcoded `<Modal visible>`. On Android a `<Modal>` that mounts already-visible
 * frequently fails to present, so tapping a log entry showed nothing. Keeping the Modal mounted +
 * toggling `visible` is the app-wide rule every other sheet follows (port of the deleted
 * GuideAndLog.modal.test.tsx for the rebuilt LogScreen).
 */

const MOD = 'a'.repeat(64);
const AUTHOR = 'b'.repeat(64);

function entry(): ModLogEntry {
  return {
    key: '1',
    action: 'hide',
    targetType: 'post',
    target: 'target-1',
    targetAuthorPubkey: AUTHOR,
    moderatorPubkey: MOD,
    moderatorNpub: 'npub1mod',
    timestamp: Math.floor(Date.now() / 1000) - 60,
    reason: 'Broke the rules.',
    reportType: 'doxxing',
    targetContent: 'The removed post body.',
  };
}

/** A stateful harness that owns openEntryKey the way MainScreen does, so the always-mounted
 *  Modal contract is exercised through real prop plumbing rather than a fixed prop. */
function Harness({entries}: {entries: ModLogEntry[]}): React.JSX.Element {
  const [openEntryKey, setOpenEntryKey] = useState<string | null>(null);
  return (
    <LogScreen
      isModerator={false}
      hearth={null}
      logOpen={true}
      onSetLogOpen={() => undefined}
      entries={entries}
      openEntryKey={openEntryKey}
      onOpenEntry={setOpenEntryKey}
      onOpenLogPost={() => undefined}
    />
  );
}

function detailModal(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance {
  // LogScreen renders exactly two always-mounted Modals: the community-log overlay
  // (animationType "none" — its slide is a custom Animated pass) and the detail sheet
  // (animationType "slide"). Both must always be present; the sheet is the one under test here.
  const modals = tree.root.findAllByType(Modal);
  expect(modals).toHaveLength(2);
  const sheet = modals.find(m => m.props.animationType === 'slide');
  expect(sheet).toBeTruthy();
  return sheet!;
}

it('detail sheet Modal is always mounted and driven by visible (not conditionally mounted)', async () => {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(<Harness entries={[entry()]} />);
  });

  // The community-log overlay Modal reflects logOpen (true in this harness).
  const logOverlay = tree!.root.findAllByType(Modal).find(m => m.props.animationType === 'none');
  expect(logOverlay?.props.visible).toBe(true);

  // Closed: Modal present but not visible.
  expect(detailModal(tree!).props.visible).toBe(false);

  // Tap the entry card.
  const card = tree!.root.find(
    n =>
      typeof n.props?.accessibilityLabel === 'string' &&
      n.props.accessibilityLabel.includes('Tap to view details'),
  );
  act(() => {
    card.props.onPress();
  });

  // Open: same single Modal, now visible → this false→true transition is what makes Android present it.
  expect(detailModal(tree!).props.visible).toBe(true);

  // The sheet content is rendered.
  const text = tree!.root
    .findAll(n => typeof n.children?.[0] === 'string')
    .map(n => n.children[0] as string)
    .join(' | ');
  expect(text).toContain('REMOVED CONTENT');
  expect(text).toContain('REASON');
  // Tags render '#'-prefixed.
  expect(text).toContain('#doxxing');

  // LogScreen's mount-time slide-in (`logOpen` true from the start) fires a real, non-native-driven
  // Animated.timing — let it run to completion inside the test (act's real-timer wait) so no
  // setTimeout callback is left pending past this file's Jest environment teardown.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  tree!.unmount();
});
