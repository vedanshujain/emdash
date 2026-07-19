/**
 * Real-D1 tests for `applyPluginStorageBatchD1` — the raw `env.DB.batch()`
 * atomic-batch path used by the Cloudflare `PluginBridge` in production.
 *
 * Runs inside a real workerd isolate with a real miniflare-backed D1 binding
 * (via `@cloudflare/vitest-pool-workers`), against the ACTUAL `_plugin_storage`
 * schema (see ./migrations). Proves the interleaved zero-rows-assertion
 * mechanism genuinely rolls back on D1 (where a bare 0-row UPDATE would NOT),
 * that `changes()` carries across batch statements, that RETURNING surfaces per
 * op, and that the failure-path diagnosis reports the right failedIndex/reason.
 */

import { applyD1Migrations, env } from "cloudflare:test";
import { applyPluginStorageBatchD1, type BatchOp, type D1BatchBinding } from "emdash";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;
const DB = () => testEnv.DB;
// The production executor takes the raw binding; D1Database is structurally a
// D1BatchBinding (prepare/bind/first/batch).
const runBatch = (ops: BatchOp[]) =>
	applyPluginStorageBatchD1(DB() as unknown as D1BatchBinding, "shop", ops);

beforeAll(async () => {
	await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
});

async function put(collection: string, id: string, data: unknown): Promise<void> {
	const now = new Date().toISOString();
	await DB()
		.prepare(
			"INSERT OR REPLACE INTO _plugin_storage (plugin_id, collection, id, data, created_at, updated_at) VALUES ('shop', ?, ?, ?, ?, ?)",
		)
		.bind(collection, id, JSON.stringify(data), now, now)
		.run();
}

async function read(collection: string, id: string): Promise<Record<string, unknown> | null> {
	const row = await DB()
		.prepare("SELECT data FROM _plugin_storage WHERE plugin_id='shop' AND collection=? AND id=?")
		.bind(collection, id)
		.first<{ data: string }>();
	return row ? JSON.parse(row.data) : null;
}

beforeEach(async () => {
	// Clear all rows between tests (keep the schema + unique index + tracking row).
	await DB().prepare("DELETE FROM _plugin_storage WHERE plugin_id='shop'").run();
});

