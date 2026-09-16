/**
 * The contract between the tenancy layer and the domain layer.
 *
 * Owned by the main thread, per CLAUDE.md §8. Dev 2 implements behind it; Dev
 * codes against it. Everything else under `src/tenancy/` belongs to Dev 2.
 *
 * This file imports nothing. That is the point: no Prisma type, no generated
 * client type, and no `org_id` reaches the domain through it. If an
 * implementation detail needs to appear here for the domain to work, the
 * boundary is in the wrong place — raise it rather than widening this file.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHAT A CALLER MAY ASSUME
 *
 * Every method on every repository below is already scoped to the caller's
 * organization, and runs inside a single database transaction that has applied
 * `app.current_org_id` from the verified token before issuing any statement.
 * The caller therefore never passes an `orgId`, never opens a transaction, and
 * never filters by tenant: no input type on this page carries an org, and any
 * that grows one is a bug. Rows belonging to another organization are not
 * merely filtered out of results — they are indistinguishable from rows that do
 * not exist, so a lookup for another tenant's survey returns `null`, and the
 * domain turns that into a 404 without ever learning which of the two it was.
 *
 * One method is one transaction, so one method is the unit of atomicity. There
 * is deliberately no way to compose two calls into one transaction: if two
 * operations must be atomic, they are one use case and belong behind one
 * method. This is why the repositories below are shaped by use case rather than
 * by table — `submit` writes a response and its answers together, and
 * `loadSummaryInputs` returns every number the summary needs from a single
 * snapshot, so the counts cannot disagree with each other.
 *
 * Called with no tenant context, every method throws `TENANT_CONTEXT_MISSING`
 * *before* it issues any SQL. Row-level security would already return zero rows
 * — that is the backstop and it stays — but an empty result is indistinguishable
 * from "this organization genuinely has no surveys", and a silent wrong answer
 * is the failure this whole design exists to prevent. The throw turns it into a
 * loud one. The only exception is `AuthDirectory`, which runs before any context
 * exists and is documented as such below.
 * ───────────────────────────────────────────────────────────────────────────
 */

// ── Identity and vocabulary ────────────────────────────────────────────────

export type OrgId = string;
export type UserId = string;
export type SurveyId = string;
export type QuestionId = string;
export type ResponseId = string;

export type Role = 'manager' | 'member';
export type SurveyStatus = 'draft' | 'active' | 'archived';

/**
 * The statuses a manager may move a survey *to*.
 *
 * `draft` is missing on purpose: it is an insert-time state, and a survey that
 * has been published may already carry responses. The database enforces this
 * independently with a BEFORE UPDATE trigger — the type narrows the API surface,
 * it is not what makes the rule true.
 */
export type ManagedSurveyStatus = Extract<SurveyStatus, 'active' | 'archived'>;

/**
 * The statuses a survey may be *created* in.
 *
 * The mirror image of ManagedSurveyStatus: `archived` is missing because
 * creating a survey already closed is not a thing anyone wants, and `draft` is
 * here because it is the only way to reach it. The two types together say that
 * `draft` is an insert-time state — entered on creation, never returned to —
 * which is precisely what the BEFORE UPDATE trigger enforces in the database.
 */
export type CreatableSurveyStatus = Extract<SurveyStatus, 'draft' | 'active'>;
export type QuestionType = 'rating' | 'yes_no';

/**
 * The Monday that starts an ISO week, as `YYYY-MM-DD`, UTC. Branded so that an
 * arbitrary date string cannot be passed where a week boundary is meant — the
 * one calculation that produces it lives in the week utility and nowhere else.
 */
export type IsoWeekStart = string & { readonly __brand: 'IsoWeekStart' };

/** Positions are 1–3; the database enforces the same range. */
export type QuestionPosition = 1 | 2 | 3;

export type RatingValue = 1 | 2 | 3 | 4 | 5;

// ── Tenant context ─────────────────────────────────────────────────────────

export interface TenantContext {
  readonly userId: UserId;
  readonly orgId: OrgId;
  readonly role: Role;
}

/**
 * Read access to the ambient context. Domain code uses this for role decisions
 * only; it never needs `orgId`, because scoping is not its job.
 */
export interface TenantContextAccessor {
  /** @throws TenancyError with code `TENANT_CONTEXT_MISSING` */
  require(): TenantContext;
  peek(): TenantContext | undefined;
}

/**
 * Establishes the context. Called by the auth guard, and by tests and the seed
 * to act as a given organization. Not for domain code.
 */
export interface TenantScope {
  runAs<T>(context: TenantContext, work: () => Promise<T>): Promise<T>;
}

// ── Data carried across the boundary ───────────────────────────────────────

export interface Question {
  readonly id: QuestionId;
  readonly text: string;
  readonly type: QuestionType;
  readonly position: QuestionPosition;
}

export interface ActiveSurvey {
  readonly id: SurveyId;
  readonly title: string;
  /**
   * The week this survey is being answered for, resolved by the server. The
   * client is told which week it is in rather than working it out: the ISO week
   * calculation exists once, in src/common/week.ts, and a browser deriving its
   * own would be a second opinion — in a different timezone — about the value
   * that decides whether a submission is a duplicate.
   */
  readonly weekStart: IsoWeekStart;
  readonly questions: readonly Question[];
  readonly alreadyRespondedThisWeek: boolean;
}

