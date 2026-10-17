import { useShell } from '@/features/shell/bid-context';
import { UPGRADE_HASH } from './routes';

/**
 * "Upgrade" on the bids screens: the shell's upgrade dialog (out of credits when none are left, otherwise
 * the plan comparison). Outside the shell (tests) it falls back to the organization page.
 */
export function useUpgrade(): (creditsLeft: number) => void {
  const shell = useShell();
  return (creditsLeft) => {
    if (shell) shell.openUpgrade(creditsLeft <= 0 ? 'out_of_credits' : 'plan');
    else window.location.hash = UPGRADE_HASH;
  };
}
