/**
 * BlurhashView — renders a decoded BlurHash as a single <Svg> of colored <Rect>s (Tier 0).
 *
 * No native module, no canvas, no <Image>, and crucially no network: the hash already
 * lives in the post's signed event, so this is a colorful preview with zero IP-leak risk.
 *
 * The grid is drawn inside ONE react-native-svg surface (one native view) instead of the
 * previous nested grid of ~73 plain RN Views (1 container + N rows + N*N cells). The visual
 * result is identical — an 8x8 grid of flat color cells filling the parent box — but the
 * native view tree collapses to a single node. The component is also React.memo'd on its
 * props so the (pure, deterministic) decode + render happens once per (hash, resolution)
 * and never re-runs on unrelated parent re-renders.
 */
import React, {useMemo} from 'react';
import {StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import Svg, {Rect} from 'react-native-svg';
import {decodeBlurhash} from '../media/blurhash';
import {colors} from './theme';

export interface BlurhashViewProps {
  hash?: string;
  /** Grid resolution; higher = smoother but more cells. */
  resolution?: number;
  style?: StyleProp<ViewStyle>;
}

function BlurhashViewImpl({hash, resolution = 8, style}: BlurhashViewProps): React.JSX.Element {
  const grid = useMemo(
    () => (hash ? decodeBlurhash(hash, resolution, resolution) : null),
    [hash, resolution],
  );

  if (!grid) {
    return <View style={[styles.fallback, style]} />;
  }

  // Use the grid's own dimensions as the SVG viewBox so each cell is exactly 1 unit; the Svg
  // stretches to fill the parent via preserveAspectRatio="none" (same fill behavior as the
  // old flex grid, which let each cell flex to fill without preserving aspect ratio).
  const {cols, rows, colors: cellColors} = grid;
  // Bleed each rect slightly past its cell so neighbors overlap — under
  // preserveAspectRatio="none" scaling, exact 1-unit tiles can leave hairline anti-alias seams;
  // the overlap keeps the surface visually seamless like the old butted flex cells.
  const BLEED = 0.02;
  const cells: React.JSX.Element[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const color = cellColors[r * cols + c];
      cells.push(
        <Rect
          key={r * cols + c}
          x={c - BLEED}
          y={r - BLEED}
          width={1 + BLEED * 2}
          height={1 + BLEED * 2}
          fill={color}
        />,
      );
    }
  }

  return (
    <View style={[styles.container, style]}>
      <Svg
        style={StyleSheet.absoluteFill}
        viewBox={`0 0 ${cols} ${rows}`}
        preserveAspectRatio="none">
        {cells}
      </Svg>
    </View>
  );
}

export const BlurhashView = React.memo(BlurhashViewImpl);
BlurhashView.displayName = 'BlurhashView';

const styles = StyleSheet.create({
  container: {...StyleSheet.absoluteFillObject},
  fallback: {...StyleSheet.absoluteFillObject, backgroundColor: colors.surfaceAlt},
});
