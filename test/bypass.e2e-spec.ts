/**
 * What happens when a developer tries to reach the database directly.
 *
 * The requirement is that the answer is never "it works, but unscoped". There
 * are three layers, and this file exercises each one independently, because any
 * of them could be removed by a future refactor without the others noticing.
 */

import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { createGuardedClient } from '../src/tenancy/prisma.js';
import { TenancyModule } from '../src/tenancy/tenancy.module.js';
import { isTenancyError } from '../src/tenancy/tenancy.errors.js';

const APP_URL = process.env['DATABASE_URL'];
const OWNER_URL = process.env['MIGRATION_DATABASE_URL'];
const SEEDED_ORG = '11111111-1111-4111-8111-111111111111';

let seededSurveys = 0;

beforeAll(async () => {
  // Confirm there is data to leak, or "zero rows" below proves nothing.
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL! }) });
  // Scoped, because FORCE ROW LEVEL SECURITY binds the owner as well: an
  // unscoped count here would read 0 and "prove" isolation against no data.
  seededSurveys = await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${SEEDED_ORG}, true)`;
    return await tx.survey.count();
  });
  await owner.$disconnect();
});

describe('layer 1 — the container will not hand out a database client', () => {
  it('a provider that injects PrismaClient fails to resolve, so the app cannot boot', async () => {
    const attempt = Test.createTestingModule({
      imports: [TenancyModule],
      providers: [
        // Exactly what a developer in a hurry writes.
        { provide: 'SNEAKY_SERVICE', useFactory: (client: unknown) => client, inject: [PrismaClient] },
      ],
    }).compile();

    await expect(attempt).rejects.toThrow(/can't resolve dependencies/i);
  });

  it('TenantDb itself is not exported either — only repositories are', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [TenancyModule] }).compile();
    // Resolving a provider that the module does not export throws.
    expect(() => moduleRef.get<unknown>('TenantDb')).toThrow();
    await moduleRef.close();
  });
});

describe('layer 2 — a client obtained anyway refuses to run outside the wrapper', () => {
  it('throws TENANT_CONTEXT_MISSING rather than querying unscoped', async () => {
    const client = createGuardedClient(APP_URL!);
    try {
      const attempt = client.survey.findMany();
      await expect(attempt).rejects.toThrow(/outside TenantDb\.run\(\)/);
      await expect(attempt).rejects.toSatisfy(
        (error: unknown) => isTenancyError(error) && error.code === 'TENANT_CONTEXT_MISSING',
      );
    } finally {
      await client.$disconnect();
    }
  });

  it('refuses raw queries too, not just model operations', async () => {
    const client = createGuardedClient(APP_URL!);
    try {
      await expect(client.$queryRaw`SELECT 1`).rejects.toThrow(/outside TenantDb\.run\(\)/);
    } finally {
      await client.$disconnect();
    }
  });
});

describe('layer 3 — even a hand-rolled client sees nothing', () => {
  it('a raw PrismaClient with no guard reads zero rows, while the data exists', async () => {
    expect(seededSurveys, 'fixture check: there must be surveys to leak').toBeGreaterThan(0);

    // No extension, no wrapper, no AsyncLocalStorage — the shape a developer
    // gets by constructing their own client. The database is the backstop.
    const unguarded = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_URL! }) });
    try {
      const surveys = await unguarded.survey.findMany();
      const users = await unguarded.user.findMany();
      expect(surveys).toHaveLength(0);
      expect(users).toHaveLength(0);
    } finally {
      await unguarded.$disconnect();
    }
  });

  it('cannot write to a table it has no INSERT grant on — refused before RLS is consulted', async () => {
    const unguarded = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_URL! }) });
    try {
      const attempt = unguarded.$executeRaw`
        INSERT INTO organizations (id, name) VALUES (gen_random_uuid(), 'smuggled')`;
      // 42501: pulse_app holds only SELECT on organizations. The grant layer
      // answers first; the policy never gets a say.
      await expect(attempt).rejects.toThrow(/permission denied for table organizations/i);
    } finally {
      await unguarded.$disconnect();
    }
  });

  it('cannot write to a table it CAN insert into either — WITH CHECK refuses it', async () => {
    const unguarded = new PrismaClient({ adapter: new PrismaPg({ connectionString: APP_URL! }) });
    try {
      // surveys does carry INSERT for pulse_app, so this reaches the policy.
      const attempt = unguarded.$executeRaw`
        INSERT INTO surveys (org_id, title, created_by)
        VALUES (${SEEDED_ORG}::uuid, 'smuggled', ${SEEDED_ORG}::uuid)`;
      await expect(attempt).rejects.toThrow(/row-level security/i);
    } finally {
      await unguarded.$disconnect();
    }
  });
});

afterAll(() => {
  // nothing to clean: none of the above was able to write anything
});
