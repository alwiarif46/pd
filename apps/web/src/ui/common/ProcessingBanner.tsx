import { Check, Circle, Loader2, X } from 'lucide-react';
import { Progress } from '@/components/ui/progress';
import type { ProcessingBannerProps } from './types';
export function ProcessingBanner({ processing }: ProcessingBannerProps) {
  const eta =
    processing.etaSeconds === null
      ? null
      : processing.etaSeconds < 60
        ? 'Less than a minute'
        : `Usually about ${Math.ceil(processing.etaSeconds / 60)} minutes`;
  return (
    <section aria-live="polite" className="space-y-3 rounded-lg border border-line bg-paper p-4">
      <h3 className="font-semibold">Processing</h3>
      {processing.steps.map((s) => (
        <div key={s.id} className="grid grid-cols-[auto_1fr_auto] items-center gap-2 text-sm">
          {s.status === 'running' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : s.status === 'done' ? (
            <Check className="h-4 w-4 text-today" />
          ) : s.status === 'failed' ? (
            <X className="h-4 w-4 text-due" />
          ) : (
            <Circle className="h-4 w-4 text-muted-foreground" />
          )}
          <span>
            {s.status}: {s.label}
          </span>
          <span className="font-numeric">{s.percent}%</span>
          <Progress className="col-span-3" value={s.percent} />
        </div>
      ))}
      {processing.queuePosition !== null && (
        <p className="text-sm text-muted-foreground">Queue position {processing.queuePosition}</p>
      )}
      {eta && <p className="text-sm text-muted-foreground">{eta}</p>}
    </section>
  );
}
