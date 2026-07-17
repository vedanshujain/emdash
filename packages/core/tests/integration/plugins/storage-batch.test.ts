/**
 * Atomic multi-document batch primitive — `applyPluginStorageBatch`
 * (the executor behind `ctx.storage.batch`).
 *
 * Runs on SQLite (always) and Postgres (when EMDASH_TEST_PG is set). The batch
 * couples N conditional writes (`insert` / `updateIf`) across multiple documents
 * and collections all-or-nothing: it commits iff EVERY op's guard passes, and
 * any guard failure rolls back the WHOLE batch and reports which op failed.
 * Guard/uniqueness OUTCOMES are reported (never thrown); malformed ops THROW.
 */

import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach, describe } from "vitest";

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
	idempotency_key?: string;
}

const PLUGIN = "shop";

describeEachDialect("Plugin storage atomic batch", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
		// Declared unique index on reservations.idempotency_key (the DB-enforced
		// idempotency claim, mirroring the SQL adapter's ON CONFLICT).
		await createStorageIndexes(db, PLUGIN, "reservations", [], {
			uniqueIndexes: ["idempotency_key"],
		});
		// Raised hook timeout: the shared test-PG DB-create/migrate provisioning
		// can contend under back-to-back runs and blow the default 10s. The batch
		// tx itself completes in ~1.4s — this only absorbs setup contention.
	}, 30000);

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	const inventory = () => new PluginStorageRepository<Inventory>(db, PLUGIN, "inventory", []);
	const reservations = () =>
		new PluginStorageRepository<Reservation>(db, PLUGIN, "reservations", ["idempotency_key"]);
	const batch = (ops: BatchOp[]) => applyPluginStorageBatch(db, PLUGIN, ops);

	// 1 — both-commit atomicity proof
	it("commits a coupled decrement ∧ flip when both guards pass", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		await reservations().insert("r1", { state: "pending", sku: "widget", qty: 2 });

		const result = await batch([
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

		expect(result).toEqual({
			applied: true,
			results: [
				{ op: "updateIf", applied: true, data: { on_hand: 3 } },
				{ op: "updateIf", applied: true, data: { state: "held", sku: "widget", qty: 2 } },
			],
		});
		expect((await inventory().get("widget"))?.on_hand).toBe(3);
		expect((await reservations().get("r1"))?.state).toBe("held");
	});

	// 2 — THE atomicity proof: guard-fail rolls BOTH back
	it("rolls BOTH ops back when the decrement guard fails — neither applies", async () => {
		await inventory().insert("widget", { on_hand: 1 });
		await reservations().insert("r1", { state: "pending", sku: "widget", qty: 2 });

		const result = await batch([
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
		expect((await inventory().get("widget"))?.on_hand).toBe(1);
		expect((await reservations().get("r1"))?.state).toBe("pending");
	});

	// 3 — second-op guard-fail rolls back the first
	it("rolls back op 0 when the SECOND op's guard fails (failedIndex 1)", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		await reservations().insert("r1", { state: "held", sku: "widget", qty: 2 });

		const result = await batch([
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
				where: { state: "pending" }, // already held → guard fails
				set: { state: "held" },
			},
		]);

		expect(result).toEqual({ applied: false, failedIndex: 1, reason: "guard_failed" });
		expect((await inventory().get("widget"))?.on_hand).toBe(5);
	});

	// 4 — full reserve: claim ∧ decrement ∧ flip
	it("commits a claim insert ∧ decrement ∧ flip together (the reserve happy path)", async () => {
		await inventory().insert("widget", { on_hand: 5 });

		const result = await batch([
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
		expect((await inventory().get("widget"))?.on_hand).toBe(3);
		expect((await reservations().get("res-1"))?.state).toBe("held");
	});

	// 5 — idempotent replay: duplicate claim (same id) → failedIndex 0 exists, no double-decrement
	it("fails a duplicate claim insert at failedIndex 0 reason exists — no double-decrement", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		const reserve: BatchOp[] = [
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
		];

		expect((await batch(reserve)).applied).toBe(true);
		expect((await inventory().get("widget"))?.on_hand).toBe(3);

		// Replay with the SAME reservation id → exists, decrement rolled back.
		const replay = await batch(reserve);
		expect(replay).toEqual({ applied: false, failedIndex: 0, reason: "exists" });
		expect((await inventory().get("widget"))?.on_hand).toBe(3); // NOT 1
	});

	// 6 — unique_violation on a non-id unique field → failedIndex + conflictField
	it("fails a claim with a duplicate idempotency_key (different id) → unique_violation + conflictField", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		await reservations().insert("res-1", {
			state: "held",
			sku: "widget",
			qty: 2,
			idempotency_key: "dup",
		});

		const result = await batch([
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
		expect((await inventory().get("widget"))?.on_hand).toBe(5);
		expect(await reservations().get("res-2")).toBeNull();
	});

	// 7 — ifNotExists insert treats an existing row as a satisfied no-op
	it("ifNotExists insert on an existing row is a satisfied no-op — the batch still commits siblings", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		await reservations().insert("res-1", {
			state: "held",
			sku: "widget",
			qty: 2,
			idempotency_key: "k",
		});

		const result = await batch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-1",
				ifNotExists: true,
				data: { state: "held", sku: "widget", qty: 99, idempotency_key: "k" },
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
		expect(result.results[1]).toEqual({ op: "updateIf", applied: true, data: { on_hand: 3 } });
		// The pre-existing row was NOT overwritten (qty stays 2, not 99).
		expect((await reservations().get("res-1"))?.qty).toBe(2);
		expect((await inventory().get("widget"))?.on_hand).toBe(3);
	});

	// 8 — cross-collection + cross-op-type
	it("applies a cross-collection, cross-op-type batch (insert + updateIf), order-preserved", async () => {
		await inventory().insert("widget", { on_hand: 4 });

		const result = await batch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-1",
				data: { state: "held", sku: "widget", qty: 1, idempotency_key: "a" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 1 } },
				delta: { on_hand: { dec: 1 } },
			},
		]);

		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("expected applied");
		expect(result.results[0]).toEqual({ op: "insert", inserted: true });
		expect(result.results[1]).toEqual({ op: "updateIf", applied: true, data: { on_hand: 3 } });
	});

	// 9 — empty in:[] guard → guard_failed rolls back siblings
	it("fails the batch when an updateIf op has an empty in:[] guard (rolls back siblings)", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		await reservations().insert("r1", { state: "pending", sku: "widget", qty: 2 });

		const result = await batch([
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 1 } },
				delta: { on_hand: { dec: 1 } },
			},
			{
				op: "updateIf",
				collection: "reservations",
				id: "r1",
				where: { state: { in: [] } }, // matches nothing
				set: { state: "held" },
			},
		]);

		expect(result).toEqual({ applied: false, failedIndex: 1, reason: "guard_failed" });
		expect((await inventory().get("widget"))?.on_hand).toBe(5);
	});

	// 10 — release: flip ∧ restore commit together / non-held rolls back the restore
	it("release commits flip held→released ∧ stock restore together", async () => {
		await inventory().insert("widget", { on_hand: 3 });
		await reservations().insert("r1", { state: "held", sku: "widget", qty: 2 });

		const result = await batch([
			{
				op: "updateIf",
				collection: "reservations",
				id: "r1",
				where: { state: { in: ["held", "adopted"] } },
				set: { state: "released" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: {},
				delta: { on_hand: { inc: 2 } },
			},
		]);

		expect(result.applied).toBe(true);
		expect((await reservations().get("r1"))?.state).toBe("released");
		expect((await inventory().get("widget"))?.on_hand).toBe(5);
	});

	it("release on a non-held reservation rolls back the stock restore (failedIndex 0)", async () => {
		await inventory().insert("widget", { on_hand: 3 });
		await reservations().insert("r1", { state: "released", sku: "widget", qty: 2 });

		const result = await batch([
			{
				op: "updateIf",
				collection: "reservations",
				id: "r1",
				where: { state: { in: ["held", "adopted"] } },
				set: { state: "released" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: {},
				delta: { on_hand: { inc: 2 } },
			},
		]);

		expect(result).toEqual({ applied: false, failedIndex: 0, reason: "guard_failed" });
		expect((await inventory().get("widget"))?.on_hand).toBe(3); // no double-restore
	});

	// 11 — malformed ops THROW (and land no partial write)
	describe("malformed ops throw (programmer error), not reported failures", () => {
		it("empty ops array throws", async () => {
			await expect(batch([])).rejects.toThrow(/non-empty/i);
		});

		it("unknown op throws", async () => {
			await expect(
				batch([{ op: "frobnicate", collection: "inventory", id: "widget" } as unknown as BatchOp]),
			).rejects.toThrow(/unknown op/i);
		});

		it("float delta throws and lands NO partial write", async () => {
			await inventory().insert("widget", { on_hand: 5 });
			await expect(
				batch([
					{
						op: "updateIf",
						collection: "inventory",
						id: "widget",
						where: { on_hand: { gte: 1 } },
						delta: { on_hand: { dec: 1 } },
					},
					{
						op: "updateIf",
						collection: "inventory",
						id: "widget",
						where: {},
						delta: { on_hand: { dec: 1.5 } },
					},
				]),
			).rejects.toThrow(TypeError);
			// The valid op 0 never executed (validation precedes the transaction).
			expect((await inventory().get("widget"))?.on_hand).toBe(5);
		});

		it("field in both set and delta throws", async () => {
			await expect(
				batch([
					{
						op: "updateIf",
						collection: "inventory",
						id: "widget",
						where: {},
						set: { on_hand: 1 },
						delta: { on_hand: { dec: 1 } },
					},
				]),
			).rejects.toThrow(/both/i);
		});

		it("updateIf with neither set nor delta throws", async () => {
			await expect(
				batch([{ op: "updateIf", collection: "inventory", id: "widget", where: {} }]),
			).rejects.toThrow(/set.*delta/i);
		});

		it("insert without `data` throws up front and lands NO partial write", async () => {
			await inventory().insert("widget", { on_hand: 5 });
			await expect(
				batch([
					{
						op: "updateIf",
						collection: "inventory",
						id: "widget",
						where: { on_hand: { gte: 1 } },
						delta: { on_hand: { dec: 1 } },
					},
					{ op: "insert", collection: "reservations", id: "x", data: undefined },
				]),
			).rejects.toThrow(/insert.*requires.*data/i);
			expect((await inventory().get("widget"))?.on_hand).toBe(5);
		});

		it("a batch exceeding the max op count throws", async () => {
			const ops: BatchOp[] = Array.from({ length: 51 }, (_v, i) => ({
				op: "insert" as const,
				collection: "reservations",
				id: `r-${i}`,
				data: { state: "held", sku: "widget", qty: 1, idempotency_key: `k-${i}` },
			}));
			await expect(batch(ops)).rejects.toThrow(/maximum of 50 ops/i);
		});
	});

	// 12 — a non-abort executor error is re-thrown (only BatchAbort → {applied:false})
	it("re-throws a raw (non-guard, non-unique) executor error instead of swallowing it", async () => {
		await inventory().insert("widget", { on_hand: 5 });
		// A BigInt in `data` throws in JSON.stringify inside the batch executor —
		// not a BatchAbort and not a unique violation, so it must propagate (never
		// become {applied:false}). The valid op 0 rolls back with it.
		await expect(
			batch([
				{
					op: "updateIf",
					collection: "inventory",
					id: "widget",
					where: { on_hand: { gte: 1 } },
					delta: { on_hand: { dec: 1 } },
				},
				{
					op: "insert",
					collection: "reservations",
					id: "bad",
					data: { idempotency_key: "x", nope: 10n as unknown as number },
				},
			]),
		).rejects.toThrow();
		expect((await inventory().get("widget"))?.on_hand).toBe(5);
	});

	// 13 — results[] order matches ops[] order
	it("results[] order matches ops[] order for a 3-op batch", async () => {
		await inventory().insert("widget", { on_hand: 5 });

		const result = await batch([
			{
				op: "insert",
				collection: "reservations",
				id: "res-1",
				data: { state: "held", sku: "widget", qty: 1, idempotency_key: "a" },
			},
			{
				op: "updateIf",
				collection: "inventory",
				id: "widget",
				where: { on_hand: { gte: 1 } },
				delta: { on_hand: { dec: 1 } },
			},
			{
				op: "insert",
				collection: "reservations",
				id: "res-2",
				ifNotExists: true,
				data: { state: "held", sku: "widget", qty: 1, idempotency_key: "b" },
			},
		]);

		expect(result.applied).toBe(true);
		if (!result.applied) throw new Error("expected applied");
		expect(result.results.map((r) => r.op)).toEqual(["insert", "updateIf", "insert"]);
	});
});
