import { createRemoteStore } from './redis.mjs';
import { canonical, fail } from './canonical.mjs';

// Inject a server-only PostgreSQL query client for Supabase's database.
// Keep this SECURITY DEFINER function in an UNEXPOSED schema; no PostgREST RPC.
// The database login must have only the reviewed function execution permissions.
const QUERY = 'select valhalla_task_pending.task_tx($1::text,$2::text,$3::jsonb) as result';
export function createSupabaseStore({ query, ...options }) {
  if (typeof query !== 'function') fail('storage_config', 503);
  return createRemoteStore({ ...options, async transact(scope, command) {
    const result = await query(QUERY, [scope.tenantId, scope.subject, canonical(command)]);
    if (!result || !Array.isArray(result.rows) || result.rows.length !== 1) fail('storage_unavailable', 503);
    return result.rows[0].result;
  } });
}
