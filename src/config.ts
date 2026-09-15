/**
 * Environment-derived configuration, in one place so it can be tested and so
 * that a missing value fails at startup rather than at the first request.
 */

/**
 * Values that have appeared in the repository and are therefore public. Checked
 * before the length rule so the error names the real problem.
 */
const PUBLISHED_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'dev-only-insecure-secret',
  'change-me',
  'secret',
]);

const MINIMUM_SECRET_LENGTH = 32;

/**
 * The token signing key. There is deliberately no fallback: a default here is a
 * signing key published in the repository, and anyone holding it can mint a
 * token for any user in any organization. The database would enforce isolation
 * perfectly against a token that lies about which tenant is calling.
 */
export function requireJwtSecret(): string {
  const secret = process.env['JWT_SECRET'];

  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set. It signs the tenant claims every request is trusted on, ' +
        'so there is no default. Generate one with: openssl rand -base64 48',
    );
  }
  if (PUBLISHED_PLACEHOLDERS.has(secret)) {
    throw new Error(
      `JWT_SECRET is set to a placeholder published in .env.example (${secret}). ` +
        'It is public. Generate one with: openssl rand -base64 48',
    );
  }
  if (secret.length < MINIMUM_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MINIMUM_SECRET_LENGTH} characters; got ${secret.length}.`,
    );
  }
  return secret;
}

export function isProduction(): boolean {
  return process.env['NODE_ENV'] === 'production';
}

/**
 * Whether the passwordless development sign-in is reachable.
 *
 * It issues a valid token for any email with no credential of any kind, so it
 * is off unless explicitly switched on, and switching it on in production is a
 * startup failure rather than a warning — a misconfiguration that silently
 * serves is the one that reaches production.
 */
export function isDevLoginEnabled(): boolean {
  const enabled = process.env['ENABLE_DEV_LOGIN'] === 'true';

  if (enabled && isProduction()) {
    throw new Error(
      'ENABLE_DEV_LOGIN is set while NODE_ENV=production. That endpoint issues a valid ' +
        'token for any email, for any organization, with no password. Refusing to run.',
    );
  }
  return enabled;
}

export function requireDatabaseUrl(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not set.');
  return url;
}

/**
 * Removes the migration role's credentials from the process environment.
 *
 * The API has no use for them, and `pulse_owner` owns every table — it cannot
 * read across tenants while FORCE ROW LEVEL SECURITY is set, but it can drop
 * the policies that make that true. Keeping the string out of the process means
 * a future line of code, or a dependency that reads the environment, cannot use
 * what is not there.
 */
export function scrubOwnerCredentials(env: NodeJS.ProcessEnv = process.env): void {
  delete env['MIGRATION_DATABASE_URL'];
  delete env['SHADOW_DATABASE_URL'];
}
