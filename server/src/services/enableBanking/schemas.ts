import { z } from 'zod';

// Shapes of Enable Banking responses (https://enablebanking.com/docs/api/reference/).
// Everything here comes from outside: unknown fields are dropped, strings are capped, and
// fields that real APIs send as null are allowed to be null. Transactions are validated one
// by one (see transactionSchema) so one odd entry can't block a whole sync.

const text = (max: number) => z.string().max(max);
const optionalText = (max: number) => text(max).nullish();
/**
 * A bank's name, kept exactly as Enable Banking spells it: it's sent back to identify the bank
 * (consents, renewals). React escapes it on screen, and log lines clean it (cleanText).
 */
const bankName = text(200);

const amount = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  amount: z.string().max(40),
});

export const errorSchema = z.object({
  message: optionalText(2_000),
  code: z.number().nullish(),
  error: optionalText(100),
});

export const applicationSchema = z.object({
  name: text(500),
  kid: text(100),
  environment: z.enum(['PRODUCTION', 'SANDBOX']),
  redirect_urls: z.array(text(2_000)).max(100),
  active: z.boolean(),
});
export type EbApplication = z.infer<typeof applicationSchema>;

export const aspspSchema = z.object({
  name: bankName,
  country: z.string().regex(/^[A-Z]{2}$/),
  psu_types: z.array(text(20)).max(10).nullish(),
  maximum_consent_validity: z.number().int().positive().nullish(),
  beta: z.boolean().nullish(),
  required_psu_headers: z.array(text(100)).max(20).nullish(),
});
export type EbAspsp = z.infer<typeof aspspSchema>;

export const aspspsResponseSchema = z.object({ aspsps: z.array(aspspSchema).max(10_000) });

export const startAuthorizationResponseSchema = z.object({
  url: z.url({ protocol: /^https$/ }).max(4_000),
  authorization_id: text(200),
});

const accountIdentification = z
  .object({
    iban: optionalText(64),
    other: z.object({ identification: optionalText(200) }).nullish(),
  })
  .nullish();

export const accountResourceSchema = z.object({
  uid: optionalText(200),
  identification_hash: text(500).min(1),
  account_id: accountIdentification,
  name: optionalText(500),
  details: optionalText(500),
  product: optionalText(500),
  currency: z.string().regex(/^[A-Z]{3}$/),
  cash_account_type: optionalText(10),
});
export type EbAccount = z.infer<typeof accountResourceSchema>;

export const sessionResponseSchema = z.object({
  session_id: text(200).min(1),
  accounts: z.array(accountResourceSchema).max(500),
  aspsp: z.object({ name: bankName, country: text(2) }),
  access: z.object({ valid_until: text(100) }),
});
export type EbSession = z.infer<typeof sessionResponseSchema>;

export const sessionDetailsSchema = z.object({
  status: text(50),
  accounts_data: z
    .array(z.object({ uid: text(200), identification_hash: text(500) }))
    .max(500)
    .nullish(),
  access: z.object({ valid_until: text(100) }).nullish(),
});

export const balancesResponseSchema = z.object({
  balances: z
    .array(
      z.object({
        balance_amount: amount,
        balance_type: text(10),
        reference_date: optionalText(40),
      }),
    )
    .max(100),
});
export type EbBalance = z.infer<typeof balancesResponseSchema>['balances'][number];

export const transactionsPageSchema = z.object({
  // Validated one by one with transactionSchema
  transactions: z.array(z.unknown()).max(10_000),
  continuation_key: optionalText(2_000),
});

const party = z.object({ name: optionalText(1_000) }).nullish();

export const transactionSchema = z.object({
  entry_reference: optionalText(500),
  transaction_amount: amount,
  credit_debit_indicator: z.enum(['CRDT', 'DBIT']),
  status: text(10),
  booking_date: optionalText(20),
  value_date: optionalText(20),
  transaction_date: optionalText(20),
  creditor: party,
  debtor: party,
  creditor_account: accountIdentification,
  debtor_account: accountIdentification,
  remittance_information: z.array(text(5_000)).max(50).nullish(),
  note: optionalText(5_000),
  bank_transaction_code: z.object({ description: optionalText(1_000) }).nullish(),
});
export type EbTransaction = z.infer<typeof transactionSchema>;
