/**
 * Injection tokens for the contract's interfaces.
 *
 * They live here rather than in contract.ts so that contract.ts stays free of
 * runtime values — it describes the boundary, it does not participate in it.
 */
export const AUTH_DIRECTORY = Symbol('AuthDirectory');
export const IDENTITY_READER = Symbol('IdentityReader');
export const ACTIVE_SURVEY_READER = Symbol('ActiveSurveyReader');
export const SURVEY_CATALOGUE = Symbol('SurveyCatalogue');
export const SURVEY_AUTHORING = Symbol('SurveyAuthoring');
export const RESPONSE_SUBMISSION = Symbol('ResponseSubmission');
export const SUMMARY_REPORTING = Symbol('SummaryReporting');
