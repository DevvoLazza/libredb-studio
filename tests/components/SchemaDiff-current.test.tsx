import "../setup-dom";
import "../helpers/mock-sonner";
import "../helpers/mock-navigation";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import React from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { SchemaSnapshot } from "@/lib/types";
import { mockPostgresConnection } from "../fixtures/connections";
import type { DetailedObject } from "@/lib/db/detailed-object";

let snapshots: SchemaSnapshot[] = [];
const saveSnapshot = mock((snapshot: SchemaSnapshot) => snapshots.push(snapshot));
mock.module("@/lib/storage", () => ({
  storage: {
    getSchemaSnapshots: () => [...snapshots],
    saveSchemaSnapshot: saveSnapshot,
    deleteSchemaSnapshot: () => {},
  },
}));
mock.module("@/hooks/use-all-connections", () => ({ useAllConnections: () => ({ connections: [] }) }));
mock.module("@/components/SnapshotTimeline", () => ({ SnapshotTimeline: () => null }));
mock.module("@/components/ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: React.ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

import { SchemaDiff } from "@/components/SchemaDiff";

const connection = { ...mockPostgresConnection, type: "sqlite" as const };
const before: DetailedObject[] = [
  {
    name: "people",
    kind: "table",
    path: ["people"],
    columns: [{ name: "id", type: "INTEGER", nullable: false, isPrimary: true }],
    indexes: [],
    foreignKeys: [],
  },
];
const after: DetailedObject[] = [
  {
    ...before[0],
    columns: [...before[0].columns, { name: "nickname", type: "TEXT", nullable: true, isPrimary: false }],
  },
];
const originalFetch = globalThis.fetch;
let inventory: () => unknown;
let requests: { url: string; init?: RequestInit }[];
const fetchSchema = mock(async (url: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(url), init });
  return Response.json(
    String(url).includes("provider-meta")
      ? {
          capabilities: {
            objectKinds: [
              { id: "table", role: "relation", label: "Table", labelPlural: "Tables" },
              { id: "routine", role: "routine", label: "Routine", labelPlural: "Routines" },
            ],
          },
        }
      : await inventory(),
  );
});

