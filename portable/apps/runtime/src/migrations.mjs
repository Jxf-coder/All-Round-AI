// Every entry upgrades the on-disk data schema by one version. Once a release
// ships, its migration must keep working on data written by older releases, so
// entries are append-only: never renumber or rewrite an applied migration.
//
// Version 1 is the baseline that already-existing installations record on
// their first start. It deliberately changes nothing; it exists so future
// releases have a version to migrate from and so an older build can detect
// that the data directory belongs to a newer schema.
export const RUNTIME_SCHEMA_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "baseline",
    async up() {},
  }),
]);

export const RUNTIME_SCHEMA_VERSION = RUNTIME_SCHEMA_MIGRATIONS.at(-1).version;
