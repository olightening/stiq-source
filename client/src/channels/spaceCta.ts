/**
 * CTA state line for a private-space embed card (membership handoff):
 *   none    → "View & request access ›"
 *   pending → "⏳ Requested · pending ›"
 *   member  → no line (the card just opens the space).
 *
 * WHY a module-level resolver and not a prop: the card renders inside ReferencedCard, which sits
 * under MessageBody/ChatBubble/RichText across FIVE independent surfaces (DM, group, channel,
 * comments, feed). The join state lives on the AppRuntime; threading a getter prop through every
 * layer of every surface for one sub-line is exactly the bug-#12 drift trap. The host (App.tsx)
 * registers the runtime-backed resolver once; the card reads it at render. Every state change that
 * can flip the CTA (request sent / withdrawn / approved) also emits a runtime snapshot, so the tree
 * re-renders and the line is never stale.
 */
type JoinStateResolver = (groupId: string) => 'member' | 'pending' | 'none';

let resolver: JoinStateResolver | null = null;

/** Register (or clear, with null) the host's join-state resolver. */
export function setJoinStateResolver(r: JoinStateResolver | null): void {
  resolver = r;
}

/** The CTA line for a space card, or null to render no line (member / no resolver / not private). */
export function spaceCtaFor(groupId: string, isPrivate: boolean): string | null {
  if (!resolver || !isPrivate) return null;
  switch (resolver(groupId)) {
    case 'none':
      return 'View & request access ›';
    case 'pending':
      return '⏳ Requested · pending ›';
    default:
      return null;
  }
}
