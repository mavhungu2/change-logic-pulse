import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator.js';
import { InvalidWeekError, parseWeekStart, weekStartOf } from '../common/week.js';
import type { SummaryReporting } from '../tenancy/contract.js';
import { SUMMARY_REPORTING } from '../tenancy/tokens.js';
import { summarise, type WeeklySummary } from './weekly-summary.js';

@Controller('surveys/:id/summary')
export class SummaryController {
  constructor(@Inject(SUMMARY_REPORTING) private readonly reporting: SummaryReporting) {}

  @Get()
  @Roles('manager')
  async summary(
    @Param('id', new ParseUUIDPipe()) surveyId: string,
    @Query('week') week?: string,
  ): Promise<WeeklySummary> {
    // A manager choosing which week to *read* is fine — unlike submission, where
    // the week is the server's alone. Any day in a week resolves to its Monday.
    let weekStart;
    try {
      weekStart = week === undefined ? weekStartOf() : parseWeekStart(week);
    } catch (error) {
      if (error instanceof InvalidWeekError) throw new BadRequestException(error.message);
      throw error;
    }

    const inputs = await this.reporting.loadSummaryInputs(surveyId, weekStart);
    if (!inputs) throw new NotFoundException('Survey not found');

    return summarise(inputs);
  }
}
