import { resolve } from "path";

export interface LoadedGraphs {
  [exportName: string]: any;
}

export async function loadGraphsFromFile(
  filePath: string,
): Promise<LoadedGraphs> {
  const absPath = resolve(filePath);
  const cacheBuster = `?t=${Date.now()}`;
  const mod = await import(absPath + cacheBuster);

  const graphs: LoadedGraphs = {};

  for (const [key, value] of Object.entries(mod)) {
    if (isCompiledGraph(value)) {
      graphs[key] = value;
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
