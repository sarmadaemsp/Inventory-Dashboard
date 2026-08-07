-- ============================================================
-- refresh_tokens — server-side refresh-token revocation
-- ============================================================
-- Closes audit gap C2 (refresh-token revocation was a stub before
-- this migration). Adds the canonical table that records every
-- refresh token the platform has issued, so the /auth/refresh and
-- /auth/logout endpoints can REJECT revoked / expired tokens
-- regardless of whether they're still cryptographically valid.
--
-- Columns:
--   jti           — the refresh token's JTI claim. PRIMARY semantic key.
--   user_id       — owner of the token. Indexed implicitly via jti lookup;
--                   also used by revokeAllByUserId for password-change
--                   and "logout from all devices" flows.
--   family_id     — rotation chain identifier. All refresh tokens
--                   minted from the same login (and subsequent rotations)
--                   share one family_id. Forward-compatible with
--                   stolen-token replay detection (future work).
--   issued_at     — when this row was inserted (rotation moment).
--   expires_at    — when the JWT itself expires. We re-check this on
--                   refresh because tokens can be revoked BEFORE
--                   expiry, and we don't want to issue a new pair if
--                   the old one was already expired.
--   revoked_at    — NULL = active. Non-NULL = revoked at that time.
--   last_used_at  — set on each successful /auth/refresh use. Useful
--                   for "active sessions" UI in a future enhancement.
--   remembered    — TRUE if the user checked "Remember this device" at
--                   login. Drives the longer JWT_REFRESH_EXPIRES_REMEMBERED
--                   TTL and lets future UI distinguish "trusted device"
--                   sessions.
--   user_agent    — captured at issuance for the future Active Sessions
--                   page. Truncated to 256 chars at the application layer.
--   ip            — captured at issuance, same purpose.
--
-- Clustering: by user_id so revokeAllByUserId scans only that user's
-- rows. Most reads are jti-based (single-row lookup) — no clustering
-- needed for those; the table is small enough that a full scan stays
-- under 1 MB until many thousands of active sessions exist.
-- ============================================================

-- NOTE on column-constraint ordering: BigQuery's grammar is
--   `data_type [DEFAULT expr] [NOT NULL] [OPTIONS(...)]`
-- so DEFAULT must appear BEFORE NOT NULL. Reversing the order is a
-- syntax error ("Expected ')' or ',' but got keyword DEFAULT").
CREATE TABLE IF NOT EXISTS `patman-inventory.patman_inventory.refresh_tokens` (
  jti          STRING    NOT NULL,
  user_id      STRING    NOT NULL,
  family_id    STRING    NOT NULL,
  issued_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP() NOT NULL,
  expires_at   TIMESTAMP NOT NULL,
  revoked_at   TIMESTAMP,
  last_used_at TIMESTAMP,
  remembered   BOOL      DEFAULT FALSE NOT NULL,
  user_agent   STRING,
  ip           STRING
)
CLUSTER BY user_id;

-- Uniqueness contract enforced by application code: jti is unique.
