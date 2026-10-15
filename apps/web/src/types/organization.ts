// Organization: docs/plans/09-ui-workflow.md section 5.14.
import type { FormStatus, Plan, Role } from './shared';

export interface OrgMember {
  userId: string;
  name: string;
  email: string;
  role: Role;
  isYou: boolean;
}
export interface OrgCredits {
  allowed: number;
  used: number;
  reserved: number;
  periodStart: string;
  periodEnd: string;
}
export interface ProcessingInfo {
  provider: string;
  model: string;
  subprocessors: string[];
}
export interface OrganizationPageProps {
  org: { name: string; plan: Plan; planStatus: 'active' | 'past_due' | 'free' } | null; // null: no organization yet
  role: Role;
  members: OrgMember[];
  seatLimit: number;
  credits: OrgCredits | null;
  mbCap: number;
  processing: ProcessingInfo | null;
  billingAvailable: boolean;
  createStatus: FormStatus;
  inviteStatus: FormStatus;
  onCreateOrg: (name: string) => void;
  onInvite: (email: string) => void;
  onRemoveMember: (userId: string) => void;
  onOpenBilling: () => void;
  onUpgrade: () => void;
  onOpenPrivacy: () => void;
}
