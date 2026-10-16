'use client';

import { useEffect, useState } from 'react';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2 } from 'lucide-react';
import type { ConfirmDialogProps } from './types';

export function ConfirmDialog(p: ConfirmDialogProps) {
  const [value, setValue] = useState('');

  useEffect(() => {
    if (p.open) setValue('');
  }, [p.open]);

  const valid = p.typeToConfirm === null || value === p.typeToConfirm;

  return (
    <AlertDialog open={p.open} onOpenChange={(open) => !open && p.onCancel()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{p.title}</AlertDialogTitle>
          <AlertDialogDescription>{p.body}</AlertDialogDescription>
        </AlertDialogHeader>
        {p.typeToConfirm && <div className="flex flex-col gap-2"><Label htmlFor="confirm-text">Type {p.typeToConfirm} to confirm</Label><Input id="confirm-text" value={value} onChange={(event) => setValue(event.target.value)} /></div>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={p.busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={!valid || p.busy} onClick={(event) => { event.preventDefault(); p.onConfirm(); }}>
            {p.busy && <Loader2 data-icon="inline-start" className="animate-spin" />}
            {p.busy ? 'Working…' : p.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
