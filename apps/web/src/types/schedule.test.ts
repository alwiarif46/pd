// The web resolves the shared schedule rules ('@pd/core/schedule') at run time, and the
// template ids in @/types match them.
import { describe, expect, it } from 'vitest';
import { federalHolidayName, SCHEDULE_TEMPLATES } from '@pd/core/schedule';
import type { ScheduleTemplateId } from '@/types';

describe('@pd/core/schedule from the web', () => {
  it('loads the shared rules', () => {
    const ids: ScheduleTemplateId[] = ['federal-standard', 'federal-fast', 'task-order'];
    expect(SCHEDULE_TEMPLATES.map((template) => template.id)).toEqual(ids);
    expect(federalHolidayName('2026-11-26')).toBe('Thanksgiving Day');
  });
});
