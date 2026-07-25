/**
 * Thread collapse/expand state (PLAN.md §2 / Step 14, sub-step 3).
 *
 * A collapsed node stays visible but its descendants are hidden. `visibleNodes` produces the
 * flat, pre-order render list honouring the collapsed set.
 */
import type {CommentNode} from './thread';

export function visibleNodes(
  nodes: CommentNode[],
  collapsed: ReadonlySet<string>,
): CommentNode[] {
  const out: CommentNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (!collapsed.has(node.event.id)) {
      out.push(...visibleNodes(node.children, collapsed));
    }
  }
  return out;
}

/** Mutable collapse state with a toggle. */
export class ThreadCollapse {
  private readonly collapsed = new Set<string>();

  isCollapsed(id: string): boolean {
    return this.collapsed.has(id);
  }

  toggle(id: string): void {
    if (this.collapsed.has(id)) {
      this.collapsed.delete(id);
    } else {
      this.collapsed.add(id);
    }
  }

  collapse(id: string): void {
    this.collapsed.add(id);
  }

  expand(id: string): void {
    this.collapsed.delete(id);
  }

  set(): ReadonlySet<string> {
    return this.collapsed;
  }
}
