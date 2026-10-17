import type { Knex } from "knex";
import { strongEtag } from "../http/etag";
import { effectiveEnrollmentPredicate, enrollmentOverlapsFromDatePredicate } from "./effective-enrollment";
import { AdminSessionRevokedError, lockAdminMutationSessions } from "./session-service";
import type { MutationActor } from "./admin-class-service";

export type CreateEnrollmentInput = {
  classId: string;
  studentId: string;
  startDate: string;
  confirmPreviousEnrollmentId?: string;
};

export type EnrollmentRepresentation = {
  enrollmentId: string;
  studentId: string;
  classId: string;
  startDate: string;
  cancellationDate: string | null;
  cancellationRequestedAt: string | null;
};

export type CreateEnrollmentResult =
  | { status: "created"; enrollmentId: string }
  | { status: "class-not-found" }
  | { status: "class-closed" }
  | { status: "student-not-found" }
  | { status: "date-before-today" }
  | { status: "date-before-class-start" }
  | { status: "already-active" }
  | { status: "previous-year-cannot-be-renewed" }
  | { status: "confirmation-required"; previousEnrollmentId: string }
  | { status: "confirmation-stale" }
  | { status: "etag-stale" };

type EnrollmentRow = {
  id_matricula: string | number;
  id_usuario_aluno: string | number;
  id_turma: string | number;
  inicio_vigencia: string;
  fim_vigencia: string | null;
  cancelada_em: Date | string | null;
};

type EnrollmentOverlapRow = EnrollmentRow & {
  ano_letivo: number;
  effective_on_start: boolean;
};

function representation(row: EnrollmentRow): EnrollmentRepresentation {
  return {
    enrollmentId: String(row.id_matricula),
    studentId: String(row.id_usuario_aluno),
    classId: String(row.id_turma),
    startDate: String(row.inicio_vigencia),
    cancellationDate: row.fim_vigencia === null ? null : String(row.fim_vigencia),
    cancellationRequestedAt: row.cancelada_em === null
      ? null
      : row.cancelada_em instanceof Date
        ? row.cancelada_em.toISOString()
        : String(row.cancelada_em)
  };
}

function enrollmentTag(row: EnrollmentRow): string {
  return strongEtag(representation(row));
}

function numericSort(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

async function lockUsers(transaction: Knex.Transaction, userIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(userIds)].sort(numericSort)) {
    await transaction("usuario").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
  }
}

async function lockStudentProfile(transaction: Knex.Transaction, studentId: string): Promise<boolean> {
  const profile = await transaction("aluno").select("id_usuario")
    .where({ id_usuario: studentId }).forUpdate().first();
  return Boolean(profile);
}

function isOpenEnrollmentUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && "constraint" in error
    && (error as { code?: unknown }).code === "23505"
    && (error as { constraint?: unknown }).constraint === "matricula_aluno_aberta_uk";
}

