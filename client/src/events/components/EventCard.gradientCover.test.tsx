/**
 * EventCard's Feed cover gradient must render through the onLayout-measured `GradientRect` (pixel
 * `width`/`height`), never a `%`-sized root Svg — that's flaky on Android react-native-svg 15 and
 * only partially fills the 152px cover band. See ui/GradientRect.tsx.
 */
import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {View} from 'react-native';
import {EventCard} from './EventCard';
import {GradientRect} from '../../ui/GradientRect';
import type {EventCardProps} from '../types';

function render(el: React.ReactElement): renderer.ReactTestRenderer {
  let tree: renderer.ReactTestRenderer | undefined;
  act(() => {
    tree = renderer.create(el);
  });
  return tree!;
}

const baseProps: EventCardProps = {
  title: 'Launch party',
  variant: 'Feed',
  type: 'inperson',
  month: 'NOV',
  day: '8',
  dateLabel: 'Sat, Nov 8',
  timeLabel: '19:00 CET',
  locationLabel: '',
  hostName: 'Alice',
  hostGrad: {type: 'linear', angle: 135, stops: ['#111111', '#222222']},
  interestedCount: 0,
  attendingCount: null,
  capacity: null,
  countOnly: false,
  tag: '',
  recurring: '',
  rsvp: null,
  status: 'upcoming',
  external: false,
  coverMode: 'gradient',
  coverGradient: {type: 'linear', angle: 135, stops: ['#7cb2ff', '#b89aff']},
  coverImage: undefined,
};

test('cover gradient measures a real pixel size via onLayout, not a % Svg', () => {
  const tree = render(<EventCard {...baseProps} />);

  const gradientRect = tree.root.findByType(GradientRect);
  // Before layout fires, no pixel size is known yet — GradientRect renders nothing but its
  // onLayout-bearing measuring View (the whole point: it never falls back to a %-sized Svg).
  expect(gradientRect.findAllByType(View).length).toBeGreaterThan(0);

  const measuringView = gradientRect.findAllByType(View)[0]!;
  expect(typeof measuringView.props.onLayout).toBe('function');

  act(() => {
    measuringView.props.onLayout({nativeEvent: {layout: {x: 0, y: 0, width: 343, height: 152}}});
  });

  // After layout, the mocked <Svg> (jest.setup.js renders it as a plain View) must carry the
  // MEASURED pixel dimensions — never the string "100%".
  const svgView = gradientRect.findAllByType(View).find(n => typeof n.props.width === 'number');
  expect(svgView).toBeDefined();
  expect(svgView!.props.width).toBe(343);
  expect(svgView!.props.height).toBe(152);
});

test('coverMode "none" renders no GradientRect', () => {
  const tree = render(<EventCard {...baseProps} coverMode="none" />);
  expect(tree.root.findAllByType(GradientRect)).toHaveLength(0);
});
