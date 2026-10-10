import { Link } from 'react-router-dom';
import { useCurrencies } from '../../hooks/useCurrencies';
import { ExternalLink } from '../ui/ExternalLink';
import { useBudgetCurrency } from '../../utils/budgetCurrency';
import { docsUrl } from '../../utils/project';

/** The codes the ECB doesn't publish, from `ratesError` ("unsupported:ARS,KES") */
function unsupportedCodes(ratesError: string | null | undefined): string[] {
  const prefix = 'unsupported:';
  if (!ratesError?.startsWith(prefix)) return [];
  return ratesError.slice(prefix.length).split(',');
}

interface Props {
  /** The account's currency (not the budget's) */
  currency: string;
  /** The Off budget box, as it will be saved */
  offBudget: boolean;
}

/**
 * What an account in another currency does in the budget, under its Off budget box (M1, M4).
 * On budget, its transactions are converted each day, so it needs rates; if none can come from
 * anywhere, say where to add them.
 */
export function ForeignBudgetHint({ currency, offBudget }: Props) {
  const budget = useBudgetCurrency();
  const { data } = useCurrencies();

  if (offBudget) {
    return (
      <span className="block text-xs text-text-tertiary">
        Its income counts when it's exchanged into {budget}.{' '}
        <ExternalLink
          href={`${docsUrl('accounts')}#income-in-another-currency`}
          className="font-medium text-brand-600 hover:text-brand-700"
        >
          How this works
        </ExternalLink>
      </span>
    );
  }

  // Before the overview loads, don't claim there's no source yet
  const entry = data?.currencies.find((c) => c.code === currency);
  const noRateSource =
    data !== undefined &&
    !entry?.latest &&
    (!data.downloadRates || unsupportedCodes(data.ratesError).includes(currency));

  return (
    <span className="block text-xs text-text-tertiary">
      Its transactions count in {budget}, converted at each day's rate.
      {noRateSource && (
        <>
          {' '}
          There's no rate for {currency} yet.{' '}
          <Link
            to="/settings?tab=currencies"
            className="font-medium text-brand-600 hover:text-brand-700 whitespace-nowrap"
          >
            Add exchange rates in Settings → Currencies
          </Link>
        </>
      )}
    </span>
  );
}
