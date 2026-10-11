import { apiFetch } from './client';
import type {
  EnableBankingAspsp,
  EnableBankingConfigInput,
  EnableBankingConnection,
  EnableBankingConsentStatus,
  EnableBankingMappingAction,
  EnableBankingMappingResult,
  EnableBankingStatus,
  EnableBankingSyncResult,
} from '../types';

// Contract: docs/enable-banking/api.md

export const getEnableBankingStatus = () => apiFetch<EnableBankingStatus>('/enablebanking/status');

export const configureEnableBanking = (input: EnableBankingConfigInput) =>
  apiFetch<EnableBankingStatus>('/enablebanking/config', {
    method: 'PUT',
    body: JSON.stringify(input),
  });

export const removeEnableBankingConfig = () =>
  apiFetch<void>('/enablebanking/config', { method: 'DELETE' });

export const getEnableBankingAspsps = (country: string) =>
  apiFetch<{ aspsps: EnableBankingAspsp[] }>(
    `/enablebanking/aspsps?country=${encodeURIComponent(country)}`,
  );

export interface StartConsentInput {
  aspspName: string;
  country: string;
  psuType?: 'personal' | 'business';
  /** Renew this connection instead of adding one */
  connectionId?: string;
}

export const startEnableBankingConsent = (input: StartConsentInput) =>
  apiFetch<{ id: string; url: string }>('/enablebanking/authorizations', {
    method: 'POST',
    body: JSON.stringify(input),
  });

export const pollEnableBankingConsent = (id: string) =>
  apiFetch<EnableBankingConsentStatus>(`/enablebanking/authorizations/${encodeURIComponent(id)}`);

/** For installs whose redirect URL isn't FlyBudget's callback: the address the bank sent the user to */
export const completeEnableBankingConsent = (id: string, redirectedTo: string) =>
  apiFetch<EnableBankingConsentStatus>(
    `/enablebanking/authorizations/${encodeURIComponent(id)}/complete`,
    { method: 'POST', body: JSON.stringify({ redirectedTo }) },
  );

export const cancelEnableBankingConsent = (id: string) =>
  apiFetch<void>(`/enablebanking/authorizations/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const getEnableBankingConnections = () =>
  apiFetch<EnableBankingConnection[]>('/enablebanking/connections');

// The server decides which accounts are in another currency from the budget's currency it
// stores (docs/multi-currency M2), so the request doesn't carry one
export const mapEnableBankingAccounts = (
  connectionId: string,
  accounts: EnableBankingMappingAction[],
) =>
  apiFetch<EnableBankingMappingResult>(
    `/enablebanking/connections/${encodeURIComponent(connectionId)}/accounts`,
    { method: 'PUT', body: JSON.stringify({ accounts }) },
  );

export const syncEnableBankingConnection = (connectionId: string) =>
  apiFetch<EnableBankingSyncResult>(
    `/enablebanking/connections/${encodeURIComponent(connectionId)}/sync`,
    { method: 'POST' },
  );

export const syncAllEnableBanking = () =>
  apiFetch<{ results: EnableBankingSyncResult[] }>('/enablebanking/sync-all', { method: 'POST' });

export const disconnectEnableBanking = (connectionId: string) =>
  apiFetch<void>(`/enablebanking/connections/${encodeURIComponent(connectionId)}`, {
    method: 'DELETE',
  });
