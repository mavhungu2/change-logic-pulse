import { Injectable } from '@nestjs/common';
import type {
  ActiveSurvey,
  ActiveSurveyReader,
  IsoWeekStart,
  NewSurvey,
  SurveyAuthoring,
  SurveyCatalogue,
  SurveyId,
  SurveyListing,
} from './contract.js';
import { tenantContext } from './tenant-context.js';
import { TenantDb } from './tenant-db.js';
import { TenancyViolation } from './tenancy.errors.js';

const asDate = (week: IsoWeekStart): Date => new Date(`${week}T00:00:00.000Z`);

@Injectable()
export class PrismaSurveyRepository
  implements ActiveSurveyReader, SurveyCatalogue, SurveyAuthoring
{
  constructor(private readonly db: TenantDb) {}

  async listActive(weekStart: IsoWeekStart): Promise<readonly ActiveSurvey[]> {
    const { userId } = tenantContext.require();

    return this.db.run(async (tx) => {
      // One query, not one per survey: the caller's own response for the week is
      // fetched alongside, so the member screen is a single round trip.
      const surveys = await tx.survey.findMany({
        where: { status: 'active' },
        select: {
          id: true,
          title: true,
          questions: {
            select: { id: true, text: true, type: true, position: true },
            orderBy: { position: 'asc' },
          },
          responses: { where: { userId, weekStart: asDate(weekStart) }, select: { id: true }, take: 1 },
        },
        orderBy: { title: 'asc' },
      });

      return surveys.map((survey) => ({
        id: survey.id,
        title: survey.title,
        questions: survey.questions.map((question) => ({
          id: question.id,
          text: question.text,
          type: question.type,
          position: question.position as 1 | 2 | 3,
        })),
        alreadyRespondedThisWeek: survey.responses.length > 0,
      }));
    });
  }

  async list(): Promise<readonly SurveyListing[]> {
    return this.db.run(async (tx) =>
      tx.survey.findMany({
        select: { id: true, title: true, status: true },
        orderBy: { title: 'asc' },
      }),
    );
  }

  async findById(id: SurveyId): Promise<SurveyListing | null> {
    return this.db.run(async (tx) =>
      // No org filter, and none is needed: a survey belonging to another tenant
      // is not visible to this transaction, so this returns null exactly as it
      // would for an id that never existed. The caller cannot tell them apart,
      // which is the point — it becomes a 404, never a 403.
      tx.survey.findUnique({ where: { id }, select: { id: true, title: true, status: true } }),
    );
  }

  async create(draft: NewSurvey): Promise<SurveyId> {
    const { userId, orgId } = tenantContext.require();

    if (draft.questions.length < 1 || draft.questions.length > 3) {
      throw new TenancyViolation(
        'QUESTION_COUNT_EXCEEDED',
        `A survey has between 1 and 3 questions; received ${draft.questions.length}.`,
      );
    }

    return this.db.run(async (tx) => {
      const survey = await tx.survey.create({
        data: { orgId, title: draft.title, status: 'active', createdBy: userId },
        select: { id: true },
      });

      // A separate statement rather than a nested create: org_id is a leg of the
      // composite foreign key pinning a question to its survey's org, so Prisma
      // manages it through the relation and refuses it as a scalar when nested.
      // Both run in the wrapper's transaction, so a survey cannot be left
      // half-built with no questions.
      await tx.question.createMany({
        data: draft.questions.map((question) => ({
          surveyId: survey.id,
          orgId,
          text: question.text,
          type: question.type,
          position: question.position,
        })),
      });

      return survey.id;
    });
  }
}
