import { Injectable } from '@nestjs/common';
import type {
  IsoWeekStart,
  ResponseId,
  ResponseSubmission,
  SubmitResponse,
  SurveyId,
} from './contract.js';
import { tenantContext } from './tenant-context.js';
import { TenantDb } from './tenant-db.js';
import { TenancyViolation } from './tenancy.errors.js';

/** Prisma's unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

const asDate = (week: IsoWeekStart): Date => new Date(`${week}T00:00:00.000Z`);

@Injectable()
export class PrismaResponseRepository implements ResponseSubmission {
  constructor(private readonly db: TenantDb) {}

  async submit(input: SubmitResponse): Promise<ResponseId> {
    const { userId, orgId } = tenantContext.require();

    return this.db.run(async (tx) => {
      // The survey's own questions, which is what an answer is validated against.
      // Invisible survey -> no questions -> UNKNOWN_QUESTION, never a leak.
      const questions = await tx.question.findMany({
        where: { surveyId: input.surveyId },
        select: { id: true, type: true },
      });
      const byId = new Map(questions.map((question) => [question.id, question.type]));

      for (const answer of input.answers) {
        const type = byId.get(answer.questionId);
        if (!type) {
          throw new TenancyViolation(
            'UNKNOWN_QUESTION',
            `Question ${answer.questionId} does not belong to this survey.`,
          );
        }
        if (type !== answer.answer.type) {
          throw new TenancyViolation(
            'UNKNOWN_QUESTION',
            `Question ${answer.questionId} is a ${type} question; received a ${answer.answer.type} answer.`,
          );
        }
      }

      const answered = new Set(input.answers.map((answer) => answer.questionId));
      if (answered.size !== questions.length) {
        throw new TenancyViolation(
          'UNKNOWN_QUESTION',
          `This survey has ${questions.length} questions; received ${answered.size} distinct answers.`,
        );
      }

      try {
        const response = await tx.response.create({
          data: {
            surveyId: input.surveyId,
            // From the verified token, never from the request body: this is what
            // stops a Manager submitting on a Member's behalf.
            userId,
            orgId,
            // Derived server-side from the ISO calendar week.
            weekStart: asDate(input.weekStart),
          },
          select: { id: true },
        });

        // A separate statement rather than a nested create: org_id and
        // question_type are legs of the composite foreign keys that pin an
        // answer to its response's org and its question's type, so Prisma
        // manages them through the relations and refuses them as scalars in a
        // nested create. Both statements run in the wrapper's transaction, so
        // this is still all-or-nothing.
        await tx.answer.createMany({
          data: input.answers.map((answer) => ({
            responseId: response.id,
            questionId: answer.questionId,
            orgId,
            questionType: answer.answer.type,
            ratingValue: answer.answer.type === 'rating' ? answer.answer.value : null,
            boolValue: answer.answer.type === 'yes_no' ? answer.answer.value : null,
          })),
        });

        return response.id;
      } catch (error) {
        // The one-per-week rule is a unique constraint, so a concurrent second
        // submission loses the race here rather than passing a check-then-insert.
        if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
          throw new TenancyViolation(
            'DUPLICATE_RESPONSE',
            'A response for this survey already exists for this week.',
          );
        }
        throw error;
      }
    });
  }

  /** When the response was recorded, for the 409 body. */
  async findSubmittedAt(surveyId: SurveyId, weekStart: IsoWeekStart): Promise<Date | null> {
    const { userId } = tenantContext.require();
    return this.db.run(async (tx) => {
      const existing = await tx.response.findUnique({
        where: {
          surveyId_userId_weekStart: { surveyId, userId, weekStart: asDate(weekStart) },
        },
        select: { submittedAt: true },
      });
      return existing?.submittedAt ?? null;
    });
  }
}
