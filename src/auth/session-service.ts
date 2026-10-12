import argon2 from "argon2";
import type { Knex } from "knex";
import { createOpaqueToken, hashOpaqueToken } from "./token-crypto";

const DUMMY_PASSWORD_HASH = "$argon2id$v=19$m=19456,p=1,t=2$E5lArmfMnm3PLlR9RW99vA$/PvdykPSvRk69SAli+gXX3DaVYIqOY1DvOGVCReZLXA";
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
const ACCOUNT_RECHECK_ATTEMPTS = 3;

export class AdminSessionRevokedError extends Error {
  constructor() {
    super("Administrator session is no longer valid.");
    this.name = "AdminSessionRevokedError";
  }
}

type AccountRow = {
  id_usuario: string | number;
  email_institucional: string;
  tipo_perfil: string;
  nome_completo: string;
  hash_senha: string | null;
  ativado_em: Date | string | null;
  excluido_em: Date | string | null;
  falhas_login_na_janela: number;
  inicio_janela_falhas_login: Date | string | null;
  bloqueado_ate: Date | string | null;
};

type SessionRow = {
  id_sessao: string | number;
  id_usuario: string | number;
  expira_em: Date | string;
  expira_absoluta_em: Date | string;
};

type IdentityRow = Pick<AccountRow, "id_usuario" | "tipo_perfil" | "nome_completo">;
type LoginFailureState = Pick<AccountRow,
  "falhas_login_na_janela" | "inicio_janela_falhas_login" | "bloqueado_ate">;

export type SessionIdentity = {
  id: string;
  displayName: string;
  profile: string;
};

export type LoginResult =
  | { success: true; token: string; user: SessionIdentity }
  | { success: false };

export type CurrentSessionResult =
  | { authenticated: false }
  | { authenticated: true; user: SessionIdentity };

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

async function databaseNow(transaction: Knex.Transaction): Promise<Date> {
  const result = await transaction.raw("SELECT clock_timestamp() AS database_now") as {
    rows: Array<{ database_now: Date | string }>;
  };
  return asDate(result.rows[0].database_now);
}

function identity(account: IdentityRow): SessionIdentity {
  return {
    id: String(account.id_usuario),
    displayName: account.nome_completo,
    profile: account.tipo_perfil
  };
}

async function verifyPasswordHash(hash: string | null | undefined, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash || DUMMY_PASSWORD_HASH, password);
  } catch (error) {
    if (!hash) throw error;
    await argon2.verify(DUMMY_PASSWORD_HASH, password);
    return false;
  }
}

function accountIsBlocked(account: Pick<AccountRow, "bloqueado_ate">, now: Date): boolean {
  return account.bloqueado_ate !== null
    && asDate(account.bloqueado_ate).getTime() > now.getTime();
}

function nextLoginFailureState(account: LoginFailureState, now: Date) {
  const windowStartedAt = account.inicio_janela_falhas_login
    ? asDate(account.inicio_janela_falhas_login)
    : undefined;
  const windowIsCurrent = windowStartedAt !== undefined
    && windowStartedAt.getTime() > now.getTime() - FAILURE_WINDOW_MS;
  const failures = windowIsCurrent ? account.falhas_login_na_janela + 1 : 1;
  return {
    falhas_login_na_janela: failures,
    inicio_janela_falhas_login: windowIsCurrent ? windowStartedAt : now,
    bloqueado_ate: failures >= 5 ? new Date(now.getTime() + LOCKOUT_MS) : null
  };
}

function accountIsActiveAdministrator(account: Pick<AccountRow,
  "tipo_perfil" | "ativado_em" | "excluido_em" | "hash_senha">): boolean {
  return account.tipo_perfil === "administrador"
    && account.ativado_em !== null
    && account.excluido_em === null
    && account.hash_senha !== null;
}

