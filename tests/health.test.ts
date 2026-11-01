import { once } from "node:events";
import type { Server } from "node:http";
import type { PublicClient } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadDeploymentMetadata, CELO_SEPOLIA_CHAIN_ID } from "@/config/network";

const state = vi.hoisted(() => ({
  chainId: 11142220,
  headBlock: 100n,
  databaseError: null as unknown,
  checkpoints: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/config/env", () => ({ getEnv: () => ({ CONFIRMATIONS: 5 }) }));

vi.mock("@/db/supabaseClient", () => ({
  getServiceRoleClient: () => ({
    from: () => ({
      select: () => ({
        eq: async () => ({ data: state.checkpoints, error: state.databaseError }),
      }),
    }),
  }),
}));

vi.mock("@/util/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { startHealthServer } from "@/health/server";

function checkpoint(lastProcessedBlock: string, syncStatus = "idle"): Record<string, unknown> {
  return {
    contract_name: "CeloHTAgentRegistry",
    last_processed_block: lastProcessedBlock,
    latest_confirmed_block: "95",
    sync_status: syncStatus,
    last_error: null,
    last_successful_sync_at: "2026-01-01T00:00:00.000Z",
  };
}

async function openHealthServer(): Promise<{ server: Server; url: string }> {
  const client = {
    getChainId: async () => state.chainId,
    getBlockNumber: async () => state.headBlock,
  } as unknown as PublicClient;
  const server = startHealthServer({
    client,
    meta: loadDeploymentMetadata("celoSepolia"),
    port: 0,
    expectedCheckpointCount: 1,
  });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Health server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function closeHealthServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("health and readiness endpoints", () => {
  beforeEach(() => {
    state.chainId = CELO_SEPOLIA_CHAIN_ID;
    state.headBlock = 100n;
    state.databaseError = null;
    state.checkpoints = [checkpoint("90")];
  });

  it("keeps liveness healthy during initial sync and readiness false until caught up", async () => {
    const { server, url } = await openHealthServer();
    try {
      const health = await fetch(`${url}/health`);
      const healthBody = await health.json();
      const readiness = await fetch(`${url}/readyz`);
      const readinessBody = await readiness.json();

      expect(health.status).toBe(200);
      expect(healthBody).toMatchObject({ chainId: CELO_SEPOLIA_CHAIN_ID, ready: false });
      expect(readiness.status).toBe(503);
      expect(readinessBody).toMatchObject({ chainId: CELO_SEPOLIA_CHAIN_ID, ready: false });
    } finally {
      await closeHealthServer(server);
    }
  });

  it("returns ready after the confirmed checkpoint reaches the target block", async () => {
    state.checkpoints = [checkpoint("95")];
    const { server, url } = await openHealthServer();
    try {
      const readiness = await fetch(`${url}/readyz`);
      expect(readiness.status).toBe(200);
      expect(await readiness.json()).toMatchObject({ chainId: CELO_SEPOLIA_CHAIN_ID, ready: true });
    } finally {
      await closeHealthServer(server);
    }
  });

  it("reports wrong-chain and Supabase errors as unavailable", async () => {
    state.chainId = 42220;
    let active = await openHealthServer();
    try {
      const response = await fetch(`${active.url}/health`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "down", reason: "chain_id_mismatch" });
    } finally {
      await closeHealthServer(active.server);
    }

    state.chainId = CELO_SEPOLIA_CHAIN_ID;
    state.databaseError = { code: "ECONNREFUSED", message: "database unavailable" };
    active = await openHealthServer();
    try {
      const response = await fetch(`${active.url}/readyz`);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "down", reason: "database_unreachable" });
    } finally {
      await closeHealthServer(active.server);
    }
  });
});