import type { ScreenRoute } from '@/features/shell/registry';
import { BidsContainer } from './BidsContainer';
import { NewBidContainer } from './NewBidContainer';

/** The bids list (#/bids) and new bid (#/bids/new), registered with the shell (features/shell/registry.ts). */
export const routes: ScreenRoute[] = [
  { page: 'bids', Component: BidsContainer },
  { page: 'new_bid', Component: NewBidContainer },
];
