import type { ScreenRoute } from '@/features/shell/registry';
import { SettingsContainer } from './SettingsContainer';

/** The Settings tab (09 s5.11 BidSettings), integrated from v0, registered with the shell. */
export const routes: ScreenRoute[] = [{ tab: 'settings', Component: SettingsContainer }];
