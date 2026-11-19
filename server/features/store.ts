import { and, eq } from "drizzle-orm";
import { drizzle, type MySql2Database } from "drizzle-orm/mysql2";
import mysql, { type Pool } from "mysql2/promise";
import { appRecords } from "../../drizzle/schema";

let pool: Pool | undefined;
let db: MySql2Database | undefined;

/** A small pool shared by feature records; there is no in-memory production fallback. */
export function database(): MySql2Database {
  if (!db) {
    if (!process.env.DATABASE_URL)
      throw Object.assign(new Error("Database is unavailable"), {
        status: 503,
      });
    pool = mysql.createPool({
      uri: process.env.DATABASE_URL,
      connectionLimit: 5,
      waitForConnections: true,
      queueLimit: 100,
    });
    db = drizzle(pool);
  }
  return db;
}

export async function closeStore() {
  const old = pool;
  pool = undefined;
  db = undefined;
  await old?.end();
}

export async function list<T>(kind: string): Promise<T[]> {
  const rows = await database()
    .select({ payload: appRecords.payload })
    .from(appRecords)
    .where(eq(appRecords.kind, kind));
  return rows.map(row => row.payload as T);
}

export async function get<T>(kind: string, id: string): Promise<T | undefined> {
  const [row] = await database()
    .select({ payload: appRecords.payload })
    .from(appRecords)
    .where(and(eq(appRecords.kind, kind), eq(appRecords.id, id)))
    .limit(1);
  return row?.payload as T | undefined;
}

export async function create<T extends { id: string }>(
  kind: string,
  ownerId: number,
  data: T
): Promise<T> {
  await database()
    .insert(appRecords)
    .values({ id: data.id, kind, ownerId, payload: data });
  return data;
}

/** The callback is synchronous and executes while the row is locked. Throwing rolls back. */
export async function mutate<T>(
  kind: string,
  id: string,
  fn: (value: T) => T
): Promise<T> {
  return database().transaction(async tx => {
    const [row] = await tx
      .select()
      .from(appRecords)
      .where(and(eq(appRecords.kind, kind), eq(appRecords.id, id)))
      .limit(1)
      .for("update");
    if (!row)
      throw Object.assign(new Error("Record not found"), { status: 404 });
    const next = fn(structuredClone(row.payload) as T);
    if ((next as { id?: string })?.id !== id)
      throw new Error("Record identity cannot change");
    await tx
      .update(appRecords)
      .set({ payload: next, revision: row.revision + 1, updatedAt: new Date() })
      .where(and(eq(appRecords.id, id), eq(appRecords.kind, kind)));
    return next;
  });
}

export async function remove(kind: string, id: string): Promise<void> {
  await database()
    .delete(appRecords)
    .where(and(eq(appRecords.kind, kind), eq(appRecords.id, id)));
}
