// Minimal worker entry so vitest-pool-workers has a `main` to load. The tests
// drive `env.DB` directly; this fetch handler is unused.
export default {
	fetch(): Response {
		return new Response("d1-plugin-storage-batch");
	},
};
