import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import * as txApi from '../api/transactions';
import { useUndoStore } from '../store/undoStore';
import type { Transaction, TransactionQueryParams } from '../types';
import { refreshBudgetFigures } from './budgetFigures';

function findTxInCache(qc: QueryClient, id: string): Transaction | undefined {
  const caches = qc.getQueriesData<Transaction[]>({ queryKey: ['transactions'] });
  for (const [, data] of caches) {
    const found = data?.find((t) => t.id === id);
    if (found) return found;
  }
}

export function useTransactions(params: TransactionQueryParams = {}) {
  return useQuery({
    queryKey: ['transactions', params],
    queryFn: () => txApi.getTransactions(params),
  });
}

export function useCreateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: txApi.createTransaction,
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      useUndoStore.getState().push({
        description: `Create transaction`,
        undo: async () => {
          await txApi.deleteTransaction(created.id);
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
        redo: async () => {
          await txApi.createTransaction({
            accountId: created.accountId,
            date: created.date,
            amount: created.amount,
            payeeId: created.payeeId,
            payeeName: created.payeeName,
            categoryId: created.categoryId,
            notes: created.notes,
          });
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
      });
    },
  });
}

export function useUpdateTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id: string;
      data: Parameters<typeof txApi.updateTransaction>[1];
    }) => txApi.updateTransaction(id, data),
    onMutate: async ({ id }) => {
      return { old: findTxInCache(qc, id) };
    },
    onSuccess: (_, { id, data }, ctx) => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      if (!ctx?.old) return;
      const snapshot = ctx.old;
      useUndoStore.getState().push({
        description: `Edit transaction`,
        undo: async () => {
          await txApi.updateTransaction(id, {
            accountId: snapshot.accountId,
            date: snapshot.date,
            amount: snapshot.amount,
            payeeId: snapshot.payeeId,
            payeeName: snapshot.payeeName,
            categoryId: snapshot.categoryId,
            notes: snapshot.notes,
          });
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
        redo: async () => {
          await txApi.updateTransaction(id, data);
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
      });
    },
  });
}

export function useDeleteTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      const snapshot = findTxInCache(qc, id);
      return txApi.deleteTransaction(id).then(() => snapshot);
    },
    onSuccess: (snapshot) => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
      if (!snapshot) return;
      useUndoStore.getState().push({
        description: `Delete transaction`,
        undo: async () => {
          await txApi.createTransaction({
            accountId: snapshot.accountId,
            date: snapshot.date,
            amount: snapshot.amount,
            payeeId: snapshot.payeeId,
            payeeName: snapshot.payeeName,
            categoryId: snapshot.categoryId,
            notes: snapshot.notes,
          });
          qc.invalidateQueries({ queryKey: ['transactions'] });
          qc.invalidateQueries({ queryKey: ['accounts'] });
        },
        redo: async () => {
          // Can't delete same id (new one was created), just re-delete latest
          // For simplicity, redo of delete is not supported after undo
          qc.invalidateQueries({ queryKey: ['transactions'] });
        },
      });
    },
  });
}

/** What "Link as transfer" offers for a transaction (loaded when `enabled`) */
export function useTransferCandidates(id: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['transfer-candidates', id],
    queryFn: () => txApi.getTransferCandidates(id!),
    enabled: enabled && !!id,
  });
}

/**
 * Two existing transactions become one transfer (or an exchange, across currencies); the payees
 * and budget figures change with it
 */
export function useLinkTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, otherId }: { id: string; otherId: string }) =>
      txApi.linkTransfer(id, otherId),
    onSuccess: () => {
      refreshBudgetFigures(qc);
      qc.invalidateQueries({ queryKey: ['payees'] });
      qc.invalidateQueries({ queryKey: ['transfer-candidates'] });
    },
  });
}

/** Turns a transfer back into two transactions; the payees and budget figures change with it */
export function useUnlinkTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => txApi.unlinkTransfer(id),
    onSuccess: () => {
      refreshBudgetFigures(qc);
      qc.invalidateQueries({ queryKey: ['payees'] });
      qc.invalidateQueries({ queryKey: ['transfer-candidates'] });
    },
  });
}

export function useReconcileAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, transactionIds }: { accountId: string; transactionIds: string[] }) =>
      txApi.reconcileAccount(accountId, transactionIds),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}

export function useCreateTransfer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: txApi.createTransfer,
    onSuccess: (created) => {
      // An exchange or a transfer across the budget's edge (with a category) moves budget figures
      refreshBudgetFigures(qc);
      const ids = created.map((t) => t.id);
      useUndoStore.getState().push({
        description: `Create transfer`,
        undo: async () => {
          for (const id of ids) await txApi.deleteTransaction(id);
          refreshBudgetFigures(qc);
        },
        redo: async () => {
          if (created.length >= 2) {
            await txApi.createTransfer({
              fromAccountId: created[0].accountId,
              toAccountId: created[1].accountId,
              date: created[0].date,
              amount: Math.abs(created[0].amount),
              // An exchange keeps what arrived, and a category on the budget side
              toAmount: Math.abs(created[1].amount),
              categoryId: created[0].categoryId ?? created[1].categoryId,
              notes: created[0].notes,
            });
          }
          refreshBudgetFigures(qc);
        },
      });
    },
  });
}

export function useImportConfirm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ accountId, rows }: { accountId: string; rows: txApi.ImportRow[] }) =>
      txApi.importConfirm(accountId, rows),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['transactions'] });
      qc.invalidateQueries({ queryKey: ['accounts'] });
    },
  });
}
