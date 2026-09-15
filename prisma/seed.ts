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
}

const ORGS: readonly OrgSpec[] = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Northwind Logistics',
    domain: 'northwind.test',
    surveyId: '11111111-1111-4111-8111-5000000000a1',
    surveyTitle: 'Northwind weekly pulse',
    memberCount: 3,
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    name: 'Seabird Studios',
    domain: 'seabird.test',
    surveyId: '22222222-2222-4222-8222-5000000000b1',
    surveyTitle: 'Seabird weekly pulse',
    memberCount: 4,
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
  });

  console.log(`seeded ${org.name}: 1 manager, ${org.memberCount} members, 1 active survey`);
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
