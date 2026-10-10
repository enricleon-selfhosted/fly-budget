import { useEffect, useRef } from 'react';
import { useCanSave } from '../../hooks/useConnection';
import { useCurrencies, useUpdateCurrencySettings } from '../../hooks/useCurrencies';
import { usePreferencesStore } from '../../store/preferencesStore';
import { budgetCurrency } from '../../utils/budgetCurrency';

/**
 * Keeps the budget's currency in step with the server (docs/multi-currency M2). A budget
 * without one gets this device's, sent once; a device whose preference differs follows the
 * budget. Mounted in AppShell; renders nothing.
 */
export function BudgetCurrencySync() {
  const { data } = useCurrencies();
  const canSave = useCanSave();
  const { mutate } = useUpdateCurrencySettings();
  const deviceCode = usePreferencesStore((s) => s.currencyCode);
  const deviceSymbol = usePreferencesStore((s) => s.currencySymbol);
  const setCurrencyCode = usePreferencesStore((s) => s.setCurrencyCode);
  const sending = useRef(false);

  const serverCode = data?.budgetCurrency ?? null;
  const loaded = data !== undefined;

  useEffect(() => {
    if (serverCode) {
      if (serverCode !== deviceCode) setCurrencyCode(serverCode);
      return;
    }
    // Sent once: a failed send is tried again only when the connection or the data changes
    if (!loaded || !canSave || sending.current) return;
    sending.current = true;
    mutate(
      { currency: budgetCurrency(deviceCode, deviceSymbol) },
      {
        onSettled: () => {
          sending.current = false;
        },
      },
    );
  }, [serverCode, deviceCode, deviceSymbol, loaded, canSave, mutate, setCurrencyCode]);

  return null;
}
