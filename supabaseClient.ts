import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/config/env";

/**
 * Service-role Supabase client. This process is the only writer for
 * indexer-owned tables (see celoht-supabase/docs/OWNERSHIP.md). It must
 * never write to backend-owned tables (profiles, agent_kyc, courses,
 * course_progress, certificates, reforestation_projects,
 * reforestation_evidence, audit_logs) — every write in src/db/persist.ts
 * is scoped to the indexer-owned set only.
 */
let client: SupabaseClient | null = null;

export function getServiceRoleClient(): SupabaseClient {
  if (client) return client;
  const env = getEnv();
  client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}
