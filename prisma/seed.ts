/**
 * Seed — runs on the OWNER connection, and still through the policies.
 *
 * It writes to two organizations, which is exactly what row-level security
 * forbids for any single tenant context, so it scopes itself per organization
 * and writes each one inside its own transaction. Nothing here bypasses RLS:
 * FORCE ROW LEVEL SECURITY applies to the owner too, so a missing set_config
 * would make these inserts fail rather than quietly cross tenants.
 *
 * Creating the organization row is the one ordering subtlety: the tenant it
 * belongs to is itself, so the id is chosen here and the GUC is set to it before
 * the insert, which is what satisfies the WITH CHECK on organizations.
 *
 * IDEMPOTENCE — every upsert matches on the row's NATURAL key, never on a
 * surrogate id:
 *
 *   organizations  id           (it is the tenant; the id is the identity)
 *   users          email        UNIQUE(email)
 *   questions      survey + position    UNIQUE(survey_id, position)
 *   responses      survey + user + week UNIQUE(survey_id, user_id, week_start)
 *   answers        response + question  UNIQUE(response_id, question_id)
 *
 * Matching on natural keys is what makes re-running safe in the case that
 * actually bites: a member answers through the API, which mints a random uuid,
 * and the seed then runs. Keyed on its own fixed id the seed would try to insert
 * a second response for the same member and week and hit the unique constraint;
 * keyed on (survey, user, week) it finds the row the API wrote and updates it.
 * Re-running converges on the declared state rather than merely avoiding
 * duplicates.
 */
import 'dotenv/config';
import { weekStartOf } from '../src/common/week.js';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });

type Rating = 1 | 2 | 3 | 4 | 5;

/** One member's answers to the three questions below. */
interface Reply {
  readonly member: number;
  readonly week: Rating;
  readonly blocked: boolean;
  readonly support: Rating;
}

interface OrgSpec {
  readonly id: string;
  readonly name: string;
  readonly domain: string;
  readonly surveyTitle: string;
  readonly managerCount: number;
  readonly memberCount: number;
  readonly replies: readonly Reply[];
}

/** Both surveys use both question types, in the same order, per CLAUDE.md §6. */
const QUESTIONS = [
  { position: 1, type: 'rating' as const, text: 'How was your week?' },
  { position: 2, type: 'yes_no' as const, text: 'Did anything block you?' },
  { position: 3, type: 'rating' as const, text: 'How supported did you feel?' },
];

/**
 * The two organizations are deliberately at opposite ends of every number, so
 * that switching users in the demo cannot be mistaken for a cached screen:
 *
 *                     Northwind      Seabird
 *   managers              2             2
 *   members               4             5
 *   responded          4 (100%)      2 (40%)
 *   avg "how was..."     4.75          1.5
 *   blocked            0 yes / 4 no  2 yes / 0 no
 */
const ORGS: readonly OrgSpec[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Northwind Logistics',
    domain: 'northwind.test',
    surveyTitle: 'Northwind weekly pulse',
    managerCount: 2,
    memberCount: 4,
    replies: [
      { member: 1, week: 5, blocked: false, support: 5 },
      { member: 2, week: 4, blocked: false, support: 5 },
      { member: 3, week: 5, blocked: false, support: 4 },
      { member: 4, week: 5, blocked: false, support: 5 },
    ],
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Seabird Studios',
    domain: 'seabird.test',
    surveyTitle: 'Seabird weekly pulse',
    managerCount: 2,
    memberCount: 5,
    replies: [
      { member: 1, week: 2, blocked: true, support: 1 },
      { member: 2, week: 1, blocked: true, support: 2 },
    ],
  },
];

/** Stable uuid for rows that have no natural key of their own (the survey). */
const surveyIdFor = (org: OrgSpec): string => `${org.id.slice(0, 24)}5000000000a1`;

/**
 * The first manager keeps the unsuffixed address. Every reference to this seed
 * outside it — the README, the login picker, the e2e tests — names
 * `manager@<domain>`, and renaming that to `manager1@` would buy nothing.
 */
const managerEmailFor = (org: OrgSpec, slot: number): string =>
  slot === 1 ? `manager@${org.domain}` : `manager${slot}@${org.domain}`;

const memberEmailFor = (org: OrgSpec, slot: number): string =>
  `member${slot}@${org.domain}`;

