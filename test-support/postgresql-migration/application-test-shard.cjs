"use strict";

// Each CI shard owns a separate, freshly initialized PostgreSQL service.
// Node's native test sharding partitions the unchanged complete discovery set.
function applicationTestShard(argv) {
  const indexes = argv.flatMap((value, index) => value === "--application-shard" ? [index] : []);
  if (!indexes.length) return null;
  if (indexes.length !== 1 || !argv.includes("--full") || argv.includes("--bootstrap-only")
    || argv.includes("--diagnostic-api") || !/^[123]\/3$/.test(argv[indexes[0] + 1] || "")) {
    throw new Error("Explicit full application shard 1/3, 2/3 or 3/3 required");
  }
  return argv[indexes[0] + 1];
}

module.exports = { applicationTestShard };
