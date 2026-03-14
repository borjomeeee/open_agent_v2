import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  startE2EServer,
  e2eFetch,
  e2eDeployGraph,
  json,
  BUILDER_GRAPH_CODE,
  type E2EContext,
} from "../helpers/e2e-setup.ts";

describe("E2E: Graph lifecycle", () => {
  let ctx: E2EContext;

  beforeEach(async () => {
    ctx = await startE2EServer();
  });

  afterEach(async () => {
    await ctx.cleanup();
  });

  test("full lifecycle: deploy → list → stop → start → delete", async () => {
    const deployRes = await e2eDeployGraph(ctx.baseUrl, "lifecycle");
    expect(deployRes.status).toBe(200);
    const deployBody = await json(deployRes);
    expect(deployBody.message).toContain("deployed and activated");
    expect(deployBody.exports).toContain("graph");

    const listRes = await e2eFetch(ctx.baseUrl, "/api/graphs");
    expect(listRes.status).toBe(200);
    const { graphs } = await json(listRes);
    expect(graphs.length).toBe(1);
    expect(graphs[0].name).toBe("lifecycle");
    expect(graphs[0].active).toBe(true);

    const stopRes = await e2eFetch(ctx.baseUrl, "/api/graphs/lifecycle/stop", {
      method: "POST",
    });
    expect(stopRes.status).toBe(200);

    const detailRes = await e2eFetch(ctx.baseUrl, "/api/graphs/lifecycle");
    expect(detailRes.status).toBe(200);
    const detail = await json(detailRes);
    expect(detail.active).toBe(false);

    const startRes = await e2eFetch(ctx.baseUrl, "/api/graphs/lifecycle/start", {
      method: "POST",
    });
    expect(startRes.status).toBe(200);

    const detailRes2 = await e2eFetch(ctx.baseUrl, "/api/graphs/lifecycle");
    const detail2 = await json(detailRes2);
    expect(detail2.active).toBe(true);

    const delRes = await e2eFetch(ctx.baseUrl, "/api/graphs/lifecycle", {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);

    const listRes2 = await e2eFetch(ctx.baseUrl, "/api/graphs");
    const { graphs: remaining } = await json(listRes2);
    expect(remaining.length).toBe(0);
  });

  test("deploy multiple graphs and list them", async () => {
    await e2eDeployGraph(ctx.baseUrl, "alpha");
    await e2eDeployGraph(ctx.baseUrl, "beta");
    await e2eDeployGraph(ctx.baseUrl, "gamma");

    const listRes = await e2eFetch(ctx.baseUrl, "/api/graphs");
    const { graphs } = await json(listRes);
    expect(graphs.length).toBe(3);

    const names = graphs.map((g: any) => g.name).sort();
    expect(names).toEqual(["alpha", "beta", "gamma"]);
  });

  test("redeploy overwrites existing graph", async () => {
    await e2eDeployGraph(ctx.baseUrl, "echo");
    const res = await e2eDeployGraph(ctx.baseUrl, "echo");
    expect(res.status).toBe(200);

    const listRes = await e2eFetch(ctx.baseUrl, "/api/graphs");
    const { graphs } = await json(listRes);
    expect(graphs.length).toBe(1);
  });

  test("deploy with env vars and verify masking", async () => {
    const res = await e2eFetch(ctx.baseUrl, "/api/graphs/deploy", {
      method: "POST",
      body: JSON.stringify({
        name: "env-graph",
        code: BUILDER_GRAPH_CODE,
        env: { SECRET_TOKEN: "super-secret-123" },
      }),
    });
    expect(res.status).toBe(200);

    const envRes = await e2eFetch(ctx.baseUrl, "/api/graphs/env-graph/env");
    expect(envRes.status).toBe(200);
    const { env } = await json(envRes);
    expect(env).toHaveProperty("SECRET_TOKEN");
    expect(env.SECRET_TOKEN).not.toBe("super-secret-123");
    expect(env.SECRET_TOKEN).toContain("****");
  });

  test("set env vars after deploy", async () => {
    await e2eDeployGraph(ctx.baseUrl, "echo");

    const putRes = await e2eFetch(ctx.baseUrl, "/api/graphs/echo/env", {
      method: "PUT",
      body: JSON.stringify({ vars: { API_TOKEN: "tok-123" } }),
    });
    expect(putRes.status).toBe(200);

    const getRes = await e2eFetch(ctx.baseUrl, "/api/graphs/echo/env");
    const { env } = await json(getRes);
    expect(env).toHaveProperty("API_TOKEN");
    expect(env.API_TOKEN).toContain("****");
  });
});
