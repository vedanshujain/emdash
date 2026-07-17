/**
 * Plugin Storage Repository
 *
 * Provides a document store API for plugin data storage.
 * Uses a single _plugin_storage table with JSON documents and expression indexes.
 *
 * @see PLUGIN-SYSTEM.md § Plugin Storage > Full API Reference
 */

import {
	DummyDriver,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
	Kysely,
	sql,
	type RawBuilder,
	type SqlBool,
	type UpdateQueryBuilder,
	type InsertQueryBuilder,
} from "kysely";

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
	BatchOp,
	BatchOpResult,
	BatchResult,
	BatchFailureReason,
	NumericDelta,
	StorageAccess,
} from "../../plugins/types.js";
import { pluginDataWriteExpr } from "../dialect-helpers.js";
import { withTransaction } from "../transaction.js";
import type { Database } from "../types.js";
import { validateIdentifier } from "../validate.js";
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
 * Best-effort recovery of the single field behind a unique-index violation.
 * Prefers the `_plugin_indexes` tracking row (authoritative field list); falls
 * back to parsing the `generateIndexName` format. Composite indexes yield
 * `undefined`.
 *
 * Lifted to a module-level free function (from the former private method) so
 * both `PluginStorageRepository.insert` and the batch executors can call it
 * with an explicit `(db, pluginId, collection)` — behaviour-preserving.
 */
async function recoverConflictField(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	indexName?: string,
): Promise<string | undefined> {
	if (!indexName) return undefined;

	const row = await db
		.selectFrom("_plugin_indexes")
		.select("fields")
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
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
	const prefix = `uidx_plugin_${pluginId}_${collection}_`;
	if (indexName.startsWith(prefix)) {
		const field = indexName.slice(prefix.length);
		if (SAFE_FIELD_NAME_RE.test(field)) return field;
	}
	return undefined;
}

/**
 * Build the `INSERT … ON CONFLICT (plugin_id, collection, id) DO NOTHING`
 * statement for a single insert-once. Extracted from `insert` so the standalone
 * method and the batch executor share ONE builder (pure — no execution here).
 */
function buildInsertQuery(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	id: string,
	data: unknown,
): InsertQueryBuilder<
	Database,
	"_plugin_storage",
	{ numInsertedOrUpdatedRows: bigint | undefined }
> {
	const now = new Date().toISOString();
	const jsonData = JSON.stringify(data);
	return db
		.insertInto("_plugin_storage")
		.values({
			plugin_id: pluginId,
			collection,
			id,
			data: jsonData,
			created_at: now,
			updated_at: now,
		})
		.onConflict((oc) => oc.columns(["plugin_id", "collection", "id"]).doNothing());
}

/**
 * Normalize the `delta` map into signed integer entries, enforcing integer-only
 * and the "not in both `set` and `delta`" rule at runtime. Extracted verbatim
 * from `updateIf` so the standalone method and the batch reject floats /
 * both-in-set-and-delta identically (a `TypeError` — a programmer error).
 */
function normalizeDeltaEntries<T>(
	delta: { [K in keyof T]?: NumericDelta } | undefined,
	setEntries: Array<[string, unknown]>,
): Array<[string, number]> {
	const deltaEntries: Array<[string, number]> = [];
	if (!delta || Object.keys(delta).length === 0) return deltaEntries;

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
	return deltaEntries;
}

/**
 * Build the guarded `UPDATE … RETURNING data` statement for a single `updateIf`.
 * Returns `{ query, empty }` where `empty` flags the empty-`in:[]` short-circuit
 * (matches nothing → `applied:false`) so the caller never emits invalid
 * `IN ()`. Extracted from `updateIf`; the delta validation runs through
 * {@link normalizeDeltaEntries}. Pure — no execution here.
 */
