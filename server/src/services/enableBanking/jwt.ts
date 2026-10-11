import { createPrivateKey, sign, type KeyObject } from 'crypto';
import { ConfigurationError } from './errors.js';

// Enable Banking authenticates an application with a JWT signed by its private key (RS256,
// `kid` = application id, at most 24 hours long). Signed with Node's crypto: no dependency.

export const JWT_LIFETIME_SECONDS = 60 * 60;
/** A cached token is replaced this long before it expires */
const RENEW_MARGIN_SECONDS = 5 * 60;

const base64url = (data: string | Buffer) => Buffer.from(data).toString('base64url');

/** Reads a PEM private key, refusing anything that isn't an RSA private key */
export function parsePrivateKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch {
    throw new ConfigurationError('That isn’t a valid private key (.pem file).');
  }
  if (key.asymmetricKeyType !== 'rsa')
    throw new ConfigurationError('Enable Banking keys are RSA keys; this one isn’t.');
  return key;
}

/** One signed application JWT, valid from `nowSeconds` for JWT_LIFETIME_SECONDS */
export function applicationJwt(applicationId: string, key: KeyObject, nowSeconds: number): string {
  const header = base64url(JSON.stringify({ typ: 'JWT', alg: 'RS256', kid: applicationId }));
  const payload = base64url(
    JSON.stringify({
      iss: 'enablebanking.com',
      aud: 'api.enablebanking.com',
      iat: nowSeconds,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
    }),
  );
  const signature = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${base64url(signature)}`;
}

/** Returns a function giving a valid JWT, reusing one until shortly before it expires */
export function createJwtSigner(
  applicationId: string,
  privateKeyPem: string,
  now: () => number = Date.now,
): () => string {
  const key = parsePrivateKey(privateKeyPem);
  let cached: { token: string; expires: number } | undefined;
  return () => {
    const seconds = Math.floor(now() / 1000);
    if (!cached || seconds >= cached.expires - RENEW_MARGIN_SECONDS) {
      cached = {
        token: applicationJwt(applicationId, key, seconds),
        expires: seconds + JWT_LIFETIME_SECONDS,
      };
    }
    return cached.token;
  };
}
