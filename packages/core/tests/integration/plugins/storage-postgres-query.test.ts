/**
 * Plugin storage query/count/index correctness across dialects.
 *
 * `_plugin_storage.data` is a plain `text` column. On Postgres the JSON
 * operator `->>` needs an explicit `::jsonb` cast (`text ->> 'x'` is a parse
 * error), and the extracted value is `text` — so a numeric range guard would
 * compare lexically (`'9' >= '10'` is TRUE) and over-count / oversell.
 *
 * These assertions run on SQLite (always) and Postgres (when EMDASH_TEST_PG is
 * set). The numeric-range case is the load-bearing one: it fails on Postgres
 * before the jsonb + numeric-cast fix and passes after, while SQLite — whose
 * `json_extract` already returns a typed numeric — stays green throughout.
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
	tier: number;
	name: string;
}

describeEachDialect("Plugin storage query correctness", (dialect) => {
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
		return new PluginStorageRepository<Product>(db, "shop", "products", [
			"sku",
			"stock",
			"tier",
			"name",
		]);
	}

	async function seedProducts(): Promise<PluginStorageRepository<Product>> {
		const repo = productsRepo();
		await repo.putMany([
			{ id: "p9", data: { sku: "A9", stock: 9, tier: 1, name: "Alpha" } },
			{ id: "p10", data: { sku: "B10", stock: 10, tier: 2, name: "Bravo" } },
			{ id: "p100", data: { sku: "C100", stock: 100, tier: 3, name: "Charlie" } },
		]);
		return repo;
	}

	it("equality guard on a string field returns the right rows", async () => {
		const repo = await seedProducts();
		const result = await repo.query({ where: { sku: "B10" } });
		expect(result.items.map((i) => i.id)).toEqual(["p10"]);
	});

	it("numeric RangeFilter compares numerically across the lexical boundary", async () => {
		// '9' >= '10' is TRUE lexically but false numerically. A correct
		// implementation returns exactly {10, 100}, never 9.
		const repo = await seedProducts();
		const result = await repo.query({ where: { stock: { gte: 10 } }, orderBy: { stock: "asc" } });
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p10", "p100"]);
	});

	it("numeric RangeFilter with an upper bound stays numeric", async () => {
		const repo = await seedProducts();
		// lexically '100' < '9' and '100' < '10'; numerically 100 is largest.
		const result = await repo.query({ where: { stock: { lt: 100 } } });
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p10", "p9"]);
	});

	it("in filter with numeric values compares numerically", async () => {
		const repo = await seedProducts();
		const result = await repo.query({ where: { stock: { in: [9, 100] } } });
		expect(result.items.map((i) => i.id).toSorted()).toEqual(["p100", "p9"]);
	});

	it("startsWith on a string field matches by prefix", async () => {
		const repo = await seedProducts();
		const result = await repo.query({ where: { sku: { startsWith: "C" } } });
		expect(result.items.map((i) => i.id)).toEqual(["p100"]);
	});

	it("count with a numeric range guard is numerically correct", async () => {
		const repo = await seedProducts();
		// Lexical comparison would count 9 as >= 10 and return 3.
		expect(await repo.count({ stock: { gte: 10 } })).toBe(2);
	});

	it("count with an in filter of numeric values is correct", async () => {
		const repo = await seedProducts();
		expect(await repo.count({ stock: { in: [10, 100] } })).toBe(2);
	});

	it("creates a UNIQUE index on a declared field and enforces uniqueness", async () => {
		// Proves the index-expression path parses on Postgres (the `->>` on a
		// text column would otherwise raise "operator does not exist").
		const result = await createStorageIndexes(db, "shop", "products", [], {
			uniqueIndexes: ["sku"],
		});
		expect(result.errors).toEqual([]);
		expect(result.created).toContain("uidx_plugin_shop_products_sku");

		const repo = productsRepo();
		await repo.put("first", { sku: "DUP", stock: 1, tier: 1, name: "First" });
		await expect(
			repo.put("second", { sku: "DUP", stock: 2, tier: 1, name: "Second" }),
		).rejects.toThrow();
	});

	it("creates a non-unique expression index that queries parse against", async () => {
		const result = await createStorageIndexes(db, "shop", "products", ["stock"]);
		expect(result.errors).toEqual([]);
		expect(result.created).toContain("idx_plugin_shop_products_stock");

		const repo = await seedProducts();
		// Query should run against the indexed expression without a parse error.
		expect(await repo.count({ stock: { gte: 10 } })).toBe(2);
	});

	it("orderBy on an indexed field parses and returns all rows", async () => {
		const repo = await seedProducts();
		const result = await repo.query({ orderBy: { name: "asc" } });
		expect(result.items.map((i) => i.data.name)).toEqual(["Alpha", "Bravo", "Charlie"]);
	});

	it("stores the data column as plain text (not json/jsonb)", async () => {
		// Guards the premise of the bug: data is text, so PG needs the ::jsonb cast.
		await seedProducts();
		const row = await db
			.selectFrom("_plugin_storage")
			.select("data")
			.where("id", "=", "p9")
			.executeTakeFirstOrThrow();
		expect(typeof row.data).toBe("string");
		expect(JSON.parse(row.data)).toMatchObject({ stock: 9 });
	});
});