function buildUpdateIfQuery<T>(
	db: Kysely<Database>,
	pluginId: string,
	collection: string,
	id: string,
	args: UpdateIfArgs<T>,
):
	| { empty: true; query: null }
	| {
			empty: false;
			query: UpdateQueryBuilder<Database, "_plugin_storage", "_plugin_storage", { data: string }>;
	  } {
	const { where, set, delta } = args;

	const setEntries: Array<[string, unknown]> = set ? Object.entries(set) : [];
	const hasSet = setEntries.length > 0;
	const hasDelta = delta !== undefined && Object.keys(delta).length > 0;

	if (!hasSet && !hasDelta) {
		throw new Error("updateIf requires at least one of `set` or `delta`.");
	}

	const deltaEntries = normalizeDeltaEntries(delta, setEntries);

	// Defensive empty-`in` guard: an empty `in: []` matches nothing. The shared
	// where-translation would emit invalid `IN ()`; short-circuit to a no-op
	// (matches nothing → applied:false) BEFORE building any SQL.
	for (const value of Object.values(where)) {
		if (isInFilter(value) && value.in.length === 0) {
			return { empty: true, query: null };
		}
	}

	const now = new Date().toISOString();
	const dataExpr = pluginDataWriteExpr(db, setEntries, deltaEntries);

	let query = db
		.updateTable("_plugin_storage")
		.set({ data: dataExpr, updated_at: now })
		.where("plugin_id", "=", pluginId)
		.where("collection", "=", collection)
		.where("id", "=", id);

	const whereResult = buildWhereClause(db, where);
	if (whereResult.sql) {
		query = query.where(buildRawWhereExpression(whereResult));
	}

	return { empty: false, query: query.returning("data") };
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
		try {
			const result = await buildInsertQuery(
				this.db,
				this.pluginId,
				this.collection,
				id,
				data,
			).executeTakeFirst();

			const inserted = (result?.numInsertedOrUpdatedRows ?? 0n) > 0n;
			if (inserted) return { inserted: true };
			return { inserted: false, reason: "exists" };
		} catch (error) {
			const classified = classifyUniqueViolation(error);
			if (!classified) throw error;
			const conflictField = await recoverConflictField(
				this.db,
				this.pluginId,
				this.collection,
				classified.indexName,
			);
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
		const built = buildUpdateIfQuery(this.db, this.pluginId, this.collection, id, args);
		if (built.empty) return { applied: false };

		const row = await built.query.executeTakeFirst();
		if (!row) return { applied: false };
		// JSON.parse returns any; it flows into the T-typed `data` field directly.
		const data: T = JSON.parse(row.data);
		return { applied: true, data };
	}
}

// =============================================================================
// Atomic multi-document batch (ctx.storage.batch)
// =============================================================================

/**
 * Internal sentinel thrown inside the transaction to force a rollback with a
 * reported outcome. Caught OUTSIDE the transaction and turned into a
 * `{ applied:false, … }` result (never surfaced to callers). `indexName` /
 * `collection` are carried for `unique_violation` so `conflictField` can be
 * recovered on the pool connection AFTER the transaction rolls back (a
 * constraint error poisons the Postgres transaction, so the lookup must not run
 * inside it).
 */
class BatchAbort extends Error {
	constructor(
		readonly failedIndex: number,
		readonly reason: BatchFailureReason,
		readonly indexName?: string,
		readonly abortCollection?: string,
	) {
		super(`batch aborted at op ${failedIndex}: ${reason}`);
		this.name = "BatchAbort";
	}
}

/** True for an `updateIf` op whose guard contains an empty `in: []` (matches nothing). */
function hasEmptyInGuard(op: BatchOp): boolean {
	if (op.op !== "updateIf") return false;
	for (const value of Object.values(op.where)) {
		if (isInFilter(value) && value.in.length === 0) return true;
	}
	return false;
}

/**
 * Upper bound on ops per batch.
 *
 * The D1 executor emits up to TWO statements per guarded op (the write + its
 * zero-rows assertion), so this caps a batch at ≤ ~2× statements. 50 keeps the
 * worst case (~100 statements) comfortably inside Cloudflare D1's per-`batch()`
 * budget and far under the SQLite/D1 bound-variable ceiling (32766) — each op's
 * compiled statement binds only a handful of params. It is also generous for the
 * intended coupled-write use case (a reserve is 2–3 ops). An over-limit batch is
 * a programmer error (THROW), consistent with the other malformed-ops throws,
 * rather than an opaque D1 failure deep in `env.DB.batch()`.
 */
const MAX_BATCH_OPS = 50;