export async function createEnrollment(
  knex: Knex,
  input: CreateEnrollmentInput,
  actor?: MutationActor,
  ifMatch?: string
): Promise<CreateEnrollmentResult> {
  try {
    return await knex.transaction(async (transaction) => {
      const schoolClass = await transaction("turma")
        .select("id_turma", "ano_letivo", transaction.raw("inicio_em::text AS inicio_em"), "fechada_em")
        .where({ id_turma: input.classId })
        .forUpdate()
        .first() as {
          id_turma: string | number; ano_letivo: number; inicio_em: string; fechada_em: Date | string | null;
        } | undefined;
      if (!schoolClass) return { status: "class-not-found" };

      await lockUsers(transaction, actor ? [actor.actorId, input.studentId] : [input.studentId]);
      const account = await transaction("usuario")
        .select("id_usuario")
        .where({ id_usuario: input.studentId, tipo_perfil: "aluno" })
        .whereNull("excluido_em")
        .first();
      if (!account || !await lockStudentProfile(transaction, input.studentId)) {
        return { status: "student-not-found" };
      }

      const businessDateResult = await transaction.raw("SELECT CURRENT_DATE::text AS business_date");
      const businessDate = String(businessDateResult.rows[0].business_date);
      if (input.startDate < businessDate) return { status: "date-before-today" };
      if (input.startDate < String(schoolClass.inicio_em)) return { status: "date-before-class-start" };
      if (schoolClass.fechada_em !== null) return { status: "class-closed" };

      const overlapping = await transaction("matricula as m")
        .join("turma as t", "t.id_turma", "m.id_turma")
        .select(
          "m.id_matricula", "m.id_usuario_aluno", "m.id_turma", "t.ano_letivo",
          transaction.raw("m.inicio_vigencia::text AS inicio_vigencia"),
          transaction.raw("m.fim_vigencia::text AS fim_vigencia"), "m.cancelada_em",
          transaction.raw(
            `(${effectiveEnrollmentPredicate("m", "?::date")}) AS effective_on_start`,
            [input.startDate, input.startDate]
          )
        )
        .where("m.id_usuario_aluno", input.studentId)
        .whereRaw(enrollmentOverlapsFromDatePredicate("m", "?::date"), [input.startDate])
        .orderBy("m.id_matricula", "asc")
        .forUpdate("m") as EnrollmentOverlapRow[];

      const previousYear = Number(schoolClass.ano_letivo) - 1;
      const eligiblePrevious = overlapping.filter((row) =>
        Number(row.ano_letivo) === previousYear && row.effective_on_start
      );
      const eligiblePreviousIds = new Set(eligiblePrevious.map((row) => String(row.id_matricula)));
      if (overlapping.some((row) => !eligiblePreviousIds.has(String(row.id_matricula)))) {
        if (actor) await authorizeAndLockSessions(transaction, actor);
        return { status: "already-active" };
      }
      if (eligiblePrevious.length > 1) {
        if (actor) await authorizeAndLockSessions(transaction, actor);
        return { status: "already-active" };
      }
      if (eligiblePrevious.length === 1 && eligiblePrevious[0].inicio_vigencia === input.startDate) {
        if (actor) await authorizeAndLockSessions(transaction, actor);
        return { status: "previous-year-cannot-be-renewed" };
      }

      let previousEnrollment: EnrollmentOverlapRow | undefined;
      if (eligiblePrevious.length === 1) {
        previousEnrollment = eligiblePrevious[0];
        const previousId = String(previousEnrollment.id_matricula);
        if (input.confirmPreviousEnrollmentId === undefined) {
          if (actor) await authorizeAndLockSessions(transaction, actor);
          return { status: "confirmation-required", previousEnrollmentId: previousId };
        }
        if (input.confirmPreviousEnrollmentId !== previousId) {
          if (actor) await authorizeAndLockSessions(transaction, actor);
          return { status: "confirmation-required", previousEnrollmentId: previousId };
        }
        if (!ifMatch || enrollmentTag(previousEnrollment) !== ifMatch) {
          if (actor) await authorizeAndLockSessions(transaction, actor);
          return { status: "etag-stale" };
        }
      } else if (input.confirmPreviousEnrollmentId !== undefined) {
        if (actor) await authorizeAndLockSessions(transaction, actor);
        return { status: "confirmation-stale" };
      }

      const sessions = actor
        ? await lockAdminMutationSessions(transaction, actor.token, actor.actorId, [input.studentId])
        : undefined;
      if (sessions && !sessions.authorized) throw new AdminSessionRevokedError();

      if (previousEnrollment) {
        await transaction("matricula")
          .where({ id_matricula: previousEnrollment.id_matricula, id_usuario_aluno: input.studentId })
          .whereRaw("inicio_vigencia <= ?::date AND (fim_vigencia IS NULL OR fim_vigencia > ?::date)",
            [input.startDate, input.startDate])
          .update({ fim_vigencia: input.startDate });
      }
      const [created] = await transaction("matricula")
        .insert({ id_usuario_aluno: input.studentId, id_turma: input.classId, inicio_vigencia: input.startDate })
        .returning("id_matricula") as Array<{ id_matricula: string | number }>;
      if (sessions?.affectedSessionIds.length) {
        await transaction("sessao").whereIn("id_sessao", sessions.affectedSessionIds)
          .whereNull("revogada_em").update({ revogada_em: transaction.raw("clock_timestamp()") });
      }
      return { status: "created", enrollmentId: String(created.id_matricula) };
    });
  } catch (error) {
    if (isOpenEnrollmentUniqueViolation(error)) return { status: "already-active" };
    throw error;
  }
}

async function authorizeAndLockSessions(transaction: Knex.Transaction, actor: MutationActor) {
  const result = await lockAdminMutationSessions(transaction, actor.token, actor.actorId);
  if (!result.authorized) throw new AdminSessionRevokedError();
}

