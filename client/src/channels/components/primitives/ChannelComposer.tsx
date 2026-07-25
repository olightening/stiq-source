/**
 * ChannelComposer — backward-compatible alias for the shared {@link MessageComposer}.
 *
 * The channel/group message input is now the SAME component used by DMs and comments, so the bubble,
 * the `+` menu, and the send button are standard everywhere and update in lock-step. Channels and
 * group chat keep importing `ChannelComposer` from the primitives barrel; it just resolves to the
 * shared composer. Voice (organizer-allowed) now rides the trailing button when the box is empty
 * instead of sitting in the `+` menu — see MessageComposer's docblock.
 */
export {MessageComposer as ChannelComposer, type MessageComposerProps} from '../../../feed/components/MessageComposer';
