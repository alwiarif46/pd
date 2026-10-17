import { useId, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { AlertCircle, FileSpreadsheet, FileText, Upload, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BYTES_PER_MB, creditsLine, cx, formatFileSize, formatMb } from './format';
import { OutOfCreditsMessage } from './OutOfCreditsMessage';
import type { BidType, NewBidProps } from './types';

const ACCEPT_ATTR =
  '.pdf,.docx,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ACCEPTED_EXTENSION = /\.(pdf|docx|xlsx)$/i;

const BID_TYPE_LABEL: Record<BidType, string> = {
  federal: 'Federal',
  sled: 'SLED',
};

interface AddResult {
  files: File[];
  wrongType: string[];
  overCap: File[];
  bytesLeft: number;
}

function totalBytes(files: File[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function isSameSelection(a: File, b: File): boolean {
  return a.name === b.name && a.size === b.size && a.lastModified === b.lastModified;
}

function addFiles(current: File[], incoming: File[], capBytes: number): AddResult {
  const files = [...current];
  let total = totalBytes(files);
  const wrongType: string[] = [];
  const overCap: File[] = [];

  for (const file of incoming) {
    if (!ACCEPTED_EXTENSION.test(file.name)) {
      wrongType.push(file.name);
      continue;
    }
    if (files.some((existing) => isSameSelection(existing, file))) continue;
    if (total + file.size > capBytes) {
      overCap.push(file);
      continue;
    }
    files.push(file);
    total += file.size;
  }

  return { files, wrongType, overCap, bytesLeft: capBytes - total };
}

export function NewBid(props: NewBidProps) {
  return <NewBidForm {...props} />;
}

/**
 * Same screen as NewBid, with an optional starting file list so Preview.tsx can show
 * filled and over-cap states. Containers should render NewBid.
 */
export function NewBidForm({
  creditsLeft,
  creditsResetOn,
  plan,
  mbCap,
  onCreate,
  onCancel,
  onUpgrade,
  initialFiles,
}: NewBidProps & { initialFiles?: File[] }) {
  const capBytes = mbCap * BYTES_PER_MB;
  const [initial] = useState(() => addFiles([], initialFiles ?? [], capBytes));
  const [name, setName] = useState('');
  const [bidType, setBidType] = useState<BidType | ''>('');
  const [files, setFiles] = useState<File[]>(initial.files);
  const [lastAdd, setLastAdd] = useState<AddResult | null>(
    initial.wrongType.length || initial.overCap.length ? initial : null,
  );
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const ids = {
    name: useId(),
    type: useId(),
    typeHelp: useId(),
    drop: useId(),
    hint: useId(),
  };

  if (creditsLeft <= 0) {
    return (
      <main className="flex w-full max-w-2xl flex-col gap-6 font-sans text-ink">
        <NewBidHeader creditsLeft={creditsLeft} creditsResetOn={creditsResetOn} />
        <OutOfCreditsMessage
          creditsResetOn={creditsResetOn}
          onUpgrade={onUpgrade}
          secondaryAction={
            <Button type="button" variant="outline" onClick={onCancel}>
              Back to bids
            </Button>
          }
        />
      </main>
    );
  }

  const usedBytes = totalBytes(files);
  const usedRatio = capBytes > 0 ? Math.min(1, usedBytes / capBytes) : 0;
  const trimmedName = name.trim();
  const missing = [
    !trimmedName && 'a bid name',
    !bidType && 'a bid type',
    files.length === 0 && 'at least one file',
  ].filter((item): item is string => Boolean(item));
  const canSubmit = missing.length === 0;

  function handleIncoming(incoming: File[]) {
    if (incoming.length === 0) return;
    const result = addFiles(files, incoming, capBytes);
    setFiles(result.files);
    setLastAdd(result.wrongType.length || result.overCap.length ? result : null);
  }

  function handleRemove(target: File) {
    setFiles((current) => current.filter((file) => file !== target));
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    handleIncoming(Array.from(event.dataTransfer.files));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !bidType) return;
    onCreate(trimmedName, bidType, files);
  }

  return (
    <main className="flex w-full max-w-2xl flex-col gap-6 font-sans text-ink">
      <NewBidHeader creditsLeft={creditsLeft} creditsResetOn={creditsResetOn} />

      <form onSubmit={handleSubmit} noValidate className="flex flex-col rounded-md border border-line bg-paper">
        <fieldset className="flex flex-col gap-5 p-6">
          <legend className="sr-only">Bid details</legend>
          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.name} className="text-ink">
              Bid name <span className="font-normal text-muted-foreground">(required)</span>
            </Label>
            <Input
              id={ids.name}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              aria-required="true"
              autoComplete="off"
              className="border-line bg-paper text-ink"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor={ids.type} className="text-ink">
              Bid type <span className="font-normal text-muted-foreground">(required)</span>
            </Label>
            <Select value={bidType} onValueChange={(value) => setBidType(value as BidType)}>
              <SelectTrigger
                id={ids.type}
                aria-describedby={ids.typeHelp}
                aria-required="true"
                className="w-full border-line bg-paper text-ink sm:w-64"
              >
                <SelectValue placeholder="Choose a bid type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="federal">{BID_TYPE_LABEL.federal}</SelectItem>
                <SelectItem value="sled">{BID_TYPE_LABEL.sled}</SelectItem>
              </SelectContent>
            </Select>
            <p id={ids.typeHelp} className="text-sm text-muted-foreground">
              Bid facts can correct this later
            </p>
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-4 border-t border-line p-6">
          <legend className="sr-only">Solicitation set</legend>
          <h2 className="text-base font-semibold text-ink" aria-hidden="true">
            Solicitation set
          </h2>

          <CreditRule />

          <CapMeter usedBytes={usedBytes} mbCap={mbCap} ratio={usedRatio} />

          <div
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
            }}
            onDrop={handleDrop}
            className={cx(
              'flex flex-col items-center gap-3 rounded-md border-2 border-dashed px-6 py-8 text-center transition-colors',
              dragging ? 'border-primary bg-weekend' : 'border-line bg-canvas',
            )}
          >
            <Upload className="size-6 text-primary" aria-hidden="true" />
            <p id={ids.drop} className="text-pretty text-sm leading-relaxed text-ink">
              Drag the solicitation, amendments, and attachments here.
              <span className="block text-muted-foreground">PDF, DOCX, or XLSX</span>
            </p>
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              aria-describedby={ids.drop}
              className="border-line bg-paper"
            >
              Choose files
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept={ACCEPT_ATTR}
              hidden
              onChange={(event) => {
                handleIncoming(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
          </div>

          {lastAdd && (
            <UploadNotices
              result={lastAdd}
              mbCap={mbCap}
              showUpgrade={plan === 'free' && lastAdd.overCap.length > 0}
              onUpgrade={onUpgrade}
              onDismiss={() => setLastAdd(null)}
            />
          )}

          {files.length > 0 && <FileList files={files} onRemove={handleRemove} />}
        </fieldset>

        <div className="flex flex-col gap-3 border-t border-line p-6 sm:flex-row sm:items-center sm:justify-between">
          <p id={ids.hint} className="text-sm text-muted-foreground" aria-live="polite">
            {canSubmit ? 'Ready to create the bid and upload its files.' : `Still needed: ${missing.join(', ')}.`}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button type="button" variant="outline" onClick={onCancel} className="border-line">
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} aria-describedby={ids.hint}>
              Create bid and upload
            </Button>
          </div>
        </div>
      </form>
    </main>
  );
}

function NewBidHeader({ creditsLeft, creditsResetOn }: { creditsLeft: number; creditsResetOn: string }) {
  return (
    <header className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold text-ink">New bid</h1>
      <p className={cx('text-sm', creditsLeft <= 0 ? 'font-medium text-due' : 'text-muted-foreground')}>
        <span className="font-numeric tabular-nums">{creditsLine(creditsLeft, creditsResetOn)}</span>
      </p>
    </header>
  );
}

function CreditRule() {
  return (
    <div className="rounded-md border border-line bg-weekend p-4">
      <p className="text-pretty text-sm leading-relaxed text-ink">
        <span className="font-semibold">How credits work: </span>
        Uploading the solicitation reserves 1 RFP credit, which is used only when the compliance matrix succeeds and
        released if processing fails. The same file again costs nothing, and amendments and attachments are free.
      </p>
    </div>
  );
}

function CapMeter({ usedBytes, mbCap, ratio }: { usedBytes: number; mbCap: number; ratio: number }) {
  const nearFull = ratio >= 0.9;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-ink">
        Files on this bid:{' '}
        <span className="font-numeric font-semibold tabular-nums">
          {formatMb(usedBytes)} MB of {mbCap} MB
        </span>
      </p>
      <div
        role="meter"
        aria-label="Files on this bid"
        aria-valuemin={0}
        aria-valuemax={mbCap}
        aria-valuenow={Number(formatMb(usedBytes))}
        aria-valuetext={`${formatMb(usedBytes)} MB of ${mbCap} MB`}
        className="h-2 w-full overflow-hidden rounded-full bg-weekend"
      >
        <div
          className={cx('h-full rounded-full transition-[width]', nearFull ? 'bg-warning' : 'bg-primary')}
          style={{ width: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

function UploadNotices({
  result,
  mbCap,
  showUpgrade,
  onUpgrade,
  onDismiss,
}: {
  result: AddResult;
  mbCap: number;
  showUpgrade: boolean;
  onUpgrade: () => void;
  onDismiss: () => void;
}) {
  return (
    <div role="alert" className="flex flex-col gap-3 rounded-md border border-due bg-paper p-4">
      <div className="flex items-start gap-3">
        <AlertCircle className="mt-0.5 size-5 shrink-0 text-due" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 text-sm leading-relaxed text-ink">
          {result.overCap.length > 0 && (
            <div className="flex flex-col gap-1">
              <p>
                {result.overCap.length === 1 ? 'This file is' : 'These files are'} larger than what is left of this
                bid&apos;s {mbCap} MB cap.{' '}
                <span className="font-numeric font-semibold tabular-nums">{formatMb(result.bytesLeft)} MB left.</span>
              </p>
              <ul className="flex flex-col gap-0.5">
                {result.overCap.map((file) => (
                  <li key={`${file.name}-${file.size}`} className="break-all text-muted-foreground">
                    Not added: {file.name}{' '}
                    <span className="font-numeric tabular-nums">({formatFileSize(file.size)})</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {result.wrongType.length > 0 && (
            <p className="break-words">
              Only PDF, DOCX, and XLSX files can be added. Not added: {result.wrongType.join(', ')}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onDismiss}
          className="size-8 shrink-0 text-muted-foreground"
        >
          <X className="size-4" aria-hidden="true" />
          <span className="sr-only">Dismiss message</span>
        </Button>
      </div>
      {showUpgrade && (
        <div className="flex flex-wrap items-center gap-3 pl-8">
          <Button type="button" onClick={onUpgrade}>
            Upgrade plan
          </Button>
          <span className="text-sm text-muted-foreground">Starter and Growth bids hold up to 300 MB.</span>
        </div>
      )}
    </div>
  );
}

function FileList({ files, onRemove }: { files: File[]; onRemove: (file: File) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-medium text-ink">
        Chosen files <span className="font-numeric tabular-nums text-muted-foreground">({files.length})</span>
      </h3>
      <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
        {files.map((file) => {
          const Icon = /\.xlsx$/i.test(file.name) ? FileSpreadsheet : FileText;
          return (
            <li key={`${file.name}-${file.size}-${file.lastModified}`} className="flex items-center gap-3 px-3 py-2">
              <Icon className="size-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate text-sm text-ink" title={file.name}>
                {file.name}
              </span>
              <span className="shrink-0 font-numeric text-sm tabular-nums text-muted-foreground">
                {formatFileSize(file.size)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={() => onRemove(file)}
                className="size-8 shrink-0 text-muted-foreground hover:text-due"
              >
                <X className="size-4" aria-hidden="true" />
                <span className="sr-only">Remove {file.name}</span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
