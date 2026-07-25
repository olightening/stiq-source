/**
 * Shared message primitives for the Channels area. Both the channel screen and the group screen
 * compose these, so each visual (card, bubble, chips, footer, header, composer, referenced card) has
 * exactly ONE implementation — fixing one fixes every space type at once (the S-2 of the redesign).
 */
export {AuthorHeader} from './AuthorHeader';
export {ChannelComposer} from './ChannelComposer';
export {ChatBubble} from './ChatBubble';
export {CommentThread} from './CommentThread';
export {MessageBody} from './MessageBody';
export {MessageCard, cardChrome} from './MessageCard';
export {MessageFooter} from './MessageFooter';
export {QuotedReply} from './QuotedReply';
export {ReactionChips} from './ReactionChips';
export {ReferencedCard} from './ReferencedCard';
export {SpaceHeader, StatusPill, SpaceBackButton} from './SpaceHeader';
export {SwipeToReply} from './SwipeToReply';
export {npubFor, shortNpub, relativeTime, relTimeShort, referencedLabel} from './format';
