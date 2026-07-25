/**
 * In-memory session produced by enrollment (PLAN.md §3.3 / Step 6). Held only until the
 * key + credential are moved into the hardware keystore (Step 7). clear() scrubs the
 * secret material and is the duress/logout hook (Step 11).
 */
import type {Session} from './enrollment';

export class SessionManager {
  private session: Session | null = null;

  current(): Session | null {
    return this.session;
  }

  isEnrolled(): boolean {
    return this.session !== null;
  }

  set(session: Session): void {
    this.session = session;
  }

  clear(): void {
    if (this.session) {
      this.session.secretKey.fill(0);
      this.session.credential.token.fill(0);
      this.session.credential.signature.fill(0);
    }
    this.session = null;
  }
}
