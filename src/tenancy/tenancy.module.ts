import { Module } from '@nestjs/common';
import { PostgresAuthDirectory } from './auth-directory.js';
import { PrismaIdentityReader } from './identity.repository.js';
import { TenantDb } from './tenant-db.js';
import { AUTH_DIRECTORY, IDENTITY_READER } from './tokens.js';

/**
 * Exports repositories and nothing else.
 *
 * TenantDb is a provider but is deliberately NOT exported, and the PrismaClient
 * is not a provider at all — it is constructed inside TenantDb and never
 * escapes. So the container cannot hand a database handle to anything outside
 * this module: a service that asks for one fails to resolve at bootstrap rather
 * than quietly querying unscoped.
 */
@Module({
  providers: [
    TenantDb,
    { provide: AUTH_DIRECTORY, useClass: PostgresAuthDirectory },
    { provide: IDENTITY_READER, useClass: PrismaIdentityReader },
  ],
  exports: [AUTH_DIRECTORY, IDENTITY_READER],
})
export class TenancyModule {}
