/**
 * Reviewer-facing regression evidence for the Postgres plugin-storage fix
 * (fork PR #1, branch `fix/plugin-storage-postgres-jsonb`).
 *
 * WHAT THIS DEMONSTRATES
 * ----------------------
 * `_plugin_storage.data` is a plain `text` column, and plugin storage had only
 * ever been exercised on SQLite. On Postgres the query/count/index/order paths
 * built the JSON accessor as an uncast `data ->> 'field'`, which is broken four
 * distinct ways. Each `it` below pins one of them:
 *
 *   (a) numeric RangeFilter across a multi-digit boundary — the load-bearing
 *       case. `->>` yields `text`, so `'9' >= '10'` is TRUE lexically and the
 *       row with stock 9 leaks into a `{ stock: { gte: 10 } }` result. That is
 *       an over-count / oversell.
 *   (b) count() with the same numeric guard — same lexical bug, surfaced
 *       through the aggregate path.
 *   (c) index creation + enforcement via createStorageIndexes on Postgres —
 *       building an expression index over `data ->> 'sku'` raises
 *       "operator does not exist: text ->> unknown" because `data` is text.
 *   (d) numeric orderBy — lexical sort returns [10, 100, 9] instead of
 *       [9, 10, 100].
 *
 * These run on SQLite (always) and Postgres (when EMDASH_TEST_PG is set).
 * SQLite's json_extract already returns a typed value, so the suite stays green
 * on SQLite on both main and the PR. The Postgres dialect is RED on upstream
 * main (c786fd42) and GREEN on PR #1, which casts to `(data::jsonb)->>'field'`
 * and applies a type-guarded `::numeric` for numeric comparisons/order.
 */

import type { Kysely } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { PluginStorageRepository } from "../../../src/database/repositories/plugin-storage.js";
import type { Database } from "../../../src/database/types.js";
import { createStorageIndexes } from "../../../src/plugins/storage-indexes.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

interface Product {
	sku: string;
	stock: number;
}

describeEachDialect("Plugin storage Postgres regression (PR #1)", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function productsRepo(): PluginStorageRepository<Product> {
		// `stock` is declared indexed so it may be used in orderBy.
		return new PluginStorageRepository<Product>(db, "shop", "products", ["sku", "stock"]);
	}

	/** Stock values chosen so lexical and numeric ordering disagree: '9' > '10'. */
	async function seedProducts(): Promise<PluginStorageRepository<Product>> {
		const repo = productsRepo();
		await repo.putMany([
			{ id: "p9", data: { sku: "A9", stock: 9 } },
			{ id: "p10", data: { sku: "B10", stock: 10 } },
			{ id: "p100", data: { sku: "C100", stock: 100 } },
		]);
		return repo;
	}

	// (a) The key numeric-vs-lexical case.
	it("numeric RangeFilter { gte: 10 } returns exactly {10, 100}, never 9", async () => {
		const repo = await seedProducts();
		const result = await repo.query({ where: { stock: { gte: 10 } } });
		// Lexically '9' >= '10' is TRUE, which would leak p9 in (oversell).
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p10", "p100"]);
		expect(result.items.map((i) => i.data.stock).toSorted((a, b) => a - b)).toEqual([10, 100]);
	});

	// (b) count() with a numeric range guard.
	it("count({ stock: { gte: 10 } }) is numerically correct (2, not 3)", async () => {
		const repo = await seedProducts();
		// Lexical comparison would count 9 as >= 10 and return 3.
		expect(await repo.count({ stock: { gte: 10 } })).toBe(2);
	});

	// (c) unique index creation + enforcement on Postgres.
	it("creates and enforces a UNIQUE expression index (no `text ->>` parse error)", async () => {
		// On main-PG this raises "operator does not exist: text ->> unknown"
		// while building the index expression, so `errors` is non-empty.
		const result = await createStorageIndexes(db, "shop", "products", [], {
			uniqueIndexes: ["sku"],
		});
		expect(result.errors).toEqual([]);
		expect(result.created).toContain("uidx_plugin_shop_products_sku");

		const repo = productsRepo();
		await repo.put("first", { sku: "DUP", stock: 1 });
		await expect(repo.put("second", { sku: "DUP", stock: 2 })).rejects.toThrow();
	});

	// (d) numeric orderBy.
	it("orderBy { stock: 'asc' } sorts numerically [9, 10, 100], not lexically [10, 100, 9]", async () => {
		const repo = await seedProducts();
		const asc = await repo.query({ orderBy: { stock: "asc" } });
		expect(asc.items.map((i) => i.data.stock)).toEqual([9, 10, 100]);
		expect(asc.items.map((i) => i.id)).toEqual(["p9", "p10", "p100"]);

		const desc = await repo.query({ orderBy: { stock: "desc" } });
		expect(desc.items.map((i) => i.data.stock)).toEqual([100, 10, 9]);
	});
});
