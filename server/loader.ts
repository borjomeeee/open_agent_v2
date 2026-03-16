import { resolve } from "path";

export interface CompiledGraph {
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: unknown, config?: Record<string, unknown>): AsyncGenerator<unknown>;
}

export type GraphBuilder = (env: Record<string, string>) => CompiledGraph;

export type LoadedBuilders = Record<string, GraphBuilder>;

export async function loadBuildersFromFile(filePath: string): Promise<LoadedBuilders> {
  const absPath = resolve(filePath);

  // Use require() with explicit cache clearing instead of import() with
  // query-string cache busting. ESM import() cache entries can never be evicted,
  // so each reload permanently leaks the old module. require.cache can be deleted.
  const resolved = require.resolve(absPath);
  delete require.cache[resolved];
  const mod = require(absPath);

  const builders: LoadedBuilders = {};

  for (const [key, value] of Object.entries(mod)) {
    if (typeof value === "function") {
      builders[key] = value as GraphBuilder;
    }
  }

  return builders;
}
