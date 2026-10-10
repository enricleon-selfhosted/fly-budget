import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as accountsApi from '../api/accounts';
import { useUndoStore } from '../store/undoStore';
import type { Account } from '../types';

// Changing an account's currency or budget status changes what its transactions are worth in the
// budget (docs/multi-currency M5, M8), so every figure built from them is refreshed
const BUDGET_FIGURES = [
  'transactions',
  'budget',
  'budget-summary',
  'reports',
  'category-history',
  'dashboards',
  'currencies',
];

function refreshBudgetFigures(qc: ReturnType<typeof useQueryClient>) {
  for (const key of BUDGET_FIGURES) qc.invalidateQueries({ queryKey: [key] });
}

type AccountUpdate = Parameters<typeof accountsApi.updateAccount>[1];

function movesBudgetFigures(data: AccountUpdate): boolean {
  return 'currency' in data || 'isOffBudget' in data;
}

export function useAccounts() {
  return useQuery({
    queryKey: ['accounts'],
    queryFn: accountsApi.getAccounts,
  });
}

export function useCreateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: accountsApi.createAccount,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      // The currency's account count (and its rates' status) changes with a new account in it
      if (created.currency) qc.invalidateQueries({ queryKey: ['currencies'] });
      useUndoStore.getState().push({
        description: `Create account "${created.name}"`,
        undo: async () => {
          await accountsApi.closeAccount(created.id);
          qc.invalidateQueries({ queryKey: ['accounts'] });
          if (created.currency) qc.invalidateQueries({ queryKey: ['currencies'] });
        },
        redo: async () => {
          await accountsApi.createAccount({
            name: created.name,
            type: created.type,
            startingBalance: created.startingBalance,
            isOffBudget: created.isOffBudget,
            currency: created.currency,
          });
          qc.invalidateQueries({ queryKey: ['accounts'] });
          if (created.currency) qc.invalidateQueries({ queryKey: ['currencies'] });
        },
      });
    },
  });
}

export function useUpdateAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof accountsApi.updateAccount>[1];
    }) => accountsApi.updateAccount(id, data),
    onMutate: async ({ id }) => {
      const accounts = qc.getQueryData<Account[]>(['accounts']);
      return { old: accounts?.find((a) => a.id === id) };
    },
    onSuccess: (_, { id, data }, ctx) => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      if (movesBudgetFigures(data)) refreshBudgetFigures(qc);
      if (!ctx?.old) return;
      const snapshot = ctx.old;
      useUndoStore.getState().push({
        description: `Edit account`,
        undo: async () => {
          await accountsApi.updateAccount(id, {
            name: snapshot.name,
            type: snapshot.type,
            isOffBudget: snapshot.isOffBudget,
            currency: snapshot.currency ?? null,
          });
          qc.invalidateQueries({ queryKey: ['accounts'] });
          refreshBudgetFigures(qc);
        },
        redo: async () => {
          await accountsApi.updateAccount(id, data);
          qc.invalidateQueries({ queryKey: ['accounts'] });
          if (movesBudgetFigures(data)) refreshBudgetFigures(qc);
        },
      });
    },
  });
}

export function useCloseAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      const accounts = qc.getQueryData<Account[]>(['accounts']);
      const snapshot = accounts?.find((a) => a.id === id);
      return accountsApi.closeAccount(id).then(() => snapshot);
    },
    onSuccess: (snapshot) => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      if (!snapshot) return;
      useUndoStore.getState().push({
        description: `Close account "${snapshot.name}"`,
        undo: async () => {
          await accountsApi.updateAccount(snapshot.id, { name: snapshot.name });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
        redo: async () => {
          await accountsApi.closeAccount(snapshot.id);
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
      });
    },
  });
}

export function useBalancesAgo() {
  return useQuery({
    queryKey: ['accounts', 'balances-ago'],
    queryFn: accountsApi.getBalancesAgo,
  });
}

export function useReorderAccounts() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) => {
      const accounts = qc.getQueryData<Account[]>(['accounts']);
      const oldIds = accounts?.map((a) => a.id) ?? [];
      return accountsApi.reorderAccounts(ids).then(() => oldIds);
    },
    onSuccess: (oldIds, newIds) => {
      qc.invalidateQueries({ queryKey: ['accounts'] });
      useUndoStore.getState().push({
        description: `Reorder accounts`,
        undo: async () => {
          await accountsApi.reorderAccounts(oldIds);
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
        redo: async () => {
          await accountsApi.reorderAccounts(newIds);
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
      });
    },
  });
}
