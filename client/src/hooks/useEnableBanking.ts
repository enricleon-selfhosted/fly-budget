import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as api from '../api/enableBanking';
import type { EnableBankingMappingAction } from '../types';
import { refreshBudgetFigures, refreshRecurring } from './budgetFigures';

const STATUS = ['enablebanking-status'];
const CONNECTIONS = ['enablebanking-connections'];

/**
 * What a sync or mapping change can touch: new accounts, payees and transactions, exchanges and
 * transfers it links, and recurring items it pays (docs/enable-banking D29)
 */
function invalidateBudgetData(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: CONNECTIONS });
  qc.invalidateQueries({ queryKey: ['payees'] });
  refreshBudgetFigures(qc);
  refreshRecurring(qc);
}

export function useEnableBankingStatus() {
  return useQuery({ queryKey: STATUS, queryFn: api.getEnableBankingStatus });
}

export function useConfigureEnableBanking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.configureEnableBanking,
    onSuccess: (status) => qc.setQueryData(STATUS, status),
  });
}

export function useRemoveEnableBankingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.removeEnableBankingConfig,
    onSuccess: () => qc.invalidateQueries({ queryKey: STATUS }),
  });
}

/** Banks Enable Banking supports in a country (cached for the session) */
export function useEnableBankingAspsps(country: string | null) {
  return useQuery({
    queryKey: ['enablebanking-aspsps', country],
    queryFn: () => api.getEnableBankingAspsps(country!),
    enabled: !!country,
    staleTime: 60 * 60 * 1000,
    select: (data) => data.aspsps,
  });
}

export function useEnableBankingConnections() {
  return useQuery({ queryKey: CONNECTIONS, queryFn: api.getEnableBankingConnections });
}

export function useMapEnableBankingAccounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      connectionId,
      budgetCurrency,
      accounts,
    }: {
      connectionId: string;
      budgetCurrency: string;
      accounts: EnableBankingMappingAction[];
    }) => api.mapEnableBankingAccounts(connectionId, budgetCurrency, accounts),
    onSuccess: () => invalidateBudgetData(qc),
  });
}

export function useSyncEnableBankingConnection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.syncEnableBankingConnection,
    onSettled: () => invalidateBudgetData(qc),
  });
}

export function useSyncAllEnableBanking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncAllEnableBanking(),
    onSettled: () => invalidateBudgetData(qc),
  });
}

export function useDisconnectEnableBanking() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.disconnectEnableBanking,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: CONNECTIONS });
      qc.invalidateQueries({ queryKey: STATUS });
    },
  });
}
