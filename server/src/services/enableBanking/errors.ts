// Typed errors for Enable Banking, and the only messages about them that reach the UI.
// Enable Banking's own messages (and the banks' behind them) go to the server log only.

export class EnableBankingError extends Error {
  constructor(
    message: string,
    /** HTTP status from Enable Banking, null when it couldn't be reached */
    readonly status: number | null = null,
    /** Enable Banking's error code (e.g. EXPIRED_SESSION), if it gave one */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** The consent ended (expired, revoked, closed): the user has to renew it at their bank */
export class ReauthRequiredError extends EnableBankingError {}

/** The bank or Enable Banking limits how often accounts can be read */
export class RateLimitedError extends EnableBankingError {}

/** The application id, private key or redirect URL isn't accepted. Its message is safe to show. */
export class ConfigurationError extends EnableBankingError {}

/** Not set up yet, or the thing asked for doesn't exist. Its message is safe to show. */
export class NotFoundError extends Error {}

/** Can't be done in the current state (e.g. removing the setup while banks are connected). Safe to show. */
export class ConflictError extends Error {}

const SESSION_ENDED = new Set([
  'EXPIRED_SESSION',
  'CLOSED_SESSION',
  'REVOKED_SESSION',
  'SESSION_DOES_NOT_EXIST',
]);

const SAFE_MESSAGES: Record<string, string> = {
  EXPIRED_AUTHORIZATION_CODE: 'The answer from your bank expired. Connect again.',
  WRONG_AUTHORIZATION_CODE: 'The answer from your bank was not accepted. Connect again.',
  ALREADY_AUTHORIZED: 'This consent was already used. Connect again.',
  NO_ACCOUNTS_ADDED:
    'No accounts were shared. In restricted mode, link the accounts in Enable Banking’s control panel first.',
  ASPSP_ERROR: 'Your bank isn’t answering properly right now. Try again later.',
  ASPSP_TIMEOUT: 'Your bank took too long to answer. Try again later.',
  ASPSP_PSU_ACTION_REQUIRED: 'Your bank needs you to do something in its app or website first.',
  ASPSP_ACCOUNT_NOT_ACCESSIBLE: 'Your bank doesn’t allow reading this account.',
  PSU_HEADER_NOT_PROVIDED:
    'This bank only shares data while you are using FlyBudget. Press Sync while signed in.',
  WRONG_ASPSP_PROVIDED: 'Enable Banking doesn’t know this bank. Pick it from the list again.',
};

/** Turns an Enable Banking error response into the right error type */
export function errorFromResponse(
  status: number,
  code: string | null,
  message: string,
): EnableBankingError {
  if (code && SESSION_ENDED.has(code)) return new ReauthRequiredError(message, status, code);
  if (status === 429 || code === 'ASPSP_RATE_LIMIT_EXCEEDED')
    return new RateLimitedError(message, status, code);
  if (code === 'REDIRECT_URI_NOT_ALLOWED')
    return new ConfigurationError(
      'This redirect URL isn’t registered in your Enable Banking application.',
      status,
      code,
    );
  if (status === 401 || code === 'UNAUTHORIZED_ACCESS' || code === 'AUTHORIZATION_NOT_PROVIDED')
    return new ConfigurationError(
      'Enable Banking didn’t accept the application id and private key.',
      status,
      code,
    );
  return new EnableBankingError(message, status, code);
}

/** A message that is safe and useful to show the user */
export function enableBankingErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ReauthRequiredError)
    return 'Access to this bank has ended. Renew it to keep syncing.';
  if (err instanceof RateLimitedError)
    return 'Your bank limits how often FlyBudget can read your accounts. Try again later.';
  if (
    err instanceof ConfigurationError ||
    err instanceof NotFoundError ||
    err instanceof ConflictError
  )
    return err.message;
  if (err instanceof EnableBankingError) {
    if (err.code && SAFE_MESSAGES[err.code]) return SAFE_MESSAGES[err.code];
    if (err.status === null) return 'Could not reach Enable Banking. Try again later.';
  }
  return fallback;
}
