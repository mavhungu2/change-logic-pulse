/**
 * The behaviours CLAUDE.md §4 calls out, exercised over HTTP.
 *
 * Each test creates its own survey and removes it afterwards, so the suite does
 * not drift the seeded numbers the demo relies on.
 */
import 'dotenv/config';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { weekStartOf } from '../src/common/week.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
/**
 * Read from the database in beforeAll, never written down here.
 *
 * It was written down here, as an id the seed does not produce, and so the
 * cross-tenant tests below were asserting 404 for a survey that did not exist
 * anywhere — which any id would satisfy. A 404 only means something if the row
 * is real and belongs to somebody else.
 */
let ORG_B_SURVEY = '';

let app: INestApplication;
let managerA = '';
let memberA = '';
let memberB = '';
/** Read from the database, so the test does not hard-code the seed's numbers. */
let memberCountA = 0;
const createdSurveys: string[] = [];

const login = async (email: string): Promise<string> => {
  const response = await request(app.getHttpServer())
    .post('/auth/login')
    .send({ email })
    .expect(201);
  return response.body.accessToken as string;
};

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

/**
 * A survey's status read as the owner from inside one organization.
 *
 * The scoping is the assertion: `organizations` and `surveys` are FORCEd, so an
 * unscoped read here returns nothing and would confirm any outcome at all.
 */
async function statusOf(orgId: string, surveyId: string): Promise<string | undefined> {
  const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['MIGRATION_DATABASE_URL']! }),
  });
  try {
    return await owner.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgId}, true)`;
      // Qualified by orgId for the same reason the id is: a read that trusts the
      // policy cannot be evidence about the policy. If the row is not this org's,
      // this returns undefined rather than somebody else's status.
      const row = await tx.survey.findFirst({
        where: { id: surveyId, orgId },
        select: { status: true },
      });
      return row?.status;
    });
  } finally {
    await owner.$disconnect();
  }
}

/** A fresh survey so assertions do not depend on seeded response counts. */
async function createSurvey(title: string): Promise<{ id: string; questionIds: string[] }> {
  const created = await request(app.getHttpServer())
    .post('/surveys')
    .set(auth(managerA))
    .send({
      title,
      questions: [
        { text: 'How was your week?', type: 'rating' },
        { text: 'Blocked?', type: 'yes_no' },
      ],
    })
    .expect(201);

  const id = created.body.id as string;
  createdSurveys.push(id);

  const active = await request(app.getHttpServer())
    .get('/surveys/active')
    .set(auth(memberA))
    .expect(200);
  const survey = (active.body as { id: string; questions: { id: string }[] }[]).find(
    (candidate) => candidate.id === id,
  );
  return { id, questionIds: survey!.questions.map((question) => question.id) };
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();

  const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['MIGRATION_DATABASE_URL']! }),
  });
  memberCountA = await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ORG_A}, true)`;
    return await tx.user.count({ where: { role: 'member' } });
  });
  ORG_B_SURVEY = await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ORG_B}, true)`;
    // The explicit orgId is load-bearing, not belt-and-braces. These tests write
    // to this id, and the thing they are testing is the policy that decides
    // which rows a scope can see — so the fixture must not let that policy pick
    // the row. Under the mutation that replaces surveys_select with USING
    // (true), an unqualified findFirst here returned org A's survey, and the
    // cross-tenant test then archived the seeded survey it was supposed to be
    // proving it could not touch.
    const survey = await tx.survey.findFirst({ where: { orgId: ORG_B }, select: { id: true } });
    if (!survey) throw new Error('Seed the database first: npm run db:seed');
    return survey.id;
  });
  await owner.$disconnect();

  managerA = await login('manager@northwind.test');
  memberA = await login('member1@northwind.test');
  memberB = await login('member1@seabird.test');
});

afterAll(async () => {
  await app?.close();

  // Remove what the tests created, as the owner, scoped to org A.
  const owner = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env['MIGRATION_DATABASE_URL']! }),
  });
  await owner.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${ORG_A}, true)`;
    for (const id of createdSurveys) {
      await tx.answer.deleteMany({ where: { response: { surveyId: id } } });
      await tx.response.deleteMany({ where: { surveyId: id } });
      await tx.question.deleteMany({ where: { surveyId: id } });
      await tx.survey.deleteMany({ where: { id } });
    }
  });
  await owner.$disconnect();
});