export async function createLoginSession(
  knex: Knex,
  credentials: { email: string; password: string },
  previousToken?: string
): Promise<LoginResult> {
  for (let attempt = 0; attempt < ACCOUNT_RECHECK_ATTEMPTS; attempt += 1) {
    const snapshot = await knex("usuario")
      .select(
        "id_usuario",
        "email_institucional",
        "tipo_perfil",
        "nome_completo",
        "hash_senha",
        "ativado_em",
        "excluido_em",
        "falhas_login_na_janela",
        "inicio_janela_falhas_login",
        "bloqueado_ate"
      )
      .where({ email_institucional: credentials.email })
      .first() as AccountRow | undefined;

    const passwordMatches = await verifyPasswordHash(snapshot?.hash_senha, credentials.password);
    if (!snapshot) return { success: false };

    const result = await knex.transaction(async (transaction) => {
      const previousSessionReference = previousToken
        ? await transaction("sessao")
          .select("id_sessao", "id_usuario")
          .where({ hash_token_sha256: hashOpaqueToken(previousToken) })
          .whereNull("revogada_em")
          .first() as Pick<SessionRow, "id_sessao" | "id_usuario"> | undefined
        : undefined;

      const identityIds = [...new Set([
        String(snapshot.id_usuario),
        ...(previousSessionReference ? [String(previousSessionReference.id_usuario)] : [])
      ])].sort((left, right) => BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0);
      for (const id of identityIds) {
        await transaction("usuario").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
      }

      const previousSession = previousSessionReference
        ? await transaction("sessao")
          .select("id_sessao")
          .where({
            id_sessao: previousSessionReference.id_sessao,
            hash_token_sha256: hashOpaqueToken(previousToken as string)
          })
          .whereNull("revogada_em")
          .forUpdate()
          .first() as Pick<SessionRow, "id_sessao"> | undefined
        : undefined;

      const account = await transaction("usuario")
        .select(
          "id_usuario",
          "email_institucional",
          "tipo_perfil",
          "nome_completo",
          "hash_senha",
          "ativado_em",
          "excluido_em",
          "falhas_login_na_janela",
          "inicio_janela_falhas_login",
          "bloqueado_ate"
        )
        .where({ id_usuario: snapshot.id_usuario })
        .first() as AccountRow | undefined;

      if (!account || account.email_institucional !== credentials.email
        || account.hash_senha !== snapshot.hash_senha) {
        return { retry: true as const };
      }

      const now = await databaseNow(transaction);
      if (accountIsBlocked(account, now)) {
        return { retry: false as const, login: { success: false } as LoginResult };
      }

      if (!passwordMatches || !accountIsActiveAdministrator(account)) {
        await transaction("usuario")
          .where({ id_usuario: account.id_usuario })
          .update(nextLoginFailureState(account, now));
        return { retry: false as const, login: { success: false } as LoginResult };
      }

      const token = createOpaqueToken();
      const absoluteExpiry = new Date(now.getTime() + ABSOLUTE_TIMEOUT_MS);
      if (previousSession) {
        await transaction("sessao")
          .where({ id_sessao: previousSession.id_sessao })
          .whereNull("revogada_em")
          .update({ revogada_em: now });
      }

      await transaction("usuario")
        .where({ id_usuario: account.id_usuario })
        .update({
          falhas_login_na_janela: 0,
          inicio_janela_falhas_login: null,
          bloqueado_ate: null,
          contador_pedidos_redefinicao: 0,
          inicio_janela_redefinicao: null
        });
      await transaction("sessao").insert({
        id_usuario: account.id_usuario,
        hash_token_sha256: hashOpaqueToken(token),
        criada_em: now,
        ultima_atividade_em: now,
        expira_em: new Date(now.getTime() + IDLE_TIMEOUT_MS),
        expira_absoluta_em: absoluteExpiry
      });

      return { retry: false as const, login: { success: true, token, user: identity(account) } as LoginResult };
    });

    if (result.retry) continue;
    return result.login;
  }

  return { success: false };
}

