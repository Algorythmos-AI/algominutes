import { useEffect, useId, useRef, type ReactNode } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A modal dialog: focus moves into it (to `initialFocus`, or its first control),
 * Tab stays inside, Escape closes it, and focus goes back to whatever opened it.
 */
export function Modal({ title, onClose, children, initialFocus }: { title: string; onClose: () => void; children: ReactNode; initialFocus?: string }) {
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  const close = useRef(onClose);
  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    const target = (initialFocus && el?.querySelector<HTMLElement>(initialFocus)) || el?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => opener?.focus?.();
    // Focus once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close.current();
      return;
    }
    if (e.key !== 'Tab' || !box.current) return;
    const items = [...box.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4" onKeyDown={onKeyDown}>
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={id} className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-border bg-card p-6">
        <h2 id={id} className="mb-4 text-xl font-bold text-heading">{title}</h2>
        {children}
      </div>
    </div>
  );
}
