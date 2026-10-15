// Privacy summary: docs/plans/09-ui-workflow.md section 5.16.
import type { ProcessingInfo } from './organization';

export interface PrivacyPageProps {
  processing: ProcessingInfo | null;
  policyUrl: string | null;
  onBack: () => void;
}
