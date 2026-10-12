import knexFactory, { type Knex } from "knex";
import { configurePostgresTimeZone } from "./postgres-timezone";

let workerKnex: Knex | undefined;

function requiredSetting(name: string): string {
  const value = process.env[name];
  const isBlankIdentifier = name !== "PGPASSWORD" && value?.trim().length === 0;
  if (typeof value !== "string" || value.length === 0 || isBlankIdentifier) {
    throw new Error("Database configuration is incomplete.");
  }
  return value;
}

export function parsePostgresPort(value: string | undefined): number {
  if (value === undefined) {
    return 5432;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error("Database configuration is incomplete.");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("Database configuration is incomplete.");
  }
  return port;
}

export function getKnex(): Knex {
  if (!workerKnex) {
    workerKnex = knexFactory({
      client: "pg",
      connection: {
        host: process.env.PGHOST || "127.0.0.1",
        port: parsePostgresPort(process.env.PGPORT),
        database: requiredSetting("PGDATABASE"),
        user: requiredSetting("PGUSER"),
        password: requiredSetting("PGPASSWORD"),
        connectionTimeoutMillis: 2500,
        query_timeout: 2500,
        statement_timeout: 2500
      },
      pool: {
        min: 0,
        max: 5,
        acquireTimeoutMillis: 2500,
        afterCreate: configurePostgresTimeZone
      },
      compileSqlOnError: false,
      log: {
        warn: () => undefined,
        error: () => undefined,
        deprecate: () => undefined,
        debug: () => undefined
      }
    });
  }

  return workerKnex;
}

export async function closeKnex(): Promise<void> {
  if (workerKnex) {
    const current = workerKnex;
    workerKnex = undefined;
    await current.destroy();
  }
}
