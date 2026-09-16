import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { weekStartOf } from '../common/week.js';
import type {
  AnswerValue,
  ResponseSubmission,
  SubmittedAnswer,
  SurveyCatalogue,
} from '../tenancy/contract.js';
import { isTenancyError } from '../tenancy/tenancy.errors.js';
import { RESPONSE_SUBMISSION, SURVEY_CATALOGUE } from '../tenancy/tokens.js';

function parseAnswers(body: unknown): readonly SubmittedAnswer[] {
  const payload = body as { answers?: unknown } | null;
  if (!Array.isArray(payload?.answers) || payload.answers.length === 0) {
    throw new BadRequestException('answers must be a non-empty array');
  }

  return payload.answers.map((raw: unknown, index: number) => {
    const entry = raw as { questionId?: unknown; value?: unknown } | null;
    if (typeof entry?.questionId !== 'string') {
      throw new BadRequestException(`answers[${index}].questionId must be a string`);
    }

    // The value's own type selects the answer type; the repository then checks
    // that against the question's actual type, so a mismatch is rejected rather
    // than silently stored in the wrong column.
    let answer: AnswerValue;
    if (typeof entry.value === 'boolean') {
      answer = { type: 'yes_no', value: entry.value };
    } else if (
      typeof entry.value === 'number' &&
      Number.isInteger(entry.value) &&
      entry.value >= 1 &&
      entry.value <= 5
    ) {
      answer = { type: 'rating', value: entry.value as 1 | 2 | 3 | 4 | 5 };
    } else {
      throw new BadRequestException(
        `answers[${index}].value must be a boolean, or an integer from 1 to 5`,
      );
    }

    return { questionId: entry.questionId, answer };
  });
}

@Controller('surveys/:id/responses')
export class ResponsesController {
  constructor(
    @Inject(RESPONSE_SUBMISSION) private readonly submission: ResponseSubmission,
    @Inject(SURVEY_CATALOGUE) private readonly catalogue: SurveyCatalogue,
  ) {}

  @Post()
  @Roles('member')
  @HttpCode(201)
  async submit(
    @Param('id', new ParseUUIDPipe()) surveyId: string,
    @Body() body: unknown,
  ): Promise<{ id: string; weekStart: string }> {
    const answers = parseAnswers(body);

    // Derived here, from the server clock. The request body has no say in which
    // week it lands in, so a client cannot backdate its way past the one-per-week
    // constraint by claiming a different week.
    const weekStart = weekStartOf();

    const survey = await this.catalogue.findById(surveyId);
    // Another tenant's survey and a nonexistent one are the same 404: a 403 here
    // would confirm that the id belongs to somebody.
    if (!survey) throw new NotFoundException('Survey not found');
    if (survey.status !== 'active') {
      throw new ConflictException({
        statusCode: 409,
        error: 'Conflict',
        message: `This survey is ${survey.status} and is not accepting responses.`,
        surveyId,
      });
    }

    try {
      const id = await this.submission.submit({ surveyId, weekStart, answers });
      return { id, weekStart };
    } catch (error) {
      if (isTenancyError(error) && error.code === 'DUPLICATE_RESPONSE') {
        // A normal outcome, not a failure: the member already answered. The body
        // says which week that was and when, so the UI can show the
        // already-responded state instead of an error toast.
        const submittedAt = await this.submission.findSubmittedAt(surveyId, weekStart);
        throw new ConflictException({
          statusCode: 409,
          error: 'Conflict',
          message: 'You have already responded to this survey this week.',
          surveyId,
          weekStart,
          submittedAt: submittedAt?.toISOString() ?? null,
        });
      }
      if (isTenancyError(error) && error.code === 'UNKNOWN_QUESTION') {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }
}
