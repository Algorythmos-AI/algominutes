# Restore drill: staging's point-in-time recovery (RELEASE.md PR 16)

Staging holds testers' notes, so its backups must be proven to restore before any invite goes out (Wave 1, owner
step 4), and again before production. The drill restores staging's Postgres, as it was an hour ago, into a
throwaway instance. It checks the notes are there, and deletes the copy. Nothing touches the live instance.

It takes about 20 minutes, most of it waiting for the clone. The clone costs a few cents an hour while it exists.

## 1. Clone to a point in time

As `algorythmos.france@gmail.com`:

```bash
gcloud sql instances clone algominutes-staging-pg algominutes-staging-pg-drill \
  --point-in-time="$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ)" \
  --project algominutes-staging --account=algorythmos.france@gmail.com
```

(`date -v-1H` is macOS; on Linux use `date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ`.) The clone has the same
private IP network, users and passwords as the original. Wait for it:

```bash
gcloud sql instances describe algominutes-staging-pg-drill --project algominutes-staging \
  --account=algorythmos.france@gmail.com --format='value(state)'
```

until it says `RUNNABLE`.

## 2. Check what came back

Open **Cloud SQL → algominutes-staging-pg-drill → Cloud SQL Studio**. Sign in to database `algominutes` as the
`postgres` user (its password is in Secret Manager, `algominutes-staging-db-password`), and run:

```sql
SELECT (SELECT count(*) FROM notes WHERE deleted_at IS NULL)          AS notes,
       (SELECT count(*) FROM notes WHERE status = 'ready')            AS ready,
       (SELECT count(*) FROM transcript_lines)                        AS transcript_lines,
       (SELECT count(*) FROM embeddings)                              AS embeddings,
       (SELECT count(*) FROM users)                                   AS users,
       (SELECT max(created_at) FROM notes)                            AS newest_note,
       (SELECT max(filename) FROM schema_migrations)                  AS migration;
```

Run the same query on the live `algominutes-staging-pg`. The clone should match it as of an hour ago:
- the same migration;
- `newest_note` about an hour old, or older if nothing was recorded since;
- counts equal, or lower by what was made in the last hour.

A clone with no notes, or one that won't start, is a failed drill. Stop, and don't invite testers until it's
understood.

## 3. Delete the clone

A clone copies deletion protection, so switch it off first:

```bash
gcloud sql instances patch algominutes-staging-pg-drill --no-deletion-protection \
  --project algominutes-staging --account=algorythmos.france@gmail.com
gcloud sql instances delete algominutes-staging-pg-drill --quiet \
  --project algominutes-staging --account=algorythmos.france@gmail.com
```

Check it's gone with `gcloud sql instances list --project algominutes-staging`.

## 4. Record it

Add a line under Wave 1 in `docs/BLOCKERS.md`: the date, the point in time restored to, the query's numbers
from both instances, and how long the clone took. The production drill (Prod-ready, after Apply P) is the same,
with `algominutes-prod-pg`.

## What this doesn't cover

- **Firestore** is the clients' cache. Postgres is the source of truth (CLAUDE.md), and the mirror can be
  rebuilt from it. Firestore's own delete protection is still off on staging (BLOCKERS, Apply A); a later
  infra PR turns it on.
- **Recordings in Cloud Storage** aren't versioned. A deleted note's audio is gone by design (the retention and
  deletion promises), and staging's bucket has no lifecycle rule for live objects.
