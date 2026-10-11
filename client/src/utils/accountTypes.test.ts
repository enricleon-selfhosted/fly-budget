import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ACCOUNT_TYPES } from '../types';
import { accountTypeInfo, startsOffBudget } from './accountTypes';

const anyType = fc.constantFrom(...ACCOUNT_TYPES.map((t) => t.value));

describe('startsOffBudget', () => {
  it('starts cash and credit accounts on budget and the rest off', () => {
    expect(startsOffBudget('checking', false)).toBe(false);
    expect(startsOffBudget('savings', false)).toBe(false);
    expect(startsOffBudget('credit', false)).toBe(false);
    expect(startsOffBudget('mortgage', false)).toBe(true);
    expect(startsOffBudget('investment', false)).toBe(true);
  });

  it('starts every account in another currency off budget (M1)', () => {
    fc.assert(fc.property(anyType, (type) => startsOffBudget(type, true)));
  });

  it('follows the type for an account in the budget currency', () => {
    fc.assert(
      fc.property(anyType, (type) => {
        expect(startsOffBudget(type, false)).toBe(!accountTypeInfo(type).onBudget);
      }),
    );
  });
});
