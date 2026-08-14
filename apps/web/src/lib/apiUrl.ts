const PRODUCTION_API_ORIGIN = 'https://wassup-meeting.web.app';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

function configuredApiOrigin(): string | null {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const raw = env?.VITE_API_BASE_URL?.trim();
  if (!raw) return null;
  if (raw === 'same-origin') return '';
  return raw.replace(/\/+$/, '');
}

function shouldUseProductionApi(): boolean {
  if (typeof window === 'undefined') return false;
  const { hostname, protocol } = window.location;
  return LOCAL_HOSTS.has(hostname) || protocol === 'capacitor:' || protocol === 'ionic:' || protocol === 'file:';
}

export function apiUrl(path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const configured = configuredApiOrigin();

  if (configured !== null) {
    return configured ? new URL(normalizedPath, `${configured}/`).toString() : normalizedPath;
  }

  if (shouldUseProductionApi()) {
    return `${PRODUCTION_API_ORIGIN}${normalizedPath}`;
  }

  return normalizedPath;
}
