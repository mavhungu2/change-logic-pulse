import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module.js';
import { SurveysController } from './surveys.controller.js';

@Module({ imports: [TenancyModule], controllers: [SurveysController] })
export class SurveysModule {}
