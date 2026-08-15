// Admin gate for the operator-only surfaces (A7.4 dead-letter view).
//
// Mounted AFTER authMiddleware, so req.uid is the verified Firebase uid. There
// is no server-side admin check in this service yet — the only existing one
// (apps/web/src/lib/admin.ts) is a client-side email allowlist for the web app —
// so this gates on an ADMIN_UIDS env allowlist (comma-separated Firebase uids).
//
// TODO: formalise admin auth — promote to a Postgres workspace_members.role
// check ('owner' | 'admin'); the role column already exists (001_init.sql).

function adminUids() {
  return String(process.env.ADMIN_UIDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function adminMiddleware(req, res, next) {
  const allow = adminUids();
  if (!req.uid || !allow.includes(req.uid)) {
    if (req.log && typeof req.log.warn === 'function') {
      req.log.warn({ uid: req.uid || null }, 'admin_access_denied');
    }
    return res.status(403).json({ error: 'Forbidden' });
  }
  return next();
}
