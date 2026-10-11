import { describe, expect, it } from 'vitest';
import { CONSENT_TTL_MS, createConsentRegistry } from './consent.js';

const message = (err: unknown) => (err as Error).message;

describe('consent registry', () => {
  it('gives the UI an id and the bank a different, unguessable state', async () => {
    const registry = createConsentRegistry<{ bank: string }, string>();
    const { id, state } = registry.begin({ bank: 'BBVA' });
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(id).not.toBe(state);
    expect(registry.status(id)).toEqual({ status: 'pending' });
    // Finishing gets the details the consent began with
    let seen: { bank: string } | undefined;
    const finish = async (info: { bank: string }) => {
      seen = info;
      return 'connection-1';
    };
    await registry.complete(state, finish, message);
    expect(seen).toEqual({ bank: 'BBVA' });
  });

  it('finishes exactly once even when the callback and a pasted address arrive together', async () => {
    const registry = createConsentRegistry<null, string>();
    const { id, state } = registry.begin(null);
    let runs = 0;
    const finish = async () => {
      runs++;
      await new Promise((r) => setTimeout(r, 5));
      return 'connection-1';
    };
    const results = await Promise.all([
      registry.complete(state, finish, message),
      registry.complete(state, finish, message, id),
      registry.complete(state, finish, message),
    ]);
    expect(runs).toBe(1);
    for (const r of results) expect(r).toEqual({ status: 'complete', result: 'connection-1' });
    expect(registry.status(id)).toEqual({ status: 'complete', result: 'connection-1' });
    // Later attempts get the same answer without running again
    expect(await registry.complete(state, finish, message)).toEqual(results[0]);
    expect(runs).toBe(1);
  });

  it('reports a failed finish to the poller, and lets a later attempt succeed', async () => {
    const registry = createConsentRegistry<null, string>();
    const { id, state } = registry.begin(null);
    const failed = await registry.complete(
      state,
      () => Promise.reject(new Error('code expired')),
      message,
    );
    expect(failed).toEqual({ status: 'error', error: 'code expired' });
    expect(registry.status(id)).toEqual({ status: 'error', error: 'code expired' });
    expect(await registry.complete(state, async () => 'ok', message)).toEqual({
      status: 'complete',
      result: 'ok',
    });
  });

  it('ignores unknown states, and a pasted address from another consent', () => {
    const registry = createConsentRegistry<null, string>();
    const a = registry.begin(null);
    const b = registry.begin(null);
    const finish = async () => 'x';
    expect(registry.complete('not-a-state', finish, message)).toBeUndefined();
    expect(registry.complete(a.state, finish, message, b.id)).toBeUndefined();
    expect(registry.status(b.id)).toEqual({ status: 'pending' });
  });

  it('expires after 30 minutes', () => {
    let now = 0;
    const registry = createConsentRegistry<null, string>(() => now);
    const { id, state } = registry.begin(null);
    now = CONSENT_TTL_MS + 1;
    expect(registry.status(id)).toEqual({ status: 'expired' });
    expect(registry.complete(state, async () => 'x', message)).toBeUndefined();
  });

  it('records an error the bank sent back, once, and forgets cancelled consents', () => {
    const registry = createConsentRegistry<null, string>();
    const { id, state } = registry.begin(null);
    expect(registry.fail(state, 'You cancelled at your bank.')).toBe(true);
    expect(registry.status(id)).toEqual({ status: 'error', error: 'You cancelled at your bank.' });
    expect(registry.fail(state, 'again')).toBe(false);

    const other = registry.begin(null);
    registry.cancel(other.id);
    expect(registry.status(other.id)).toEqual({ status: 'expired' });
    expect(registry.complete(other.state, async () => 'x', message)).toBeUndefined();
  });

  it('ignores an error address pasted for another consent, leaving both waiting', async () => {
    const registry = createConsentRegistry<null, string>();
    const a = registry.begin(null);
    const b = registry.begin(null);
    expect(registry.fail(a.state, 'You cancelled at your bank.', b.id)).toBe(false);
    expect(registry.status(a.id)).toEqual({ status: 'pending' });
    expect(registry.status(b.id)).toEqual({ status: 'pending' });
    // Both can still finish
    expect(await registry.complete(a.state, async () => 'x', message, a.id)).toEqual({
      status: 'complete',
      result: 'x',
    });
    expect(registry.fail(b.state, 'You cancelled at your bank.', b.id)).toBe(true);
  });
});
