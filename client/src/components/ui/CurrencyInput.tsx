import { useLayoutEffect, useRef, useState } from 'react';
import { formatCurrency, parseCents } from '../../utils/currency';

interface Props {
  value: number;
  onChange: (cents: number) => void;
  placeholder?: string;
  className?: string;
  allowNegative?: boolean;
  /** The account's own currency when it isn't the budget's (`Account.currency`) */
  currency?: string | null;
  'aria-label'?: string;
}

export function CurrencyInput({
  value,
  onChange,
  placeholder = '0.00',
  className = '',
  allowNegative = false,
  currency = null,
  'aria-label': ariaLabel,
}: Props) {
  const [focused, setFocused] = useState(false);
  const [raw, setRaw] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const selectWhenShown = useRef(false);

  function handleFocus() {
    const initial = value === 0 ? '' : String(value / 100);
    setFocused(true);
    setRaw(initial);
    selectWhenShown.current = initial !== '';
  }

  // Select the amount as soon as it's shown for editing (the field re-renders as a number input,
  // which drops any selection), before anything can be typed, so typing replaces it
  useLayoutEffect(() => {
    if (!focused || !selectWhenShown.current) return;
    selectWhenShown.current = false;
    const input = inputRef.current;
    if (input && document.activeElement === input) input.select();
  }, [focused]);

  function handleBlur() {
    setFocused(false);
    const cents = parseCents(raw);
    onChange(allowNegative ? cents : Math.abs(cents));
  }

  return (
    <input
      ref={inputRef}
      type={focused ? 'number' : 'text'}
      value={focused ? raw : value === 0 ? '' : formatCurrency(value, currency)}
      onFocus={handleFocus}
      onBlur={handleBlur}
      onChange={(e) => setRaw(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      step="0.01"
      className={`block w-full rounded-md border border-border px-3 py-2 text-sm text-text placeholder-text-disabled focus:border-brand-600 focus:outline-none focus:ring-1 focus:ring-brand-600 ${className}`}
    />
  );
}
