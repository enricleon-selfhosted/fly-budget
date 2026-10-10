import { test, expect, open, isoDay, thisMonth } from './fixtures';

// Budgeting across currencies (docs/multi-currency): a USD budget with an account in euros. Rates
// are typed in here: downloading would ask Frankfurter, outside the test machine (server tests
// cover the download with a fake service).

test('an account in another currency on budget counts once it has a rate', async ({
  page,
  api,
}) => {
  await api.call('PUT', '/currencies', { currency: 'USD' });
  const groceries = await api.category('Groceries');
  const euros = await api.createAccount('Euro card', 0, 'checking', {
    currency: 'EUR',
    isOffBudget: 0,
  });
  await api.createTransaction({
    accountId: euros.id,
    date: isoDay(),
    amount: -2_000,
    payeeName: 'Boulangerie',
    categoryId: groceries.id,
  });

  // Without a rate it isn't in the budget yet, and the budget says so
  await open(page, '/budget');
  const notice = page.getByText(/1 transaction in another currency isn.t in your budget yet/);
  await expect(notice).toBeVisible();
  await page.getByRole('link', { name: 'Exchange rates' }).click();

  // Settings → Currencies: type in today's rate
  await expect(page).toHaveURL(/tab=currencies/);
  await page.getByRole('button', { name: 'Rates' }).click();
  await page.getByLabel('1 EUR in USD').fill('1.10');
  await page.getByRole('button', { name: 'Add rate' }).click();
  await expect
    .poll(async () => (await api.transactions(`?account_id=${euros.id}`))[0].budgetAmount)
    .toBe(-2_200);

  await open(page, '/budget');
  await expect(notice).toBeHidden();
  const budget = await api.call('GET', `/budget/${thisMonth()}`);
  const spent = budget
    .flatMap((g: { categories: { id: string; spent: number }[] }) => g.categories)
    .find((c: { id: string }) => c.id === groceries.id).spent;
  expect(spent).toBe(2_200);
});

test('a transaction’s value in the budget currency can be typed in, and go back to the rate', async ({
  page,
  api,
}) => {
  await api.call('PUT', '/currencies', { currency: 'USD' });
  await api.call('PUT', `/currencies/EUR/rates/${isoDay(-3)}`, { rate: 1.1 });
  const euros = await api.createAccount('Euro cash', 0, 'cash', {
    currency: 'EUR',
    isOffBudget: 0,
  });
  await api.createTransaction({
    accountId: euros.id,
    date: isoDay(),
    amount: -2_000,
    payeeName: 'Marché',
  });

  await open(page, `/accounts/${euros.id}`);
  // The register shows the amount in euros and what it's worth in dollars
  const row = page.getByTestId('transaction-row').filter({ hasText: 'Marché' });
  await expect(row).toContainText('≈ $22');

  await row.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Transaction details' });
  await expect(panel).toContainText('1 EUR = 1.1000 USD');

  // The card was charged $23.50
  const value = panel.getByLabel('Value in USD');
  await value.fill('23.50');
  await value.press('Tab');
  await expect
    .poll(async () => (await api.transactions(`?account_id=${euros.id}`))[0])
    .toMatchObject({ budgetAmount: -2_350, fxSource: 'manual' });

  await panel.getByRole('button', { name: /Use the day.s rate/ }).click();
  await expect
    .poll(async () => (await api.transactions(`?account_id=${euros.id}`))[0])
    .toMatchObject({ budgetAmount: -2_200, fxSource: 'rate' });
});

test('putting an account on budget removes categories from exchanges that stop crossing', async ({
  page,
  api,
}) => {
  await api.call('PUT', '/currencies', { currency: 'USD' });
  const salary = await api.category('Paychecks');
  const pounds = await api.createAccount('Pounds', 0, 'checking', { currency: 'GBP' });
  const dollars = await api.createAccount('Checking', 0);
  await api.call('POST', '/transactions/transfer', {
    fromAccountId: pounds.id,
    toAccountId: dollars.id,
    date: isoDay(),
    amount: 50_000,
    toAmount: 63_000,
    categoryId: salary.id,
  });

  await open(page, `/accounts/${pounds.id}`);
  await page.getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit Account' });
  await dialog.getByRole('checkbox', { name: /Off budget/ }).uncheck();
  await expect(dialog.getByText(/lose their category when you save/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('status')).toContainText('1 transfer lost its category');
  await dialog.getByRole('button', { name: 'Done' }).click();

  const [into] = await api.transactions(`?account_id=${dollars.id}`);
  expect(into.categoryId).toBeNull();
});
