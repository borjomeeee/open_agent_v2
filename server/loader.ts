import { resolve } from "path";

export interface CompiledGraph {
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: unknown, config?: Record<string, unknown>): AsyncGenerator<unknown>;
}

export type LoadedGraphs = Record<string, CompiledGraph>;

export async function loadGraphsFromFile(
  filePath: string,
  env: Record<string, string> = {},
): Promise<LoadedGraphs> {
  const absPath = resolve(filePath);

  // Use require() with explicit cache clearing instead of import() with
  // query-string cache busting. ESM import() cache entries can never be evicted,
  // so each reload permanently leaks the old module. require.cache can be deleted.
  const resolved = require.resolve(absPath);
  delete require.cache[resolved];
  const mod = require(absPath);

  const graphs: LoadedGraphs = {};

  for (const [key, value] of Object.entries(mod)) {
    if (isCompiledGraph(value)) {
      graphs[key] = value;
    } else if (typeof value === "function") {
      const built = (value as (env: Record<string, string>) => unknown)(env);
      if (isCompiledGraph(built)) {
        graphs[key] = built;
      }
    }
  }

  return graphs;
}

function isCompiledGraph(value: unknown): value is CompiledGraph {
  return (
    value !== null &&
    typeof value === "object" &&
    "invoke" in value! &&
    "stream" in value! &&
    typeof (value as CompiledGraph).invoke === "function"
  );
}
