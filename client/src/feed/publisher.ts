/**
 * Post publisher (PLAN.md §2 / Step 12 wiring). Composes → signs (keystore) → publishes
 * over the relay (Tor-routed in production). One call the Composer's onSubmit can use.
 */
import type {Event} from 'nostr-tools/pure';
import {publishPost, type Signer} from './compose';

export interface RelayPublisher {
  publish(event: Event): Promise<{accepted: boolean; message: string}>;
}

export interface PostResult {
  event: Event;
  accepted: boolean;
  message: string;
}

export type PostPublisher = (content: string, tags?: string[]) => Promise<PostResult>;

/** Build a publisher from a signer (Identity) and a relay client. */
export function createPostPublisher(signer: Signer, relay: RelayPublisher): PostPublisher {
  return async (content, tags = []) => {
    const event = await publishPost(signer, content, tags);
    const {accepted, message} = await relay.publish(event);
    return {event, accepted, message};
  };
}