/**
 * Validate the ops array shape up front (BEFORE any write), so a malformed op is
 * a THROW with no partial commit — mirroring the single-op `insert`/`updateIf`
 * discipline. Guard/uniqueness OUTCOMES are never validated here (they are
 * reported, not thrown); only programmer errors throw.
 */
function assertBatchOpsValid(ops: BatchOp[]): void {
	if (!Array.isArray(ops) || ops.length === 0) {
		throw new Error("batch requires a non-empty array of ops.");
	}
	if (ops.length > MAX_BATCH_OPS) {
		throw new Error(`batch exceeds the maximum of ${MAX_BATCH_OPS} ops (got ${ops.length}).`);
	}
	for (let i = 0; i < ops.length; i++) {
		const op = ops[i];
		if (op === null || typeof op !== "object") {
			throw new Error(`batch op ${i} must be an object.`);
		}
		if (op.op !== "insert" && op.op !== "updateIf") {
			throw new Error(`batch op ${i} has unknown op "${String((op as { op?: unknown }).op)}".`);
		}
		validateIdentifier(op.collection, `batch op ${i} collection name`);
		if (typeof op.id !== "string" || op.id.length === 0) {
			throw new Error(`batch op ${i} requires a non-empty string id.`);
		}
		if (op.op === "insert") {
			// `data` is required — an `insert` with no data would otherwise fall
			// through to a NOT NULL violation deep in the write. Fail up front,
			// matching the insert/updateIf validation discipline.
			if (op.data === undefined) {
				throw new Error(`batch op ${i} (insert) requires \`data\`.`);
			}
		} else {
			if (typeof op.where !== "object" || op.where === null) {
				throw new Error(`batch op ${i} (updateIf) requires an object \`where\`.`);
			}
			const setEntries: Array<[string, unknown]> = op.set ? Object.entries(op.set) : [];
			const hasSet = setEntries.length > 0;
			const hasDelta = op.delta !== undefined && Object.keys(op.delta).length > 0;
			if (!hasSet && !hasDelta) {
				throw new Error(`batch op ${i} (updateIf) requires at least one of \`set\` or \`delta\`.`);
			}
			// Throws on float delta / field in both set & delta (programmer error).
			normalizeDeltaEntries(op.delta, setEntries);
		}
	}
}

/**
 * Apply several conditional writes atomically on the pg / better-sqlite3 path.
 *
 * Runs every op inside ONE `db.transaction().execute(...)` (a real transaction —
 * NOT the `withTransaction` fallback, which degrades to non-atomic on a
 * no-transaction backend and would break all-or-nothing). Commits iff every op's
 * guard passes; a failing op throws {@link BatchAbort} to roll back the whole
 * transaction, and the outer catch turns that into `{ applied:false, … }`. A raw
 * DB error re-throws.
 *
 * The D1 production sandbox path does NOT use this (D1 has no interactive
 * transactions) — it uses {@link applyPluginStorageBatchD1}.
 */
export async function applyPluginStorageBatch(
	db: Kysely<Database>,
	pluginId: string,
	ops: BatchOp[],
): Promise<BatchResult> {
	assertBatchOpsValid(ops);

	try {
		const results = await db.transaction().execute(async (trx) => {
			const out: BatchOpResult[] = [];
			for (const [i, op] of ops.entries()) {
				if (op.op === "insert") {
					let inserted: boolean;
					try {
						const res = await buildInsertQuery(
							trx,
							pluginId,
							op.collection,
							op.id,
							op.data,
						).executeTakeFirst();
						inserted = (res?.numInsertedOrUpdatedRows ?? 0n) > 0n;
					} catch (error) {
						const classified = classifyUniqueViolation(error);
						if (!classified) throw error; // raw DB error — never swallowed
						throw new BatchAbort(i, "unique_violation", classified.indexName, op.collection);
					}
					if (inserted) {
						out.push({ op: "insert", inserted: true });
					} else if (op.ifNotExists) {
						// Satisfied no-op — the row already exists, let the batch proceed.
						out.push({ op: "insert", inserted: false, reason: "exists" });
					} else {
						throw new BatchAbort(i, "exists");
					}
				} else {
					const built = buildUpdateIfQuery(trx, pluginId, op.collection, op.id, {
						where: op.where,
						set: op.set,
						delta: op.delta,
					});
					if (built.empty) throw new BatchAbort(i, "guard_failed");
					const row = await built.query.executeTakeFirst();
					if (!row) throw new BatchAbort(i, "guard_failed");
					out.push({ op: "updateIf", applied: true, data: JSON.parse(row.data) });
				}
			}
			return out;
		});
		return { applied: true, results };
	} catch (err) {
		if (err instanceof BatchAbort) {
			if (err.reason === "unique_violation" && err.indexName && err.abortCollection) {
				const conflictField = await recoverConflictField(
					db,
					pluginId,
					err.abortCollection,
					err.indexName,
				);
				return conflictField
					? { applied: false, failedIndex: err.failedIndex, reason: err.reason, conflictField }
					: { applied: false, failedIndex: err.failedIndex, reason: err.reason };
			}
			return { applied: false, failedIndex: err.failedIndex, reason: err.reason };
		}
		throw err;
	}
}

