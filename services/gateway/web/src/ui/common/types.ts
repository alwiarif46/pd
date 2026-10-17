export type {
  Plan,
  BidType,
  Role,
  FileKind,
  ReqType,
  RowFlag,
  FormStatus,
  AmendmentMark,
  RowDetailProps,
  ProcessingStep,
  ProcessingState,
  ProcessingBannerProps,
  SourceLinkProps,
  EmptyStateProps,
  LockedTabProps,
  TabBlock,
  TabFrameProps,
  MarkingPromptProps,
  AmendmentSide,
  AmendmentProposal,
  AmendmentConfirmProps,
} from '@/types';

export interface RowDetailField {
  key: string;
  label: string;
  value: string;
  type: 'text' | 'textarea' | 'select';
  options: string[] | null;
}
