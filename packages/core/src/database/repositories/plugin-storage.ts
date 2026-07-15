/**
 * Plugin Storage Repository
 *
 * Provides a document store API for plugin data storage.
 * Uses a single _plugin_storage table with JSON documents and expression indexes.
 *
 * @see PLUGIN-SYSTEM.md § Plugin Storage > Full API Reference
 */

import type { Kysely, RawBuilder, SqlBool } from "kysely";
import { sql } from "kysely";

import {
	buildWhereClause,
	validateWhereClause,
	validateOrderByClause,
	getIndexedFields,
	jsonOrderExtract,
	isInFilter,
} from "../../plugins/storage-query.js";
import type {
	StorageCollection,
	QueryOptions,
	PaginatedResult,
	WhereClause,
	InsertResult,
	UpdateIfArgs,
	UpdateIfResult,
} from "../../plugins/types.js";
import { pluginDataWriteExpr } from "../dialect-helpers.js";
import { withTransaction } from "../transaction.js";
import type { Database } from "../types.js";
import { encodeCursor, decodeCursor } from "./types.js";

/**
 * Classify a thrown DB error as a UNIQUE-constraint violation, returning the
 * offending index name when the driver exposes it.
 *
 * - **Postgres** (`pg`): SQLSTATE `23505`; `error.constraint` carries the index
 *   name.
 * - **SQLite / D1** (better-sqlite3): `error.code === "SQLITE_CONSTRAINT_UNIQUE"`
 *   or a message `UNIQUE constraint failed: index 'uidx_…'`. Our unique indexes
 *   are partial EXPRESSION indexes, so the message names the index, not a column.
 *
 * Returns `null` for anything that is not a unique violation (the caller
 * re-throws those — raw DB errors are never swallowed).
 */
const UNIQUE_CONSTRAINT_MESSAGE_RE = /UNIQUE constraint failed/i;
const SQLITE_INDEX_NAME_RE = /index ['"]([^'"]+)['"]/;
const SAFE_FIELD_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;

function classifyUniqueViolation(error: unknown): { indexName?: string } | null {
	if (typeof error !== "object" || error === null) return null;
	const e = error as { code?: unknown; constraint?: unknown; message?: unknown };
	if (e.code === "23505") {
		return { indexName: typeof e.constraint === "string" ? e.constraint : undefined };
	}
	const message = typeof e.message === "string" ? e.message : "";
	if (e.code === "SQLITE_CONSTRAINT_UNIQUE" || UNIQUE_CONSTRAINT_MESSAGE_RE.test(message)) {
		const match = SQLITE_INDEX_NAME_RE.exec(message);
		return { indexName: match?.[1] };
	}
	return null;
}

/** True for any non-null object that may carry `inc`/`dec` delta keys. */
function isDeltaLike(value: unknown): value is { inc?: unknown; dec?: unknown } {
	return typeof value === "object" && value !== null;
}

/**
 * Turn a `buildWhereClause` result (`?`-placeholder SQL + ordered params) into a
 * single boolean expression suitable for Kysely's `.where()`.
 *
 * The `?` placeholders are spliced back into value fragments (`sql`${param}``,
 * which parameterizes safely) interleaved with the raw SQL between them. The
 * whole condition is returned as a boolean expression and passed directly to
 * `.where()` — it must NOT be wrapped in an `= 1` comparison. Postgres parses
 * `<cond> = 1` as a chained comparison (`a >= $1 = 1`), a syntax error, and even
 * parenthesized `(a >= $1) = 1` is `boolean = integer`, which Postgres rejects.
 * A bare boolean expression is valid on both SQLite and Postgres.
 */
function buildRawWhereExpression(whereResult: {
	sql: string;
	params: unknown[];
}): RawBuilder<SqlBool> {
	const parts: RawBuilder<unknown>[] = [];
	let paramIndex = 0;
	const sqlParts = whereResult.sql.split("?");
	for (let i = 0; i < sqlParts.length; i++) {
		if (i > 0) {
			parts.push(sql`${whereResult.params[paramIndex++]}`);
		}
		const chunk = sqlParts[i];
		if (chunk) {
			parts.push(sql.raw(chunk));
		}
	}
	return sql<SqlBool>`${sql.join(parts, sql.raw(""))}`;
}

/**
 * Plugin Storage Repository
 *
 * Implements the StorageCollection interface for a specific plugin and collection.
 */
export class PluginStorageRepository<T = unknown> implements StorageCollection<T> {
	private indexedFields: Set<string>;

	constructor(
		private db: Kysely<Database>,
		private pluginId: string,
		private collection: string,
		indexes: Array<string | string[]>,
	) {
		this.indexedFields = getIndexedFields(indexes);
	}

