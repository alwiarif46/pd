import type { ScreenRoute } from '@/features/shell/registry';
import { OverviewContainer } from './OverviewContainer';

/** The Overview tab (05 s3.1): the amendment proposals panel above the legacy Overview, until v0's is integrated. */
export const routes: ScreenRoute[] = [{ tab: 'overview', Component: OverviewContainer }];
