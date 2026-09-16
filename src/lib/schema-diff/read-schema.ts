import { appFetch } from "@/lib/config/base-path";
import { detailedObjects, type DetailedObject } from "@/lib/db/detailed-object";
import { relationKindIds } from "@/lib/db/object-kinds";
import type { DatabaseConnection } from "@/lib/types";

/** Read the live object surface, never the explorer's cached schema. */
export async function readSchemaForDiff(
  connection: DatabaseConnection,
  signal?: AbortSignal,
): Promise<readonly DetailedObject[]> {
  const payload =
    connection.managed && connection.seedId ? { connectionId: `seed:${connection.seedId}` } : { connection };
  const post = async (path: string, body: unknown) => {
    const response = await appFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Could not read the schema (${response.status})`);
    return data;
  };
  const meta = await post("/api/db/provider-meta", payload);
  const kinds = relationKindIds(meta.capabilities);
  if (kinds.length === 0) throw new Error(`${connection.name} declares no object kinds a schema diff can compare`);
  signal?.throwIfAborted();
  const data = await post("/api/db/objects/inventory", { ...payload, kinds, includeColumns: true });
  // A bounded reading cannot prove a table or column is absent, so it cannot
  // safely produce a migration or a saved snapshot claiming to be complete.
  if (data.truncated) throw new Error(`The schema read is incomplete: ${data.truncated.reason}`);
  if (!Array.isArray(data.objects) || !Array.isArray(data.details)) {
    throw new Error("The schema response is missing object or column details");
  }
  return detailedObjects(data.objects, data.details);
}
