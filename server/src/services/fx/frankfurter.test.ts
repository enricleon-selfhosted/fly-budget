import { describe, expect, it } from 'vitest';
import { FRANKFURTER_API, RatesUnavailableError, fetchDailyRates } from './frankfurter.js';

const query = { base: 'GBP', quote: 'EUR', from: '2026-01-01', to: '2026-01-07' };
const answer =
  (body: unknown, status = 200): typeof fetch =>
  async () =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (err) {
    return err instanceof RatesUnavailableError ? err.code : 'other';
  }
};

describe('fetchDailyRates', () => {
  it('asks only for the pair and the dates, and returns the rates oldest first', async () => {
    let asked = '';
    const rates = await fetchDailyRates(async (input) => {
      asked = String(input);
      return Response.json({
        base: 'GBP',
        rates: { '2026-01-05': { EUR: 1.16 }, '2025-12-31': { EUR: 1.15 } },
      });
    }, query);
    expect(asked).toBe(`${FRANKFURTER_API}/2026-01-01..2026-01-07?base=GBP&symbols=EUR`);
    expect(rates).toEqual([
      { date: '2025-12-31', rate: 1.15 },
      { date: '2026-01-05', rate: 1.16 },
    ]);
  });

  it('a currency the ECB doesn’t publish is unsupported', async () => {
    expect(await code(fetchDailyRates(answer({ message: 'not found' }, 404), query))).toBe(
      'unsupported',
    );
  });

  it('anything else that goes wrong is unreachable: network, errors, odd answers', async () => {
    const failing: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    for (const fake of [
      failing,
      answer('oops', 500),
      answer('not json'),
      answer({ base: 'USD', rates: {} }),
      answer({ base: 'GBP', rates: { '2026-01-05': { EUR: -1 } } }),
      answer({ base: 'GBP', rates: { yesterday: { EUR: 1.1 } } }),
    ]) {
      expect(await code(fetchDailyRates(fake, query))).toBe('unreachable');
    }
  });

  it('stops reading an answer that is too big', async () => {
    const huge = answer(`{"base":"GBP","rates":{${'"x":1,'.repeat(500_000)}}}`);
    expect(await code(fetchDailyRates(huge, query))).toBe('unreachable');
  });

  it('never builds an address from anything but codes and dates', async () => {
    const asked: string[] = [];
    const spy: typeof fetch = async (input) => {
      asked.push(String(input));
      return Response.json({ base: 'GBP', rates: {} });
    };
    expect(await code(fetchDailyRates(spy, { ...query, base: 'GB&P' }))).toBe('unsupported');
    expect(await code(fetchDailyRates(spy, { ...query, from: '2026-01-01/../x' }))).toBe(
      'unreachable',
    );
    expect(asked).toEqual([]);
  });
});
