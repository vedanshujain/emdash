-- Real `_plugin_storage` / `_plugin_indexes` schema for the D1 batch feature
-- tests. Mirrors core migration 004_plugins (SQLite/D1 forms) so the tests
-- exercise `applyPluginStorageBatchD1` against the ACTUAL production schema, not
-- a scratch `probe` table. Plus a partial UNIQUE expression index on
-- `reservations.idempotency_key` (the shape createStorageIndexes materializes),
-- and its `_plugin_indexes` tracking row so `conflictField` recovery resolves.
CREATE TABLE _plugin_storage (
	plugin_id TEXT NOT NULL,
	collection TEXT NOT NULL,
	id TEXT NOT NULL,
	data TEXT NOT NULL,
	created_at TEXT,
	updated_at TEXT,
	PRIMARY KEY (plugin_id, collection, id)
);

CREATE TABLE _plugin_indexes (
	plugin_id TEXT NOT NULL,
	collection TEXT NOT NULL,
	index_name TEXT NOT NULL,
	fields TEXT NOT NULL,
	created_at TEXT,
	PRIMARY KEY (plugin_id, collection, index_name)
);

CREATE UNIQUE INDEX uidx_plugin_shop_reservations_idempotency_key
	ON _plugin_storage(json_extract(data, '$.idempotency_key'))
	WHERE plugin_id = 'shop' AND collection = 'reservations';

INSERT INTO _plugin_indexes (plugin_id, collection, index_name, fields)
VALUES (
	'shop',
	'reservations',
	'uidx_plugin_shop_reservations_idempotency_key',
	'["idempotency_key"]'
);
