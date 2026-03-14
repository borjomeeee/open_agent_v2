import { resolve } from "path";

export interface LoadedGraphs {
  [exportName: string]: any;
}

export async function loadGraphsFromFile(
  filePath: string,
  env: Record<string, string> = {},
): Promise<LoadedGraphs> {
  const absPath = resolve(filePath);
  const cacheBuster = `?t=${Date.now()}`;
  const mod = await import(absPath + cacheBuster);

  const graphs: LoadedGraphs = {};

  for (const [key, value] of Object.entries(mod)) {
    if (isCompiledGraph(value)) {
      graphs[key] = value;
    } else if (isBuilderFunction(value)) {
      const built = (value as Function)(env);
      if (isCompiledGraph(built)) {
        graphs[key] = built;
      }
    }
  }

  return graphs;
}

function isCompiledGraph(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    "invoke" in value! &&
    "stream" in value! &&
    typeof (value as any).invoke === "function"
  );
}

function isBuilderFunction(value: unknown): boolean {
  return typeof value === "function";
}
