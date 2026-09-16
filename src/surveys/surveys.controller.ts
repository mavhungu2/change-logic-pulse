import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { weekStartOf } from '../common/week.js';
import { Roles } from '../auth/roles.decorator.js';
import type {
  ActiveSurvey,
  ActiveSurveyReader,
  CreatableSurveyStatus,
  ManagedSurveyStatus,
  NewQuestion,
  NewSurvey,
  QuestionType,
  SurveyAuthoring,
  SurveyCatalogue,
  SurveyLifecycle,
  SurveyListing,
} from '../tenancy/contract.js';
import {
  ACTIVE_SURVEY_READER,
  SURVEY_AUTHORING,
  SURVEY_CATALOGUE,
  SURVEY_LIFECYCLE,
} from '../tenancy/tokens.js';

const QUESTION_TYPES: readonly QuestionType[] = ['rating', 'yes_no'];
/** 'draft' is a real status and deliberately not a destination — see the contract. */
const MANAGED_STATUSES: readonly ManagedSurveyStatus[] = ['active', 'archived'];
/** ...but it is a starting point, and this is the only way to reach it. */
const CREATABLE_STATUSES: readonly CreatableSurveyStatus[] = ['draft', 'active'];

function parseStatusChange(body: unknown): ManagedSurveyStatus {
  const change = body as { status?: unknown } | null;
  const status = change?.status;
  if (!MANAGED_STATUSES.includes(status as ManagedSurveyStatus)) {
    throw new BadRequestException(`status must be one of: ${MANAGED_STATUSES.join(', ')}`);
  }
  return status as ManagedSurveyStatus;
}

function parseNewSurvey(body: unknown): NewSurvey {
  const draft = body as { title?: unknown; status?: unknown; questions?: unknown } | null;

  const title = typeof draft?.title === 'string' ? draft.title.trim() : '';
  if (title === '') throw new BadRequestException('title is required');

  // Absent means 'active'. Absent is `undefined` and nothing else: `?? 'active'`
  // would also swallow an explicit null, and an explicit value is checked rather
  // than coerced here — a typo that silently published a survey meant to stay a
  // draft is the one failure this field can cause.
  const status = draft?.status === undefined ? 'active' : draft.status;
  if (!CREATABLE_STATUSES.includes(status as CreatableSurveyStatus)) {
    throw new BadRequestException(
      `status must be one of: ${CREATABLE_STATUSES.join(', ')}. ` +
        'A survey cannot be created archived, and cannot return to draft once it leaves it.',
    );
  }

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

  return { title, status: status as CreatableSurveyStatus, questions };
}

@Controller('surveys')
export class SurveysController {
  constructor(
    @Inject(ACTIVE_SURVEY_READER) private readonly activeSurveys: ActiveSurveyReader,
    @Inject(SURVEY_CATALOGUE) private readonly catalogue: SurveyCatalogue,
    @Inject(SURVEY_AUTHORING) private readonly authoring: SurveyAuthoring,
    @Inject(SURVEY_LIFECYCLE) private readonly lifecycle: SurveyLifecycle,
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

  /**
   * Close a survey, or reopen it. The only thing about a survey a manager can
   * change after it exists — a title with responses filed under it is history,
   * and the API is not granted the column.
   */
  @Patch(':id')
  @Roles('manager')
  async setStatus(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: unknown,
  ): Promise<SurveyListing> {
    const updated = await this.lifecycle.setStatus(id, parseStatusChange(body));
    // Another organization's survey and an id that never existed are the same
    // 404 here, for the same reason they are everywhere else.
    if (!updated) throw new NotFoundException('Survey not found');
    return updated;
  }
}
