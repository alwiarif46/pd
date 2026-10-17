import type { ScreenRoute } from '@/features/shell/registry';
import { ComplianceContainer } from './ComplianceContainer';

/** The Compliance tab (05 s3.3, 09 s5.4), registered with the shell; its row detail uses the shell's slot. */
export const routes: ScreenRoute[] = [{ tab: 'compliance', Component: ComplianceContainer, rowDetail: true }];
