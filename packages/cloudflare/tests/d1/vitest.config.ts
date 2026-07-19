/**
 * Real-D1 test project for the atomic storage batch (`applyPluginStorageBatchD1`).
 *
 * Runs inside a real workerd isolate via `@cloudflare/vitest-pool-workers`
 * (miniflare-backed D1), against the ACTUAL `_plugin_storage` schema created by
 * `migrations/0001_plugin_storage.sql`. Kept SEPARATE from the package's default
 * node-pool suites (referenced as a project from the package `vitest.config.ts`)
 * because the workers pool cannot host the plain node suites — the probe found a
 * single pool-workers config silently drops them.
 */

import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const migrations = await readD1Migrations(here("./migrations"));

export default defineConfig({
	test: {
		name: "d1",
		include: [here("./*.d1.test.ts")],
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: here("./wrangler.jsonc") },
			miniflare: {
				bindings: {
					TEST_MIGRATIONS: migrations,
				},
			},
		}),
	],
});
