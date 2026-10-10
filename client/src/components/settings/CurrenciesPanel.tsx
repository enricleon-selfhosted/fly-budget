import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useCanSave } from '../../hooks/useConnection';
import {
  useCurrencies,
  useDeleteRate,
  useDownloadRates,
  useRates,
  useSetRate,
  useUpdateCurrencySettings,
} from '../../hooks/useCurrencies';
import { IS_DEMO } from '../../demo/isDemo';
import { useBudgetCurrency } from '../../utils/budgetCurrency';
import {
  accountCountText,
  checkRateEntry,
  dayText,
  downloadSummaryText,
  latestRateText,
  rateSourceLabel,
  rateText,
  ratesErrorText,
  ratesUpdatedText,
  todayDay,
  waitingText,
} from '../../utils/currencyRates';
import { docsUrl } from '../../utils/project';
import type { CurrencyInUse, CurrencyOverview, ExchangeRate } from '../../types';
import { SavingPausedHint } from '../connection/SavingPausedHint';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';

const fieldClass =
  'w-full px-3 py-2 text-sm border border-border rounded-md bg-surface text-text focus:outline-none focus:ring-1 focus:ring-brand-600 focus:border-brand-600 max-md:min-h-11';

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h2 className="text-sm font-semibold text-text">{children}</h2>;
}

/**
 * Settings → Currencies: the budget's currency, the download of daily rates, and the rates of
 * each currency that accounts are kept in (docs/multi-currency M4).
 */
