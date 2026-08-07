/**
 * Migration 003: Seed memberships for existing users.
 * Run once to migrate existing users into the memberships table.
 *
 * Usage:
 *   node server/migrations/003_seed_memberships.js
 *
 * Requires GCP credentials in environment (GOOGLE_APPLICATION_CREDENTIALS or ADC).
 */

import { BigQuery } from '@google-cloud/bigquery';
import { randomUUID } from 'crypto';

const PROJECT_ID = process.env.GCP_PROJECT_ID || 'your-project-id';
const ORG_ID     = process.env.SEED_ORG_ID    || 'your-default-org-id';
const ORG_SLUG   = process.env.SEED_ORG_SLUG  || 'patman';

const bq = new BigQuery({ projectId: PROJECT_ID });

async function seedMemberships() {
  console.log(`Seeding memberships for org: ${ORG_SLUG} (${ORG_ID})`);

  // Fetch all active users
  const [users] = await bq.query({
    query: `SELECT user_id, username, display_name FROM \`${PROJECT_ID}.patman_inventory.users\` WHERE is_active = TRUE`,
  });
  console.log(`Found ${users.length} active users`);

  // Check if org exists
  const [orgs] = await bq.query({
    query: `SELECT organization_id FROM \`${PROJECT_ID}.patman_inventory.organizations\` WHERE organization_id = @orgId LIMIT 1`,
    params: { orgId: ORG_ID },
  });
  if (!orgs.length) {
    console.error(`Organization ${ORG_ID} not found. Create it first.`);
    process.exit(1);
  }

  // Insert memberships for each user not yet in memberships table
  const [existing] = await bq.query({
    query: `SELECT user_id FROM \`${PROJECT_ID}.patman_inventory.memberships\` WHERE organization_id = @orgId`,
    params: { orgId: ORG_ID },
  });
  const existingIds = new Set(existing.map(r => r.user_id));

  const toInsert = users.filter(u => !existingIds.has(u.user_id));
  console.log(`Inserting ${toInsert.length} memberships`);

  if (!toInsert.length) {
    console.log('All users already have memberships. Done.');
    return;
  }

  const table = bq.dataset('patman_inventory').table('memberships');
  const rows  = toInsert.map(u => ({
    membership_id:   randomUUID(),
    user_id:         u.user_id,
    organization_id: ORG_ID,
    role:            'admin',
    is_active:       true,
    created_at:      new Date().toISOString(),
  }));

  await table.insert(rows);
  console.log(`Done. Inserted ${rows.length} memberships.`);
  rows.forEach(r => console.log(`  ${r.user_id} → ${r.membership_id} (admin)`));
}

seedMemberships().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
