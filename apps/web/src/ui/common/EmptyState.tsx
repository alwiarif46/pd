import { Button } from '@/components/ui/button';
import type { EmptyStateProps } from './types';
export function EmptyState({ title, text, action }: EmptyStateProps) {
  return (
    <div className="rounded-lg border border-dashed border-line bg-paper p-8 text-center">
      <h3 className="font-semibold text-ink">{title}</h3>
      <p className="mt-2 text-sm text-muted-foreground">{text}</p>
      {action && (
        <Button className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
