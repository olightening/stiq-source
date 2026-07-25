/**
 * App-level link-dialog opener.
 *
 * Any component asks to open a link by calling openLinkDialog(); a SINGLE <LinkDialogHost/> mounted
 * once at the app root (a sibling of AppShell) presents the one dialog. Callers never open a browser
 * themselves — the dialog is the only place that decides where a link goes.
 *
 * The host keeps its <Modal> PERMANENTLY MOUNTED and only toggles `visible`. On the old RN
 * architecture (Paper) each <Modal> is a separate Android Dialog window, and ReactModalHostView fires
 * the native Dialog.show ONLY on a false→true `visible` transition observed after the view is
 * attached; conditionally mounting the <Modal> element already-visible drops that show (the Dialog is
 * created but never shown), which is what once made "Open link" silently do nothing. Mount-once-and-
 * toggle mirrors the always-mounted RemovalSheet/BanSheet host modals.
 */
export interface LinkRequest {
  url: string;
  /** Link text / markdown title, when the caller has one. Falls back to the domain. */
  title?: string;
}

type Listener = (req: LinkRequest | null) => void;

let listener: Listener | null = null;
let queued: LinkRequest | null = null;

/** Register the single app-root host. Called by <LinkDialogHost/> on mount (null on unmount). */
export function registerLinkDialogHost(l: Listener | null): void {
  listener = l;
  if (l && queued) {
    const req = queued;
    queued = null;
    l(req);
  }
}

/**
 * Present the link dialog for a URL. Safe to call from anywhere in the tree — including from inside
 * another Modal. If the host isn't mounted yet the request is queued and opens as soon as it
 * registers.
 */
export function openLinkDialog(req: LinkRequest): void {
  if (listener) {
    listener(req);
  } else {
    queued = req;
  }
}