	/**
	 * Get a document by ID
	 */
	async get(id: string): Promise<T | null> {
		const row = await this.db
			.selectFrom("_plugin_storage")
			.select("data")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id)
			.executeTakeFirst();

		if (!row) return null;
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; generic callers provide T
		return JSON.parse(row.data) as T;
	}

	/**
	 * Store a document
	 */
	async put(id: string, data: T): Promise<void> {
		const now = new Date().toISOString();
		const jsonData = JSON.stringify(data);

		await this.db
			.insertInto("_plugin_storage")
			.values({
				plugin_id: this.pluginId,
				collection: this.collection,
				id,
				data: jsonData,
				created_at: now,
				updated_at: now,
			})
			.onConflict((oc) =>
				oc.columns(["plugin_id", "collection", "id"]).doUpdateSet({
					data: jsonData,
					updated_at: now,
				}),
			)
			.execute();
	}

	/**
	 * Delete a document
	 */
	async delete(id: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_plugin_storage")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id)
			.executeTakeFirst();

		return (result.numDeletedRows ?? 0) > 0;
	}

	/**
	 * Check if a document exists
	 */
	async exists(id: string): Promise<boolean> {
		const row = await this.db
			.selectFrom("_plugin_storage")
			.select("id")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id)
			.executeTakeFirst();

		return !!row;
	}

	/**
	 * Get multiple documents by ID
	 */
	async getMany(ids: string[]): Promise<Map<string, T>> {
		if (ids.length === 0) return new Map();

		const rows = await this.db
			.selectFrom("_plugin_storage")
			.select(["id", "data"])
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "in", ids)
			.execute();

		const result = new Map<string, T>();
		for (const row of rows) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; generic callers provide T
			result.set(row.id, JSON.parse(row.data) as T);
		}
		return result;
	}

	/**
	 * Store multiple documents
	 */
	async putMany(items: Array<{ id: string; data: T }>): Promise<void> {
		if (items.length === 0) return;

		const now = new Date().toISOString();

		// SQLite doesn't support batch upserts well, so we do them one at a time
		// In a transaction for atomicity
		await withTransaction(this.db, async (trx) => {
			for (const item of items) {
				const jsonData = JSON.stringify(item.data);
				await trx
					.insertInto("_plugin_storage")
					.values({
						plugin_id: this.pluginId,
						collection: this.collection,
						id: item.id,
						data: jsonData,
						created_at: now,
						updated_at: now,
					})
					.onConflict((oc) =>
						oc.columns(["plugin_id", "collection", "id"]).doUpdateSet({
							data: jsonData,
							updated_at: now,
						}),
					)
					.execute();
			}
		});
	}

	/**
	 * Delete multiple documents
	 */
	async deleteMany(ids: string[]): Promise<number> {
		if (ids.length === 0) return 0;

		const result = await this.db
			.deleteFrom("_plugin_storage")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "in", ids)
			.executeTakeFirst();

		return Number(result.numDeletedRows ?? 0);
	}

	/**
	 * Query documents with filters
	 */
	async query(options: QueryOptions = {}): Promise<PaginatedResult<{ id: string; data: T }>> {
		const { where = {}, orderBy = {}, cursor } = options;
		const limit = Math.min(options.limit ?? 50, 100);

		// Validate that all queried fields are indexed
		validateWhereClause(where, this.indexedFields, this.pluginId, this.collection);
		if (Object.keys(orderBy).length > 0) {
			validateOrderByClause(orderBy, this.indexedFields, this.pluginId, this.collection);
		}

		// Build base query
		let query = this.db
			.selectFrom("_plugin_storage")
			.select(["id", "data", "created_at"])
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection);

		// Add JSON extraction WHERE conditions
		const whereResult = buildWhereClause(this.db, where);
		if (whereResult.sql) {
			query = query.where(buildRawWhereExpression(whereResult));
		}

		// Handle cursor-based pagination — throws on invalid cursor.
		if (cursor) {
			const decoded = decodeCursor(cursor);
			query = query.where(({ eb }) =>
				eb(sql`(created_at, id)`, ">", sql`(${decoded.orderValue}, ${decoded.id})`),
			);
		}

		// Build ORDER BY using sql template
		if (Object.keys(orderBy).length > 0) {
			for (const [field, direction] of Object.entries(orderBy)) {
				// Order over the jsonb-native value on Postgres so numeric fields sort
				// numerically, not lexically. See pluginDataOrderExpr.
				const extract = jsonOrderExtract(this.db, field);
				const orderExpr =
					direction === "desc" ? sql`${sql.raw(extract)} desc` : sql`${sql.raw(extract)} asc`;
				query = query.orderBy(orderExpr);
			}
		} else {
			// Default ordering for consistent pagination
			query = query.orderBy("created_at", "asc").orderBy("id", "asc");
		}

		// Apply limit (fetch one extra to detect if there's more)
		query = query.limit(limit + 1);

		const rows = await query.execute();

		const hasMore = rows.length > limit;
		const items = rows.slice(0, limit).map((row) => ({
			id: row.id,
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns any; generic callers provide T
			data: JSON.parse(row.data) as T,
		}));

		// Generate cursor for next page if there are more results
		let nextCursor: string | undefined;
		if (hasMore) {
			const lastItem = rows[limit - 1];
			if (lastItem) {
				nextCursor = encodeCursor(lastItem.created_at, lastItem.id);
			}
		}

		return { items, cursor: nextCursor, hasMore };
	}

	/**
	 * Count documents matching a filter
	 */
	async count(where?: WhereClause): Promise<number> {
		if (where && Object.keys(where).length > 0) {
			validateWhereClause(where, this.indexedFields, this.pluginId, this.collection);
		}

		let query = this.db
			.selectFrom("_plugin_storage")
			.select(sql<number>`COUNT(*)`.as("count"))
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection);

		// Add JSON extraction WHERE conditions
		if (where && Object.keys(where).length > 0) {
			const whereResult = buildWhereClause(this.db, where);
			if (whereResult.sql) {
				query = query.where(buildRawWhereExpression(whereResult));
			}
		}

		const result = await query.executeTakeFirst();
		// Postgres returns COUNT(*) (bigint) as a string via node-postgres; coerce
		// so this always satisfies its Promise<number> contract on both dialects.
		return Number(result?.count ?? 0);
	}

	/**
	 * Insert-once (see {@link StorageCollection.insert}).
	 *
	 * Single `INSERT … ON CONFLICT (plugin_id, collection, id) DO NOTHING`. The
	 * conflict target is the primary key, so a same-`id` collision is swallowed
	 * (0 rows affected → `{ inserted: false, reason: "exists" }`). A collision on
	 * a declared partial UNIQUE expression index is NOT the conflict target, so
	 * the statement throws — we classify that as `unique_violation` and re-throw
	 * anything else.
	 */
	async insert(id: string, data: T): Promise<InsertResult> {
		const now = new Date().toISOString();
		const jsonData = JSON.stringify(data);

		try {
			const result = await this.db
				.insertInto("_plugin_storage")
				.values({
					plugin_id: this.pluginId,
					collection: this.collection,
					id,
					data: jsonData,
					created_at: now,
					updated_at: now,
				})
				.onConflict((oc) => oc.columns(["plugin_id", "collection", "id"]).doNothing())
				.executeTakeFirst();

			const inserted = (result.numInsertedOrUpdatedRows ?? 0n) > 0n;
			if (inserted) return { inserted: true };
			return { inserted: false, reason: "exists" };
		} catch (error) {
			const classified = classifyUniqueViolation(error);
			if (!classified) throw error;
			const conflictField = await this.recoverConflictField(classified.indexName);
			return conflictField
				? { inserted: false, reason: "unique_violation", conflictField }
				: { inserted: false, reason: "unique_violation" };
		}
	}

	/**
	 * Predicate-guarded atomic update (see {@link StorageCollection.updateIf}).
	 *
	 * One guarded `UPDATE _plugin_storage SET data = <json_set/jsonb_set expr>,
	 * updated_at = ? WHERE <pk> AND <guard> RETURNING data`. The guard reuses
	 * PR A's numeric-correct `buildWhereClause` translation verbatim, and the
	 * `set`/`delta` arithmetic is computed in-SQL — no read-then-write — which is
	 * what makes N concurrent guarded decrements correct (no oversell).
	 *
	 * `applied` is derived from whether a `RETURNING` row came back (equivalently
	 * rows-affected > 0). A missing row and a failed guard both yield 0 rows →
	 * `{ applied: false }`; the two are intentionally indistinguishable. Never
	 * inserts.
	 */
	async updateIf(id: string, args: UpdateIfArgs<T>): Promise<UpdateIfResult<T>> {
		const { where, set, delta } = args;

		const setEntries: Array<[string, unknown]> = set ? Object.entries(set) : [];
		const hasSet = setEntries.length > 0;
		const hasDelta = delta !== undefined && Object.keys(delta).length > 0;

		if (!hasSet && !hasDelta) {
			throw new Error("updateIf requires at least one of `set` or `delta`.");
		}

		// Build the signed integer deltas, enforcing integer-only at runtime.
		const deltaEntries: Array<[string, number]> = [];
		if (hasDelta) {
			const setFieldSet = new Set(setEntries.map(([field]) => field));
			for (const [field, spec] of Object.entries(delta)) {
				if (spec === undefined) continue;
				if (setFieldSet.has(field)) {
					throw new Error(`updateIf: field "${field}" appears in both \`set\` and \`delta\`.`);
				}
				if (!isDeltaLike(spec)) {
					throw new TypeError(
						`updateIf: delta for "${field}" must be exactly one of { inc: number } or { dec: number }.`,
					);
				}
				const { inc, dec } = spec;
				let signed: number;
				if (typeof inc === "number" && typeof dec !== "number") {
					signed = inc;
				} else if (typeof dec === "number" && typeof inc !== "number") {
					signed = -dec;
				} else {
					// Both present or neither present/numeric → ambiguous or invalid.
					throw new TypeError(
						`updateIf: delta for "${field}" must be exactly one of { inc: number } or { dec: number }.`,
					);
				}
				if (!Number.isInteger(signed)) {
					throw new TypeError(
						`updateIf: delta for "${field}" must be an integer (got ${String(inc ?? dec)}).`,
					);
				}
				deltaEntries.push([field, signed]);
			}
		}

		// Defensive empty-`in` guard: an empty `in: []` matches nothing. The shared
		// where-translation would emit invalid `IN ()`; short-circuit to a no-op
		// (matches nothing → applied:false) BEFORE building any SQL.
		for (const value of Object.values(where)) {
			if (isInFilter(value) && value.in.length === 0) {
				return { applied: false };
			}
		}

		const now = new Date().toISOString();
		const dataExpr = pluginDataWriteExpr(this.db, setEntries, deltaEntries);

		let query = this.db
			.updateTable("_plugin_storage")
			.set({ data: dataExpr, updated_at: now })
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("id", "=", id);

		const whereResult = buildWhereClause(this.db, where);
		if (whereResult.sql) {
			query = query.where(buildRawWhereExpression(whereResult));
		}

		const row = await query.returning("data").executeTakeFirst();
		if (!row) return { applied: false };
		// JSON.parse returns any; it flows into the T-typed `data` field directly.
		const data: T = JSON.parse(row.data);
		return { applied: true, data };
	}

	/**
	 * Best-effort recovery of the single field behind a unique-index violation.
	 * Prefers the `_plugin_indexes` tracking row (authoritative field list);
	 * falls back to parsing the `generateIndexName` format. Composite indexes
	 * yield `undefined`.
	 */
	private async recoverConflictField(indexName?: string): Promise<string | undefined> {
		if (!indexName) return undefined;

		const row = await this.db
			.selectFrom("_plugin_indexes")
			.select("fields")
			.where("plugin_id", "=", this.pluginId)
			.where("collection", "=", this.collection)
			.where("index_name", "=", indexName)
			.executeTakeFirst();

		if (row) {
			try {
				const parsed: unknown = JSON.parse(row.fields);
				if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") {
					return parsed[0];
				}
			} catch {
				// fall through to name parsing
			}
			return undefined;
		}

		// Fallback: uidx_plugin_<pluginId>_<collection>_<field>
		const prefix = `uidx_plugin_${this.pluginId}_${this.collection}_`;
		if (indexName.startsWith(prefix)) {
			const field = indexName.slice(prefix.length);
			if (SAFE_FIELD_NAME_RE.test(field)) return field;
		}
		return undefined;
	}
}

/**
 * Create a scoped storage accessor for a plugin
 */
export function createPluginStorageAccessor(
	db: Kysely<Database>,
	pluginId: string,
	storageConfig: Record<
		string,
		{ indexes: Array<string | string[]>; uniqueIndexes?: Array<string | string[]> }
	>,
): Record<string, StorageCollection> {
	const accessor: Record<string, StorageCollection> = {};

	for (const [collectionName, config] of Object.entries(storageConfig)) {
		const allIndexes = [...config.indexes, ...(config.uniqueIndexes ?? [])];
		accessor[collectionName] = new PluginStorageRepository(
			db,
			pluginId,
			collectionName,
			allIndexes,
		);
	}

	return accessor;
}

/**
 * Delete all storage data for a plugin
 */
export async function deleteAllPluginStorage(
	db: Kysely<Database>,
	pluginId: string,
): Promise<number> {
	const result = await db
		.deleteFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.executeTakeFirst();

	return Number(result.numDeletedRows ?? 0);
}

/**
 * Delete all storage data for a plugin collection
 */
export async function deletePluginCollection(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
): Promise<number> {
	const result = await db
		.deleteFrom("_plugin_storage")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.executeTakeFirst();

	return Number(result.numDeletedRows ?? 0);
}
