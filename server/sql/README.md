# Patman SQL — Canonical Schema & Migrations

This directory is the **single source of truth** for the Patman BigQuery schema.

```
server/sql/
├── README.md                    ← this file
├── schema/                      ← canonical DDLs (the system of record)
│   ├── 01_organizations.sql
│   ├── 02_users.sql
│   ├── 03_memberships.sql
│   ├── 04_inventory.sql
│   ├── 05_orders.sql
│   ├── 06_activity_log.sql
│   └── 07_uploads.sql
└── migrations/                  ← timestamped, run-once scripts
    ├── 20260513_001_pre_migration_validation.sql
    ├── 20260513_002_backup_users.sql
    ├── 20260513_003_users_canonical_migration.sql
    ├── 20260513_004_post_migration_validation.sql
    └── 20260513_999_rollback_users.sql
```

## Conventions

- **`schema/`** is what the production schema **should look like** after all migrations have been applied. It is the canonical contract that the runtime code is written against. When a new table is added or columns are changed, update the corresponding file here in the same PR as the migration.
- **`migrations/`** are timestamped, ordered, idempotent SQL scripts that move production from one schema version to the next. **Run each script exactly once in the order shown.** Filename format: `YYYYMMDD_NNN_short_description.sql`.

## Rules

1. **Never edit a migration after it has run in production.** Add a new migration instead.
2. **Every destructive migration MUST have a corresponding rollback** in the same batch (e.g., `_999_rollback_*.sql`).
3. **Every destructive migration MUST be preceded by a validation script** that returns 0 rows for every "expected zero" check before the destructive script is allowed to run.
4. **Backup the affected table** before destructive changes (see `002_backup_users.sql` as the pattern).
5. **Migrations are idempotent where possible** — use `IF EXISTS` / `IF NOT EXISTS` so re-running on an already-migrated DB is safe.
6. **Application code MUST be deployed BEFORE running a column-drop migration.** The deployed code must already not reference the column being dropped. Otherwise queries will fail in the gap between schema change and code deploy.

## Current open migration: 20260513 (Phase B — users canonical)

Drops legacy `users.organization_id` and `users.role` columns, makes `users.email` nullable, and adds `users.updated_at`. See [migrations/20260513_003_users_canonical_migration.sql](migrations/20260513_003_users_canonical_migration.sql) for details.

### Execution sequence

| Order | Script | What it does | Mutating? |
|-------|--------|--------------|-----------|
| 1 | `20260513_001_pre_migration_validation.sql` | Confirms every user has a membership; checks no orphans | No |
| 2 | `20260513_002_backup_users.sql` | Creates `users_backup_20260513` snapshot | Creates table |
| 3 | `20260513_003_users_canonical_migration.sql` | Adds `updated_at`, drops `organization_id` + `role`, makes `email` nullable | **Yes — destructive** |
| 4 | `20260513_004_post_migration_validation.sql` | Confirms final column set matches `schema/02_users.sql` | No |
| 999 | `20260513_999_rollback_users.sql` | Restores users from backup snapshot (emergency only) | Yes |

### Pre-flight checklist

Before running `003`:

- [ ] Application code that **does not write to `users.organization_id` or `users.role`** is already deployed to Cloud Run.
- [ ] `001` validation returned **0 rows** for Checks 1 and 4.
- [ ] `002` backup completed and row counts matched (live = backup).
- [ ] A 30-minute maintenance window is scheduled — `003` takes seconds but mid-flight failures during writes could cause partial state.

### After successful 003

- [ ] `004` post-validation matches the expected canonical column set.
- [ ] Smoke test: create a new user via the admin UI. Expected: succeeds with 201, no 500 error.
- [ ] Smoke test: edit an existing user's display name. Expected: succeeds with 200.
- [ ] Smoke test: change a user's password. Expected: succeeds.
- [ ] Keep `users_backup_20260513` for at least 7 days. Drop only after production has been validated stable.
