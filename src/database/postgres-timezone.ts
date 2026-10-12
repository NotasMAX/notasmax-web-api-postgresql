type PostgresConnection = {
  query: (queryText: string, callback: (error?: Error | null) => void) => unknown;
};

type ConnectionCreated = (error: Error | null, connection: PostgresConnection) => void;

export const POSTGRES_BUSINESS_TIME_ZONE = "America/Sao_Paulo";

export function configurePostgresTimeZone(
  connection: PostgresConnection,
  done: ConnectionCreated
): void {
  connection.query(`SET TIME ZONE '${POSTGRES_BUSINESS_TIME_ZONE}'`, (error) => {
    done(error ?? null, connection);
  });
}
