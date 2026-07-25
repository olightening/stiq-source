/**
 * useLazyModalMount — lazy-mount a heavy <Modal> WITHOUT ever mounting it already-visible.
 *
 * Android on RN 0.76 reliably presents a Modal only when it is already mounted and its `visible`
 * prop toggles false→true; a Modal that MOUNTS with `visible` already true frequently fails to
 * appear (the app-wide "always-mount + toggle visible" rule — see LogScreen.tsx's DetailSheet and
 * StiqAlert.tsx). MainScreen's heavy sheets can't afford to be always-mounted from first render,
 * so they used the `mounted.current ||= open` lazy idiom instead — which sets mount + visible in
 * the SAME render on first open: exactly the failure mode the rule exists to avoid, and a visible
 * first-open flicker even when the Modal does present.
 *
 * This hook keeps the lazy part and fixes the sequencing:
 *  - closed and never opened → `{mounted:false, visible:false}` (costs nothing, same as before);
 *  - first open → ONE commit with `{mounted:true, visible:false}` (the Modal mounts hidden), then
 *    the effect flips to `{mounted:true, visible:true}` on the next commit — a false→true toggle
 *    on an already-mounted Modal, the sequencing Android needs;
 *  - close → `visible:false` but `mounted` stays true forever after (matching the old idiom, so
 *    re-opens are instant and follow the always-mount rule from then on).
 *
 * Usage: `const sheet = useLazyModalMount(sheetOpen);`
 *        `{sheet.mounted && <Modal visible={sheet.visible} …>}`
 */
import {useEffect, useState} from 'react';

export interface LazyModalMount {
  /** Render the Modal at all? False until the first open, true forever after. */
  mounted: boolean;
  /** The Modal's `visible` prop. Never true in the same commit that `mounted` becomes true. */
  visible: boolean;
}

export function useLazyModalMount(open: boolean): LazyModalMount {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      if (!mounted) {
        // Commit 1: mount the Modal hidden. The effect re-runs after this commit (mounted is a
        // dependency) and takes the else-branch below — flipping visible in commit 2.
        setMounted(true);
      } else if (!visible) {
        setVisible(true);
      }
    } else if (visible) {
      setVisible(false);
    }
  }, [open, mounted, visible]);

  return {mounted, visible};
}