describe("applyPluginStorageBatchD1 — real D1", () => {
	it("guard-fail rolls back BOTH coupled writes on real D1 (the atomicity proof)", async () => {
		await put("inventory", "widget", { on_hand: 1 });
		await put("reservations", "r1", { state: "pending", sku: "widget", qty: 2 });

		const result = await runBatch([
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
			{
				op: "updateIf",
				collection: "reservations",
				id: "r1",
				where: { state: "pending" },
				set: { state: "held" },
			},
		]);

		expect(result).toEqual({ applied: false, failedIndex: 0, reason: "guard_failed" });
		// Neither moved — the flip did not happen because the decrement rolled back.
		expect((await read("inventory", "widget"))?.on_hand).toBe(1);
		expect((await read("reservations", "r1"))?.state).toBe("pending");
	});

	it("changes() carries across statements within one env.DB.batch (load-bearing assumption)", async () => {
		await put("inventory", "a", { on_hand: 10 });
		await put("inventory", "b", { on_hand: 10 });

		const rows = await DB().batch<{ c: number }>([
			DB().prepare(
				"UPDATE _plugin_storage SET data=json_set(data,'$.on_hand',json_extract(data,'$.on_hand')-1) WHERE plugin_id='shop' AND collection='inventory' AND id='a' AND json_extract(data,'$.on_hand')>=1",
			),
			DB().prepare("SELECT changes() AS c"),
			DB().prepare(
				"UPDATE _plugin_storage SET data=json_set(data,'$.on_hand',json_extract(data,'$.on_hand')-1) WHERE plugin_id='shop' AND collection='inventory' AND id='b' AND json_extract(data,'$.on_hand')>=999",
			),
			DB().prepare("SELECT changes() AS c"),
		]);

		expect(rows[1]?.results?.[0]?.c).toBe(1);
		expect(rows[3]?.results?.[0]?.c).toBe(0);
	});

	it("happy path commits and returns RETURNING data per updateIf op", async () => {
		await put("inventory", "widget", { on_hand: 5 });
		await put("reservations", "r1", { state: "pending", sku: "widget", qty: 2 });

		const result = await runBatch([
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
			{
				op: "updateIf",
				collection: "reservations",
				id: "r1",
				where: { state: "pending" },
				set: { state: "held" },
			},
		]);

		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("expected applied");
		expect(result.results[0]).toEqual({
			op: "updateIf",
			applied: true,
			data: { on_hand: 3 },
		});
		expect((result.results[1] as { data: { state: string } }).data.state).toBe("held");
		expect((await read("inventory", "widget"))?.on_hand).toBe(3);
		expect((await read("reservations", "r1"))?.state).toBe("held");
	});

	it("full reserve: claim insert ∧ decrement commit atomically on D1", async () => {
		await put("inventory", "widget", { on_hand: 5 });

		const result = await runBatch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-1",
				data: { state: "held", sku: "widget", qty: 2, idempotency_key: "key-1" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
		]);

		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("expected applied");
		expect(result.results[0]).toEqual({ op: "insert", inserted: true });
		expect((await read("inventory", "widget"))?.on_hand).toBe(3);
		expect((await read("reservations", "res-1"))?.state).toBe("held");
	});

	it("diagnosis reports the correct failedIndex/reason when the SECOND op fails", async () => {
		await put("inventory", "widget", { on_hand: 5 });
		await put("reservations", "r1", { state: "held", sku: "widget", qty: 2 });

		const result = await runBatch([
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
			{
				op: "updateIf",
				collection: "reservations",
				id: "r1",
				where: { state: "pending" },
				set: { state: "released" },
			},
		]);

		expect(result).toEqual({ applied: false, failedIndex: 1, reason: "guard_failed" });
		// op0's decrement rolled back too.
		expect((await read("inventory", "widget"))?.on_hand).toBe(5);
	});

	it("duplicate claim (same id) → failedIndex 0 reason exists, decrement rolled back", async () => {
		await put("inventory", "widget", { on_hand: 5 });
		await put("reservations", "res-1", {
			state: "held",
			sku: "widget",
			qty: 2,
			idempotency_key: "k",
		});

		const result = await runBatch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-1",
				data: { state: "held", sku: "widget", qty: 2, idempotency_key: "k2" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
		]);

		expect(result).toEqual({ applied: false, failedIndex: 0, reason: "exists" });
		expect((await read("inventory", "widget"))?.on_hand).toBe(5);
	});

	it("unique_violation on idempotency_key (different id, same key) → failedIndex 0 + conflictField", async () => {
		await put("inventory", "widget", { on_hand: 5 });
		await put("reservations", "res-1", {
			state: "held",
			sku: "widget",
			qty: 2,
			idempotency_key: "dup",
		});

		const result = await runBatch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-2",
				data: { state: "held", sku: "widget", qty: 2, idempotency_key: "dup" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
		]);

		expect(result).toEqual({
			applied: false,
			failedIndex: 0,
			reason: "unique_violation",
			conflictField: "idempotency_key",
		});
		expect((await read("inventory", "widget"))?.on_hand).toBe(5);
		expect(await read("reservations", "res-2")).toBeNull();
	});

	it("ifNotExists insert treats an existing row as a satisfied no-op and commits siblings", async () => {
		await put("inventory", "widget", { on_hand: 5 });
		await put("reservations", "res-1", {
			state: "held",
			sku: "widget",
			qty: 2,
			idempotency_key: "k",
		});

		const result = await runBatch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-1",
				ifNotExists: true,
				data: { state: "held", sku: "widget", qty: 2, idempotency_key: "k" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 2 } },
				delta: { on_hand: { dec: 2 } },
			},
		]);

		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("expected applied");
		expect(result.results[0]).toEqual({ op: "insert", inserted: false, reason: "exists" });
		// The decrement DID apply.
		expect((await read("inventory", "widget"))?.on_hand).toBe(3);
	});

	it("concurrent coupled reserve batches never throw and report well-formed results (diagnosis is graceful)", async () => {
		await put("inventory", "widget", { on_hand: 3 });

		const N = 8;
		const results = await Promise.all(
			Array.from({ length: N }, (_v, i) =>
				runBatch([
					{
						op: "insert",
						collection: "reservations",
						id: `res-${i}`,
						data: { state: "held", sku: "widget", qty: 1, idempotency_key: `key-${i}` },
					},
					{
						op: "updateIf",
						collection: "inventory",
						id: "widget",
						where: { on_hand: { gte: 1 } },
						delta: { on_hand: { dec: 1 } },
					},
				]),
			),
		);

		// Every call resolved (no throw); every result is a well-formed BatchResult.
		for (const r of results) {
			expect(typeof r.applied).toBe("boolean");
			if (!r.applied) {
				expect(typeof r.failedIndex).toBe("number");
				expect(["guard_failed", "exists", "unique_violation"]).toContain(r.reason);
			}
		}
		// D1 serializes writes, so no oversell: on_hand never goes below 0.
		const onHand = (await read("inventory", "widget"))?.on_hand as number;
		expect(onHand).toBeGreaterThanOrEqual(0);
		expect(onHand).toBeLessThanOrEqual(3);
	});
});
