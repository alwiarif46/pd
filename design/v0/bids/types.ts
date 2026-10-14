export interface BidCard {
  id: string;
  name: string;
  agency?: string;
  dueDate?: string;
  daysLeft?: number;
  status: 'planning' | 'writing' | 'submitted' | 'closed';
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

export type BidType = 'federal' | 'sled';

export interface NewBidProps {
  creditsLeft: number;
  creditsResetOn: string;
  plan: 'free' | 'starter' | 'growth';
  mbCap: number;
  onCreate: (name: string, bidType: BidType, files: File[]) => void;
  onCancel: () => void;
  onUpgrade: () => void;
}
