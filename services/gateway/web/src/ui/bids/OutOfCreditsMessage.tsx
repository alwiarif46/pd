import type { ReactNode } from 'react';
import { CircleSlash } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { outOfCreditsCopy } from './format';

interface OutOfCreditsMessageProps {
  creditsResetOn: string;
  onUpgrade: () => void;
  secondaryAction?: ReactNode;
}

export function OutOfCreditsMessage({ creditsResetOn, onUpgrade, secondaryAction }: OutOfCreditsMessageProps) {
  return (
    <section
      aria-labelledby="out-of-credits-title"
      className="flex flex-col items-start gap-4 rounded-md border border-line bg-paper p-6"
    >
      <div className="flex items-start gap-3">
        <CircleSlash className="mt-0.5 size-5 shrink-0 text-due" aria-hidden="true" />
        <div className="flex flex-col gap-1">
          <h2 id="out-of-credits-title" className="text-base font-semibold text-ink">
            {outOfCreditsCopy.title}
          </h2>
          <p className="text-pretty text-sm leading-relaxed text-muted-foreground">
            {outOfCreditsCopy.body(creditsResetOn)}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-8">
        <Button type="button" onClick={onUpgrade}>
          Upgrade plan
        </Button>
        {secondaryAction}
      </div>
    </section>
  );
}
