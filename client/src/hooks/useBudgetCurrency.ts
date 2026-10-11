import { usePreferencesStore } from '../store/preferencesStore';
import { budgetCurrency } from '../utils/budgetCurrency';
import { useCurrencies } from './useCurrencies';

/** The budget's currency: the server's once it has one (docs/multi-currency M2), else this device's */
export function useBudgetCurrency(): string {
  const code = usePreferencesStore((s) => s.currencyCode);
  const symbol = usePreferencesStore((s) => s.currencySymbol);
  const server = useCurrencies().data?.budgetCurrency;
  return server ?? budgetCurrency(code, symbol);
}
