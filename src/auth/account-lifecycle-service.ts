import argon2 from "argon2";
import type { Knex } from "knex";
import { createOpaqueToken, hashOpaqueToken } from "./token-crypto";

const ACTIVATION_TOKEN_LIFETIME_MS = 72 * 60 * 60 * 1000;
const PASSWORD_RESET_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const PASSWORD_RESET_WINDOW_MS = 24 * 60 * 60 * 1000;
const PASSWORD_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1
} as const;

type UserLifecycleRow = {
  id_usuario: string | number;
  email_institucional: string;
  email_pendente: string | null;
  hash_senha: string | null;
  ativado_em: Date | string | null;
  excluido_em: Date | string | null;
  contador_pedidos_redefinicao: number;
  inicio_janela_redefinicao: Date | string | null;
};

type TokenTable = "token_ativacao" | "token_redefinicao_senha";
type AccountState = Pick<UserLifecycleRow, "hash_senha" | "ativado_em" | "excluido_em">;

export type ActivationIssueResult =
  | { status: "not-found" }
  | { status: "already-active" }
  | { status: "issued"; recipient: string; token: string };

export type PasswordResetReservation =
  | { status: "not-reserved" }
  | { status: "reserved"; recipient: string; token: string };

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function databaseNow(transaction: Knex.Transaction): Promise<Date> {
  const result = await transaction.raw("SELECT clock_timestamp() AS database_now") as {
    rows: Array<{ database_now: Date | string }>;
  };
  return asDate(result.rows[0].database_now);
}

async function saveToken(
  transaction: Knex.Transaction,
  table: TokenTable,
  userId: string | number | null,
  tokenHash: Buffer,
  expiresAt: Date,
  shouldPersist = true
): Promise<void> {
  await transaction.raw(
    "DELETE FROM ?? WHERE id_usuario = ? AND ?::boolean",
    [table, userId, shouldPersist]
  );
  await transaction.raw(
    "INSERT INTO ?? (id_usuario, hash_token_sha256, expira_em) SELECT ?, ?, ? WHERE ?::boolean",
    [table, userId, tokenHash, expiresAt, shouldPersist]
  );
}

function isEligibleActiveAccount(account: AccountState): boolean {
  return account.ativado_em !== null
    && account.excluido_em === null
    && account.hash_senha !== null;
}

export async function issueActivationToken(knex: Knex, userId: string): Promise<ActivationIssueResult> {
  return knex.transaction(async (transaction) => {
    const account = await transaction("usuario")
      .select("id_usuario", "email_institucional", "email_pendente", "ativado_em", "excluido_em")
      .where({ id_usuario: userId })
      .forUpdate()
      .first() as Pick<UserLifecycleRow,
        "id_usuario" | "email_institucional" | "email_pendente" | "ativado_em" | "excluido_em"> | undefined;

    if (!account || account.excluido_em !== null) return { status: "not-found" };
    if (account.ativado_em !== null) return { status: "already-active" };

    const token = createOpaqueToken();
    const now = await databaseNow(transaction);
    await saveToken(
      transaction,
      "token_ativacao",
      account.id_usuario,
      hashOpaqueToken(token),
      new Date(now.getTime() + ACTIVATION_TOKEN_LIFETIME_MS)
    );
    return { status: "issued", recipient: account.email_pendente ?? account.email_institucional, token };
  });
}

export async function reservePasswordReset(
  knex: Knex,
  email: string
): Promise<PasswordResetReservation> {
  const token = createOpaqueToken();
  const tokenHash = hashOpaqueToken(token);

  return knex.transaction(async (transaction) => {
    const account = await transaction("usuario")
      .select(
        "id_usuario",
        "email_institucional",
        "hash_senha",
        "ativado_em",
        "excluido_em",
        "contador_pedidos_redefinicao",
        "inicio_janela_redefinicao"
      )
      .where({ email_institucional: email })
      .forUpdate()
      .first() as UserLifecycleRow | undefined;

    const now = await databaseNow(transaction);
    const accountIsEligible = account !== undefined && isEligibleActiveAccount(account);
    const startedAt = account?.inicio_janela_redefinicao
      ? asDate(account.inicio_janela_redefinicao)
      : undefined;
    const windowIsCurrent = startedAt !== undefined
      && now.getTime() < startedAt.getTime() + PASSWORD_RESET_WINDOW_MS;
    const requestsInWindow = windowIsCurrent && account
      ? account.contador_pedidos_redefinicao
      : 0;
    const shouldReserve = accountIsEligible && requestsInWindow < 3;

    const windowStartedAt = windowIsCurrent ? startedAt : now;
    await transaction("usuario")
      .where({ email_institucional: email })
      .whereRaw("?::boolean", [shouldReserve])
      .update({
        contador_pedidos_redefinicao: requestsInWindow + 1,
        inicio_janela_redefinicao: windowStartedAt
      });
    await saveToken(
      transaction,
      "token_redefinicao_senha",
      account?.id_usuario ?? null,
      tokenHash,
      new Date(now.getTime() + PASSWORD_RESET_TOKEN_LIFETIME_MS),
      shouldReserve
    );

    if (!shouldReserve || !account) return { status: "not-reserved" };
    return { status: "reserved", recipient: account.email_institucional, token };
  });
}

function validOpaqueToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, PASSWORD_HASH_OPTIONS);
}

class LifecycleStateChanged extends Error {}

async function consumeTokenAndUpdateAccount(
  knex: Knex,
  table: TokenTable,
  userId: string | number,
  tokenHash: Buffer,
  passwordHash: string,
  activate: boolean
): Promise<boolean> {
  try {
    return await knex.transaction(async (transaction) => {
      const account = await transaction("usuario")
        .select("id_usuario", "hash_senha", "email_pendente", "ativado_em", "excluido_em")
        .where({ id_usuario: userId })
        .forUpdate()
        .first() as Pick<UserLifecycleRow,
          "id_usuario" | "hash_senha" | "email_pendente" | "ativado_em" | "excluido_em"> | undefined;
      if (!account || account.excluido_em !== null) return false;
      if (activate ? account.ativado_em !== null : !isEligibleActiveAccount(account)) return false;

      const activeSessions = await transaction("sessao")
        .select("id_sessao")
        .where({ id_usuario: userId })
        .whereNull("revogada_em")
        .orderBy("id_sessao")
        .forUpdate() as Array<{ id_sessao: string | number }>;

      const consumed = await transaction(table)
        .where({ id_usuario: userId, hash_token_sha256: tokenHash })
        .whereRaw("expira_em > clock_timestamp()")
        .delete()
        .returning("id_usuario") as Array<{ id_usuario: string | number }>;
      if (consumed.length !== 1) return false;

      let userUpdate = transaction("usuario")
        .where({ id_usuario: userId })
        .whereNull("excluido_em");
      if (activate) userUpdate = userUpdate.whereNull("ativado_em");
      else userUpdate = userUpdate.whereNotNull("ativado_em");

      const update = activate
        ? {
            hash_senha: passwordHash,
            ...(account.email_pendente === null ? {} : {
              email_institucional: account.email_pendente,
              email_pendente: null
            }),
            ativado_em: transaction.raw("clock_timestamp()")
          }
        : {
          hash_senha: passwordHash,
          contador_pedidos_redefinicao: 0,
          inicio_janela_redefinicao: null
        };
      const updated = await userUpdate.update(update).returning("id_usuario") as Array<{ id_usuario: string | number }>;
      if (updated.length !== 1) throw new LifecycleStateChanged();

      if (!activate || account.email_pendente !== null) {
        await transaction("sessao").whereIn("id_sessao", activeSessions.map((session) => session.id_sessao))
          .whereNull("revogada_em")
          .update({ revogada_em: transaction.raw("clock_timestamp()") });
      }
      return true;
    });
  } catch (error) {
    if (error instanceof LifecycleStateChanged) return false;
    throw error;
  }
}

async function consumePasswordToken(
  knex: Knex,
  table: TokenTable,
  token: string,
  password: string,
  activate: boolean
): Promise<boolean> {
  if (!validOpaqueToken(token)) return false;
  const tokenHash = hashOpaqueToken(token);
  const tokenRow = await knex(table)
    .select("id_usuario")
    .where({ hash_token_sha256: tokenHash })
    .whereRaw("expira_em > clock_timestamp()")
    .first() as Pick<UserLifecycleRow, "id_usuario"> | undefined;
  if (!tokenRow) return false;

  const account = await knex("usuario")
    .select("id_usuario", "hash_senha", "ativado_em", "excluido_em")
    .where({ id_usuario: tokenRow.id_usuario })
    .first() as Pick<UserLifecycleRow, "id_usuario" | "hash_senha" | "ativado_em" | "excluido_em"> | undefined;
  if (!account || account.excluido_em !== null) return false;
  if (activate ? account.ativado_em !== null : !isEligibleActiveAccount(account)) return false;

  // Argon2 runs before the transaction so database locks are not held during hashing.
  const passwordHash = await hashPassword(password);
  return consumeTokenAndUpdateAccount(knex, table, tokenRow.id_usuario, tokenHash, passwordHash, activate);
}

export function activateAccount(knex: Knex, token: string, password: string): Promise<boolean> {
  return consumePasswordToken(knex, "token_ativacao", token, password, true);
}

export function completePasswordReset(knex: Knex, token: string, password: string): Promise<boolean> {
  return consumePasswordToken(knex, "token_redefinicao_senha", token, password, false);
}

export async function deleteExpiredLifecycleTokens(knex: Knex): Promise<number> {
  return knex.transaction(async (transaction) => {
    const activations = await transaction("token_ativacao")
      .whereRaw("expira_em <= clock_timestamp()")
      .delete();
    const resets = await transaction("token_redefinicao_senha")
      .whereRaw("expira_em <= clock_timestamp()")
      .delete();
    return Number(activations) + Number(resets);
  });
}
