import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import * as api from '../api/enableBanking';
import type { StartConsentInput } from '../api/enableBanking';
import type { EnableBankingConsentResult } from '../types';

const POLL_INTERVAL_MS = 3_000;

/** Shows the bank's page in the tab opened for it, or a new one (the desktop app's system browser) */
function openBankPage(url: string, tab: Window | null) {
  if (tab && !tab.closed) {
    // The bank's page must not be able to reach back into FlyBudget's
    tab.opener = null;
    tab.location.replace(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export type ConsentState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'waiting'; url: string; submitting: boolean; pasteError?: string }
  | { phase: 'error'; message: string };

/**
 * Sends the user to their bank to consent (in their own browser; the desktop app routes
 * window.open() there) and polls the server until the bank sends them back. When the
 * redirect URL isn't FlyBudget's own callback, `submitAddress` takes the address of the page
 * the bank sent them to instead.
 */
export function useEnableBankingConsent(onComplete: (result: EnableBankingConsentResult) => void) {
  const qc = useQueryClient();
  const [state, setState] = useState<ConsentState>({ phase: 'idle' });
  const consent = useRef<string | null>(null);
  /** Bumped by every start, finish and cancel, so a start that returns late knows it's stale */
  const generation = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  const stopPolling = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const finish = useCallback(
    (next: ConsentState) => {
      stopPolling();
      generation.current++;
      consent.current = null;
      setState(next);
    },
    [stopPolling],
  );

  /** Acts on a poll or paste answer; true when the consent is over */
  const settle = useCallback(
    (res: Awaited<ReturnType<typeof api.pollEnableBankingConsent>>) => {
      if (res.status === 'complete') {
        finish({ phase: 'idle' });
        qc.invalidateQueries({ queryKey: ['enablebanking-connections'] });
        qc.invalidateQueries({ queryKey: ['enablebanking-status'] });
        onCompleteRef.current(res.result);
        return true;
      }
      if (res.status === 'expired') {
        finish({ phase: 'error', message: 'Connecting took too long. Please start again.' });
        return true;
      }
      if (res.status === 'error') {
        finish({ phase: 'error', message: res.error });
        return true;
      }
      return false;
    },
    [finish, qc],
  );

  const poll = useCallback(
    async (id: string) => {
      if (consent.current !== id) return;
      try {
        const res = await api.pollEnableBankingConsent(id);
        if (consent.current !== id || settle(res)) return;
      } catch (err) {
        return finish({ phase: 'error', message: (err as Error).message });
      }
      timer.current = setTimeout(() => poll(id), POLL_INTERVAL_MS);
    },
    [finish, settle],
  );

  const start = useCallback(
    async (input: StartConsentInput) => {
      stopPolling();
      const attempt = ++generation.current;
      // Opened now, while the click still counts: browsers block windows opened after an await.
      // The desktop app refuses blank windows (it sends https links to the system browser), so
      // there this is null and the bank page is opened once its address is known.
      const tab = window.open('', '_blank');
      setState({ phase: 'starting' });
      try {
        const { id, url } = await api.startEnableBankingConsent(input);
        if (attempt !== generation.current) {
          // Closed or restarted meanwhile: drop this consent
          tab?.close();
          api.cancelEnableBankingConsent(id).catch(() => {});
          return;
        }
        consent.current = id;
        openBankPage(url, tab);
        setState({ phase: 'waiting', url, submitting: false });
        timer.current = setTimeout(() => poll(id), POLL_INTERVAL_MS);
      } catch (err) {
        tab?.close();
        if (attempt === generation.current)
          setState({ phase: 'error', message: (err as Error).message });
      }
    },
    [poll, stopPolling],
  );

  const submitAddress = useCallback(
    async (address: string) => {
      const id = consent.current;
      if (!id) return;
      setState((s) =>
        s.phase === 'waiting' ? { ...s, submitting: true, pasteError: undefined } : s,
      );
      try {
        const res = await api.completeEnableBankingConsent(id, address.trim());
        if (consent.current === id) settle(res);
      } catch (err) {
        setState((s) =>
          s.phase === 'waiting'
            ? { ...s, submitting: false, pasteError: (err as Error).message }
            : s,
        );
      }
    },
    [settle],
  );

  const reopen = useCallback(() => {
    if (state.phase === 'waiting') openBankPage(state.url, null);
  }, [state]);

  const cancel = useCallback(() => {
    const id = consent.current;
    finish({ phase: 'idle' });
    if (id) api.cancelEnableBankingConsent(id).catch(() => {});
  }, [finish]);

  // Stop polling and drop the pending consent if the component goes away
  useEffect(
    () => () => {
      stopPolling();
      generation.current++;
      if (consent.current) api.cancelEnableBankingConsent(consent.current).catch(() => {});
      consent.current = null;
    },
    [stopPolling],
  );

  return { state, start, submitAddress, reopen, cancel };
}
