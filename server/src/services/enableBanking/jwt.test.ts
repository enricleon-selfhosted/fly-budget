import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { generateKeyPairSync, verify } from 'crypto';
import { ConfigurationError } from './errors.js';
import { JWT_LIFETIME_SECONDS, createJwtSigner, parsePrivateKey } from './jwt.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString());

describe('application JWT', () => {
  it('is an RS256 token Enable Banking accepts: kid, issuer, audience, at most 24 hours', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1_600_000_000, max: 2_500_000_000 }),
        fc.uuid(),
        (seconds, appId) => {
          const token = createJwtSigner(appId, pem, () => seconds * 1000)();
          const [header, payload, signature] = token.split('.');
          expect(decode(header)).toEqual({ typ: 'JWT', alg: 'RS256', kid: appId });
          const claims = decode(payload);
          expect(claims).toMatchObject({
            iss: 'enablebanking.com',
            aud: 'api.enablebanking.com',
            iat: seconds,
          });
          expect(claims.exp - claims.iat).toBe(JWT_LIFETIME_SECONDS);
          expect(claims.exp - claims.iat).toBeLessThanOrEqual(86_400);
          expect(
            verify(
              'RSA-SHA256',
              Buffer.from(`${header}.${payload}`),
              publicKey,
              Buffer.from(signature, 'base64url'),
            ),
          ).toBe(true);
        },
      ),
      { numRuns: 20 },
    );
  });

  it('reuses a token until shortly before it expires', () => {
    let now = 1_700_000_000_000;
    const jwt = createJwtSigner('app', pem, () => now);
    const first = jwt();
    now += 30 * 60 * 1000;
    expect(jwt()).toBe(first);
    now += 29 * 60 * 1000;
    const renewed = jwt();
    expect(renewed).not.toBe(first);
    expect(decode(renewed.split('.')[1]).iat).toBe(Math.floor(now / 1000));
  });
});

describe('parsePrivateKey', () => {
  it('accepts an RSA private key in PKCS#8 or PKCS#1 PEM', () => {
    expect(parsePrivateKey(pem).asymmetricKeyType).toBe('rsa');
    expect(
      parsePrivateKey(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()),
    ).toBeTruthy();
  });

  it.each([
    ['empty', ''],
    ['a certificate-like blob', '-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----'],
    ['a public key', publicKey.export({ type: 'spki', format: 'pem' }).toString()],
    [
      'an EC key',
      generateKeyPairSync('ec', { namedCurve: 'P-256' })
        .privateKey.export({ type: 'pkcs8', format: 'pem' })
        .toString(),
    ],
  ])('refuses %s with a message for the user', (_label, value) => {
    expect(() => parsePrivateKey(value)).toThrow(ConfigurationError);
  });
});
