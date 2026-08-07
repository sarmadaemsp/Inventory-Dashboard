import fp from 'fastify-plugin';
import { BigQuery } from '@google-cloud/bigquery';
import { env } from '../config/env.js';

// BigQuery client plugin.
//
// Previously this file contained a Proxy that caught "Unrecognized name:
// is_ignored / mapped_inventory_sku" errors from pre-Phase-D schemas and
// rewrote the SQL on the fly. Phase D dropped is_ignored entirely, and
// the canonical DDL guarantees mapped_inventory_sku is always present,
// so that fallback is no longer needed and the proxy has been removed.

async function bigqueryPlugin(fastify) {
  const bq = new BigQuery({ projectId: env.GCP_PROJECT_ID });
  fastify.decorate('bq', bq);
  fastify.log.info({ projectId: env.GCP_PROJECT_ID }, 'BigQuery client ready');
}

export default fp(bigqueryPlugin, { name: 'bigquery' });
