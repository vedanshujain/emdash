/**
 * Unit coverage for the storage ACCESS surface added by the batch primitive:
 * - `ctx.storage.batch` is present AND every declared collection accessor still
 *   works (backwards compatibility of the `StorageAccess` intersection type).
 * - a collection literally named `batch` is rejected at declaration time
 *   (it would be shadowed by the `ctx.storage.batch()` method).
 * - a compile-time call-site typecheck of the intersection type (no `as`).
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { it, expect, describe } from "vitest";

import type { Database as DB } from "../../../src/database/types.js";
import { createStorageAccess } from "../../../src/plugins/context.js";
import {
	assertCollectionNameAllowed,
	createStorageIndexes,
} from "../../../src/plugins/storage-indexes.js";
import type { BatchResult, StorageAccess, StorageCollection } from "../../../src/plugins/types.js";

function makeDb(): Kysely<DB> {
	const sqlite = new Database(":memory:");
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- test-only in-memory db typed as the app schema
	return new Kysely<DB>({ dialect: new SqliteDialect({ database: sqlite }) });
}

describe("ctx.storage access object (batch + per-collection)", () => {
	it("exposes batch AND every declared collection accessor (backwards compat)", () => {
		const db = makeDb();
		const storage = createStorageAccess(db, "shop", {
			inventory: { indexes: ["sku"] },
			reservations: { indexes: [], uniqueIndexes: ["idempotency_key"] },
		});

		// batch present and callable.
		expect(typeof storage.batch).toBe("function");
		// per-collection accessors still present with the full StorageCollection API.
		for (const name of ["inventory", "reservations"]) {
			const coll = storage[name];
			expect(coll).toBeDefined();
			expect(typeof coll?.get).toBe("function");
			expect(typeof coll?.updateIf).toBe("function");
			expect(typeof coll?.insert).toBe("function");
		}
	});

	it("call-site typecheck: batch() returns Promise<BatchResult>, collections stay StorageCollection (no `as`)", () => {
		const db = makeDb();
		const storage: StorageAccess = createStorageAccess(db, "shop", {
			inventory: { indexes: ["sku"] },
		});
		// These are compile-time assertions (the values are never awaited here).
		const batchCall: Promise<BatchResult> = storage.batch([]).catch(
			(): BatchResult => ({
				applied: false,
				failedIndex: 0,
				reason: "guard_failed",
			}),
		);
		const coll: StorageCollection = storage.inventory!;
		expect(batchCall).toBeInstanceOf(Promise);
		expect(coll).toBeDefined();
	});
});

describe("reserved collection name", () => {
	it("assertCollectionNameAllowed rejects the reserved name `batch`", () => {
		expect(() => assertCollectionNameAllowed("batch")).toThrow(/reserved/i);
		// A normal name is fine.
		expect(() => assertCollectionNameAllowed("inventory")).not.toThrow();
	});

	it("createStorageIndexes rejects a collection named `batch` at declaration time", async () => {
		const db = makeDb();
		// _plugin_storage / _plugin_indexes need not exist — validation happens first.
		await expect(createStorageIndexes(db, "shop", "batch", ["x"])).rejects.toThrow(/reserved/i);
	});
});
