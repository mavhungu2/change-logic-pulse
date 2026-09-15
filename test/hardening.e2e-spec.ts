/**
 * Regression tests for the findings in the security review.
 *
 * Each test names the finding it guards. They are written against the running
 * application, because every one of them describes something an attacker can do
 * over HTTP, not something a unit can be persuaded to do in isolation.
 */
import 'dotenv/config';
import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { assertRuntimeRoleIsLeastPrivileged } from '../src/tenancy/least-privilege.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const APP_URL = process.env['DATABASE_URL']!;
const OWNER_URL = process.env['MIGRATION_DATABASE_URL']!;

let app: INestApplication;
let memberId = '';
let orgId = '';

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Signs with whatever secret the app is configured with — no hardcoded key. */
function forge(claims: Record<string, unknown>): string {
  const header = base64url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64url(claims);
  const signature = createHmac('sha256', process.env['JWT_SECRET']!)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const hour = () => Math.floor(Date.now() / 1000) + 3600;

beforeAll(async () => {
  const owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: OWNER_URL }) });
  const rows = await owner.$queryRaw<{ user_id: string; org_id: string }[]>`
    SELECT user_id, org_id FROM app_auth_lookup('member1@northwind.test')`;
  memberId = rows[0]!.user_id;
  orgId = rows[0]!.org_id;
  await owner.$disconnect();

  const moduleRef = await Test.createTestingModule({ imports: [(await import('../src/app.module.js')).AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('S3 — a signed token is not a trusted token', () => {
  it('rejects a validly-signed token whose orgId is not a uuid, rather than 500ing', async () => {
    const token = forge({ sub: memberId, orgId: 'not-a-uuid', role: 'member', exp: hour() });
    await request(app.getHttpServer())
      .get('/surveys/active')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a validly-signed token whose sub is not a uuid', async () => {
    const token = forge({ sub: 'not-a-uuid', orgId, role: 'member', exp: hour() });
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a token with no expiry, which would otherwise be immortal', async () => {
    const token = forge({ sub: memberId, orgId, role: 'member' });
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('rejects a role outside the two the product has', async () => {
    const token = forge({ sub: memberId, orgId, role: 'superuser', exp: hour() });
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
  });

  it('still accepts a well-formed token', async () => {
    const token = forge({ sub: memberId, orgId, role: 'member', exp: hour() });
    await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
  });
});

describe('S1 — the passwordless login is not reachable unless opted in', () => {
  // The flag is read per request, so the gate can be exercised without
  // rebuilding the application.
  const withFlag = async (value: string | undefined, run: () => Promise<void>) => {
    const previous = process.env['ENABLE_DEV_LOGIN'];
    if (value === undefined) delete process.env['ENABLE_DEV_LOGIN'];
    else process.env['ENABLE_DEV_LOGIN'] = value;
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env['ENABLE_DEV_LOGIN'];
      else process.env['ENABLE_DEV_LOGIN'] = previous;
    }
  };

  it('does not exist when the flag is unset', async () => {
    await withFlag(undefined, async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'manager@northwind.test' })
        .expect(404);
    });
  });

  it('does not exist when the flag is anything other than "true"', async () => {
    await withFlag('1', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'manager@northwind.test' })
        .expect(404);
    });
  });

  it('works when explicitly enabled', async () => {
    await withFlag('true', async () => {
      await request(app.getHttpServer())
        .post('/auth/login')
        .send({ email: 'manager@northwind.test' })
        .expect(201);
    });
  });

  it('refuses to serve it in production even with the flag on', async () => {
    const previousEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      await withFlag('true', async () => {
        // isDevLoginEnabled throws, which surfaces as a 500 rather than a token.
        const response = await request(app.getHttpServer())
          .post('/auth/login')
          .send({ email: 'manager@northwind.test' });
        expect(response.status).not.toBe(201);
        expect(response.body).not.toHaveProperty('accessToken');
      });
    } finally {
      if (previousEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = previousEnv;
    }
  });
});

describe('S6 — the API must not be able to run as the owner role', () => {
  it('accepts the restricted application role', async () => {
    await expect(assertRuntimeRoleIsLeastPrivileged(APP_URL)).resolves.toBeUndefined();
  });

  it('refuses a connection string that authenticates as the table owner', async () => {
    await expect(assertRuntimeRoleIsLeastPrivileged(OWNER_URL)).rejects.toThrow(
      /owns .*table|privileged|owner/i,
    );
  });
});