export async function reauthenticateAdministrator(
  knex: Knex,
  userId: string,
  password: string
): Promise<boolean> {
  for (let attempt = 0; attempt < ACCOUNT_RECHECK_ATTEMPTS; attempt += 1) {
    const snapshot = await knex("usuario")
      .select(
        "id_usuario",
        "tipo_perfil",
        "hash_senha",
        "ativado_em",
        "excluido_em",
        "falhas_login_na_janela",
        "inicio_janela_falhas_login",
        "bloqueado_ate"
      )
      .where({ id_usuario: userId })
      .first() as Pick<AccountRow,
        "id_usuario" | "tipo_perfil" | "hash_senha" | "ativado_em" | "excluido_em"
        | "falhas_login_na_janela" | "inicio_janela_falhas_login" | "bloqueado_ate"> | undefined;

    const passwordMatches = await verifyPasswordHash(snapshot?.hash_senha, password);
    if (!snapshot) return false;

    const result = await knex.transaction(async (transaction) => {
      const account = await transaction("usuario")
        .select(
          "id_usuario",
          "tipo_perfil",
          "hash_senha",
          "ativado_em",
          "excluido_em",
          "falhas_login_na_janela",
          "inicio_janela_falhas_login",
          "bloqueado_ate"
        )
        .where({ id_usuario: userId })
        .forUpdate()
        .first() as Pick<AccountRow,
          "id_usuario" | "tipo_perfil" | "hash_senha" | "ativado_em" | "excluido_em"
          | "falhas_login_na_janela" | "inicio_janela_falhas_login" | "bloqueado_ate"> | undefined;

      if (!account || account.hash_senha !== snapshot.hash_senha) {
        return { retry: true as const, authenticated: false };
      }

      const now = await databaseNow(transaction);
      if (accountIsBlocked(account, now) || !accountIsActiveAdministrator(account)) {
        return { retry: false as const, authenticated: false };
      }

      if (!passwordMatches) {
        await transaction("usuario")
          .where({ id_usuario: account.id_usuario })
          .update(nextLoginFailureState(account, now));
        return { retry: false as const, authenticated: false };
      }

      await transaction("usuario")
        .where({ id_usuario: account.id_usuario })
        .update({
          falhas_login_na_janela: 0,
          inicio_janela_falhas_login: null,
          bloqueado_ate: null
        });
      return { retry: false as const, authenticated: true };
    });

    if (result.retry) continue;
    return result.authenticated;
  }

  return false;
}

export async function inspectSession(knex: Knex, token: string): Promise<CurrentSessionResult> {
  return knex.transaction(async (transaction) => {
    const reference = await transaction("sessao")
      .select("id_sessao", "id_usuario")
      .where({ hash_token_sha256: hashOpaqueToken(token) })
      .whereNull("revogada_em")
      .first() as SessionRow | undefined;
    if (!reference) return { authenticated: false };

    const account = await transaction("usuario")
      .select("id_usuario", "tipo_perfil", "nome_completo", "ativado_em", "excluido_em")
      .where({ id_usuario: reference.id_usuario })
      .forUpdate()
      .first() as Pick<AccountRow, "id_usuario" | "tipo_perfil" | "nome_completo" | "ativado_em" | "excluido_em"> | undefined;

    const session = await transaction("sessao")
      .select("id_sessao", "id_usuario", "expira_em", "expira_absoluta_em")
      .where({ id_sessao: reference.id_sessao, hash_token_sha256: hashOpaqueToken(token) })
      .whereNull("revogada_em")
      .forUpdate()
      .first() as SessionRow | undefined;
    if (!session) return { authenticated: false };

    const now = await databaseNow(transaction);
    const absoluteExpiry = asDate(session.expira_absoluta_em);
    if (asDate(session.expira_em).getTime() <= now.getTime()
      || absoluteExpiry.getTime() <= now.getTime()) {
      await transaction("sessao")
        .where({ id_sessao: session.id_sessao })
        .whereNull("revogada_em")
        .update({ revogada_em: now });
      return { authenticated: false };
    }

    if (!account || account.ativado_em === null || account.excluido_em !== null) {
      await transaction("sessao")
        .where({ id_sessao: session.id_sessao })
        .whereNull("revogada_em")
        .update({ revogada_em: now });
      return { authenticated: false };
    }

    await transaction("sessao")
      .where({ id_sessao: session.id_sessao })
      .whereNull("revogada_em")
      .update({
        ultima_atividade_em: now,
        expira_em: new Date(Math.min(now.getTime() + IDLE_TIMEOUT_MS, absoluteExpiry.getTime()))
      });

    return { authenticated: true, user: identity(account) };
  });
}

