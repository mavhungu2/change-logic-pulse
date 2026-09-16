import { Module } from '@nestjs/common';
import { PostgresAuthDirectory } from './auth-directory.js';
import { PrismaIdentityReader } from './identity.repository.js';
import { PrismaResponseRepository } from './response.repository.js';
import { PrismaSummaryRepository } from './summary.repository.js';
import { PrismaSurveyRepository } from './survey.repository.js';
import { TenantDb } from './tenant-db.js';
import {
  ACTIVE_SURVEY_READER,
  AUTH_DIRECTORY,
  IDENTITY_READER,
  RESPONSE_SUBMISSION,
  SUMMARY_REPORTING,
  SURVEY_AUTHORING,
  SURVEY_CATALOGUE,
  SURVEY_LIFECYCLE,
} from './tokens.js';

/**
 * Exports repositories and nothing else.
 *
 * TenantDb is a provider but is deliberately NOT exported, and the PrismaClient
 * is not a provider at all — it is constructed inside TenantDb and never
 * escapes. So the container cannot hand a database handle to anything outside
 * this module: a service that asks for one fails to resolve at bootstrap rather
 * than quietly querying unscoped.
 */
@Module({
  providers: [
    TenantDb,
    PrismaSurveyRepository,
    PrismaResponseRepository,
    { provide: AUTH_DIRECTORY, useClass: PostgresAuthDirectory },
    { provide: IDENTITY_READER, useClass: PrismaIdentityReader },
    { provide: ACTIVE_SURVEY_READER, useExisting: PrismaSurveyRepository },
    { provide: SURVEY_CATALOGUE, useExisting: PrismaSurveyRepository },
    { provide: SURVEY_AUTHORING, useExisting: PrismaSurveyRepository },
    { provide: SURVEY_LIFECYCLE, useExisting: PrismaSurveyRepository },
    { provide: RESPONSE_SUBMISSION, useExisting: PrismaResponseRepository },
    { provide: SUMMARY_REPORTING, useClass: PrismaSummaryRepository },
  ],
  exports: [
    AUTH_DIRECTORY,
    IDENTITY_READER,
    ACTIVE_SURVEY_READER,
    SURVEY_CATALOGUE,
    SURVEY_AUTHORING,
    SURVEY_LIFECYCLE,
    RESPONSE_SUBMISSION,
    SUMMARY_REPORTING,
    // Exported for the 409 body only: the controller needs the existing
    // response's timestamp, which is not part of any contract interface.
    PrismaResponseRepository,
  ],
})
export class TenancyModule {}
