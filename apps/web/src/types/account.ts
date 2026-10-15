// Account: docs/plans/09-ui-workflow.md section 5.15.
import type { FormStatus } from './shared';

export interface AccountPageProps {
  name: string;
  email: string;
  phone: string;
  profileStatus: FormStatus;
  passwordStatus: FormStatus;
  onSaveName: (name: string) => void;
  onChangePassword: (currentPassword: string, newPassword: string) => void;
}
