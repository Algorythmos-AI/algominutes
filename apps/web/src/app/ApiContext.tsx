import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { createApiClient, type ApiClient } from '../lib/api/client';
import type { ApiOrigins } from '../lib/api/config';
import { useAuth } from './auth/AuthContext';

interface ApiValue {
  api: ApiClient;
  /** Set once any answer is a 426: this page is older than the server allows. */
  updateRequired: boolean;
}

const ApiContext = createContext<ApiValue | null>(null);

export function ApiProvider({ origins, children, fetchImpl }: { origins: ApiOrigins; children: ReactNode; fetchImpl?: typeof fetch }) {
  const { idToken } = useAuth();
  const [updateRequired, setUpdateRequired] = useState(false);
  const api = useMemo(
    () => createApiClient({ origins, getIdToken: idToken, onUpdateRequired: () => setUpdateRequired(true), fetch: fetchImpl }),
    [origins, idToken, fetchImpl],
  );
  const value = useMemo(() => ({ api, updateRequired }), [api, updateRequired]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiValue {
  const v = useContext(ApiContext);
  if (!v) throw new Error('useApi outside ApiProvider');
  return v;
}
