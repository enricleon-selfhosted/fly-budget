import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { addCounts, emptySyncResult } from './syncService.js';

// How a connection's sync result adds up its accounts' imports.

const counts = fc.record({
  added: fc.nat(1000),
  matched: fc.nat(1000),
  transfers: fc.nat(1000),
  recurring: fc.nat(1000),
  duplicates: fc.nat(1000),
  otherCurrency: fc.nat(1000),
});

describe('sync results', () => {
  it('start at zero and add up every account’s import, keeping the connection’s fields', () => {
    fc.assert(
      fc.property(fc.array(counts, { maxLength: 6 }), (imports) => {
        const empty = emptySyncResult({ id: 'c1', aspspName: 'BBVA' });
        expect(empty).toEqual({
          connectionId: 'c1',
          aspspName: 'BBVA',
          added: 0,
          matched: 0,
          transfers: 0,
          recurring: 0,
          status: 'good',
          errors: [],
        });
        const total = imports.reduce(addCounts, empty);
        const sum = (k: 'added' | 'matched' | 'transfers' | 'recurring') =>
          imports.reduce((n, i) => n + i[k], 0);
        // Only the counts a sync reports: nothing else from the import reaches the response
        expect(total).toEqual({
          ...empty,
          added: sum('added'),
          matched: sum('matched'),
          transfers: sum('transfers'),
          recurring: sum('recurring'),
        });
      }),
    );
  });

  it('can start as a failed sync', () => {
    expect(emptySyncResult({ id: 'c1', aspspName: 'BBVA' }, 'error').status).toBe('error');
  });
});
