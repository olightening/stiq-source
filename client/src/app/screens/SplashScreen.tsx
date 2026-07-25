/**
 * SplashScreen — the neutral launch screen shown while the runtime determines the real app state.
 *
 * On cold start the snapshot defaults to `enrolled: false`; without this gate the app would render
 * the onboarding welcome for a frame before `AppRuntime.init()` reads the keystore and flips to the
 * lock screen. Showing this calm, on-brand splash until hydration removes that flash. It is just the
 * `Stiq.` wordmark on the app background — no chrome — with a slow "breathing" pulse so a multi-second
 * cold start reads as "working", not "frozen".
 */
import React, {useEffect, useRef} from 'react';
import {Animated, Easing, StyleSheet, Text, View} from 'react-native';
import {colors, weight} from '../../ui/theme';
import {fonts} from '../../ui/typography';

export function SplashScreen(): React.JSX.Element {
  // A slow opacity pulse signals the app is alive while init() holds this splash on the serial
  // keystore/SQLCipher reads. CRUCIAL: useNativeDriver:true runs the animation on the UI thread, so it
  // keeps moving even while the single Hermes JS thread is blocked in those reads — a JS-driven
  // animation (useNativeDriver:false) would stall for exactly this window and look worse than static.
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 0.45,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  return (
    <View style={s.root}>
      <Animated.Text style={[s.wordmark, {opacity: pulse}]}>
        Stiq<Text style={s.dot}>.</Text>
      </Animated.Text>
    </View>
  );
}

const s = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg, alignItems: 'center', justifyContent: 'center'},
  wordmark: {fontFamily: fonts.serif, fontSize: 42, fontWeight: weight.bold, color: colors.textPrimary, letterSpacing: 0.4},
  dot: {color: colors.accent},
});
