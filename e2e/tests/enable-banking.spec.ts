import { test, expect, open } from './fixtures';

// Enable Banking (European banks), accounts in another currency, and unlinking a transfer.
// The bank side needs a real Enable Banking application; server tests drive it with a fake
// (server/src/routes/enableBanking.test.ts), so here it is the screens around it.

test.describe('Enable Banking setup', () => {
  test('the welcome screen leads to the Enable Banking setup', async ({ page }) => {
    await open(page, '/welcome');
    await page.getByRole('button', { name: /Connect a European bank/ }).click();
    await expect(page.getByRole('heading', { name: 'Set up Enable Banking' })).toBeVisible();
  });

  test('explains the https redirect and checks the key before saving', async ({ page, api }) => {
    await api.createAccount('Checking', 0);
    await open(page, '/settings?tab=connections&provider=enablebanking');

    await expect(page.getByRole('heading', { name: 'Set up Enable Banking' })).toBeVisible();
    // The desktop app's server is plain http, so the setup says to register an https address
    await expect(page.getByText(/only accepts https redirect URLs/)).toBeVisible();

    const form = page.getByRole('form', { name: 'Enable Banking application' });
    await form.getByLabel('Application ID').fill('app-12345678');
    await form.getByLabel('Private key', { exact: true }).fill('not a key');
    await form.getByLabel('Redirect URL').fill('https://localhost/flybudget-callback');
    await form.getByRole('button', { name: 'Save' }).click();

    await expect(form.getByRole('alert')).toContainText('isn’t a valid private key');
    expect((await api.call('GET', '/enablebanking/status')).configured).toBe(false);
  });
});

test.describe('accounts in another currency', () => {
  test('are created off budget and stay out of the totals', async ({ page, api }) => {
    await api.createAccount('Everyday', 100_000);
    await open(page, '/accounts');
    await page.getByRole('main').getByRole('button', { name: 'Add Account' }).click();

    const dialog = page.getByRole('dialog', { name: 'Add Account' });
    await dialog.getByRole('textbox', { name: 'Account name' }).fill('Franc pocket');
    await dialog.getByRole('combobox', { name: 'Currency' }).selectOption('CHF');
    const offBudget = dialog.getByRole('checkbox', { name: /Off budget/ });
    await expect(offBudget).toBeChecked();
    await expect(offBudget).toBeDisabled();
    await dialog.getByRole('button', { name: 'Add Account' }).click();

    await expect
      .poll(async () => (await api.accounts()).find((a) => a.name === 'Franc pocket'))
      .toMatchObject({ currency: 'CHF', isOffBudget: 1 });
    await expect(page.getByText(/Other currencies/)).toBeVisible();
  });

  test('refuse a transfer to an account in another currency', async ({ api }) => {
    const eur = await api.createAccount('Everyday', 0);
    const usd = await api.createAccount('Dollar pocket', 0, 'checking', { currency: 'USD' });
    await expect(
      api.call('POST', '/transactions/transfer', {
        fromAccountId: eur.id,
        toAccountId: usd.id,
        date: '2026-01-15',
        amount: 1_000,
      }),
    ).rejects.toThrow(/same currency/);
  });
});

test('a transfer can be turned back into two transactions', async ({ page, api }) => {
  const checking = await api.createAccount('Checking', 50_000);
  const savings = await api.createAccount('Savings', 0, 'savings');
  const [out] = await api.call('POST', '/transactions/transfer', {
    fromAccountId: checking.id,
    toAccountId: savings.id,
    date: new Date().toISOString().slice(0, 10),
    amount: 2_500,
  });

  await open(page, `/accounts/${checking.id}`);
  await page.getByText('Transfer: Savings').click();
  const panel = page.getByRole('complementary', { name: 'Transaction details' });
  await panel.getByRole('button', { name: 'Unlink transfer' }).click();

  await expect
    .poll(
      async () => (await api.transactions()).find((t) => t.id === out.id)?.transferTransactionId,
    )
    .toBeNull();
  await expect(panel.getByRole('button', { name: 'Unlink transfer' })).toBeHidden();
});

