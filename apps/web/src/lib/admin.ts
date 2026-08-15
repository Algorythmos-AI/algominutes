// Admin-only surfaces (Settings → Admin tools). Email allowlist for
// the alpha single-operator window. Promote to a Postgres
// workspace_members.role check ('owner' | 'admin') after the first
// multi-admin user lands; the role column already exists in
// db/migrations/001_init.sql:39.
import type { User } from 'firebase/auth';

export const ADMIN_EMAILS: ReadonlyArray<string> = ['skalaliya@gmail.com'];

export function isAdmin(user: { email?: string | null } | User | null | undefined): boolean {
  const email = (user && (user as { email?: string | null }).email) || '';
  return ADMIN_EMAILS.includes(email.toLowerCase());
}