// ── D1 executor (raw env.DB.batch) ────────────────────────────────────────
//
// Cloudflare D1 has no interactive transactions; the only atomic primitive is
// `env.DB.batch([...])`, an implicit transaction that rolls back ONLY when a
// statement ERRORS. A guarded `UPDATE … WHERE guard` matching 0 rows does not
// error, so we interleave an assertion after each guarded write that raises when
// `changes() = 0`, forcing the whole batch to roll back. Verified on real D1
// (see packages/cloudflare/tests/sandbox/*batch* + the probe): `changes()`
// carries across statements in one batch; `abs(-9223372036854775808)` overflows
// → SQLITE_ERROR → whole-batch rollback.

/** Minimal structural view of the raw `D1Database` binding (avoids a hard dep on `@cloudflare/workers-types` in core). */
export interface D1BatchBinding {
	prepare(query: string): D1BatchStatement;
	batch(statements: D1BatchStatement[]): Promise<D1BatchRow[]>;
}
export interface D1BatchStatement {
	bind(...values: unknown[]): D1BatchStatement;
	first<T = Record<string, unknown>>(colName?: string): Promise<T | null>;
}
interface D1BatchRow {
	results?: Array<Record<string, unknown>>;
	meta?: { changes?: number };
}

/**
 * `changes() = 0` → integer-overflow → `SQLITE_ERROR`, rolling back the whole
 * `env.DB.batch`. No JSON1 dependency. (`json('')` "malformed JSON" is a proven
 * fallback if a future D1 build changes overflow behaviour.)
 */
const D1_ASSERT_APPLIED = "SELECT CASE WHEN changes()=0 THEN abs(-9223372036854775808) ELSE 1 END";
/** Unconditional error (no `changes()` dependency) used to force rollback for an unsatisfiable guard. */
const D1_ASSERT_ALWAYS = "SELECT abs(-9223372036854775808)";

/**
 * Compile-only Kysely (SQLite dialect, DummyDriver — never executes) used to
 * translate the shared query builders into `{ sql, parameters }` for D1. A
 * SQLite adapter makes `pluginDataWriteExpr` / `buildWhereClause` emit the
 * SQLite JSON forms (`json_set` / `json_extract`), NOT the Postgres `jsonb`
 * syntax — exactly what D1 needs.
 */
let compileDb: Kysely<Database> | null = null;
function getCompileDb(): Kysely<Database> {
	compileDb ??= new Kysely<Database>({
		dialect: {
			createAdapter: () => new SqliteAdapter(),
			createDriver: () => new DummyDriver(),
			createQueryCompiler: () => new SqliteQueryCompiler(),
			createIntrospector: (d) => new SqliteIntrospector(d),
		},
	});
	return compileDb;
}

