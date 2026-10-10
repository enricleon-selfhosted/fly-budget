import { z } from 'zod';

// Daily reference rates of the European Central Bank, through Frankfurter (frankfurter.dev: open
// source, no key). Only used when the user turns downloading on (docs/multi-currency M4). The
// request carries the two currency codes and the dates, nothing else. `fetch` is passed in, so
// tests use a fake.

export const FRANKFURTER_API = 'https://api.frankfurter.dev/v1';
const TIMEOUT_MS = 30_000;
/** Ten years of one pair is about 80 KB */
const MAX_BYTES = 2 * 1024 * 1024;

export type RatesErrorCode = 'unreachable' | 'unsupported';

export class RatesUnavailableError extends Error {
  constructor(readonly code: RatesErrorCode) {
    super(
      code === 'unsupported' ? 'No rates for this currency' : 'Could not reach the rates service',
    );
  }
}

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const code = z.string().regex(/^[A-Z]{3}$/);
const rangeSchema = z.object({
  base: code,
  rates: z.record(isoDay, z.record(code, z.number().positive().finite().max(1e9))),
});

async function readLimited(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new RatesUnavailableError('unreachable');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * The rates of 1 `base` in `quote` for each business day from `from` to `to` (YYYY-MM-DD). The
 * service also returns the business day before `from` when `from` isn't one.
 */
export async function fetchDailyRates(
  fetchImpl: typeof fetch,
  query: { base: string; quote: string; from: string; to: string },
): Promise<{ date: string; rate: number }[]> {
  const { base, quote, from, to } = query;
  // Only checked codes and dates go into the address
  for (const c of [base, quote])
    if (!code.safeParse(c).success) throw new RatesUnavailableError('unsupported');
  for (const d of [from, to])
    if (!isoDay.safeParse(d).success) throw new RatesUnavailableError('unreachable');

  const url = `${FRANKFURTER_API}/${from}..${to}?base=${base}&symbols=${quote}`;
  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new RatesUnavailableError('unreachable');
  }
  // An unknown currency: the ECB doesn't publish it
  if (response.status === 404 || response.status === 422) {
    throw new RatesUnavailableError('unsupported');
  }
  if (!response.ok) throw new RatesUnavailableError('unreachable');

  let body: unknown;
  try {
    body = JSON.parse(await readLimited(response));
  } catch (err) {
    if (err instanceof RatesUnavailableError) throw err;
    throw new RatesUnavailableError('unreachable');
  }
  const parsed = rangeSchema.safeParse(body);
  if (!parsed.success || parsed.data.base !== base) throw new RatesUnavailableError('unreachable');
  return Object.entries(parsed.data.rates)
    .map(([date, rates]) => ({ date, rate: rates[quote] }))
    .filter((r): r is { date: string; rate: number } => r.rate !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
}