test.describe('connecting a bank (Enable Banking answers stubbed in the browser)', () => {
  const connection = {
    id: 'conn-1',
    aspspName: 'Banco Ejemplo',
    aspspCountry: 'ES',
    validUntil: '2099-01-01T00:00:00Z',
    syncStatus: 'good',
    syncError: null,
    lastSyncedAt: null,
  };
  const bankAccount = (over: object) => ({
    ibanMask: 'ES91 •••• 1332',
    currency: 'USD',
    cashAccountType: 'CACC',
    suggestedType: 'checking',
    accountId: null,
    accountName: null,
    isEnabled: true,
    syncFrom: null,
    bankBalance: 123_456,
    bankBalanceAt: null,
    balance: null,
    ...over,
  });
  const accounts = [
    bankAccount({ id: 'ba-1', name: 'Cuenta Online' }),
    bankAccount({ id: 'ba-2', name: 'Tarjeta', cashAccountType: 'CARD', suggestedType: 'credit' }),
  ];

  test('country → bank → consent with a pasted address → choose accounts → sync', async ({
    page,
    context,
    api,
  }) => {
    await api.createAccount('Checking', 0);
    let polls = 0;
    let pasted: unknown;
    let mapping: unknown;
    // The bank's page, in the tab FlyBudget opens for it
    await context.route('https://bank.example/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: '<p>Your bank</p>' }),
    );
    await page.route('**/api/enablebanking/**', async (route) => {
      const url = new URL(route.request().url());
      const path = url.pathname.replace('/api/enablebanking', '');
      const method = route.request().method();
      const json = (body: unknown, status = 200) => route.fulfill({ status, json: body });
      if (path === '/status')
        return json({
          configured: true,
          applicationId: 'app-12345678',
          environment: 'PRODUCTION',
          redirectUrl: 'https://localhost/flybudget-callback',
          suggestedRedirectUrl: 'http://localhost/api/enablebanking/callback',
          connectionCount: 0,
        });
      if (path === '/connections') return json([]);
      if (path === '/aspsps')
        return json({
          aspsps: [
            {
              name: 'Banco Ejemplo',
              country: url.searchParams.get('country'),
              maximumConsentDays: 180,
              beta: false,
              psuTypes: ['personal'],
            },
            {
              name: 'Otro Banco',
              country: url.searchParams.get('country'),
              maximumConsentDays: null,
              beta: true,
              psuTypes: ['personal'],
            },
          ],
        });
      if (path === '/authorizations' && method === 'POST')
        return json({ id: 'consent-1', url: 'https://bank.example/consent' }, 201);
      if (path === '/authorizations/consent-1' && method === 'GET') {
        polls++;
        return json({ status: 'pending' });
      }
      if (path === '/authorizations/consent-1/complete') {
        pasted = route.request().postDataJSON();
        return json({
          status: 'complete',
          result: { connectionId: 'conn-1', renewed: false, accounts },
        });
      }
      if (path === '/connections/conn-1/accounts' && method === 'PUT') {
        mapping = route.request().postDataJSON();
        return json({ created: 1, linked: 0, skipped: 1, errors: [] });
      }
      if (path === '/connections/conn-1/sync')
        return json({
          connectionId: 'conn-1',
          aspspName: 'Banco Ejemplo',
          added: 12,
          matched: 2,
          transfers: 1,
          status: 'good',
          errors: [],
        });
      return json({ error: `unexpected ${method} ${path}` }, 500);
    });

    await open(page, '/settings?tab=connections&provider=enablebanking');
    await page.getByRole('button', { name: 'Connect a bank' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Connect a European bank' });

    // Bank step: the browser language isn't European, so Spain is preselected
    await expect(dialog.getByLabel('Country')).toHaveValue('ES');
    await dialog.getByLabel('Bank').fill('ejemplo');
    await expect(dialog.getByRole('button', { name: /Otro Banco/ })).toBeHidden();
    await dialog.getByRole('button', { name: /Banco Ejemplo/ }).click();
    const bankTab = context.waitForEvent('page');
    await dialog.getByRole('button', { name: 'Continue' }).click();

    // The bank's page opens in its own tab; FlyBudget waits, and takes the pasted address
    await expect((await bankTab).getByText('Your bank')).toBeVisible();
    await expect(
      dialog.getByText('Finish at your bank in the browser window that opened'),
    ).toBeVisible();
    await expect.poll(() => polls).toBeGreaterThan(0);
    const address = 'https://localhost/flybudget-callback?code=abc&state=xyz';
    await dialog.getByLabel('Address of that page').fill(address);
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await expect.poll(() => pasted).toEqual({ redirectedTo: address });

    // Accounts step: import the current account as a new one, skip the card
    await expect(dialog.getByRole('heading', { name: 'Choose accounts to import' })).toBeVisible();
    const card = dialog.getByRole('group', { name: 'Tarjeta' });
    await card.getByRole('radio', { name: "Don't import" }).check();
    await dialog.getByRole('button', { name: 'Save and sync' }).click();

    await expect(dialog.getByRole('heading', { name: 'Bank connected' })).toBeVisible();
    await expect(dialog.getByText('12 new transactions imported')).toBeVisible();
    await expect(dialog.getByText('2 transactions matched to ones you entered')).toBeVisible();
    await expect(dialog.getByText('1 transfer linked between your accounts')).toBeVisible();
    expect(mapping).toMatchObject({
      budgetCurrency: 'USD',
      accounts: [
        {
          id: 'ba-1',
          action: 'create',
          accountName: 'Cuenta Online',
          accountType: 'checking',
          isOffBudget: 0,
        },
        { id: 'ba-2', action: 'skip' },
      ],
    });
  });

  test('a connection card shows the bank balance next to FlyBudget’s and offers to reconcile', async ({
    page,
    api,
  }) => {
    const checking = await api.createAccount('Checking', 0);
    await page.route('**/api/enablebanking/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace('/api/enablebanking', '');
      if (path === '/status')
        return route.fulfill({
          json: {
            configured: true,
            applicationId: 'app-12345678',
            environment: 'PRODUCTION',
            redirectUrl: 'https://localhost/flybudget-callback',
            suggestedRedirectUrl: 'http://localhost/api/enablebanking/callback',
            connectionCount: 1,
          },
        });
      if (path === '/connections')
        return route.fulfill({
          json: [
            {
              ...connection,
              validUntil: new Date(Date.now() + 5 * 864e5).toISOString(),
              accounts: [
                bankAccount({
                  id: 'ba-1',
                  name: 'Cuenta Online',
                  accountId: checking.id,
                  accountName: 'Checking',
                  balance: 120_000,
                }),
              ],
            },
          ],
        });
      return route.fulfill({ status: 500, json: { error: 'unexpected' } });
    });

    await open(page, '/settings?tab=connections&provider=enablebanking');
    await expect(page.getByRole('heading', { name: 'Banco Ejemplo' })).toBeVisible();
    // Access ends within two weeks: renewing is offered
    await expect(page.getByRole('button', { name: /Renew access/ })).toBeVisible();
    await page.getByRole('link', { name: /Reconcile/ }).click();
    await expect(page).toHaveURL(new RegExp(`/accounts/${checking.id}/reconcile`));
  });
});