async function seedOrg(org: OrgSpec): Promise<void> {
  const weekStart = weekStartOf();
  const surveyId = surveyIdFor(org);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org_id', ${org.id}, true)`;

    await tx.organization.upsert({
      where: { id: org.id },
      update: { name: org.name },
      create: { id: org.id, name: org.name },
    });

    // Managers are seeded as a series for the same reason members are: one of a
    // role proves the role exists, two prove nothing about the row is special.
    // The author of the survey is the first of them.
    let author: string | null = null;
    for (let slot = 1; slot <= org.managerCount; slot += 1) {
      const manager = await tx.user.upsert({
        where: { email: managerEmailFor(org, slot) },
        update: { name: `Manager ${slot} (${org.name})`, role: 'manager' },
        create: {
          orgId: org.id,
          email: managerEmailFor(org, slot),
          name: `Manager ${slot} (${org.name})`,
          role: 'manager',
        },
        select: { id: true },
      });
      author ??= manager.id;
    }
    if (!author) throw new Error(`${org.name}: no managers seeded`);

    const memberIds = new Map<number, string>();
    for (let slot = 1; slot <= org.memberCount; slot += 1) {
      const member = await tx.user.upsert({
        where: { email: memberEmailFor(org, slot) },
        update: { name: `Member ${slot} (${org.name})`, role: 'member' },
        create: {
          orgId: org.id,
          email: memberEmailFor(org, slot),
          name: `Member ${slot} (${org.name})`,
          role: 'member',
        },
        select: { id: true },
      });
      memberIds.set(slot, member.id);
    }

    await tx.survey.upsert({
      where: { id: surveyId },
      update: { title: org.surveyTitle, status: 'active' },
      create: {
        id: surveyId,
        orgId: org.id,
        title: org.surveyTitle,
        status: 'active',
        createdBy: author,
      },
    });

    const questionIds = new Map<number, string>();
    for (const question of QUESTIONS) {
      const row = await tx.question.upsert({
        where: { surveyId_position: { surveyId, position: question.position } },
        update: { text: question.text, type: question.type },
        create: {
          surveyId,
          orgId: org.id,
          text: question.text,
          type: question.type,
          position: question.position,
        },
        select: { id: true },
      });
      questionIds.set(question.position, row.id);
    }

    for (const reply of org.replies) {
      const userId = memberIds.get(reply.member);
      if (!userId) throw new Error(`${org.name}: reply for member ${reply.member}, who has none`);

      const response = await tx.response.upsert({
        where: {
          surveyId_userId_weekStart: {
            surveyId,
            userId,
            weekStart: new Date(`${weekStart}T00:00:00.000Z`),
          },
        },
        update: {},
        create: {
          surveyId,
          userId,
          orgId: org.id,
          weekStart: new Date(`${weekStart}T00:00:00.000Z`),
        },
        select: { id: true },
      });

      const values: readonly { position: number; rating: Rating | null; bool: boolean | null }[] = [
        { position: 1, rating: reply.week, bool: null },
        { position: 2, rating: null, bool: reply.blocked },
        { position: 3, rating: reply.support, bool: null },
      ];

      for (const value of values) {
        const questionId = questionIds.get(value.position)!;
        const question = QUESTIONS.find((q) => q.position === value.position)!;
        await tx.answer.upsert({
          where: { responseId_questionId: { responseId: response.id, questionId } },
          update: { ratingValue: value.rating, boolValue: value.bool },
          create: {
            responseId: response.id,
            questionId,
            orgId: org.id,
            questionType: question.type,
            ratingValue: value.rating,
            boolValue: value.bool,
          },
        });
      }
    }
  });

  const rate = Math.round((org.replies.length / org.memberCount) * 100);
  console.log(
    `  ${org.name.padEnd(22)} ${org.managerCount} managers, ${org.memberCount} members, ` +
      `${org.replies.length} responded this week (${rate}%)`,
  );
}

async function main(): Promise<void> {
  console.log(`seeding week starting ${weekStartOf()}\n`);
  for (const org of ORGS) await seedOrg(org);

  console.log('\nsign in with any of these (no password):');
  for (const org of ORGS) {
    for (let slot = 1; slot <= org.managerCount; slot += 1) {
      console.log(`  ${managerEmailFor(org, slot).padEnd(28)} manager`);
    }
    console.log(`  ${memberEmailFor(org, 1).padEnd(28)} member`);
  }
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
