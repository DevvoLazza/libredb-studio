"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import { readSchemaForDiff } from "@/lib/schema-diff/read-schema";
import { logger } from "@/lib/logger";

export function useSchemaDiffCurrent(
  connection: DatabaseConnection | null,
  sourceId: string,
  targetId: string,
  schemaRevision: readonly DetailedObject[],
) {
  const [generation, setGeneration] = useState(0);
  // The request identity also hides a previous result synchronously on render,
  // before the effect starts the new read. Even a briefly stale migration is wrong.
  const request = useMemo(
    () => ({ connection, sourceId, targetId, generation, schemaRevision }),
    [connection, sourceId, targetId, generation, schemaRevision],
  );
  const [reading, setReading] = useState<{
    request: typeof request;
    schema: readonly DetailedObject[] | null;
    error: string | null;
    readAt: Date | null;
  } | null>(null);
  const required = sourceId === "current" || targetId === "current";

  useEffect(() => {
    if (!required || !connection) return;
    const controller = new AbortController();
    let active = true;
    readSchemaForDiff(connection, controller.signal)
      .then((schema) => {
        if (active) setReading({ request, schema, error: null, readAt: new Date() });
      })
      .catch((error) => {
        if (!active) return;
        const message = error instanceof Error ? error.message : "Could not read the current schema";
        setReading({ request, schema: null, error: message, readAt: null });
        logger.warn("Failed to read the current schema for a diff", { route: "SchemaDiff", error: message });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [connection, required, request]);

  const result = reading?.request === request ? reading : null;
  const refresh = useCallback(() => setGeneration((value) => value + 1), []);
  return {
    schema: result?.schema ?? null,
    error: required ? (connection ? (result?.error ?? null) : "Select a connection to read the current schema.") : null,
    loading: required && connection !== null && result === null,
    readAt: result?.readAt ?? null,
    refresh,
  };
}
