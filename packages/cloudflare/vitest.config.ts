/**
 * Two-project test setup:
 *
 * - `node`  — the package's default suites, run in the standard node pool.
 * - `d1`    — real-D1 tests for the atomic storage batch, run inside a workerd
 *             isolate via `@cloudflare/vitest-pool-workers` (see
 *             `tests/d1/vitest.config.ts`). Kept as a SEPARATE project because a
 *             single pool-workers config would silently drop the node suites.
 *
 * `pnpm test` (`vitest run`) runs BOTH projects.
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: [
			{
				test: {
					name: "node",
					include: ["tests/**/*.test.ts"],
					exclude: ["tests/d1/**", "**/node_modules/**", "**/dist/**"],
				},
			},
			"./tests/d1/vitest.config.ts",
		],
	},
});