export async function revokeSession(knex: Knex, token: string): Promise<boolean> {
  return knex.transaction(async (transaction) => {
    const reference = await transaction("sessao")
      .select("id_sessao", "id_usuario")
      .where({ hash_token_sha256: hashOpaqueToken(token) })
      .whereNull("revogada_em")
      .first() as Pick<SessionRow, "id_sessao" | "id_usuario"> | undefined;
    if (!reference) return false;

    await transaction("usuario").select("id_usuario")
      .where({ id_usuario: reference.id_usuario }).forUpdate().first();
    const session = await transaction("sessao")
      .select("id_sessao", "expira_em", "expira_absoluta_em")
      .where({ id_sessao: reference.id_sessao, hash_token_sha256: hashOpaqueToken(token) })
      .whereNull("revogada_em")
      .forUpdate()
      .first() as Pick<SessionRow, "id_sessao" | "expira_em" | "expira_absoluta_em"> | undefined;
    if (!session) return false;

    const now = await databaseNow(transaction);
    const expired = asDate(session.expira_em).getTime() <= now.getTime()
      || asDate(session.expira_absoluta_em).getTime() <= now.getTime();
    await transaction("sessao")
      .where({ id_sessao: session.id_sessao })
      .whereNull("revogada_em")
      .update({ revogada_em: now });
    return !expired;
  });
}

export async function lockAdminMutationSessions(
  transaction: Knex.Transaction,
  token: string,
  actorId: string,
  affectedUserIds: readonly string[] = []
): Promise<{ authorized: boolean; affectedSessionIds: string[] }> {
  const account = await transaction("usuario")
    .select("id_usuario", "tipo_perfil", "hash_senha", "ativado_em", "excluido_em")
    .where({ id_usuario: actorId })
    .forShare()
    .first() as Pick<AccountRow, "id_usuario" | "tipo_perfil" | "hash_senha" | "ativado_em" | "excluido_em"> | undefined;
  if (!account || !accountIsActiveAdministrator(account)) {
    return { authorized: false, affectedSessionIds: [] };
  }

  const targetIds = [...new Set(affectedUserIds.map(String).filter((id) => id !== actorId))];
  const lockedIds = [...new Set([actorId, ...targetIds])];
  const sessions = await transaction("sessao")
    .select("id_sessao", "id_usuario", "hash_token_sha256", "expira_em", "expira_absoluta_em")
    .whereIn("id_usuario", lockedIds)
    .whereNull("revogada_em")
    .orderBy("id_sessao", "asc")
    .forUpdate() as Array<SessionRow & { hash_token_sha256: Buffer }>;

  const current = sessions.find((session) =>
    session.hash_token_sha256.equals(hashOpaqueToken(token)) && String(session.id_usuario) === actorId
  );
  const now = await databaseNow(transaction);
  const authorized = current !== undefined
    && asDate(current.expira_em).getTime() > now.getTime()
    && asDate(current.expira_absoluta_em).getTime() > now.getTime();
  return {
    authorized,
    affectedSessionIds: sessions
      .filter((session) => targetIds.includes(String(session.id_usuario)))
      .map((session) => String(session.id_sessao))
  };
}
