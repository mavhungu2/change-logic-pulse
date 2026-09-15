import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDevLoginEnabled, requireJwtSecret } from './config.js';

const ORIGINAL = { ...process.env };
beforeEach(() => {
  delete process.env['JWT_SECRET'];
  delete process.env['ENABLE_DEV_LOGIN'];
  delete process.env['NODE_ENV'];
});
afterEach(() => {
  process.env = { ...ORIGINAL };
});

describe('S2 — the signing secret must never have a fallback', () => {
  it('refuses to start when JWT_SECRET is absent', () => {
    expect(() => requireJwtSecret()).toThrow(/JWT_SECRET/);
  });

  it('refuses a secret short enough to brute force', () => {
    process.env['JWT_SECRET'] = 'short';
    expect(() => requireJwtSecret()).toThrow(/32/);
  });

  it('refuses the placeholder published in .env.example', () => {
    // The literal that used to be the fallback. It is in the repository, so it
    // is public, so it must never be accepted as a real secret.
    process.env['JWT_SECRET'] = 'dev-only-insecure-secret';
    expect(() => requireJwtSecret()).toThrow(/placeholder|example/i);
  });

  it('accepts a secret that is set and long enough', () => {
    process.env['JWT_SECRET'] = 'a'.repeat(32);
    expect(requireJwtSecret()).toBe('a'.repeat(32));
  });
});

describe('S1 — the passwordless login must be opt-in', () => {
  it('is disabled unless explicitly enabled', () => {
    expect(isDevLoginEnabled()).toBe(false);
  });

  it('is enabled by the opt-in flag', () => {
    process.env['ENABLE_DEV_LOGIN'] = 'true';
    expect(isDevLoginEnabled()).toBe(true);
  });

  it('is refused outright in production, even with the flag', () => {
    process.env['ENABLE_DEV_LOGIN'] = 'true';
    process.env['NODE_ENV'] = 'production';
    expect(() => isDevLoginEnabled()).toThrow(/production/i);
  });
});
