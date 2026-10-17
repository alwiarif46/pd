import type { ScreenRoute } from '@/features/shell/registry';
import { ScheduleContainer } from './ScheduleContainer';

/** The Schedule tab (05 s3.2), the Claude Code port in src/schedule, registered with the shell. */
export const routes: ScreenRoute[] = [{ tab: 'schedule', Component: ScheduleContainer }];
