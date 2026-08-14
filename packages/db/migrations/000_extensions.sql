-- 000_extensions.sql
-- Run this BEFORE 001_init.sql. Cloud SQL allows installing pgvector,
-- pg_trgm, and uuid-ossp; they need to be enabled by a privileged role
-- (the postgres superuser via gcloud sql import sql).
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
