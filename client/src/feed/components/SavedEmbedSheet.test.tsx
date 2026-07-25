/**
 * SavedEmbedSheet — the shared "SAVED · TAP TO EMBED" picker (behind a composer's `+` → Embed).
 *
 * A saved SPACE embed (channel kind-30311 / private group kind-39000) must render as a channel-card
 * row — its space label + carried name, no post snippet — instead of falling back to the generic
 * "REFERENCED POST" / "Saved post" row: its id is a NIP-01 coordinate (`30311:<owner>:<d>` /
 * `39000:<owner>:<groupId>`) that `getSummary` can't resolve. Mirrors the same fix in
 * ChannelView / GroupView / ConversationView.
 */
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

import 'react-native';
import React from 'react';
import renderer, {act} from 'react-test-renderer';
import {SavedEmbedSheet} from './SavedEmbedSheet';
import {saveChannelEmbed, saveSpaceEmbed, removeEmbed} from '../../channels/savedEmbeds';

const owner = 'c'.repeat(64);
const channelId = `30311:${owner}:general`;
const groupId = `39000:${owner}:secret`;

describe('SavedEmbedSheet — saved SPACE embeds render as channel-card rows', () => {
  afterEach(async () => {
    await removeEmbed(channelId);
    await removeEmbed(groupId);
  });

  it('renders a saved CHANNEL and PRIVATE SPACE with their space label + name, and no post snippet', async () => {
    await saveChannelEmbed({id: channelId, owner, name: 'General Chat'}, 1);
    await saveSpaceEmbed({id: 'secret', owner, name: 'Secret Group'}, 2);

    // A getSummary that WOULD inject a post name/snippet if a space row wrongly consulted it — the
    // space rows must ignore it entirely (their id is a coordinate, not a resolvable event id).
    const getSummary = jest.fn(() => ({name: 'WRONG NAME', content: 'a post body that must never show'}));

    let tree: renderer.ReactTestRenderer | undefined;
    await act(async () => {
      tree = renderer.create(
        <SavedEmbedSheet visible onClose={jest.fn()} onPick={jest.fn()} getSummary={getSummary} />,
      );
    });

    const text = JSON.stringify(tree!.toJSON());
    // Channel-card labels + the carried names, not the generic REFERENCED POST / Saved post fallback.
    expect(text).toContain('CHANNEL');
    expect(text).toContain('General Chat');
    expect(text).toContain('PRIVATE SPACE');
    expect(text).toContain('Secret Group');
    expect(text).not.toContain('Saved post');
    expect(text).not.toContain('REFERENCED POST');
    // No post snippet on a space row, and the coordinate id is never fed to getSummary.
    expect(text).not.toContain('a post body that must never show');
    expect(text).not.toContain('WRONG NAME');
    expect(getSummary).not.toHaveBeenCalled();
  });
});
