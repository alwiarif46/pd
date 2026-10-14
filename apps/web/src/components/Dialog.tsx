import { useEffect, useRef, type ReactNode } from 'react';

export function Dialog({
  title,
  children,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  onCancel: () => void;
}) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);
  return (
    <div className="dialog" role="dialog" aria-modal="true" aria-label={title}>
      <div className="card stack">
        <h2>{title}</h2>
        {children}
        <div className="row">
          <button ref={cancelRef} className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
