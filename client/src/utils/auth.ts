/**
 * Session token storage. The token is an opaque bearer token issued by
 * /api/auth/login; the server keeps only its hash. localStorage survives
 * reloads and PWA restarts, which matters on a shop counter.
 */
const TOKEN_KEY = 'nexus_pos_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private mode or blocked storage: the session simply lasts until reload.
  }
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe to "the server no longer accepts our token" so the app can show the sign-in screen. */
export function onUnauthorized(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function notifyUnauthorized(): void {
  setToken(null);
  listeners.forEach((fn) => fn());
}
