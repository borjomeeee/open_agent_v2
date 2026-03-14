import { join } from "path";

export interface GraphEntry {
  name: string;
  fileName: string;
  active: boolean;
  deployedAt: string;
  exports: string[];
  env?: Record<string, string>;
}

export interface RegistryData {
  graphs: Record<string, GraphEntry>;
}

export class GraphRegistry {
  private data: RegistryData = { graphs: {} };
  private registryPath: string;
  private graphInstances: Map<string, any> = new Map();

  constructor(private dataDir: string) {
    this.registryPath = join(dataDir, "registry.json");
  }

  async init() {
    const file = Bun.file(this.registryPath);
    if (await file.exists()) {
      this.data = await file.json();
    } else {
      await Bun.write(this.registryPath, JSON.stringify(this.data, null, 2));
    }
  }

  private async save() {
    await Bun.write(this.registryPath, JSON.stringify(this.data, null, 2));
  }

  async register(name: string, fileName: string, exports: string[], env?: Record<string, string>) {
    const existing = this.data.graphs[name];
    this.data.graphs[name] = {
      name,
      fileName,
      active: true,
      deployedAt: new Date().toISOString(),
      exports,
      env: env ?? existing?.env,
    };
    await this.save();
  }

  async activate(name: string): Promise<boolean> {
    const entry = this.data.graphs[name];
    if (!entry) return false;
    entry.active = true;
    await this.save();
    return true;
  }

  async deactivate(name: string): Promise<boolean> {
    const entry = this.data.graphs[name];
    if (!entry) return false;
    entry.active = false;
    this.graphInstances.delete(name);
    await this.save();
    return true;
  }

  async remove(name: string): Promise<boolean> {
    const entry = this.data.graphs[name];
    if (!entry) return false;

    const filePath = join(this.dataDir, entry.fileName);
    const file = Bun.file(filePath);
    if (await file.exists()) {
      const { unlink } = await import("fs/promises");
      await unlink(filePath);
    }

    this.graphInstances.delete(name);
    delete this.data.graphs[name];
    await this.save();
    return true;
  }

  getEntry(name: string): GraphEntry | undefined {
    return this.data.graphs[name];
  }

  listAll(): GraphEntry[] {
    return Object.values(this.data.graphs);
  }

  setGraphInstance(name: string, instance: any) {
    this.graphInstances.set(name, instance);
  }

  getGraphInstance(name: string): any | undefined {
    return this.graphInstances.get(name);
  }

  getFilePath(name: string): string | undefined {
    const entry = this.data.graphs[name];
    if (!entry) return undefined;
    return join(this.dataDir, entry.fileName);
  }

  async setEnv(name: string, vars: Record<string, string>): Promise<boolean> {
    const entry = this.data.graphs[name];
    if (!entry) return false;
    entry.env = vars;
    await this.save();
    return true;
  }

  getEnv(name: string): Record<string, string> {
    return this.data.graphs[name]?.env ?? {};
  }

}
