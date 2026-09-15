import type { IsTenancyError, TenancyError, TenancyErrorCode } from './contract.js';

const CODES: ReadonlySet<string> = new Set<TenancyErrorCode>([
  'TENANT_CONTEXT_MISSING',
  'DUPLICATE_RESPONSE',
  'UNKNOWN_QUESTION',
  'QUESTION_COUNT_EXCEEDED',
  'CROSS_TENANT_WRITE',
]);

export class TenancyViolation extends Error implements TenancyError {
  constructor(
    readonly code: TenancyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenancyViolation';
  }
}

/** Structural, so the domain narrows on `code` rather than on a class identity. */
export const isTenancyError: IsTenancyError = (error): error is TenancyError =>
  error instanceof Error && CODES.has((error as Partial<TenancyError>).code ?? '');