describe('another tenant is invisible, not forbidden', () => {
  it('a summary for another org’s survey is 404, never 403', async () => {
    await request(app.getHttpServer())
      .get(`/surveys/${ORG_B_SURVEY}/summary`)
      .set(auth(managerA))
      .expect(404);
  });

  it('submitting to another org’s survey is 404, never 403', async () => {
    const { id, questionIds } = await createSurvey('Cross-tenant probe');
    // memberB belongs to the other org: the survey exists, and must not appear to.
    await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberB))
      .send({ answers: [{ questionId: questionIds[0], value: 3 }] })
      .expect(404);
  });
});

describe('roles are enforced, not advisory', () => {
  it('a Member cannot create a survey', async () => {
    await request(app.getHttpServer())
      .post('/surveys')
      .set(auth(memberA))
      .send({ title: 'nope', questions: [{ text: 'q', type: 'rating' }] })
      .expect(403);
  });

  it('a Manager cannot submit a response', async () => {
    const { id, questionIds } = await createSurvey('Manager submit probe');
    await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(managerA))
      .send({
        answers: [
          { questionId: questionIds[0], value: 4 },
          { questionId: questionIds[1], value: true },
        ],
      })
      .expect(403);
  });

  it('a Member cannot read the manager survey list', async () => {
    await request(app.getHttpServer()).get('/surveys').set(auth(memberA)).expect(403);
  });
});

describe('one response per member per week', () => {
  it('the second submission is a 409 that explains itself', async () => {
    const { id, questionIds } = await createSurvey('Duplicate probe');
    const body = {
      answers: [
        { questionId: questionIds[0], value: 5 },
        { questionId: questionIds[1], value: false },
      ],
    };

    const first = await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send(body)
      .expect(201);
    expect(first.body.weekStart).toBe(weekStartOf());

    const second = await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send(body)
      .expect(409);

    // A normal outcome, so the body has to be useful enough to render.
    expect(second.body).toMatchObject({
      statusCode: 409,
      error: 'Conflict',
      surveyId: id,
      weekStart: weekStartOf(),
    });
    expect(second.body.message).toMatch(/already responded/i);
    expect(typeof second.body.submittedAt).toBe('string');
  });

  it('the client cannot choose which week its response lands in', async () => {
    const { id, questionIds } = await createSurvey('Week-forging probe');
    const answers = [
      { questionId: questionIds[0], value: 2 },
      { questionId: questionIds[1], value: true },
    ];

    await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send({ answers })
      .expect(201);

    // Every spelling a client might try. The week is the server's alone, so this
    // still collides with the response just written.
    const forged = await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send({ answers, weekStart: '2020-01-06', week_start: '2020-01-06', week: '2020-01-06' })
      .expect(409);

    expect(forged.body.weekStart).toBe(weekStartOf());
  });
});

describe('the weekly summary', () => {
  it('counts members as the denominator and averages what was answered', async () => {
    const { id, questionIds } = await createSurvey('Summary probe');

    await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send({
        answers: [
          { questionId: questionIds[0], value: 4 },
          { questionId: questionIds[1], value: true },
        ],
      })
      .expect(201);

    const summary = await request(app.getHttpServer())
      .get(`/surveys/${id}/summary`)
      .set(auth(managerA))
      .expect(200);

    expect(summary.body.weekStart).toBe(weekStartOf());
    expect(summary.body.completedCount).toBe(1);
    // The denominator is members only — managers author surveys, they are not
    // the responding population. Counted from the database rather than assumed,
    // so re-balancing the seed does not silently change what this asserts.
    expect(summary.body.eligibleCount).toBe(memberCountA);
    expect(summary.body.eligibleCount).toBeGreaterThanOrEqual(3);
    expect(summary.body.completionRate).toBeCloseTo(1 / memberCountA, 3);
    expect(summary.body.questions).toEqual([
      { id: questionIds[0], text: 'How was your week?', type: 'rating', average: 4, count: 1 },
      { id: questionIds[1], text: 'Blocked?', type: 'yes_no', counts: { yes: 1, no: 0 } },
    ]);
  });

  it('a week with no responses reports no average rather than zero', async () => {
    const { id, questionIds } = await createSurvey('Empty week probe');
    const summary = await request(app.getHttpServer())
      .get(`/surveys/${id}/summary?week=2026-08-31`)
      .set(auth(managerA))
      .expect(200);

    expect(summary.body.completedCount).toBe(0);
    expect(summary.body.completionRate).toBe(0);
    expect(summary.body.questions[0]).toEqual({
      id: questionIds[0],
      text: 'How was your week?',
      type: 'rating',
      average: null,
      count: 0,
    });
  });

  it('normalises any day in a week to that week’s Monday', async () => {
    const { id } = await createSurvey('Week normalising probe');
    const wednesday = await request(app.getHttpServer())
      .get(`/surveys/${id}/summary?week=2026-09-16`)
      .set(auth(managerA))
      .expect(200);
    expect(wednesday.body.weekStart).toBe('2026-09-14');
  });
});