export interface SurveyListing {
  readonly id: SurveyId;
  readonly title: string;
  readonly status: SurveyStatus;
}

export interface NewQuestion {
  readonly text: string;
  readonly type: QuestionType;
  readonly position: QuestionPosition;
}

export interface NewSurvey {
  readonly title: string;
  /**
   * Defaults to `active` at the edge, because a survey nobody can answer is the
   * less useful default for a demo. `draft` is the alternative, and the only
   * route to that status: nothing may move a survey back to it afterwards.
   */
  readonly status: CreatableSurveyStatus;
  /** One to three. The database enforces the ceiling independently. */
  readonly questions: readonly NewQuestion[];
}

/**
 * Type-keyed rather than two nullable fields, so that adding a question type is
 * a new member here and a new entry in the registry — not a new `if` in three
 * layers. Mirrors the storage-level CHECK.
 */
export type AnswerValue =
  | { readonly type: 'rating'; readonly value: RatingValue }
  | { readonly type: 'yes_no'; readonly value: boolean };

export interface SubmittedAnswer {
  readonly questionId: QuestionId;
  readonly answer: AnswerValue;
}

export interface SubmitResponse {
  readonly surveyId: SurveyId;
  readonly weekStart: IsoWeekStart;
  readonly answers: readonly SubmittedAnswer[];
}

/** Raw tallies, not finished statistics — the maths is pure and testable without a database. */
export type QuestionTally =
  | {
      readonly questionId: QuestionId;
      readonly text: string;
      readonly type: 'rating';
      readonly sum: number;
      readonly count: number;
    }
  | {
      readonly questionId: QuestionId;
      readonly text: string;
      readonly type: 'yes_no';
      readonly yes: number;
      readonly no: number;
    };

export interface SummaryInputs {
  readonly weekStart: IsoWeekStart;
  /** Users in this organization with role `member`. */
  readonly eligibleCount: number;
  readonly completedCount: number;
  readonly tallies: readonly QuestionTally[];
}

// ── Repositories, segregated by use case ───────────────────────────────────

export interface ActiveSurveyReader {
  listActive(weekStart: IsoWeekStart): Promise<readonly ActiveSurvey[]>;
}

export interface SurveyCatalogue {
  list(): Promise<readonly SurveyListing[]>;
  /** `null` when it does not exist *or* belongs to another organization. */
  findById(id: SurveyId): Promise<SurveyListing | null>;
}

export interface SurveyAuthoring {
  /** @throws TenancyError `QUESTION_COUNT_EXCEEDED` */
  create(draft: NewSurvey): Promise<SurveyId>;
}

export interface SurveyLifecycle {
  /**
   * Opens a survey to responses, or closes it. Idempotent: setting the status a
   * survey already has succeeds and returns the row unchanged.
   *
   * Closing is not deleting — an archived survey keeps its responses and its
   * summary stays readable. Nothing else about a survey is editable through
   * this boundary; see ManagedSurveyStatus.
   *
   * `null` when it does not exist *or* belongs to another organization.
   */
  setStatus(id: SurveyId, status: ManagedSurveyStatus): Promise<SurveyListing | null>;
}

export interface ResponseSubmission {
  /**
   * Writes the response and all its answers atomically.
   * @throws TenancyError `DUPLICATE_RESPONSE` — already answered this week
   * @throws TenancyError `UNKNOWN_QUESTION` — question not on this survey
   */
  submit(input: SubmitResponse): Promise<ResponseId>;
}

export interface SummaryReporting {
  /** Every number from one snapshot. `null` if the survey is not visible. */
  loadSummaryInputs(surveyId: SurveyId, weekStart: IsoWeekStart): Promise<SummaryInputs | null>;
}

/**
 * The one path that runs with no tenant context, because it is what establishes
 * it: the caller has an email and nothing else. Implemented as a narrow
 * `SECURITY DEFINER` function returning only these claim fields — never a table
 * read — so it cannot be widened into a cross-tenant query. See SPEC.md.
 */
export interface AuthDirectory {
  findContextByEmail(email: string): Promise<TenantContext | null>;
}

// ── Errors ─────────────────────────────────────────────────────────────────

export type TenancyErrorCode =
  | 'TENANT_CONTEXT_MISSING'
  | 'DUPLICATE_RESPONSE'
  | 'UNKNOWN_QUESTION'
  | 'QUESTION_COUNT_EXCEEDED'
  /** A write aimed at another organization was refused by `WITH CHECK`. Always a bug. */
  | 'CROSS_TENANT_WRITE';

/**
 * Narrowed on `code`, never on `instanceof`, so the domain does not depend on
 * the tenancy layer's class identities. No database driver error escapes this
 * boundary: the implementation translates them.
 */
export interface TenancyError extends Error {
  readonly code: TenancyErrorCode;
}

/** The tenancy module exports a guard of this type. */
export type IsTenancyError = (error: unknown) => error is TenancyError;

// ── Identity ───────────────────────────────────────────────────────────────

export interface MeView {
  readonly userId: UserId;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly org: {
    readonly id: OrgId;
    readonly name: string;
    readonly logoUrl: string | null;
  };
}

export interface IdentityReader {
  /** The signed-in user and their organization. `null` if the user is gone. */
  findMe(): Promise<MeView | null>;
}
