import type { ScreenRoute } from '@/features/shell/registry';
import { ScheduleContainer } from './ScheduleContainer';

/** The Schedule tab (05 s3.2), the Claude Code port in src/schedule, registered with the shell; its row detail uses the shell's slot. */
export const routes: ScreenRoute[] = [{ tab: 'schedule', Component: ScheduleContainer, rowDetail: true }];
