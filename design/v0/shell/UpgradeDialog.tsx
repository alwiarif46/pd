import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { UpgradeDialogProps } from './types';

function localDate(value: string) {
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(year, month - 1, day));
}

export function UpgradeDialog(p: UpgradeDialogProps) {
  const reason = p.reason === 'locked_tab' ? 'This tab is on a paid plan.' : p.reason === 'out_of_credits' ? `You have ${p.creditsLeft} RFP credits left. ${p.creditsResetOn ? `They reset on ${localDate(p.creditsResetOn)}.` : 'They reset at the start of the next period.'}` : p.reason === 'over_cap' ? 'This bid is at its file cap.' : p.reason === 'seats' ? "Your plan's seats are full." : 'Compare plans.';
  return <Dialog open={p.open} onOpenChange={(open) => !open && p.onClose()}><DialogContent><DialogHeader><DialogTitle>{reason}</DialogTitle></DialogHeader><p className="text-sm">Free: 1 RFP per period (2 in the first month), 50 MB per bid, 2 users, Overview, Schedule and Compliance.</p><div className="grid gap-3 sm:grid-cols-2">{(['starter', 'growth'] as const).map((plan) => <div key={plan} className="rounded border border-line bg-paper p-4"><h3 className="font-semibold capitalize">{plan}</h3>{p.plan === plan && <Badge>Current plan</Badge>}<p className="mt-2 text-sm">{plan === 'starter' ? '10 RFPs per period' : '20 RFPs per period'} · 300 MB per bid · 5 users · files stay live for 90 days · All tabs</p>{p.plan !== plan && <Button className="mt-4" onClick={() => p.onChoosePlan(plan)}>Choose {plan[0].toUpperCase() + plan.slice(1)}</Button>}</div>)}</div><p className="text-sm text-muted-foreground">The price is shown at checkout.</p><Button variant="outline" onClick={p.onClose}>Close</Button></DialogContent></Dialog>;
}
