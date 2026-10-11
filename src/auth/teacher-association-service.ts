import type { Knex } from "knex";

export type TeacherAssociation = {
  teacherId: string;
  name: string;
  email: string;
  activationStatus: "pending" | "activated";
};

type AssociationResult = { status: "ok" } | { status: "not-found" };

async function activeOfferId(knex: Knex, classId: string, subjectId: string) {
  const offer = await knex("turma_disciplina as td")
    .join("turma as t", "t.id_turma", "td.id_turma")
    .join("materia as m", "m.id_materia", "td.id_materia")
    .select("td.id_turma_disciplina")
    .where("td.id_turma", classId)
    .where("td.id_materia", subjectId)
    .whereNull("t.excluido_em")
    .whereNull("m.excluido_em")
    .first() as { id_turma_disciplina: string | number } | undefined;
  return offer ? String(offer.id_turma_disciplina) : undefined;
}

async function lockActiveOfferId(
  transaction: Knex.Transaction,
  classId: string,
  subjectId: string
): Promise<string | undefined> {
  const schoolClass = await transaction("turma")
    .select("id_turma")
    .where({ id_turma: classId })
    .whereNull("excluido_em")
    .forUpdate()
    .first();
  if (!schoolClass) return undefined;

  const subject = await transaction("materia")
    .select("id_materia")
    .where({ id_materia: subjectId })
    .whereNull("excluido_em")
    .forUpdate()
    .first();
  if (!subject) return undefined;

  const offer = await transaction("turma_disciplina")
    .select("id_turma_disciplina")
    .where({ id_turma: classId, id_materia: subjectId })
    .forUpdate()
    .first() as { id_turma_disciplina: string | number } | undefined;
  return offer ? String(offer.id_turma_disciplina) : undefined;
}

export async function listCurrentTeachers(
  knex: Knex,
  classId: string,
  subjectId: string
): Promise<{ status: "ok"; items: TeacherAssociation[] } | { status: "not-found" }> {
  const offerId = await activeOfferId(knex, classId, subjectId);
  if (!offerId) return { status: "not-found" };

  const rows = await knex("turma_disciplina_professor as tdp")
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

  return {
    status: "ok",
    items: rows.map((row) => ({
      teacherId: String(row.id_usuario),
      name: row.nome_completo,
      email: row.email_institucional,
      activationStatus: row.ativado_em === null ? "pending" : "activated"
    }))
  };
}

async function lockActiveTeacher(transaction: Knex.Transaction, teacherId: string) {
  // Match deleteAccount's professor-row lock without locking usuario: deletion locks usuario first.
  const profile = await transaction("professor")
    .select("id_usuario")
    .where({ id_usuario: teacherId })
    .forUpdate()
    .first();
  if (!profile) return false;

  const activeAccount = await transaction("usuario")
    .select("id_usuario")
    .where({ id_usuario: teacherId, tipo_perfil: "professor" })
    .whereNull("excluido_em")
    .first();
  return Boolean(activeAccount);
}

export async function addCurrentTeacher(
  knex: Knex,
  classId: string,
  subjectId: string,
  teacherId: string
): Promise<AssociationResult> {
  return knex.transaction(async (transaction) => {
    const offerId = await lockActiveOfferId(transaction, classId, subjectId);
    if (!offerId) return { status: "not-found" };
    // Lock order serializes offer changes before validating the active teacher row.
    if (!await lockActiveTeacher(transaction, teacherId)) return { status: "not-found" };

    await transaction("turma_disciplina_professor")
      .insert({ id_turma_disciplina: offerId, id_usuario_professor: teacherId })
      .onConflict(["id_turma_disciplina", "id_usuario_professor"])
      .ignore();
    return { status: "ok" };
  });
}

export async function removeCurrentTeacher(
  knex: Knex,
  classId: string,
  subjectId: string,
  teacherId: string
): Promise<AssociationResult> {
  return knex.transaction(async (transaction) => {
    const offerId = await lockActiveOfferId(transaction, classId, subjectId);
    if (!offerId) return { status: "not-found" };
    if (!await lockActiveTeacher(transaction, teacherId)) return { status: "not-found" };

    await transaction("turma_disciplina_professor")
      .where({ id_turma_disciplina: offerId, id_usuario_professor: teacherId })
      .delete();
    return { status: "ok" };
  });
}

export async function removeCurrentTeachersForOffer(
  transaction: Knex.Transaction,
  offerId: string
): Promise<void> {
  await transaction("turma_disciplina_professor")
    .where({ id_turma_disciplina: offerId })
    .delete();
}
