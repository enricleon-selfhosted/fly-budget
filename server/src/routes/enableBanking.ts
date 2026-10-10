import { Router, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { logError } from '../utils/log.js';
import { currencyCode } from '../utils/currency.js';
import { isoDate } from '../utils/validation.js';
import { accountTypeSchema } from '../utils/accountTypes.js';
import { isPublicAddress } from '../services/safeFetch.js';
import type { PsuHeaders } from '../services/enableBanking/client.js';
import {
  ConfigurationError,
  ConflictError,
  EnableBankingError,
  NotFoundError,
  RateLimitedError,
  enableBankingErrorMessage,
} from '../services/enableBanking/errors.js';
import { cleanText } from '../services/enableBanking/mapping.js';
import type { EnableBankingService } from '../services/enableBanking/service.js';

// /api/enablebanking — contract in docs/enable-banking/api.md. Thin: validate, call the
// service, map its errors to statuses and safe messages.

/** Where the bank sends the browser back to; registered before the guards (see index.ts) */
export const ENABLE_BANKING_CALLBACK_PATH = '/api/enablebanking/callback';

const configSchema = z.object({
  applicationId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{8,100}$/, 'That doesn’t look like an Enable Banking application id'),
  privateKey: z.string().min(1).max(20_000).optional(),
  redirectUrl: z.url({ protocol: /^https?$/ }).max(2_000),
});

const countrySchema = z.string().regex(/^[A-Z]{2}$/);

const startSchema = z.object({
  aspspName: z.string().trim().min(1).max(200),
  country: countrySchema,
  psuType: z.enum(['personal', 'business']).optional(),
  connectionId: z.string().max(64).optional(),
});

const completeSchema = z.object({ redirectedTo: z.string().min(1).max(10_000) });

const mappingSchema = z.object({
  budgetCurrency: currencyCode,
  accounts: z
    .array(
      z.discriminatedUnion('action', [
        z.object({
          id: z.string().max(64),
          action: z.literal('create'),
          accountName: z.string().max(200).optional(),
          accountType: accountTypeSchema.optional(),
          isOffBudget: z.number().int().min(0).max(1).optional(),
          syncFrom: isoDate.optional(),
        }),
        z.object({
          id: z.string().max(64),
          action: z.literal('link'),
          accountId: z.string().max(64),
          syncFrom: isoDate.optional(),
        }),
        z.object({ id: z.string().max(64), action: z.literal('skip') }),
      ]),
    )
    .max(500),
});

function sendError(res: Response, err: unknown, fallback: string) {
  const status =
    err instanceof ConfigurationError
      ? 400
      : err instanceof NotFoundError
        ? 404
        : err instanceof ConflictError
          ? 409
          : err instanceof RateLimitedError
            ? 429
            : err instanceof EnableBankingError
              ? 502
              : 500;
  if (status >= 500) logError('Enable Banking', err);
  res.status(status).json({ error: enableBankingErrorMessage(err, fallback) });
}

/**
 * Tells the bank the user is present for syncs they start themselves, so PSD2 doesn't count
 * them as unattended reads. Only with a real public address: a local one would be refused.
 */
function psuHeaders(req: Request): PsuHeaders | undefined {
  if (!req.ip || !isPublicAddress(req.ip)) return undefined;
  return {
    'Psu-Ip-Address': req.ip,
    'Psu-User-Agent': cleanText(req.get('user-agent'), 256) || 'FlyBudget',
  };
}

/** This server's callback URL, as the browser reached it */
const callbackUrl = (req: Request) =>
  `${req.protocol}://${req.get('host')}${ENABLE_BANKING_CALLBACK_PATH}`;

