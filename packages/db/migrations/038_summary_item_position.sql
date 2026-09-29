-- RELEASE.md PR 30b (audit Q22): action items and key decisions in the order the summary gave them. Every
-- writer inserts a summary's items in one transaction, so they share created_at, and ordering by the
-- random UUID id shuffled them. Each item now stores its index; readers order by it, then as before for
-- rows written before it (NULL). Expand-only: two nullable columns.
ALTER TABLE action_items ADD COLUMN IF NOT EXISTS position INTEGER;
ALTER TABLE key_decisions ADD COLUMN IF NOT EXISTS position INTEGER;
