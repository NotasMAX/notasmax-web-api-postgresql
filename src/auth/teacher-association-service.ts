import type { Knex } from "knex";
import { strongEtag } from "../http/etag";
import { AdminSessionRevokedError, lockAdminMutationSessions } from "./session-service";
import type { MutationActor } from "./admin-class-service";

export type TeacherAssociation = {
  teacherId: string;
  name: string;
  email: string;
  activationStatus: "pending" | "activated";
};

type AssociationResult =
  | { status: "ok"; etag: string }
  | { status: "not-found" }
  | { status: "stale" }
  | { status: "class-closed" };

function numericSort(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

async function teacherItems(
  queryable: Knex | Knex.Transaction,
  offerId: string
): Promise<TeacherAssociation[]> {
  const rows = await queryable("turma_disciplina_professor as tdp")
    .join("professor as p", "p.id_usuario", "tdp.id_usuario_professor")
    .join("usuario as u", "u.id_usuario", "p.id_usuario")
    .select("u.id_usuario", "u.nome_completo", "u.email_institucional", "u.ativado_em")
    .where("tdp.id_turma_disciplina", offerId)
    .whereNull("u.excluido_em")
    .orderBy("u.nome_completo", "asc")
    .orderBy("u.id_usuario", "asc") as Array<{
      id_usuario: string | number;
      nome_completo: string;
      email_institucional: string;
      ativado_em: Date | string | null;
    }>;
  return rows.map((row) => ({
    teacherId: String(row.id_usuario),
    name: row.nome_completo,
    email: row.email_institucional,
    activationStatus: row.ativado_em === null ? "pending" : "activated"
  }));
}

async function collectionTag(
  queryable: Knex | Knex.Transaction,
  offerId: string
): Promise<string> {
  const offer = await queryable("turma_disciplina")
    .select("teachers_version")
    .where({ id_turma_disciplina: offerId })
    .first() as { teachers_version: number } | undefined;
  const items = await teacherItems(queryable, offerId);
  return strongEtag({ version: Number(offer?.teachers_version), items });
}

export async function listCurrentTeachers(
  knex: Knex,
  classId: string,
  subjectId: string
): Promise<{ status: "ok"; items: TeacherAssociation[]; etag: string } | { status: "not-found" }> {
  return knex.transaction(async (transaction) => {
    const schoolClass = await transaction("turma").select("id_turma")
      .where({ id_turma: classId }).forUpdate().first();
    if (!schoolClass) return { status: "not-found" };
    const subject = await transaction("materia").select("id_materia")
      .where({ id_materia: subjectId }).whereNull("excluido_em").forUpdate().first();
    if (!subject) return { status: "not-found" };
    const reference = await transaction("turma_disciplina")
      .select("id_turma_disciplina").where({ id_turma: classId, id_materia: subjectId })
      .first() as { id_turma_disciplina: string | number } | undefined;
    if (!reference) return { status: "not-found" };
    const offerId = String(reference.id_turma_disciplina);
    const teacherRows = await transaction("turma_disciplina_professor")
      .select("id_usuario_professor").where({ id_turma_disciplina: offerId })
      .orderBy("id_usuario_professor", "asc") as Array<{ id_usuario_professor: string | number }>;
    const teacherIds = [...new Set(teacherRows.map((row) => String(row.id_usuario_professor)))].sort(numericSort);
    for (const id of teacherIds) {
      await transaction("usuario").select("id_usuario").where({ id_usuario: id }).forShare().first();
    }
    for (const id of teacherIds) {
      await transaction("professor").select("id_usuario").where({ id_usuario: id }).forShare().first();
    }
    const offer = await transaction("turma_disciplina")
      .select("id_turma_disciplina", "teachers_version")
      .where({ id_turma_disciplina: offerId }).forShare().first() as LockedOffer | undefined;
    if (!offer) return { status: "not-found" };
    await transaction("turma_disciplina_professor").select("id_usuario_professor")
      .where({ id_turma_disciplina: offerId }).orderBy("id_usuario_professor", "asc").forShare();
    const items = await teacherItems(transaction, String(offer.id_turma_disciplina));
    return {
      status: "ok", items,
      etag: strongEtag({ version: Number(offer.teachers_version), items })
    };
  });
}

type LockedOffer = { id_turma_disciplina: string | number; teachers_version: number };

async function lockAssociationMutation(
  transaction: Knex.Transaction,
  classId: string,
  subjectId: string,
  teacherId: string,
  actor: MutationActor,
  ifMatch: string,
  adding: boolean
): Promise<AssociationResult> {
  const schoolClass = await transaction("turma")
    .select("id_turma", "fechada_em")
    .where({ id_turma: classId })
    .forUpdate()
    .first() as { id_turma: string | number; fechada_em: Date | string | null } | undefined;
  if (!schoolClass) return { status: "not-found" };
  if (schoolClass.fechada_em !== null) return { status: "class-closed" };

  const subject = await transaction("materia")
    .select("id_materia")
    .where({ id_materia: subjectId })
    .whereNull("excluido_em")
    .forUpdate()
    .first();
  if (!subject) return { status: "not-found" };

  const offerReference = await transaction("turma_disciplina")
    .select("id_turma_disciplina")
    .where({ id_turma: classId, id_materia: subjectId })
    .first() as { id_turma_disciplina: string | number } | undefined;
  if (!offerReference) return { status: "not-found" };
  const offerId = String(offerReference.id_turma_disciplina);
  const associatedRows = await transaction("turma_disciplina_professor")
    .select("id_usuario_professor")
    .where({ id_turma_disciplina: offerId })
    .orderBy("id_usuario_professor", "asc") as Array<{ id_usuario_professor: string | number }>;
  const teacherIds = [...new Set([...associatedRows.map((row) => String(row.id_usuario_professor)), teacherId])]
    .sort(numericSort);
  const identityIds = [...new Set([actor.actorId, ...teacherIds])].sort(numericSort);
  for (const id of identityIds) {
    await transaction("usuario").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
  }
  for (const id of teacherIds) {
    await transaction("professor").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
  }

  const offer = await transaction("turma_disciplina")
    .select("id_turma_disciplina", "teachers_version")
    .where({ id_turma_disciplina: offerId })
    .forUpdate()
    .first() as LockedOffer | undefined;
  if (!offer) return { status: "not-found" };
  const associations = await transaction("turma_disciplina_professor")
    .select("id_usuario_professor")
    .where({ id_turma_disciplina: offerId })
    .orderBy("id_usuario_professor", "asc")
    .forUpdate() as Array<{ id_usuario_professor: string | number }>;
  const existingIds = associations.map((row) => String(row.id_usuario_professor));
  const currentItems = await teacherItems(transaction, offerId);
  const currentTag = strongEtag({ version: Number(offer.teachers_version), items: currentItems });
  if (currentTag !== ifMatch) return { status: "stale" };

  const activeTeacher = await transaction("usuario")
    .select("id_usuario")
    .where({ id_usuario: teacherId, tipo_perfil: "professor" })
    .whereNull("excluido_em")
    .first();
  const teacherProfile = await transaction("professor").select("id_usuario")
    .where({ id_usuario: teacherId }).first();
  if (!activeTeacher || !teacherProfile) return { status: "not-found" };

  const changed = adding ? !existingIds.includes(teacherId) : existingIds.includes(teacherId);
  const sessions = await lockAdminMutationSessions(
    transaction, actor.token, actor.actorId, changed ? [teacherId] : []
  );
  if (!sessions.authorized) throw new AdminSessionRevokedError();

  if (changed && adding) {
    await transaction("turma_disciplina_professor").insert({
      id_turma_disciplina: offerId, id_usuario_professor: teacherId
    });
  } else if (changed) {
    await transaction("turma_disciplina_professor")
      .where({ id_turma_disciplina: offerId, id_usuario_professor: teacherId }).delete();
  }
  if (changed) {
    await transaction("turma_disciplina").where({ id_turma_disciplina: offerId })
      .update({ teachers_version: transaction.raw("teachers_version + 1") });
    if (sessions.affectedSessionIds.length > 0) {
      await transaction("sessao").whereIn("id_sessao", sessions.affectedSessionIds)
        .whereNull("revogada_em").update({ revogada_em: transaction.raw("clock_timestamp()") });
    }
  }
  return { status: "ok", etag: await collectionTag(transaction, offerId) };
}

export async function addCurrentTeacher(
  knex: Knex,
  classId: string,
  subjectId: string,
  teacherId: string,
  ifMatch: string,
  actor: MutationActor
): Promise<AssociationResult> {
  return knex.transaction((transaction) =>
    lockAssociationMutation(transaction, classId, subjectId, teacherId, actor, ifMatch, true)
  );
}

export async function removeCurrentTeacher(
  knex: Knex,
  classId: string,
  subjectId: string,
  teacherId: string,
  ifMatch: string,
  actor: MutationActor
): Promise<AssociationResult> {
  return knex.transaction((transaction) =>
    lockAssociationMutation(transaction, classId, subjectId, teacherId, actor, ifMatch, false)
  );
}

/** Caller holds class, subject, identity, profile, offer and session locks in protocol order. */
export async function removeCurrentTeachersForOffer(
  transaction: Knex.Transaction,
  offerId: string
): Promise<void> {
  await transaction("turma_disciplina_professor")
    .where({ id_turma_disciplina: offerId })
    .delete();
}