/** Compile an `EXISTS(SELECT 1 … WHERE pk [AND guard])` diagnosis probe (parameterized — reuses buildWhereClause). */
function compileExistsProbe(
	pluginId: string,
	collection: string,
	id: string,
	where?: WhereClause,
): { sql: string; parameters: unknown[] } {
	const parts = [
		"SELECT EXISTS(SELECT 1 FROM _plugin_storage WHERE plugin_id = ? AND collection = ? AND id = ?",
	];
	const parameters: unknown[] = [pluginId, collection, id];
	if (where && Object.keys(where).length > 0) {
		const whereResult = buildWhereClause(getCompileDb(), where);
		if (whereResult.sql) {
			parts.push(` AND ${whereResult.sql}`);
			parameters.push(...whereResult.params);
		}
	}
	parts.push(") AS e");
	return { sql: parts.join(""), parameters };
}

/** Read a truthy `EXISTS(...)` result column from a D1 `.first()` row. */
function existsRowTrue(row: Record<string, unknown> | null): boolean {
	if (!row) return false;
	const e = row.e;
	return e === 1 || e === true || e === "1";
}

/**
 * Failure-path diagnosis (D1 only). The atomic guarantee already held (nothing
 * committed); this read-only pass re-derives `failedIndex` / `reason` for the
 * report. It NEVER throws or loops: under a concurrent restock every guard may
 * be satisfiable again, in which case we return a well-formed generic fallback.
 * Best-effort by construction — the committed state is always correct; only the
 * report can drift (TOCTOU between rollback and diagnosis).
 */
async function diagnoseD1Failure(
	d1: D1BatchBinding,
	pluginId: string,
	ops: BatchOp[],
	classified: { indexName?: string } | null,
): Promise<BatchResult> {
	for (const [i, op] of ops.entries()) {
		if (op.op === "insert") {
			const probe = compileExistsProbe(pluginId, op.collection, op.id);
			const row = await d1
				.prepare(probe.sql)
				.bind(...probe.parameters)
				.first();
			const exists = existsRowTrue(row);
			if (op.ifNotExists) {
				// ifNotExists never fails on a PK conflict; only a unique violation can.
				if (classified) {
					const conflictField = await recoverConflictFieldD1(
						d1,
						pluginId,
						op.collection,
						classified,
					);
					return conflictField
						? { applied: false, failedIndex: i, reason: "unique_violation", conflictField }
						: { applied: false, failedIndex: i, reason: "unique_violation" };
				}
				continue;
			}
			if (exists) return { applied: false, failedIndex: i, reason: "exists" };
			// PK absent but the insert still failed → a declared unique violation.
			if (classified) {
				const conflictField = await recoverConflictFieldD1(d1, pluginId, op.collection, classified);
				return conflictField
					? { applied: false, failedIndex: i, reason: "unique_violation", conflictField }
					: { applied: false, failedIndex: i, reason: "unique_violation" };
			}
		} else {
			if (hasEmptyInGuard(op)) return { applied: false, failedIndex: i, reason: "guard_failed" };
			const probe = compileExistsProbe(pluginId, op.collection, op.id, op.where);
			const row = await d1
				.prepare(probe.sql)
				.bind(...probe.parameters)
				.first();
			if (!existsRowTrue(row)) return { applied: false, failedIndex: i, reason: "guard_failed" };
		}
	}
	// No op currently fails (a concurrent restock re-satisfied every guard).
	// Return a well-formed best-effort fallback rather than throwing/looping.
	if (classified) {
		for (const [i, op] of ops.entries()) {
			if (op.op === "insert") {
				const conflictField = await recoverConflictFieldD1(d1, pluginId, op.collection, classified);
				return conflictField
					? { applied: false, failedIndex: i, reason: "unique_violation", conflictField }
					: { applied: false, failedIndex: i, reason: "unique_violation" };
			}
		}
	}
	return { applied: false, failedIndex: 0, reason: "guard_failed" };
}

/** conflictField recovery over the raw D1 binding (mirrors {@link recoverConflictField}). */
async function recoverConflictFieldD1(
	d1: D1BatchBinding,
	pluginId: string,
	collection: string,
	classified: { indexName?: string },
): Promise<string | undefined> {
	const indexName = classified.indexName;
	if (!indexName) return undefined;
	const row = await d1
		.prepare(
			"SELECT fields FROM _plugin_indexes WHERE plugin_id = ? AND collection = ? AND index_name = ?",
		)
		.bind(pluginId, collection, indexName)
		.first<{ fields?: string }>();
	if (row && typeof row.fields === "string") {
		try {
			const parsed: unknown = JSON.parse(row.fields);
			if (Array.isArray(parsed) && parsed.length === 1 && typeof parsed[0] === "string") {
				return parsed[0];
			}
		} catch {
			// fall through
		}
		return undefined;
	}
	const prefix = `uidx_plugin_${pluginId}_${collection}_`;
	if (indexName.startsWith(prefix)) {
		const field = indexName.slice(prefix.length);
		if (SAFE_FIELD_NAME_RE.test(field)) return field;
	}
	return undefined;
}