export function CurrenciesPanel() {
  const { data, isError } = useCurrencies();
  const budget = useBudgetCurrency();
  const canSave = useCanSave();

  if (!data) {
    return (
      <p className="text-sm text-text-tertiary">
        {isError
          ? "Couldn't load the currencies. Try again when FlyBudget reconnects."
          : 'Loading…'}
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <SectionTitle>Budget currency</SectionTitle>
        <p className="text-sm text-text-secondary">
          Your budget is in <span className="font-semibold text-text">{budget}</span>. To change it,
          go to{' '}
          <Link to="/settings?tab=preferences" className="underline hover:text-text">
            Preferences
          </Link>
          .
        </p>
      </section>

      <section className="space-y-3">
        <SectionTitle>Exchange rates</SectionTitle>
        <p className="text-sm text-text-secondary">
          Accounts in another currency are converted into the budget&apos;s currency at these rates.
          Each transaction keeps the rate it was converted at, so past months don&apos;t change when
          rates move.
        </p>
        <DownloadRates overview={data} canSave={canSave} />
      </section>

      <section className="space-y-3">
        <SectionTitle>Currencies in use</SectionTitle>
        {data.currencies.length === 0 ? (
          <div className="rounded-lg border border-border-light bg-surface-alt">
            <EmptyState
              title="No accounts in other currencies"
              description="Accounts in another currency are converted into the budget's currency with the rates on this page. Choose an account's currency when you add it, or in its Edit dialog, and its rates show here."
              learnMoreHref={docsUrl('accounts')}
            />
          </div>
        ) : (
          <ul className="space-y-3">
            {data.currencies.map((item) => (
              <CurrencyRow key={item.code} item={item} budget={budget} canSave={canSave} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** The switch for daily downloads, and what the last download did */
function DownloadRates({ overview, canSave }: { overview: CurrencyOverview; canSave: boolean }) {
  const checkboxId = useId();
  const descriptionId = useId();
  const update = useUpdateCurrencySettings();
  const download = useDownloadRates();
  const downloading = overview.downloadRates;
  const busy = update.isPending || download.isPending;
  const error = update.error ?? download.error;

  function setDownloading(on: boolean) {
    if (!on) {
      update.mutate({ downloadRates: false });
      return;
    }
    update.mutate({ downloadRates: true }, { onSuccess: () => download.mutate() });
  }

  const problem = downloading ? ratesErrorText(overview.ratesError) : null;

  return (
    <div className="rounded-lg bg-surface-alt p-5 space-y-4">
      <div className="flex items-start gap-3 max-md:min-h-11">
        <input
          id={checkboxId}
          type="checkbox"
          aria-describedby={descriptionId}
          checked={downloading}
          disabled={IS_DEMO || !canSave || busy}
          onChange={(e) => setDownloading(e.target.checked)}
          className="mt-2.5 size-4 max-md:size-5 shrink-0 accent-brand-600 disabled:opacity-50"
        />
        <div className="min-w-0">
          <label
            htmlFor={checkboxId}
            className="inline-flex items-center min-h-6 text-sm font-medium text-text max-md:min-h-11"
          >
            Download daily exchange rates
          </label>
          <p id={descriptionId} className="text-xs text-text-tertiary mt-0.5 leading-relaxed">
            Rates come from the European Central Bank, through Frankfurter (frankfurter.dev).
            FlyBudget sends only currency codes and dates, never amounts or account details.
          </p>
          {IS_DEMO && (
            <p className="text-xs text-caution mt-1">
              The demo can&apos;t download rates. Type rates in below instead.
            </p>
          )}
          <SavingPausedHint />
        </div>
      </div>

      {downloading && !IS_DEMO && (
        <div className="space-y-2 border-t border-border-light pt-4">
          <p className="text-xs text-text-secondary">
            {download.isPending ? 'Downloading rates…' : ratesUpdatedText(overview.ratesUpdatedAt)}
          </p>
          {/* The result of the last download says what went wrong too; else the saved error */}
          {download.data && !download.isPending ? (
            <p role="status" className="text-xs text-text-secondary">
              {downloadSummaryText(download.data)}
            </p>
          ) : (
            problem &&
            !download.isPending && (
              <p role="status" className="text-xs text-caution">
                {problem}
              </p>
            )
          )}
          <Button
            variant="secondary"
            size="sm"
            disabled={!canSave || busy}
            onClick={() => download.mutate()}
          >
            {download.isPending ? (
              <Loader2 size={14} className="animate-spin" aria-hidden />
            ) : (
              <RefreshCw size={14} aria-hidden />
            )}
            Update now
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="text-xs text-negative">
          {error.message}
        </p>
      )}
    </div>
  );
}

/** One currency accounts are kept in: its latest rate, what's waiting, and its rates */
function CurrencyRow({
  item,
  budget,
  canSave,
}: {
  item: CurrencyInUse;
  budget: string;
  canSave: boolean;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const waiting = waitingText(item.waiting);

  return (
    <li className="rounded-lg border border-border-light bg-surface-alt p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">{item.code}</p>
          <p className="text-xs text-text-tertiary mt-0.5">{accountCountText(item.accounts)}</p>
          <p className="text-sm text-text-secondary mt-2">
            {latestRateText(item.code, budget, item.latest)}
          </p>
          {waiting && <p className="text-xs text-caution mt-1">{waiting}</p>}
        </div>
        <Button
          variant="secondary"
          size="sm"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className="shrink-0"
        >
          {open ? 'Hide rates' : 'Rates'}
          <ChevronDown size={14} aria-hidden className={open ? 'rotate-180' : ''} />
        </Button>
      </div>
      {open && <RatesPanel id={panelId} code={item.code} budget={budget} canSave={canSave} />}
    </li>
  );
}

/** The recent rates of one currency, and a form to type one in */
function RatesPanel({
  id,
  code,
  budget,
  canSave,
}: {
  id: string;
  code: string;
  budget: string;
  canSave: boolean;
}) {
  const { data: rates, isLoading, isError } = useRates(code);
  const remove = useDeleteRate();

  return (
    <div id={id} className="mt-4 pt-4 border-t border-border-light space-y-5">
      <SavingPausedHint />
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-text-secondary">Recent rates</h3>
        {isLoading && <p className="text-xs text-text-tertiary">Loading…</p>}
        {isError && (
          <p className="text-xs text-text-tertiary">Couldn&apos;t load the rates right now.</p>
        )}
        {rates && rates.length === 0 && (
          <p className="text-xs text-text-tertiary">No rates for {code} yet.</p>
        )}
        {rates && rates.length > 0 && (
          <ul>
            {rates.map((rate) => (
              <RateItem
                key={rate.id}
                rate={rate}
                code={code}
                budget={budget}
                canSave={canSave}
                deleting={remove.isPending}
                onDelete={() => remove.mutate({ code, date: rate.date })}
              />
            ))}
          </ul>
        )}
        {remove.error && (
          <p role="alert" className="text-xs text-negative">
            {remove.error.message}
          </p>
        )}
      </div>

      <AddRateForm code={code} budget={budget} canSave={canSave} />
    </div>
  );
}

function RateItem({
  rate,
  code,
  budget,
  canSave,
  deleting,
  onDelete,
}: {
  rate: ExchangeRate;
  code: string;
  budget: string;
  canSave: boolean;
  deleting: boolean;
  onDelete: () => void;
}) {
  const day = dayText(rate.date);
  return (
    <li className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-2 border-b border-border-light last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm text-text">{day}</p>
        <p className="text-xs text-text-tertiary">
          {rateText(code, budget, rate.rate)} · {rateSourceLabel(rate.source)}
        </p>
      </div>
      {rate.source === 'manual' && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Delete the rate for ${day}`}
          disabled={!canSave || deleting}
          onClick={onDelete}
        >
          <Trash2 size={14} aria-hidden />
          Delete
        </Button>
      )}
    </li>
  );
}

/** A rate for a day, typed in: it applies from that day until the next rate */
function AddRateForm({
  code,
  budget,
  canSave,
}: {
  code: string;
  budget: string;
  canSave: boolean;
}) {
  const dateId = useId();
  const rateId = useId();
  const [day, setDay] = useState(() => todayDay());
  const [rateInput, setRateInput] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const save = useSetRate();

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const entry = checkRateEntry(day, rateInput);
    if (!entry.ok) {
      setProblem(entry.error);
      return;
    }
    setProblem(null);
    save.mutate(
      { code, date: entry.date, rate: entry.rate },
      { onSuccess: () => setRateInput('') },
    );
  }

  return (
    <form onSubmit={submit} noValidate className="space-y-3">
      <h3 className="text-xs font-semibold text-text-secondary">Add a rate</h3>
      <div className="grid gap-3 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-end">
        <div>
          <label htmlFor={dateId} className="block text-xs text-text-tertiary mb-1">
            Date
          </label>
          <input
            id={dateId}
            type="date"
            value={day}
            onChange={(e) => setDay(e.target.value)}
            className={`${fieldClass} sm:w-44`}
          />
        </div>
        <div>
          <label htmlFor={rateId} className="block text-xs text-text-tertiary mb-1">
            {`1 ${code} in ${budget}`}
          </label>
          <input
            id={rateId}
            type="number"
            inputMode="decimal"
            step="any"
            min="0"
            placeholder="e.g. 1.1798"
            value={rateInput}
            onChange={(e) => setRateInput(e.target.value)}
            className={fieldClass}
          />
        </div>
        <Button type="submit" disabled={!canSave || save.isPending} className="max-md:w-full">
          {save.isPending && <Loader2 size={14} className="animate-spin" aria-hidden />}
          Add rate
        </Button>
      </div>
      {problem && (
        <p role="alert" className="text-xs text-negative">
          {problem}
        </p>
      )}
      {save.error && (
        <p role="alert" className="text-xs text-negative">
          {save.error.message}
        </p>
      )}
    </form>
  );
}
