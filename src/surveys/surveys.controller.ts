import { BadRequestException, Body, Controller, Get, Inject, Post } from '@nestjs/common';
import { weekStartOf } from '../common/week.js';
import { Roles } from '../auth/roles.decorator.js';
import type {
  ActiveSurvey,
  ActiveSurveyReader,
  NewQuestion,
  NewSurvey,
  QuestionType,
  SurveyAuthoring,
  SurveyCatalogue,
  SurveyListing,
} from '../tenancy/contract.js';
import { ACTIVE_SURVEY_READER, SURVEY_AUTHORING, SURVEY_CATALOGUE } from '../tenancy/tokens.js';

const QUESTION_TYPES: readonly QuestionType[] = ['rating', 'yes_no'];

function parseNewSurvey(body: unknown): NewSurvey {
  const draft = body as { title?: unknown; questions?: unknown } | null;

  const title = typeof draft?.title === 'string' ? draft.title.trim() : '';
  if (title === '') throw new BadRequestException('title is required');

  if (!Array.isArray(draft?.questions) || draft.questions.length === 0) {
    throw new BadRequestException('questions must be a non-empty array');
  }
  if (draft.questions.length > 3) {
    throw new BadRequestException(
      `A survey may have at most 3 questions; received ${draft.questions.length}.`,
    );
  }

  const questions: NewQuestion[] = draft.questions.map((raw: unknown, index: number) => {
    const question = raw as { text?: unknown; type?: unknown } | null;
    const text = typeof question?.text === 'string' ? question.text.trim() : '';
    if (text === '') throw new BadRequestException(`questions[${index}].text is required`);
    if (!QUESTION_TYPES.includes(question?.type as QuestionType)) {
      throw new BadRequestException(
        `questions[${index}].type must be one of: ${QUESTION_TYPES.join(', ')}`,
      );
    }
    // Position is the array order, never a client-supplied number: two questions
    // claiming position 1 is a unique-constraint violation, not a 400.
    return { text, type: question?.type as QuestionType, position: (index + 1) as 1 | 2 | 3 };
  });

  return { title, questions };
}

@Controller('surveys')
export class SurveysController {
  constructor(
    @Inject(ACTIVE_SURVEY_READER) private readonly activeSurveys: ActiveSurveyReader,
    @Inject(SURVEY_CATALOGUE) private readonly catalogue: SurveyCatalogue,
    @Inject(SURVEY_AUTHORING) private readonly authoring: SurveyAuthoring,
  ) {}

  /** Declared before any ':id' route so 'active' is not read as an id. */
  @Get('active')
  @Roles('member')
  async listActive(): Promise<readonly ActiveSurvey[]> {
    // The week is the server's, derived from the ISO calendar. There is no
    // parameter here for a client to influence which week it is answering for.
    return this.activeSurveys.listActive(weekStartOf());
  }

  @Get()
  @Roles('manager')
  async list(): Promise<readonly SurveyListing[]> {
    return this.catalogue.list();
  }

  @Post()
  @Roles('manager')
  async create(@Body() body: unknown): Promise<{ id: string }> {
    const id = await this.authoring.create(parseNewSurvey(body));
    return { id };
  }
}
