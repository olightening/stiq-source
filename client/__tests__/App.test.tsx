import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import App from '../App';

it('renders the offline-gated shell without crashing', async () => {
  let tree: renderer.ReactTestRenderer | undefined;

  // App's effect bootstraps the Tor manager; with no native module it settles offline.
  // Wrap render + effect flush + unmount in act() so it completes before teardown.
  await act(async () => {
    tree = renderer.create(<App />);
  });
  await act(async () => {
    await Promise.resolve();
  });
  act(() => {
    tree?.unmount();
  });
});
