import React from 'react';
import {GradientAvatar} from './GradientAvatar';
import type {GradientSpec} from '../media/gradient';

/**
 * A small circular gradient avatar used as a timeline/list bullet. Shared by the
 * Log tab views (previously a local `Dot` in the Log tab and LogPostView).
 */
export function GradientDot({
  size,
  gradient,
  seed,
}: {
  size: number;
  gradient?: GradientSpec | null;
  seed: string;
}): React.JSX.Element {
  return <GradientAvatar size={size} shape="circle" gradient={gradient ?? undefined} seed={seed} />;
}