/**
 * Apply an atomic batch on the Cloudflare D1 path via raw `env.DB.batch()` with
 * interleaved zero-rows assertions (§5.2). Compiles each op's statement through
 * the shared SQLite-dialect builders, submits `[op0, assert0, op1, assert1, …]`
 * in one `batch()` (an implicit transaction), and on failure runs a read-only
 * {@link diagnoseD1Failure} pass to report `failedIndex` / `reason`.
 *
 * Returns the SAME `BatchResult` shape as {@link applyPluginStorageBatch}.
 */
export async function applyPluginStorageBatchD1(
	d1: D1BatchBinding,
	pluginId: string,
	ops: BatchOp[],
): Promise<BatchResult> {
	assertBatchOpsValid(ops);
	const cdb = getCompileDb();

	const statements: D1BatchStatement[] = [];
	// For each op, remember where its main statement lands so we can read
	// RETURNING data / changes() back from the batch results in ops order.
	const positions: Array<
		{ kind: "insert"; pos: number; ifNotExists: boolean } | { kind: "updateIf"; pos: number }
	> = [];

	for (const op of ops) {
		if (op.op === "insert") {
			const compiled = buildInsertQuery(cdb, pluginId, op.collection, op.id, op.data).compile();
			const pos = statements.length;
			statements.push(d1.prepare(compiled.sql).bind(...compiled.parameters));
			positions.push({ kind: "insert", pos, ifNotExists: op.ifNotExists === true });
			// A non-ifNotExists insert must affect a row; assert it did (0 rows ⇒
			// PK conflict ⇒ roll back). An ifNotExists insert gets NO assertion
			// (0 rows is a satisfied no-op).
			if (!op.ifNotExists) statements.push(d1.prepare(D1_ASSERT_APPLIED));
		} else {
			const built = buildUpdateIfQuery(cdb, pluginId, op.collection, op.id, {
				where: op.where,
				set: op.set,
				delta: op.delta,
			});
			if (built.empty) {
				// Unsatisfiable guard (empty in:[]): force a whole-batch rollback.
				statements.push(d1.prepare(D1_ASSERT_ALWAYS));
				positions.push({ kind: "updateIf", pos: -1 });
			} else {
				const compiled = built.query.compile();
				const pos = statements.length;
				statements.push(d1.prepare(compiled.sql).bind(...compiled.parameters));
				positions.push({ kind: "updateIf", pos });
				statements.push(d1.prepare(D1_ASSERT_APPLIED));
			}
		}
	}

	let batchRows: D1BatchRow[];
	try {
		batchRows = await d1.batch(statements);
	} catch (err) {
		return diagnoseD1Failure(d1, pluginId, ops, classifyUniqueViolation(err));
	}

	// Success: every guard passed. Build results[] in ops order.
	const results: BatchOpResult[] = [];
	for (const meta of positions) {
		const row = meta.pos >= 0 ? batchRows[meta.pos] : undefined;
		if (meta.kind === "insert") {
			const changed = (row?.meta?.changes ?? 0) > 0;
			if (changed) {
				results.push({ op: "insert", inserted: true });
			} else {
				// Committed with 0 rows ⇒ satisfied ifNotExists no-op (row existed).
				results.push({ op: "insert", inserted: false, reason: "exists" });
			}
		} else {
			const data = row?.results?.[0]?.data;
			results.push({
				op: "updateIf",
				applied: true,
				data: typeof data === "string" ? JSON.parse(data) : data,
			});
		}
	}
	return { applied: true, results };
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
): StorageAccess {
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

	return Object.assign(accessor, {
		batch: (ops: BatchOp[]) => applyPluginStorageBatch(db, pluginId, ops),
	});
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
