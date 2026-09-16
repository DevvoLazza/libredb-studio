import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readSchemaForDiff } from "@/lib/schema-diff/read-schema";
import { mockPostgresConnection } from "../../fixtures/connections";

const originalFetch = globalThis.fetch;
const meta = {
  capabilities: {
    objectKinds: [
      { id: "custom-relation", role: "relation", label: "Relation", labelPlural: "Relations" },
      { id: "procedure", role: "routine", label: "Procedure", labelPlural: "Procedures" },
    ],
  },
};
const inventory = {
  objects: [{ name: "a.b", kind: "custom-relation", path: ["tenant", "a.b"] }],
  details: [
    {
      path: ["tenant", "a.b"],
      columns: [{ name: "new_column", type: "text", nullable: true, isPrimary: false }],
      indexes: [{ name: "idx_new", columns: ["new_column"], unique: false }],
      foreignKeys: [{ columnName: "new_column", referencedTable: "lookup", referencedColumn: "id" }],
    },
  ],
};
let metaResponse: () => Response;
let inventoryResponse: () => Response;
const fetchSchema = mock(async (url: string) => (url.includes("provider-meta") ? metaResponse() : inventoryResponse()));
beforeEach(() => {
  metaResponse = () => Response.json(meta);
  inventoryResponse = () => Response.json(inventory);
  fetchSchema.mockClear();
  globalThis.fetch = fetchSchema as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("live schema reads for diff and snapshot", () => {
  test("reads relation kinds, exact paths, columns, indexes and foreign keys with no-store", async () => {
    const controller = new AbortController();
    const result = await readSchemaForDiff(mockPostgresConnection, controller.signal);
    expect(result).toEqual([{ ...inventory.objects[0], ...inventory.details[0] }]);
    const calls = fetchSchema.mock.calls as unknown as [string, RequestInit][];
    expect(calls.map(([url]) => url)).toEqual(["/api/db/provider-meta", "/api/db/objects/inventory"]);
    for (const [, init] of calls) {
      expect(init.method).toBe("POST");
      expect(init.cache).toBe("no-store");
      expect(init.signal).toBe(controller.signal);
    }
    expect(JSON.parse(calls[1][1].body as string).kinds).toEqual(["custom-relation"]);
    expect(JSON.parse(calls[1][1].body as string).includeColumns).toBe(true);
  });
  test("repeated calls read the database again", async () => {
    await readSchemaForDiff(mockPostgresConnection);
    inventoryResponse = () => Response.json({ objects: [], details: [] });
    expect(await readSchemaForDiff(mockPostgresConnection)).toEqual([]);
    expect(fetchSchema).toHaveBeenCalledTimes(4);
  });
  test("uses the seed identity only for managed connections with a seed", async () => {
    await readSchemaForDiff({ ...mockPostgresConnection, managed: true, seedId: "demo" });
    const calls = fetchSchema.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(calls[0][1].body as string)).toEqual({ connectionId: "seed:demo" });
    fetchSchema.mockClear();
    await readSchemaForDiff({ ...mockPostgresConnection, managed: true });
    const fallback = fetchSchema.mock.calls as unknown as [string, RequestInit][];
    expect(JSON.parse(fallback[0][1].body as string).connection.id).toBe(mockPostgresConnection.id);
  });
  test.each(["metadata", "inventory"])("propagates %s errors without producing an empty schema", async (stage) => {
    const failure = () => Response.json({ error: "Read denied" }, { status: 403 });
    if (stage === "metadata") metaResponse = failure;
    else inventoryResponse = failure;
    await expect(readSchemaForDiff(mockPostgresConnection)).rejects.toThrow("Read denied");
  });
  test("HTTP errors without a message include the status", async () => {
    metaResponse = () => Response.json({}, { status: 503 });
    await expect(readSchemaForDiff(mockPostgresConnection)).rejects.toThrow("503");
  });
  test("invalid JSON is a failed read", async () => {
    inventoryResponse = () => new Response("not-json");
    await expect(readSchemaForDiff(mockPostgresConnection)).rejects.toThrow();
  });
  test("an engine with no relation kinds is not an empty successful schema", async () => {
    metaResponse = () => Response.json({ capabilities: { objectKinds: [meta.capabilities.objectKinds[1]] } });
    await expect(readSchemaForDiff(mockPostgresConnection)).rejects.toThrow("no object kinds");
    expect(fetchSchema).toHaveBeenCalledTimes(1);
  });
  test.each([{ details: [] }, { objects: [] }, { objects: null, details: [] }, { objects: [], details: {} }])(
    "missing inventory arrays are rejected (%#)",
    async (data) => {
      inventoryResponse = () => Response.json(data);
      await expect(readSchemaForDiff(mockPostgresConnection)).rejects.toThrow("missing object or column details");
    },
  );
  test("an aborted metadata read never proceeds to the inventory", async () => {
    const controller = new AbortController();
    metaResponse = () => {
      controller.abort();
      return Response.json(meta);
    };
    await expect(readSchemaForDiff(mockPostgresConnection, controller.signal)).rejects.toThrow();
    expect(fetchSchema).toHaveBeenCalledTimes(1);
  });
});
