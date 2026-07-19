/**
 * NO OVERSELL under concurrency — for the COUPLED atomic batch.
 *
 * Seed stock M, fire N > M concurrent reserve batches (each: claim insert ∧
 * guarded decrement ∧ flip) and assert exactly M commit, final on_hand is 0,
 * exactly M reservations are `held`, and NO reservation is `held` without its
 * decrement (the invariant `held ⟺ a durable decrement`).
 *
 * As with the single-op no-oversell test:
 * - **better-sqlite3 [sqlite]** serializes writes in-process → proves the batch
 *   SQL / transaction is CORRECT, but not the race.
 * - **Postgres** is the true concurrent race: N connections contend on the same
 *   inventory row; the guarded decrement inside each transaction serializes so
 *   exactly M observe `on_hand >= 1`.
 */

import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import {
	PluginStorageRepository,
	applyPluginStorageBatch,
} from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import { createStorageIndexes } from "../../../src/plugins/storage-indexes.js";
import type { BatchOp } from "../../../src/plugins/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface Inventory {
	on_hand: number;
}
interface Reservation {
	state: string;
	sku: string;
	qty: number;
	idempotency_key: string;
}

const PLUGIN = "shop";

describeEachDialect("Plugin storage atomic batch — no oversell", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		await createStorageIndexes(db, PLUGIN, "reservations", ["state"], {
			uniqueIndexes: ["idempotency_key"],
		});
		// Raised hook timeout: the shared test-PG DB-create/migrate provisioning
		// reproducibly times out at the default 10s ~1-in-3 under back-to-back
		// runs (provisioning contention, NOT the feature — the batch tx completes
		// in ~1.4s and leaks no connections).
	}, 30000);

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it(
		dialect === "sqlite"
			? "exactly M of N coupled reserve batches commit (better-sqlite3 serializes in-process → proves SQL correctness, NOT the race)"
			: "exactly M of N coupled reserve batches commit under real concurrent connections (the true no-oversell race)",
		async () => {
			const inventory = new PluginStorageRepository<Inventory>(db, PLUGIN, "inventory", []);
			const reservations = new PluginStorageRepository<Reservation>(db, PLUGIN, "reservations", [
				"idempotency_key",
				"state",
			]);

			const M = 5;
			const N = 20;
			await inventory.insert("widget", { on_hand: M });

			const results = await Promise.all(
				Array.from({ length: N }, (_v, i) => {
					const ops: BatchOp[] = [
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
					];
					return applyPluginStorageBatch(db, PLUGIN, ops);
				}),
			);

			const applied = results.filter((r) => r.applied).length;
			const failed = results.filter((r) => !r.applied);

			expect(applied).toBe(M);
			expect(failed).toHaveLength(N - M);
			// Every failure is a guard_failed decrement (the claim rolled back too).
			for (const f of failed) {
				if (f.applied) continue;
				expect(f.reason).toBe("guard_failed");
			}

			// Stock fully drained, never negative.
			expect((await inventory.get("widget"))?.on_hand).toBe(0);

			// Exactly M reservations exist and are held (the invariant: no held
			// reservation without its decrement — a rolled-back batch leaves no row).
			const held = await reservations.count({ state: "held" } as never);
			expect(held).toBe(M);
			const total = await reservations.count();
			expect(total).toBe(M);
		},
	);
});