function response(schema = before) {
  return {
    objects: schema.map(({ name, kind, path }) => ({ name, kind, path })),
    details: schema.map(({ path, columns, indexes, foreignKeys }) => ({ path, columns, indexes, foreignKeys })),
  };
}
function compare(view: ReturnType<typeof render>, source = "baseline", target = "current") {
  const selects = view.getAllByRole("combobox");
  fireEvent.change(selects[0], { target: { value: source } });
  fireEvent.change(selects[1], { target: { value: target } });
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  snapshots = [
    {
      id: "baseline",
      connectionId: connection.id,
      connectionName: connection.name,
      databaseType: connection.type,
      schema: structuredClone(before),
      createdAt: new Date(0),
      label: "Before DDL",
    },
  ];
  requests = [];
  inventory = () => response(before);
  saveSnapshot.mockClear();
  fetchSchema.mockClear();
  globalThis.fetch = fetchSchema as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("Schema Diff reads the database for current schemas (#884)", () => {
  test("a real SQLite ALTER TABLE is visible without changing the cached prop, including migration SQL", async () => {
    const db = new Database(":memory:");
    try {
      db.exec("CREATE TABLE people (id INTEGER PRIMARY KEY NOT NULL)");
      inventory = () =>
        response([
          {
            ...before[0],
            columns: db
              .query<{ name: string; type: string; notnull: number; pk: number }, []>("PRAGMA table_info(people)")
              .all()
              .map((column) => ({
                name: column.name,
                type: column.type,
                nullable: !column.notnull,
                isPrimary: !!column.pk,
              })),
          },
        ]);
      const view = render(<SchemaDiff schema={before} connection={connection} />);
      fireEvent.click(view.getByText("Snapshot"));
      await act(async () => {
        fireEvent.click(view.getByText("Save"));
      });
      expect(saveSnapshot).toHaveBeenCalledTimes(1);
      expect(snapshots[1].schema).toEqual(before);
      db.exec("ALTER TABLE people ADD COLUMN nickname TEXT");
      compare(view);
      await waitFor(() => expect(view.queryByText("0 added, 0 removed, 1 modified")).toBeTruthy());
      fireEvent.click(view.getByText("people"));
      expect(view.getByText("nickname")).toBeTruthy();
      fireEvent.click(view.getByText("SQL Migration"));
      expect(view.container.querySelector("pre")?.textContent).toContain('ADD COLUMN "nickname" TEXT');
      expect(before[0].columns).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("current as the source is also fresh", async () => {
    inventory = () => response(after);
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view, "current", "baseline");
    await waitFor(() => expect(view.queryByText("SQL Migration")).toBeTruthy());
    fireEvent.click(view.getByText("SQL Migration"));
    expect(view.container.querySelector("pre")?.textContent).toContain('Cannot drop column "nickname"');
    const body = JSON.parse(requests.find(({ url }) => url.includes("inventory"))!.init!.body as string);
    expect(body.kinds).toEqual(["table"]);
    expect(body.includeColumns).toBe(true);
  });

  test("saving a snapshot re-reads after DDL even when the panel is already open", async () => {
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    await act(async () => {});
    inventory = () => response(after);
    fireEvent.click(view.getByText("Snapshot"));
    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });
    expect(snapshots[1].schema).toEqual(after);
  });

  test("a fresh snapshot also refreshes an already displayed current comparison", async () => {
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.queryByText("No differences found between source and target")).toBeTruthy());
    inventory = () => response(after);
    fireEvent.click(view.getByText("Snapshot"));
    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });
    expect(snapshots[1].schema).toEqual(after);
    expect(view.queryByText("SQL Migration")).toBeTruthy();
  });

  test("pending reads never display no differences or stale migration SQL", async () => {
    const pending = deferred();
    inventory = () => pending.promise;
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    expect(view.queryByText("No differences found between source and target")).toBeNull();
    expect(view.queryByText("SQL Migration")).toBeNull();
    expect(view.getByText("Reading current schema...")).toBeTruthy();
    await act(async () => {
      pending.resolve(response(after));
    });
    await waitFor(() => expect(view.queryByText("SQL Migration")).toBeTruthy());
  });

  test("failed reads show a visible error and can be retried", async () => {
    inventory = () => {
      throw new Error("Catalog unavailable");
    };
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Catalog unavailable"));
    expect(view.queryByText("No differences found between source and target")).toBeNull();
    inventory = () => response(after);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Refresh current schema" }));
    });
    await waitFor(() => expect(view.queryByText("SQL Migration")).toBeTruthy());
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.container.querySelector("time")?.dateTime).toBeTruthy();
  });

  test("refresh replaces the previous result and safely clears a removed selected table", async () => {
    inventory = () => response(after);
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.queryByText("SQL Migration")).toBeTruthy());
    fireEvent.click(view.getByText("people"));
    expect(view.getByText("nickname")).toBeTruthy();
    inventory = () => response(before);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Refresh current schema" }));
    });
    expect(view.getByText("No differences found between source and target")).toBeTruthy();
    inventory = () => response([]);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Refresh current schema" }));
    });
    expect(view.queryByText("SQL Migration")).toBeTruthy();
  });

  test("a failed refresh hides previous migration SQL", async () => {
    inventory = () => response(after);
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.queryByText("SQL Migration")).toBeTruthy());
    fireEvent.click(view.getByText("SQL Migration"));
    inventory = () => {
      throw new Error("Read failed");
    };
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Refresh current schema" }));
    });
    expect(view.getByRole("alert").textContent).toContain("Read failed");
    expect(view.container.querySelector("pre")).toBeNull();
  });

  test("connection switches ignore a slow previous read", async () => {
    const pending = deferred();
    inventory = () => pending.promise;
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await act(async () => {});
    inventory = () => response(before);
    const next = { ...connection, id: "other", name: "Other DB" };
    await act(async () => {
      view.rerender(<SchemaDiff schema={before} connection={next} />);
    });
    await act(async () => {
      pending.resolve(response(after));
    });
    expect(view.getByText("No differences found between source and target")).toBeTruthy();
    expect(view.queryByText("SQL Migration")).toBeNull();
  });

  test("failed snapshot reads never persist cached data", async () => {
    inventory = () => {
      throw new Error("Snapshot read failed");
    };
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    fireEvent.click(view.getByText("Snapshot"));
    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
    expect(view.getByRole("alert").textContent).toContain("Snapshot read failed");
    expect(view.getByText("Save")).toBeTruthy();
  });

  test("cancelling a failed snapshot clears its error and re-reads the current comparison", async () => {
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.queryByText("No differences found between source and target")).toBeTruthy());
    inventory = () => {
      throw new Error("Snapshot temporarily unavailable");
    };
    fireEvent.click(view.getByText("Snapshot"));
    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });
    expect(view.getByRole("alert").textContent).toContain("Snapshot temporarily unavailable");
    inventory = () => response(after);
    await act(async () => {
      fireEvent.click(view.getByText("Cancel"));
    });
    expect(view.queryByRole("alert")).toBeNull();
    expect(view.queryByText("SQL Migration")).toBeTruthy();
  });

  test.each(["switch", "unmount"])("a pending snapshot does not save after %s", async (action) => {
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    await act(async () => {});
    const pending = deferred();
    inventory = () => pending.promise;
    fireEvent.click(view.getByText("Snapshot"));
    act(() => {
      fireEvent.click(view.getByText("Save"));
    });
    await act(async () => {});
    if (action === "switch") view.rerender(<SchemaDiff schema={before} connection={{ ...connection, id: "other" }} />);
    else view.unmount();
    await act(async () => {
      pending.resolve(response(after));
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
  });

  test("managed sample reads use the server's seed identity", async () => {
    const view = render(<SchemaDiff schema={before} connection={{ ...connection, managed: true, seedId: "sample" }} />);
    compare(view);
    await waitFor(() => expect(view.queryByText("No differences found between source and target")).toBeTruthy());
    for (const { init } of requests) {
      const body = JSON.parse(init!.body as string);
      expect(body.connectionId).toBe("seed:sample");
      expect(body.connection).toBeUndefined();
    }
  });

  test("saved snapshots can be compared without a current database connection", async () => {
    snapshots.push({ ...snapshots[0], id: "after", schema: after });
    const view = render(<SchemaDiff schema={before} connection={null} />);
    compare(view, "baseline", "after");
    await waitFor(() => expect(view.queryByText("SQL Migration")).toBeTruthy());
    expect(requests).toHaveLength(0);
  });

  test("current cannot silently use the cached prop when disconnected", async () => {
    const view = render(<SchemaDiff schema={before} connection={null} />);
    compare(view);
    expect(view.getByRole("alert").textContent).toContain("Select a connection");
    expect(view.queryByText("No differences found between source and target")).toBeNull();
  });

  test("a changed explorer schema triggers a new database read, not a comparison of the prop", async () => {
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.queryByText("No differences found between source and target")).toBeTruthy());
    const count = requests.length;
    inventory = () => response(after);
    await act(async () => {
      view.rerender(<SchemaDiff schema={[...before]} connection={connection} />);
    });
    expect(requests.length).toBeGreaterThan(count);
    expect(view.queryByText("SQL Migration")).toBeTruthy();
  });

  test("a bounded inventory is not treated as a complete diff or snapshot", async () => {
    inventory = () => ({ ...response(after), truncated: { limit: 1, reason: "Object limit reached" } });
    const view = render(<SchemaDiff schema={before} connection={connection} />);
    compare(view);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Object limit reached"));
    expect(view.queryByText("SQL Migration")).toBeNull();
    fireEvent.click(view.getByText("Snapshot"));
    await act(async () => {
      fireEvent.click(view.getByText("Save"));
    });
    expect(saveSnapshot).not.toHaveBeenCalled();
  });
});
