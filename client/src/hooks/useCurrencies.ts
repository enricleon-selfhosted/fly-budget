import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as currenciesApi from '../api/currencies';

// The budget's currency and exchange rates (docs/multi-currency). Changing any of them changes
// what transactions in accounts in another currency are worth in the budget, so every query
// holding budget figures is refreshed.

/** Everything whose figures depend on conversions */
const CONVERTED = [
  'accounts',
  'transactions',
  'budget',
  'budget-summary',
  'category-history',
  'reports',
  'dashboards',
  'goals',
];

function refreshConverted(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['currencies'] });
  for (const key of CONVERTED) qc.invalidateQueries({ queryKey: [key] });
}

export function useCurrencies() {
  return useQuery({ queryKey: ['currencies'], queryFn: currenciesApi.getCurrencies });
}

export function useUpdateCurrencySettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: currenciesApi.updateCurrencySettings,
    onSuccess: (overview) => {
      qc.setQueryData(['currencies'], overview);
      refreshConverted(qc);
    },
  });
}

export function useRates(code: string | null, limit = 60) {
  return useQuery({
    queryKey: ['currencies', 'rates', code, limit],
    queryFn: () => currenciesApi.getRates(code!, limit),
    enabled: !!code,
  });
}

export function useSetRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, date, rate }: { code: string; date: string; rate: number }) =>
      currenciesApi.setRate(code, date, rate),
    onSuccess: () => refreshConverted(qc),
  });
}

export function useDeleteRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ code, date }: { code: string; date: string }) =>
      currenciesApi.deleteRate(code, date),
    onSuccess: () => refreshConverted(qc),
  });
}

export function useDownloadRates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: currenciesApi.downloadRates,
    onSuccess: () => refreshConverted(qc),
  });
}
