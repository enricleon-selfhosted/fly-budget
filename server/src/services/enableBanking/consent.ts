import { createHash, randomBytes } from 'crypto';
import { nanoid } from 'nanoid';

// Consents waiting for the user to come back from their bank (decision D2). The `state` sent
// to the bank is the only thing that authenticates the bank's redirect, so it is 256 random
// bits, used once, short-lived, and looked up by its hash. The UI never sees it: it polls with
// a separate id. Kept in memory: a restart just means connecting again.

export const CONSENT_TTL_MS = 30 * 60 * 1000;

export type ConsentOutcome<T> =
  { status: 'complete'; result: T } | { status: 'error'; error: string };

export type ConsentStatus<T> = { status: 'pending' } | { status: 'expired' } | ConsentOutcome<T>;

type Pending<I, T> = {
  id: string;
  stateHash: string;
  info: I;
  createdAt: number;
  finished?: ConsentOutcome<T>;
  /** The last attempt to finish failed; another one (a reload, a paste) may still succeed */
  failed?: ConsentOutcome<T>;
  inFlight?: Promise<ConsentOutcome<T>>;
};

const hash = (state: string) => createHash('sha256').update(state).digest('hex');

export interface ConsentRegistry<I, T> {
  /** Starts waiting; `state` goes to the bank, `id` to the UI */
  begin(info: I): { id: string; state: string };
  /** What the UI sees while polling */
  status(id: string): ConsentStatus<T>;
  /** Details of a pending consent, by poll id */
  info(id: string): I | undefined;
  /**
   * The bank sent the user back with this state. Runs `finish` exactly once even if the
   * callback and a pasted address arrive together. A failed `finish` is reported to the
   * poller and can be retried.
   * `expectedId` binds a pasted address to the consent the UI is waiting for.
   * Undefined when the state is unknown, expired, or belongs to another consent.
   */
  complete(
    state: string,
    finish: (info: I) => Promise<T>,
    errorMessage: (err: unknown) => string,
    expectedId?: string,
  ): Promise<ConsentOutcome<T>> | undefined;
  /** The bank sent the user back with an error */
  fail(state: string, error: string): boolean;
  cancel(id: string): void;
}

export function createConsentRegistry<I, T>(now: () => number = Date.now): ConsentRegistry<I, T> {
  const byId = new Map<string, Pending<I, T>>();
  const byState = new Map<string, Pending<I, T>>();

  const expired = (p: Pending<I, T>) => !p.finished && now() - p.createdAt > CONSENT_TTL_MS;
  const remove = (p: Pending<I, T>) => {
    byId.delete(p.id);
    byState.delete(p.stateHash);
  };
  const sweep = () => {
    for (const p of byId.values()) if (now() - p.createdAt > CONSENT_TTL_MS) remove(p);
  };
  const live = (state: string, expectedId?: string) => {
    const p = byState.get(hash(state));
    if (!p || expired(p) || (expectedId !== undefined && p.id !== expectedId)) return undefined;
    return p;
  };

  return {
    begin(info) {
      sweep();
      const state = randomBytes(32).toString('base64url');
      const pending: Pending<I, T> = {
        id: nanoid(32),
        stateHash: hash(state),
        info,
        createdAt: now(),
      };
      byId.set(pending.id, pending);
      byState.set(pending.stateHash, pending);
      return { id: pending.id, state };
    },

    status(id) {
      const p = byId.get(id);
      if (!p || expired(p)) return { status: 'expired' };
      return p.finished ?? p.failed ?? { status: 'pending' };
    },

    info(id) {
      return byId.get(id)?.info;
    },

    complete(state, finish, errorMessage, expectedId) {
      const p = live(state, expectedId);
      if (!p) return undefined;
      if (p.finished) return Promise.resolve(p.finished);
      p.inFlight ??= finish(p.info).then(
        (result) => (p.finished = { status: 'complete', result }),
        (err: unknown) => {
          p.inFlight = undefined;
          return (p.failed = { status: 'error', error: errorMessage(err) });
        },
      );
      return p.inFlight;
    },

    fail(state, error) {
      const p = live(state);
      if (!p || p.finished || p.inFlight) return false;
      p.finished = { status: 'error', error };
      return true;
    },

    cancel(id) {
      const p = byId.get(id);
      if (p) remove(p);
    },
  };
}
