import { apiFetch } from './client';
import type { CurrencyOverview, ExchangeRate } from '../types';

// The budget's currency and exchange rates (docs/multi-currency/api.md)

export const getCurrencies = () => apiFetch<CurrencyOverview>('/currencies');

export type CurrencySettingsChange = {
  currency?: string;
  /** What the accounts in the budget's currency do when it changes (M2): keep theirs, or follow it */
  budgetAccounts?: 'keep' | 'follow';
  /** Only if the budget has no currency yet: a device sending its own */
  ifUnset?: boolean;
  downloadRates?: boolean;
};

export const updateCurrencySettings = (data: CurrencySettingsChange) =>
  apiFetch<CurrencyOverview>('/currencies', { method: 'PUT', body: JSON.stringify(data) });

export const getRates = (code: string, limit = 60) =>
  apiFetch<ExchangeRate[]>(`/currencies/${encodeURIComponent(code)}/rates?limit=${limit}`);

/** A rate typed in: 1 `code` = `rate` budget currency, from `date` until the next rate */
export const setRate = (code: string, date: string, rate: number) =>
  apiFetch<ExchangeRate>(`/currencies/${encodeURIComponent(code)}/rates/${date}`, {
    method: 'PUT',
    body: JSON.stringify({ rate }),
  });

export const deleteRate = (code: string, date: string) =>
  apiFetch<void>(`/currencies/${encodeURIComponent(code)}/rates/${date}`, { method: 'DELETE' });

export const downloadRates = () =>
  apiFetch<CurrencyOverview & { downloaded: number; error: string | null; unsupported: string[] }>(
    '/currencies/download',
    { method: 'POST' },
  );