export async function getEnrollment(
  knex: Knex,
  enrollmentId: string
): Promise<{ enrollment: EnrollmentRepresentation; etag: string } | undefined> {
  const row = await knex("matricula")
    .select("id_matricula", "id_usuario_aluno", "id_turma",
      knex.raw("inicio_vigencia::text AS inicio_vigencia"),
      knex.raw("fim_vigencia::text AS fim_vigencia"), "cancelada_em")
    .where({ id_matricula: enrollmentId })
    .first() as EnrollmentRow | undefined;
  if (!row) return undefined;
  return { enrollment: representation(row), etag: enrollmentTag(row) };
}

export type CancelEnrollmentResult =
  | { status: "cancelled" }
  | { status: "not-found" }
  | { status: "already-closed" }
  | { status: "class-closed" }
  | { status: "date-before-today" }
  | { status: "date-not-after-start" }
  | { status: "date-required" }
  | { status: "etag-stale" };

type EnrollmentReference = { id_usuario_aluno: string | number; id_turma: string | number };

export async function cancelEnrollment(
  knex: Knex,
  enrollmentId: string,
  cancellationDate: string | undefined,
  ifMatch: string,
  actor: MutationActor
): Promise<CancelEnrollmentResult> {
  return knex.transaction(async (transaction) => {
    const reference = await transaction("matricula")
      .select("id_usuario_aluno", "id_turma")
      .where({ id_matricula: enrollmentId })
      .first() as EnrollmentReference | undefined;
    if (!reference) return { status: "not-found" };

    const classId = String(reference.id_turma);
    const schoolClass = await transaction("turma")
      .select("id_turma", "fechada_em")
      .where({ id_turma: classId })
      .forUpdate()
      .first() as { id_turma: string | number; fechada_em: Date | string | null } | undefined;
    if (!schoolClass) return { status: "not-found" };

    const userId = String(reference.id_usuario_aluno);
    await lockUsers(transaction, [actor.actorId, userId]);
    const account = await transaction("usuario").select("id_usuario")
      .where({ id_usuario: userId, tipo_perfil: "aluno" }).whereNull("excluido_em").first();
    if (!account || !await lockStudentProfile(transaction, userId)) return { status: "not-found" };

    const enrollment = await transaction("matricula")
      .select("id_matricula", "id_usuario_aluno", "id_turma",
        transaction.raw("fim_vigencia::text AS fim_vigencia"), "cancelada_em",
        transaction.raw("inicio_vigencia::text AS inicio_vigencia"))
      .where({ id_matricula: enrollmentId, id_usuario_aluno: userId, id_turma: classId })
      .forUpdate()
      .first() as EnrollmentRow | undefined;
    if (!enrollment) return { status: "not-found" };
    if (enrollmentTag(enrollment) !== ifMatch) {
      await authorizeAndLockSessions(transaction, actor);
      return { status: "etag-stale" };
    }
    if (schoolClass.fechada_em !== null) {
      await authorizeAndLockSessions(transaction, actor);
      return { status: "class-closed" };
    }
    if (enrollment.fim_vigencia !== null || enrollment.cancelada_em !== null) {
      await authorizeAndLockSessions(transaction, actor);
      return { status: "already-closed" };
    }

    const dateResult = await transaction.raw("SELECT CURRENT_DATE::text AS business_date");
    const businessDate = String(dateResult.rows[0].business_date);
    if (cancellationDate !== undefined && cancellationDate < businessDate) {
      await authorizeAndLockSessions(transaction, actor);
      return { status: "date-before-today" };
    }
    if (cancellationDate !== undefined && cancellationDate <= enrollment.inicio_vigencia) {
      await authorizeAndLockSessions(transaction, actor);
      return { status: "date-not-after-start" };
    }
    if (cancellationDate === undefined && enrollment.inicio_vigencia <= businessDate) {
      await authorizeAndLockSessions(transaction, actor);
      return { status: "date-required" };
    }

    const sessions = await lockAdminMutationSessions(transaction, actor.token, actor.actorId, [userId]);
    if (!sessions.authorized) throw new AdminSessionRevokedError();
    const updated = await transaction("matricula")
      .where({ id_matricula: enrollmentId, id_usuario_aluno: userId })
      .whereNull("fim_vigencia")
      .whereNull("cancelada_em")
      .update({
        ...(cancellationDate === undefined ? {} : { fim_vigencia: cancellationDate }),
        cancelada_em: transaction.raw("clock_timestamp()")
      });
    if (updated !== 1) return { status: "already-closed" };
    if (sessions.affectedSessionIds.length > 0) {
      await transaction("sessao").whereIn("id_sessao", sessions.affectedSessionIds)
        .whereNull("revogada_em").update({ revogada_em: transaction.raw("clock_timestamp()") });
    }
    return { status: "cancelled" };
  });
}