describe('a manager manages the surveys their organization owns', () => {
  it('archives an active survey, and members stop being offered it', async () => {
    const { id } = await createSurvey('Archive probe');

    const listedBefore = await request(app.getHttpServer())
      .get('/surveys/active')
      .set(auth(memberA))
      .expect(200);
    expect((listedBefore.body as { id: string }[]).map((s) => s.id)).toContain(id);

    const patched = await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'archived' })
      .expect(200);
    expect(patched.body).toEqual({ id, title: 'Archive probe', status: 'archived' });

    const listedAfter = await request(app.getHttpServer())
      .get('/surveys/active')
      .set(auth(memberA))
      .expect(200);
    expect((listedAfter.body as { id: string }[]).map((s) => s.id)).not.toContain(id);
  });

  it('closes the survey to new responses, as a normal 409 rather than a failure', async () => {
    const { id, questionIds } = await createSurvey('Closed to responses probe');
    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'archived' })
      .expect(200);

    const refused = await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send({
        answers: [
          { questionId: questionIds[0], value: 4 },
          { questionId: questionIds[1], value: true },
        ],
      })
      .expect(409);
    expect(refused.body.message).toMatch(/archived/i);
  });

  it('reopens an archived survey', async () => {
    const { id } = await createSurvey('Reopen probe');
    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'archived' })
      .expect(200);

    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'active' })
      .expect(200);

    const listed = await request(app.getHttpServer())
      .get('/surveys/active')
      .set(auth(memberA))
      .expect(200);
    expect((listed.body as { id: string }[]).map((s) => s.id)).toContain(id);
  });

  it('keeps the summary readable after archiving — closing is not deleting', async () => {
    const { id, questionIds } = await createSurvey('Archived summary probe');
    await request(app.getHttpServer())
      .post(`/surveys/${id}/responses`)
      .set(auth(memberA))
      .send({
        answers: [
          { questionId: questionIds[0], value: 5 },
          { questionId: questionIds[1], value: false },
        ],
      })
      .expect(201);

    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'archived' })
      .expect(200);

    const summary = await request(app.getHttpServer())
      .get(`/surveys/${id}/summary`)
      .set(auth(managerA))
      .expect(200);
    expect(summary.body.completedCount).toBe(1);
  });

  it('a Member cannot archive a survey', async () => {
    const { id } = await createSurvey('Member archive probe');
    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(memberA))
      .send({ status: 'archived' })
      .expect(403);
  });

  it('another org’s survey is 404, and is left exactly as it was', async () => {
    const before = await statusOf(ORG_B, ORG_B_SURVEY);
    expect(before, 'the seeded org B survey should be active to begin with').toBe('active');

    await request(app.getHttpServer())
      .patch(`/surveys/${ORG_B_SURVEY}`)
      .set(auth(managerA))
      .send({ status: 'archived' })
      .expect(404);

    // Read back from inside org B. An unscoped read here would see nothing and
    // pass whatever happened.
    expect(await statusOf(ORG_B, ORG_B_SURVEY)).toBe('active');
  });

  it('refuses a status outside the two a manager may set', async () => {
    const { id } = await createSurvey('Status validation probe');
    // 'draft' is a real enum value and still not a destination: a survey that has
    // been published cannot be unpublished. The database refuses it too.
    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'draft' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({ status: 'nonsense' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/surveys/${id}`)
      .set(auth(managerA))
      .send({})
      .expect(400);
  });

  it('refuses an id that is not a uuid, rather than failing in the driver', async () => {
    await request(app.getHttpServer())
      .patch('/surveys/not-a-uuid')
      .set(auth(managerA))
      .send({ status: 'archived' })
      .expect(400);
  });
});
