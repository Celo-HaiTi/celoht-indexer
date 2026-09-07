# SECURITY.md

- No private key is ever held or used by this process — it only reads chain
  state and writes decoded, validated data to Postgres. It never signs or
  submits transactions.
- No seed phrase is ever requested or stored.
- `SUPABASE_SERVICE_ROLE_KEY` is read only via `src/config/env.ts` /
  `src/db/supabaseClient.ts`, sourced from environment variables, never
  hardcoded or logged.
- RPC credentials embedded in `CELO_RPC_URL` (if your provider uses a
  URL-embedded API key) are never logged; `logger.ts` only logs event
  metadata, not raw URLs or request bodies.
- Least privilege: the service role key used by this process needs INSERT/
  UPDATE only on the indexer-owned tables listed in `DATABASE.md`. If your
  Supabase project supports scoping a key further, do so rather than
  relying solely on this repository's application-level discipline.
- Every log is validated before decoding (contract address, tx hash format,
  block hash presence) and every decode is validated against the official
  ABI before being trusted (`src/indexing/eventDecoder.ts`) — malformed or
  unexpected data is dropped with an error log, never persisted.
