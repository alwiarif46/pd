// The UI contracts (@/types) redeclare the unions the API client (@/api) also exports, so ui code
// never imports from the API. This file fails to compile (tsc) when the two drift apart.
import { describe, expect, expectTypeOf, it } from 'vitest';
import type * as api from '@/api';
import type * as ui from '@/types';
import type * as core from '@pd/core/schedule';

describe('@/types matches @/api', () => {
  it('has the same unions', () => {
    expectTypeOf<ui.Plan>().toEqualTypeOf<api.Plan>();
    expectTypeOf<ui.Role>().toEqualTypeOf<api.Role>();
    expectTypeOf<ui.BidType>().toEqualTypeOf<api.BidType>();
    expectTypeOf<ui.FileKind>().toEqualTypeOf<api.FileKind>();
    expectTypeOf<ui.ReqType>().toEqualTypeOf<api.ReqType>();
    expectTypeOf<ui.BidStatus>().toEqualTypeOf<api.BidStatus>();
    expectTypeOf<ui.RowStatus>().toEqualTypeOf<api.RowStatus>();
    expectTypeOf<ui.OutlineStatus>().toEqualTypeOf<api.OutlineStatus>();
    expectTypeOf<ui.PersonnelKind>().toEqualTypeOf<api.PersonnelKind>();
    expectTypeOf<ui.MatchResult>().toEqualTypeOf<api.MatchResult>();
    expectTypeOf<ui.ReviewType>().toEqualTypeOf<api.ReviewType>();
    expectTypeOf<ui.FindingKind>().toEqualTypeOf<api.FindingKind>();
    expectTypeOf<ui.Disposition>().toEqualTypeOf<api.Disposition>();
    expectTypeOf<ui.ProductionCategory>().toEqualTypeOf<api.ProductionCategory>();
    expectTypeOf<ui.OralsCategory>().toEqualTypeOf<api.OralsCategory>();
    expectTypeOf<ui.KeyCheck>().toEqualTypeOf<api.KeyCheck>();
    expectTypeOf<ui.Candidate['status']>().toEqualTypeOf<api.CandidateStatus>();
    expectTypeOf<ui.Review['status']>().toEqualTypeOf<api.ReviewStatus>();
    expectTypeOf<ui.ActivityKind>().toEqualTypeOf<api.ActivityKind>();
    expectTypeOf<ui.ReviewColor>().toEqualTypeOf<api.ReviewColor>();
    expectTypeOf<ui.ActivityOrigin>().toEqualTypeOf<api.ActivityOrigin>();
    expectTypeOf<ui.DateChangeMode>().toEqualTypeOf<api.AdjustMode>();
    expectTypeOf<ui.ScheduleTemplateId>().toEqualTypeOf<api.ScheduleTemplate>();
    expectTypeOf<ui.DateChangePromptProps['onChoose']>().parameter(0).toEqualTypeOf<api.AdjustMode>();
    expectTypeOf<ui.OrganizationPageProps['org']>().toEqualTypeOf<{
      name: string;
      plan: api.Plan;
      planStatus: api.PlanStatus;
    } | null>();
    expect(true).toBe(true);
  });

  it('matches the shared schedule rules in @pd/core/schedule', () => {
    expectTypeOf<ui.ActivityKind>().toEqualTypeOf<core.ActivityKind>();
    expectTypeOf<ui.ReviewColor>().toEqualTypeOf<core.ReviewColor>();
    expectTypeOf<ui.ActivityOrigin>().toEqualTypeOf<core.ActivityOrigin>();
    expectTypeOf<ui.DateChangeMode>().toEqualTypeOf<core.AdjustMode>();
    expectTypeOf<ui.ScheduleTemplateId>().toEqualTypeOf<core.ScheduleTemplateId>();
    expectTypeOf<ui.ScheduleHoliday>().toEqualTypeOf<core.Holiday>();
    expect(true).toBe(true);
  });

  it('covers every tab the API names', () => {
    expectTypeOf<api.TabName>().toExtend<ui.Tab>();
    expect(true).toBe(true);
  });
});
