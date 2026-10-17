// Bids list and new bid: docs/plans/09-ui-workflow.md section 5.2.
import type { BidType, FormStatus, Plan } from './shared';

export type BidStatus = 'planning' | 'writing' | 'submitted' | 'closed';
export interface BidCard {
  id: string;
  name: string;
  agency?: string;
  dueDate?: string;
  daysLeft?: number;
  status: BidStatus;
  creditUsed: boolean;
}
export interface BidsListProps {
  bids: BidCard[];
  creditsLeft: number;
  creditsResetOn: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onUpgrade: () => void;
}
export interface NewBidProps {
  creditsLeft: number;
  creditsResetOn: string;
  plan: Plan;
  mbCap: number;
  status: FormStatus;
  onCreate: (name: string, bidType: BidType, files: File[]) => void;
  onCancel: () => void;
  onUpgrade: () => void;
}
