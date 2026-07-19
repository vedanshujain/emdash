/**
 * Bridge Handler Conformance Tests
 *
 * Tests the shared bridge handler that both the production (workerd)
 * and dev (miniflare) runners use. This is the conformance test suite
 * that ensures identical behavior across all sandbox runners.
 *
 * These tests exercise capability enforcement, KV isolation, and
 * error handling at the bridge level.
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { createBridgeHandler } from "../src/sandbox/bridge-handler.js";

// Set up an in-memory SQLite database with the minimum tables needed
function createTestDb() {
	const sqlite = new Database(":memory:");
	const db = new Kysely<any>({
		dialect: new SqliteDialect({ database: sqlite }),
	});
	return { db, sqlite };
}

async function setupTables(db: Kysely<any>) {
	// Plugin storage table (used for both KV and document storage)
	await db.schema
		.createTable("_plugin_storage")
		.addColumn("plugin_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("id", "text", (col) => col.notNull())
		.addColumn("data", "text", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.addColumn("updated_at", "text", (col) => col.notNull())
		.addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
		.execute();

	// Users table (matches migration 001)
	await db.schema
		.createTable("users")
		.addColumn("id", "text", (col) => col.primaryKey())
		.addColumn("email", "text", (col) => col.notNull())
		.addColumn("name", "text")
		.addColumn("role", "integer", (col) => col.notNull())
		.addColumn("created_at", "text", (col) => col.notNull())
		.execute();

	// Insert a test user
	await db
		.insertInto("users" as any)
		.values({
			id: "user-1",
			email: "test@example.com",
			name: "Test User",
			role: 50,
			created_at: new Date().toISOString(),
		})
		.execute();
}

describe("Bridge Handler Conformance", () => {
	let db: Kysely<any>;
	let sqlite: Database.Database;

	beforeEach(async () => {
		const ctx = createTestDb();
		db = ctx.db;
		sqlite = ctx.sqlite;
		await setupTables(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqlite.close();
	});

	function makeHandler(opts: {
		capabilities?: string[];
		allowedHosts?: string[];
		storageCollections?: string[];
	}) {
		return createBridgeHandler({
			pluginId: "test-plugin",
			version: "1.0.0",
			capabilities: opts.capabilities ?? [],
			allowedHosts: opts.allowedHosts ?? [],
			storageCollections: opts.storageCollections ?? [],
			db,
			emailSend: () => null,
		});
	}

	async function call(
		handler: ReturnType<typeof makeHandler>,
		method: string,
		body: Record<string, unknown> = {},
	) {
		const request = new Request(`http://bridge/${method}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		const response = await handler(request);
		return response.json() as Promise<{ result?: unknown; error?: string }>;
	}

	// ── KV Operations ────────────────────────────────────────────────────

	describe("KV operations", () => {
		it("set and get a value", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "test", value: "hello" });
			const result = await call(handler, "kv/get", { key: "test" });
			expect(result.result).toBe("hello");
		});

		it("get returns null for non-existent key", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "kv/get", { key: "missing" });
			expect(result.result).toBeNull();
		});

		it("delete removes a key", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "to-delete", value: "bye" });
			await call(handler, "kv/delete", { key: "to-delete" });
			const result = await call(handler, "kv/get", { key: "to-delete" });
			expect(result.result).toBeNull();
		});

		it("list returns keys with prefix", async () => {
			const handler = makeHandler({});
			await call(handler, "kv/set", { key: "settings:theme", value: "dark" });
			await call(handler, "kv/set", { key: "settings:lang", value: "en" });
			await call(handler, "kv/set", { key: "state:count", value: 42 });

			const result = await call(handler, "kv/list", { prefix: "settings:" });
			const items = result.result as Array<{ key: string; value: unknown }>;
			expect(items).toHaveLength(2);
			expect(items.map((i) => i.key).toSorted()).toEqual(["settings:lang", "settings:theme"]);
		});

		it("KV is scoped per plugin (isolation)", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: [],
				db,
				emailSend: () => null,
			});

			// Plugin A sets a value
			await call(handlerA, "kv/set", { key: "secret", value: "a-data" });

			// Plugin B cannot see it
			const resultB = await call(handlerB, "kv/get", { key: "secret" });
			expect(resultB.result).toBeNull();

			// Plugin A can see it
			const resultA = await call(handlerA, "kv/get", { key: "secret" });
			expect(resultA.result).toBe("a-data");
		});
	});

	// ── Capability Enforcement ────────────────────────────────────────────

	describe("capability enforcement", () => {
		it("rejects content read without read:content capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			expect(result.error).toContain("Missing capability: read:content");
		});

		it("allows content read with read:content", async () => {
			// Create a content table first
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();

			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			// No error, returns null (post doesn't exist)
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});

		it("write:content does NOT imply read:content (matches Cloudflare bridge)", async () => {
			// The bridge enforces capabilities strictly: a plugin that declares
			// only write:content cannot call ctx.content.get/list. This matches
			// the Cloudflare PluginBridge behavior. The plugin must declare
			// read:content explicitly to read.
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();

			const handler = makeHandler({ capabilities: ["write:content"] });
			const result = await call(handler, "content/get", {
				collection: "posts",
				id: "123",
			});
			expect(result.error).toContain("Missing capability: read:content");
		});

		it("rejects taxonomy read without taxonomies:read capability", async () => {
			// content:read does not grant taxonomy access — it's a separate
			// capability (and a new one, so the canonical name is checked).
			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "taxonomy/list", {});
			expect(result.error).toContain("Missing capability: taxonomies:read");
		});

		it("allows taxonomy read with taxonomies:read", async () => {
			await db.schema
				.createTable("_emdash_taxonomy_defs")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("name", "text", (col) => col.notNull())
				.addColumn("label", "text", (col) => col.notNull())
				.addColumn("label_singular", "text")
				.addColumn("hierarchical", "integer", (col) => col.notNull().defaultTo(0))
				.addColumn("collections", "text")
				.addColumn("locale", "text", (col) => col.notNull().defaultTo("en"))
				.addColumn("translation_group", "text")
				.execute();
			await db
				.insertInto("_emdash_taxonomy_defs" as any)
				.values({
					id: "def-genre",
					name: "genre",
					label: "Genres",
					label_singular: "Genre",
					hierarchical: 1,
					collections: '["posts"]',
					locale: "en",
					translation_group: "def-genre",
				})
				.execute();

			const handler = makeHandler({ capabilities: ["taxonomies:read"] });
			const result = await call(handler, "taxonomy/list", {});
			expect(result.error).toBeUndefined();
			const defs = result.result as Array<{ name: string; hierarchical: boolean }>;
			expect(defs).toHaveLength(1);
			expect(defs[0]).toMatchObject({ name: "genre", hierarchical: true, collections: ["posts"] });
		});

		it("resolves taxonomy terms and entry terms through the pivot join", async () => {
			await db.schema
				.createTable("taxonomies")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("name", "text", (col) => col.notNull())
				.addColumn("slug", "text", (col) => col.notNull())
				.addColumn("label", "text", (col) => col.notNull())
				.addColumn("parent_id", "text")
				.addColumn("data", "text")
				.addColumn("locale", "text", (col) => col.notNull().defaultTo("en"))
				.addColumn("translation_group", "text")
				.execute();
			await db.schema
				.createTable("content_taxonomies")
				.addColumn("collection", "text", (col) => col.notNull())
				.addColumn("entry_id", "text", (col) => col.notNull())
				.addColumn("taxonomy_id", "text", (col) => col.notNull())
				.execute();
			await db
				.insertInto("taxonomies" as any)
				.values([
					{
						id: "term-en",
						name: "genre",
						slug: "scifi",
						label: "Sci-Fi",
						data: '{"description":"Space"}',
						locale: "en",
						translation_group: "tg-scifi",
					},
					{
						id: "term-de",
						name: "genre",
						slug: "scifi",
						label: "Science-Fiction",
						locale: "de",
						translation_group: "tg-scifi",
					},
					{
						id: "term-other",
						name: "genre",
						slug: "fantasy",
						label: "Fantasy",
						locale: "en",
						translation_group: "tg-fantasy",
					},
				])
				.execute();
			// The pivot stores the term's translation_group, not a row id.
			await db
				.insertInto("content_taxonomies" as any)
				.values({ collection: "posts", entry_id: "post-1", taxonomy_id: "tg-scifi" })
				.execute();

			const denied = makeHandler({ capabilities: ["read:content"] });
			expect((await call(denied, "taxonomy/terms", { taxonomy: "genre" })).error).toContain(
				"Missing capability: taxonomies:read",
			);
			expect(
				(await call(denied, "taxonomy/entryTerms", { collection: "posts", entryId: "post-1" }))
					.error,
			).toContain("Missing capability: taxonomies:read");

			const handler = makeHandler({ capabilities: ["taxonomies:read"] });

			// terms: locale filter + data JSON parsing + translation group
			const terms = await call(handler, "taxonomy/terms", { taxonomy: "genre", locale: "en" });
			expect(terms.error).toBeUndefined();
			const termRows = terms.result as Array<Record<string, unknown>>;
			expect(termRows.map((t) => t.slug)).toEqual(["fantasy", "scifi"]);
			expect(termRows[1]).toMatchObject({
				id: "term-en",
				data: { description: "Space" },
				translationGroup: "tg-scifi",
			});

			// entryTerms: pivot join on translation_group resolves both locales
			const entryTerms = await call(handler, "taxonomy/entryTerms", {
				collection: "posts",
				entryId: "post-1",
			});
			expect(entryTerms.error).toBeUndefined();
			const entryRows = entryTerms.result as Array<Record<string, unknown>>;
			expect(entryRows.map((t) => t.id)).toEqual(["term-de", "term-en"]);

			// entryTerms: locale narrows to one row per assignment
			const localized = await call(handler, "taxonomy/entryTerms", {
				collection: "posts",
				entryId: "post-1",
				locale: "de",
			});
			expect((localized.result as unknown[]).length).toBe(1);
		});

		it("rejects user read without read:users capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "users/get", { id: "user-1" });
			expect(result.error).toContain("Missing capability: read:users");
		});

		it("allows user read with read:users", async () => {
			const handler = makeHandler({ capabilities: ["read:users"] });
			const result = await call(handler, "users/get", { id: "user-1" });
			expect(result.error).toBeUndefined();
			const user = result.result as { id: string; email: string };
			expect(user.id).toBe("user-1");
			expect(user.email).toBe("test@example.com");
		});

		it("rejects network fetch without network:fetch capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "http/fetch", {
				url: "https://example.com",
			});
			expect(result.error).toContain("Missing capability: network:fetch");
		});

		it("rejects email send without email:send capability", async () => {
			const handler = makeHandler({ capabilities: [] });
			const result = await call(handler, "email/send", {
				message: { to: "a@b.com", subject: "hi", text: "hello" },
			});
			expect(result.error).toContain("Missing capability: email:send");
		});
	});

	// ── Storage (document store) ──────────────────────────────────────────

	describe("plugin storage", () => {
		it("rejects access to undeclared storage collection", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			const result = await call(handler, "storage/get", {
				collection: "secrets",
				id: "1",
			});
			expect(result.error).toContain("Storage collection not declared: secrets");
		});

		it("allows access to declared storage collection", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			const result = await call(handler, "storage/get", {
				collection: "logs",
				id: "1",
			});
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});

		it("put and get storage document", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			await call(handler, "storage/put", {
				collection: "logs",
				id: "log-1",
				data: { message: "hello", level: "info" },
			});
			const result = await call(handler, "storage/get", {
				collection: "logs",
				id: "log-1",
			});
			expect(result.result).toEqual({ message: "hello", level: "info" });
		});

		it("insert over the bridge: first { inserted: true }, replay { inserted: false, reason: 'exists' }", async () => {
			const handler = makeHandler({ storageCollections: ["items"] });
			const first = await call(handler, "storage/insert", {
				collection: "items",
				id: "x1",
				data: { stock: 5 },
			});
			expect(first.result).toEqual({ inserted: true });

			const replay = await call(handler, "storage/insert", {
				collection: "items",
				id: "x1",
				data: { stock: 999 },
			});
			expect(replay.result).toEqual({ inserted: false, reason: "exists" });

			// Original row untouched.
			const got = await call(handler, "storage/get", { collection: "items", id: "x1" });
			expect(got.result).toEqual({ stock: 5 });
		});

		it("updateIf over the bridge: guard-pass applies a delta decrement (round-trips through JSON), guard-fail no-ops", async () => {
			const handler = makeHandler({ storageCollections: ["items"] });
			await call(handler, "storage/insert", { collection: "items", id: "x1", data: { stock: 1 } });

			// The { dec: 1 } delta object must survive JSON transport and be
			// detected as a delta on the far side.
			const pass = await call(handler, "storage/updateIf", {
				collection: "items",
				id: "x1",
				where: { stock: { gte: 1 } },
				delta: { stock: { dec: 1 } },
			});
			expect(pass.result).toEqual({ applied: true, data: { stock: 0 } });

			// Now stock is 0 → guard fails, no-op.
			const fail = await call(handler, "storage/updateIf", {
				collection: "items",
				id: "x1",
				where: { stock: { gte: 1 } },
				delta: { stock: { dec: 1 } },
			});
			expect(fail.result).toEqual({ applied: false });

			const got = await call(handler, "storage/get", { collection: "items", id: "x1" });
			expect(got.result).toEqual({ stock: 0 });
		});

		it("rejects insert/updateIf on an undeclared collection", async () => {
			const handler = makeHandler({ storageCollections: ["items"] });
			const ins = await call(handler, "storage/insert", {
				collection: "secrets",
				id: "1",
				data: {},
			});
			expect(ins.error).toContain("Storage collection not declared: secrets");

			const upd = await call(handler, "storage/updateIf", {
				collection: "secrets",
				id: "1",
				where: {},
				set: { a: 1 },
			});
			expect(upd.error).toContain("Storage collection not declared: secrets");
		});

		it("storage is scoped per plugin", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["data"],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["data"],
				db,
				emailSend: () => null,
			});

			await call(handlerA, "storage/put", {
				collection: "data",
				id: "item-1",
				data: { owner: "a" },
			});

			// Plugin B cannot see plugin A's data
			const resultB = await call(handlerB, "storage/get", {
				collection: "data",
				id: "item-1",
			});
			expect(resultB.result).toBeNull();
		});
	});

	// ── storage/batch (atomic multi-document) ─────────────────────────────
	describe("storage/batch", () => {
		function batchHandler() {
			return makeHandler({ storageCollections: ["inventory", "reservations"] });
		}

		it("round-trips the ops array and applies a coupled decrement ∧ flip", async () => {
			const handler = batchHandler();
			await call(handler, "storage/put", {
				collection: "inventory",
				id: "widget",
				data: { on_hand: 5 },
			});
			await call(handler, "storage/put", {
				collection: "reservations",
				id: "r1",
				data: { state: "pending" },
			});

			const result = await call(handler, "storage/batch", {
				ops: [
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
				],
			});

			expect(result.result).toEqual({
				applied: true,
				results: [
					{ op: "updateIf", applied: true, data: { on_hand: 3 } },
					{ op: "updateIf", applied: true, data: { state: "held" } },
				],
			});
			const inv = await call(handler, "storage/get", { collection: "inventory", id: "widget" });
			expect(inv.result).toEqual({ on_hand: 3 });
		});

		it("guard-fail returns {applied:false, failedIndex, reason} and rolls back both ops", async () => {
			const handler = batchHandler();
			await call(handler, "storage/put", {
				collection: "inventory",
				id: "widget",
				data: { on_hand: 1 },
			});
			await call(handler, "storage/put", {
				collection: "reservations",
				id: "r1",
				data: { state: "pending" },
			});

			const result = await call(handler, "storage/batch", {
				ops: [
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
				],
			});

			expect(result.result).toEqual({ applied: false, failedIndex: 0, reason: "guard_failed" });
			const inv = await call(handler, "storage/get", { collection: "inventory", id: "widget" });
			expect(inv.result).toEqual({ on_hand: 1 });
			const res = await call(handler, "storage/get", { collection: "reservations", id: "r1" });
			expect(res.result).toEqual({ state: "pending" });
		});

		it("rejects an undeclared collection in ANY op — op 0 must NOT commit", async () => {
			const handler = makeHandler({ storageCollections: ["inventory"] });
			const result = await call(handler, "storage/batch", {
				ops: [
					{ op: "insert", collection: "inventory", id: "w1", data: { on_hand: 1 } },
					{ op: "updateIf", collection: "secrets", id: "s1", where: {}, set: { a: 1 } },
				],
			});
			expect(result.error).toContain("Storage collection not declared: secrets");
			// Validation precedes execution → op 0 never inserted.
			const inv = await call(handler, "storage/get", { collection: "inventory", id: "w1" });
			expect(inv.result).toBeNull();
		});

		it("is scoped per plugin (a batch cannot touch another plugin's rows)", async () => {
			const handlerA = createBridgeHandler({
				pluginId: "plugin-a",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["inventory"],
				db,
				emailSend: () => null,
			});
			const handlerB = createBridgeHandler({
				pluginId: "plugin-b",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storageCollections: ["inventory"],
				db,
				emailSend: () => null,
			});

			await call(handlerA, "storage/put", {
				collection: "inventory",
				id: "shared-id",
				data: { on_hand: 5 },
			});
			// Plugin B's batch inserts its OWN row at the same id; A's row is untouched.
			const result = await call(handlerB, "storage/batch", {
				ops: [{ op: "insert", collection: "inventory", id: "shared-id", data: { on_hand: 99 } }],
			});
			expect((result.result as { applied: boolean }).applied).toBe(true);
			const a = await call(handlerA, "storage/get", { collection: "inventory", id: "shared-id" });
			expect(a.result).toEqual({ on_hand: 5 });
		});

		it("throws a clean bridge error for malformed ops bodies", async () => {
			const handler = batchHandler();
			const notArray = await call(handler, "storage/batch", { ops: { nope: true } });
			expect(notArray.error).toContain("must be an array");

			const missingOp = await call(handler, "storage/batch", {
				ops: [{ collection: "inventory", id: "x" }],
			});
			expect(missingOp.error).toContain("unknown op");
		});

		it("rejects a non-object set/delta up front (symmetric with the Cloudflare bridge)", async () => {
			const handler = batchHandler();
			const badSet = await call(handler, "storage/batch", {
				ops: [{ op: "updateIf", collection: "inventory", id: "widget", where: {}, set: "nope" }],
			});
			expect(badSet.error).toContain("`set` must be an object");

			const badDelta = await call(handler, "storage/batch", {
				ops: [{ op: "updateIf", collection: "inventory", id: "widget", where: {}, delta: 5 }],
			});
			expect(badDelta.error).toContain("`delta` must be an object");
		});
	});

	// ── Error Handling ────────────────────────────────────────────────────

	describe("error handling", () => {
		it("returns error for unknown bridge method", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "unknown/method");
			expect(result.error).toContain("Unknown bridge method: unknown/method");
		});

		it("returns error for missing required parameters", async () => {
			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/get", {});
			expect(result.error).toContain("Missing required string parameter");
		});
	});

	// ── Limit clamping ────────────────────────────────────────────────────

	describe("list endpoints clamp negative limit", () => {
		it("content/list clamps negative limit to 1", async () => {
			await db.schema
				.createTable("ec_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("deleted_at", "text")
				.addColumn("title", "text")
				.execute();
			for (const id of ["post-1", "post-2", "post-3"]) {
				await db
					.insertInto("ec_posts" as any)
					.values({ id, deleted_at: null, title: `Title ${id}` })
					.execute();
			}

			const handler = makeHandler({ capabilities: ["read:content"] });
			const result = await call(handler, "content/list", {
				collection: "posts",
				limit: -5,
			});
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBeGreaterThanOrEqual(1);
			expect(list.items.length).toBeLessThanOrEqual(1);
		});

		it("media/list clamps negative limit to 1", async () => {
			await db.schema
				.createTable("media")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("filename", "text", (col) => col.notNull())
				.addColumn("mime_type", "text", (col) => col.notNull())
				.addColumn("size", "integer")
				.addColumn("storage_key", "text", (col) => col.notNull())
				.addColumn("status", "text", (col) => col.notNull().defaultTo("ready"))
				.addColumn("created_at", "text", (col) => col.notNull())
				.execute();
			for (const id of ["m-1", "m-2", "m-3"]) {
				await db
					.insertInto("media" as any)
					.values({
						id,
						filename: `${id}.png`,
						mime_type: "image/png",
						size: 100,
						storage_key: `keys/${id}`,
						status: "ready",
						created_at: new Date().toISOString(),
					})
					.execute();
			}

			const handler = makeHandler({ capabilities: ["read:media"] });
			const result = await call(handler, "media/list", { limit: -5 });
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBeGreaterThanOrEqual(1);
			expect(list.items.length).toBeLessThanOrEqual(1);
		});

		it("storage/query clamps negative limit to 1", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			for (const id of ["log-1", "log-2", "log-3"]) {
				await call(handler, "storage/put", {
					collection: "logs",
					id,
					data: { message: id },
				});
			}

			const result = await call(handler, "storage/query", {
				collection: "logs",
				where: {},
				limit: -5,
			});
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBeGreaterThanOrEqual(1);
			expect(list.items.length).toBeLessThanOrEqual(1);
		});

		it("storage/query without limit returns all rows (undefined passthrough)", async () => {
			const handler = makeHandler({ storageCollections: ["logs"] });
			for (const id of ["log-1", "log-2", "log-3"]) {
				await call(handler, "storage/put", {
					collection: "logs",
					id,
					data: { message: id },
				});
			}

			const result = await call(handler, "storage/query", {
				collection: "logs",
				where: {},
			});
			expect(result.error).toBeUndefined();
			const list = result.result as { items: unknown[] };
			expect(list.items.length).toBe(3);
		});
	});

	// ── Logging ───────────────────────────────────────────────────────────

	describe("logging", () => {
		it("log call succeeds without capabilities", async () => {
			const handler = makeHandler({});
			const result = await call(handler, "log", {
				level: "info",
				msg: "test message",
			});
			expect(result.error).toBeUndefined();
			expect(result.result).toBeNull();
		});
	});

	// ── Batch transactionality ────────────────────────────────────────────

	describe("batch operations are transactional", () => {
		beforeEach(async () => {
			await db.schema
				.createTable("ec_atomic_posts")
				.addColumn("id", "text", (col) => col.primaryKey())
				.addColumn("slug", "text", (col) => col.unique())
				.addColumn("status", "text", (col) => col.defaultTo("draft"))
				.addColumn("title", "text")
				.addColumn("created_at", "text")
				.addColumn("updated_at", "text")
				.addColumn("deleted_at", "text")
				.addColumn("version", "integer", (col) => col.defaultTo(1))
				.addColumn("author_id", "text")
				.execute();
		});

		it("contentCreateMany rolls back when a mid-batch insert fails", async () => {
			const handler = makeHandler({ capabilities: ["write:content"] });
			// Pre-insert a row that will collide with item index 2's slug.
			await call(handler, "content/create", {
				collection: "atomic_posts",
				data: { slug: "conflict", title: "existing" },
			});

			const before = await db
				.selectFrom("ec_atomic_posts" as any)
				.selectAll()
				.execute();
			expect(before).toHaveLength(1);

			const result = await call(handler, "content/createMany", {
				collection: "atomic_posts",
				items: [
					{ slug: "a", title: "ok 1" },
					{ slug: "b", title: "ok 2" },
					{ slug: "conflict", title: "should fail" },
					{ slug: "d", title: "would be ok" },
				],
			});
			expect(result.error).toBeDefined();

			// After the failed batch, only the pre-existing row should remain.
			const after = await db
				.selectFrom("ec_atomic_posts" as any)
				.selectAll()
				.execute();
			expect(after).toHaveLength(1);
			expect((after[0] as any).slug).toBe("conflict");
		});

		it("contentCreateMany commits all when no item fails", async () => {
			const handler = makeHandler({ capabilities: ["write:content"] });
			const result = await call(handler, "content/createMany", {
				collection: "atomic_posts",
				items: [
					{ slug: "x1", title: "1" },
					{ slug: "x2", title: "2" },
					{ slug: "x3", title: "3" },
				],
			});
			expect(result.result).toBeDefined();
			const rows = await db
				.selectFrom("ec_atomic_posts" as any)
				.selectAll()
				.execute();
			expect(rows).toHaveLength(3);
		});
	});
});
