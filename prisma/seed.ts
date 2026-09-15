/**
 * Seed — runs on the OWNER connection, and still through the policies.
 *
 * It writes to two organizations, which is exactly what row-level security
 * forbids for any single tenant context, so it scopes itself per organization
 * and inserts each one's data inside its own transaction. Nothing here bypasses
 * RLS: FORCE ROW LEVEL SECURITY applies to the owner too, so a missing
 * set_config would make these inserts fail rather than silently cross tenants.
 *
 * Creating the organization row is the one ordering subtlety: the tenant it
 * belongs to is itself, so the id is chosen here and the GUC is set to it before
 * the insert, which is what satisfies the WITH CHECK on organizations.
 *
 * Idempotent: fixed ids plus upsert, so re-running changes no row counts.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { weekStartOf } from '../src/common/week.js';
import { PrismaClient } from '../src/generated/prisma/client.js';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

interface OrgSpec {
  id: string;
  name: string;
  domain: string;
  surveyId: string;
  surveyTitle: string;
  memberCount: number;
  /** Members (1-based) who answered this week, and the rating they gave. */
  respondents: readonly { member: number; rating: number; blocked: boolean; support: number }[];
}

const ORGS: readonly OrgSpec[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Northwind Logistics',
    domain: 'northwind.test',
    surveyId: '11111111-1111-4111-8111-5000000000a1',
    surveyTitle: 'Northwind weekly pulse',
    memberCount: 3,
    // 2 of 3 members — the two orgs must show visibly different numbers.
    respondents: [
      { member: 1, rating: 4, blocked: false, support: 5 },
      { member: 2, rating: 3, blocked: true, support: 3 },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Seabird Studios',
    domain: 'seabird.test',
    surveyId: '22222222-2222-4222-8222-5000000000b1',
    surveyTitle: 'Seabird weekly pulse',
    memberCount: 4,
    // 3 of 4 members.
    respondents: [
      { member: 1, rating: 2, blocked: true, support: 2 },
      { member: 2, rating: 1, blocked: true, support: 1 },
      { member: 3, rating: 5, blocked: false, support: 4 },
    ],
  },
];

/** Deterministic uuid so re-running the seed reuses the same rows. */
const idFor = (org: OrgSpec, slot: number): string =>
  `${org.id.slice(0, 24)}${String(slot).padStart(12, '0')}`;

async function seedOrg(org: OrgSpec): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${org.id}, true)`;

    await tx.organization.upsert({
      where: { id: org.id },
      update: { name: org.name },
      create: { id: org.id, name: org.name },
    });

    const managerId = idFor(org, 1);
    await tx.user.upsert({
      where: { id: managerId },
      update: { email: `manager@${org.domain}`, name: `Manager (${org.name})`, role: 'manager' },
      create: {
        id: managerId,
        orgId: org.id,
        email: `manager@${org.domain}`,
        name: `Manager (${org.name})`,
        role: 'manager',
      },
    });

    for (let slot = 2; slot <= org.memberCount + 1; slot += 1) {
      const memberId = idFor(org, slot);
      await tx.user.upsert({
        where: { id: memberId },
        update: {
          email: `member${slot - 1}@${org.domain}`,
          name: `Member ${slot - 1} (${org.name})`,
          role: 'member',
        },
        create: {
          id: memberId,
          orgId: org.id,
          email: `member${slot - 1}@${org.domain}`,
          name: `Member ${slot - 1} (${org.name})`,
          role: 'member',
        },
      });
    }

    await tx.survey.upsert({
      where: { id: org.surveyId },
      update: { title: org.surveyTitle },
      create: {
        id: org.surveyId,
        orgId: org.id,
        title: org.surveyTitle,
        status: 'active',
        createdBy: managerId,
      },
    });

    const questions = [
      { text: 'How was your week?', type: 'rating' as const, position: 1 },
      { text: 'Did anything block you?', type: 'yes_no' as const, position: 2 },
      { text: 'How supported did you feel?', type: 'rating' as const, position: 3 },
    ];
    for (const question of questions) {
      const questionId = idFor(org, 100 + question.position);
      await tx.question.upsert({
        where: { id: questionId },
        update: { text: question.text },
        create: {
          id: questionId,
          surveyId: org.surveyId,
          orgId: org.id,
          text: question.text,
          type: question.type,
          position: question.position,
        },
      });
    }
    // week_start comes from the one week utility the API uses, so the seed
    // cannot disagree with the application about what week it is.
    const weekStart = weekStartOf();

    for (const respondent of org.respondents) {
      const responseId = idFor(org, 200 + respondent.member);
      const userId = idFor(org, respondent.member + 1);

      await tx.response.upsert({
        where: { id: responseId },
        update: {},
        create: {
          id: responseId,
          surveyId: org.surveyId,
          userId,
          orgId: org.id,
          weekStart: new Date(`${weekStart}T00:00:00.000Z`),
        },
      });

      const answers = [
        { position: 1, type: 'rating' as const, ratingValue: respondent.rating, boolValue: null },
        { position: 2, type: 'yes_no' as const, ratingValue: null, boolValue: respondent.blocked },
        { position: 3, type: 'rating' as const, ratingValue: respondent.support, boolValue: null },
      ];
      for (const answer of answers) {
        await tx.answer.upsert({
          where: {
            responseId_questionId: { responseId, questionId: idFor(org, 100 + answer.position) },
          },
          update: { ratingValue: answer.ratingValue, boolValue: answer.boolValue },
          create: {
            responseId,
            questionId: idFor(org, 100 + answer.position),
            orgId: org.id,
            questionType: answer.type,
            ratingValue: answer.ratingValue,
            boolValue: answer.boolValue,
          },
        });
      }
    }
  });

  console.log(
    `seeded ${org.name}: 1 manager, ${org.memberCount} members, 1 active survey, ` +
      `${org.respondents.length} responses this week`,
  );
}

async function main(): Promise<void> {
  for (const org of ORGS) await seedOrg(org);
  console.log('\nlog in with any seeded email, e.g.:');
  for (const org of ORGS) {
    console.log(`  manager@${org.domain}   member1@${org.domain}`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
