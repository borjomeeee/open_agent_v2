import { resolve } from "path";

export async function validateGraphFile(filePath: string): Promise<string[]> {
  const absPath = resolve(filePath);

  // Use require() with explicit cache clearing instead of import() with
  // query-string cache busting. ESM import() cache entries can never be evicted,
  // so each reload permanently leaks the old module. require.cache can be deleted.
  // The actual graph execution happens inside an isolated Worker thread, so this
  // require() is only used for validation at deploy/start time.
  const resolved = require.resolve(absPath);
  delete require.cache[resolved];
  const mod = require(absPath);

  return Object.entries(mod)
    .filter(([, value]) => typeof value === "function")
    .map(([key]) => key);
}
