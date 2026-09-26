import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

interface NoticeValue {
  /** A short message in the page's live region, cleared after a few seconds. */
  show(message: string): void;
}

const NoticeContext = createContext<NoticeValue | null>(null);

export function NoticeProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const show = useCallback((m: string) => {
    setMessage(m);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), 6000);
  }, []);
  const value = useMemo(() => ({ show }), [show]);
  return (
    <NoticeContext.Provider value={value}>
      {children}
      <div aria-live="polite" role="status" className="pointer-events-none fixed inset-x-0 bottom-4 flex justify-center px-4">
        {message && <p className="pointer-events-auto rounded-xl border border-border bg-card px-4 py-3 text-heading shadow-card">{message}</p>}
      </div>
    </NoticeContext.Provider>
  );
}

export function useNotice(): NoticeValue {
  const v = useContext(NoticeContext);
  if (!v) throw new Error('useNotice outside NoticeProvider');
  return v;
}