export function createEnableBankingRouter(service: EnableBankingService) {
  const router = Router();

  router.get('/status', (req, res) => {
    res.json(service.status(callbackUrl(req)));
  });

  router.put('/config', async (req, res) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      await service.configure(parsed.data);
      res.json(service.status(callbackUrl(req)));
    } catch (err) {
      sendError(res, err, 'Could not check the application with Enable Banking.');
    }
  });

  router.delete('/config', (_req, res) => {
    try {
      service.removeConfig();
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Could not remove the setup.');
    }
  });

  router.get('/aspsps', async (req, res) => {
    const country = countrySchema.safeParse(req.query.country);
    if (!country.success) return res.status(400).json({ error: 'Expected a country code' });
    try {
      res.json({ aspsps: await service.listBanks(country.data) });
    } catch (err) {
      sendError(res, err, 'Could not load the list of banks.');
    }
  });

  router.post('/authorizations', async (req, res) => {
    const parsed = startSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      res.status(201).json(await service.startConsent(parsed.data));
    } catch (err) {
      sendError(res, err, 'Could not start connecting to your bank.');
    }
  });

  router.get('/authorizations/:id', (req, res) => {
    res.json(service.consentStatus(req.params.id));
  });

  router.post('/authorizations/:id/complete', async (req, res) => {
    const parsed = completeSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      res.json(await service.completeFromAddress(req.params.id, parsed.data.redirectedTo));
    } catch (err) {
      sendError(res, err, 'Connecting to your bank failed. Try again.');
    }
  });

  router.delete('/authorizations/:id', (req, res) => {
    service.cancelConsent(req.params.id);
    res.status(204).send();
  });

  router.get('/connections', (_req, res) => {
    res.json(service.listConnections());
  });

  router.put('/connections/:id/accounts', (req, res) => {
    const parsed = mappingSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      res.json(
        service.mapAccounts(req.params.id, parsed.data.budgetCurrency, parsed.data.accounts),
      );
    } catch (err) {
      sendError(res, err, 'Could not save your choices.');
    }
  });

  router.post('/connections/:id/sync', async (req, res) => {
    try {
      res.json(await service.sync(req.params.id, psuHeaders(req)));
    } catch (err) {
      sendError(res, err, 'Sync failed.');
    }
  });

  router.post('/sync-all', async (req, res) => {
    try {
      res.json({ results: await service.syncAll({ psu: psuHeaders(req) }) });
    } catch (err) {
      sendError(res, err, 'Sync failed.');
    }
  });

  router.delete('/connections/:id', async (req, res) => {
    try {
      await service.disconnect(req.params.id);
      res.status(204).send();
    } catch (err) {
      sendError(res, err, 'Could not disconnect. Try again.');
    }
  });

  return router;
}

const callbackQuery = z.object({
  code: z.string().max(4_096).optional(),
  state: z.string().max(200).optional(),
  error: z.string().max(500).optional(),
});

/** A plain page for the browser tab the bank sent back; nothing from the request is echoed */
function page(title: string, message: string) {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} · FlyBudget</title></head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
</main>
</body>
</html>
`;
}

/**
 * GET /api/enablebanking/callback?code&state — the bank's redirect. Reachable without the
 * origin/token/session guards (the browser coming back from the bank can't pass them), so the
 * single-use state is its only authentication (decision D2).
 */
export function createEnableBankingCallback(service: EnableBankingService): RequestHandler {
  return async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const parsed = callbackQuery.safeParse(req.query);
    const outcome = parsed.success ? await service.completeFromCallback(parsed.data) : undefined;
    if (!outcome) {
      res
        .status(400)
        .type('html')
        .send(
          page(
            'This link has expired',
            'It was already used or is too old. Go back to FlyBudget and connect your bank again.',
          ),
        );
      return;
    }
    if (outcome.status === 'complete') {
      res
        .type('html')
        .send(
          page(
            'Your bank is connected',
            'You can close this window and go back to FlyBudget to choose which accounts to import.',
          ),
        );
      return;
    }
    res
      .type('html')
      .send(
        page('Connecting didn’t work', 'Go back to FlyBudget to see what happened and try again.'),
      );
  };
}
