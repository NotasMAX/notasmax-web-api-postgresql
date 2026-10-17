import type { Knex } from "knex";
import { isStrongOpaqueEtag, strongEtag } from "../http/etag";
import { AdminSessionRevokedError, lockAdminMutationSessions } from "./session-service";
import { removeCurrentTeachersForOffer } from "./teacher-association-service";

export type MutationActor = { actorId: string; token: string };
export type ClassListQuery = { schoolYear?: number; page: number; pageSize: number };
export type NewClass = {
  series: number;
  schoolYear: number;
  startDate: string;
  closeClassIds?: Array<{ classId: string; etag?: unknown }>;
};
export type ClassPatch = Partial<Pick<NewClass, "series" | "schoolYear">>;
export type SchoolClass = { classId: string; series: number; schoolYear: number; startDate: string };
type ClassReadRepresentation = SchoolClass & { isClosed: boolean };

type ClassRow = {
  id_turma: string | number;
  serie: number;
  ano_letivo: number;
  inicio_em: string | Date;
  fechada_em: Date | string | null;
  version: number;
  subjects_version: number;
};

type ClassRepresentationRow = Pick<ClassRow,
  "id_turma" | "serie" | "ano_letivo" | "inicio_em" | "fechada_em" | "version">;

function classItem(row: ClassRepresentationRow): SchoolClass {
  const startDate = row.inicio_em instanceof Date
    ? row.inicio_em.toISOString().slice(0, 10)
    : String(row.inicio_em).slice(0, 10);
  return {
    classId: String(row.id_turma),
    series: Number(row.serie),
    schoolYear: Number(row.ano_letivo),
    startDate
  };
}

function classReadItem(row: ClassRepresentationRow): ClassReadRepresentation {
  return { ...classItem(row), isClosed: row.fechada_em !== null };
}

function classTag(row: ClassRepresentationRow, representation = classReadItem(row)): string {
  return strongEtag({ ...representation, version: Number(row.version) });
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

async function lockProfiles(
  transaction: Knex.Transaction,
  studentIds: readonly string[],
  teacherIds: readonly string[]
): Promise<void> {
  for (const id of [...new Set(studentIds)].sort(numericSort)) {
    await transaction("aluno").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
  }
  for (const id of [...new Set(teacherIds)].sort(numericSort)) {
    await transaction("professor").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
  }
}

async function validateActor(
  transaction: Knex.Transaction,
  actor: MutationActor,
  affectedUserIds: readonly string[] = []
): Promise<string[]> {
  const result = await lockAdminMutationSessions(transaction, actor.token, actor.actorId, affectedUserIds);
  if (!result.authorized) throw new AdminSessionRevokedError();
  return result.affectedSessionIds;
}

async function revokeSessions(transaction: Knex.Transaction, sessionIds: readonly string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  await transaction("sessao")
    .whereIn("id_sessao", sessionIds)
    .whereNull("revogada_em")
    .update({ revogada_em: transaction.raw("clock_timestamp()") });
}

async function schoolClassById(
  queryable: Knex | Knex.Transaction,
  classId: string,
  lock = false
): Promise<ClassRow | undefined> {
  const query = queryable("turma")
    .select("id_turma", "serie", "ano_letivo", queryable.raw("inicio_em::text AS inicio_em"),
      "fechada_em", "version", "subjects_version")
    .where({ id_turma: classId });
  if (lock) query.forUpdate();
  return await query.first() as ClassRow | undefined;
}

export async function listClasses(
  knex: Knex,
  filters: ClassListQuery
): Promise<{ items: ClassReadRepresentation[]; pagination: {
  page: number; pageSize: number; totalItems: number; totalPages: number;
} }> {
  let schoolYear = filters.schoolYear;
  if (schoolYear === undefined) {
    const current = await knex("turma")
      .whereRaw("inicio_em <= CURRENT_DATE")
      .max({ school_year: "ano_letivo" })
      .first() as { school_year: number | null };
    if (current.school_year === null) {
      return { items: [], pagination: {
        page: filters.page, pageSize: filters.pageSize, totalItems: 0, totalPages: 0
      } };
    }
    schoolYear = Number(current.school_year);
  }

  const count = await knex("turma").where({ ano_letivo: schoolYear })
    .count({ total_items: "id_turma" }).first() as { total_items: string | number };
  const totalItems = Number(count.total_items);
  const rows = await knex("turma")
    .select("id_turma", "serie", "ano_letivo", knex.raw("inicio_em::text AS inicio_em"), "fechada_em", "version", "subjects_version")
    .where({ ano_letivo: schoolYear })
    .orderBy("ano_letivo", "asc").orderBy("serie", "asc").orderBy("id_turma", "asc")
    .limit(filters.pageSize).offset((filters.page - 1) * filters.pageSize) as ClassRow[];
  return {
    items: rows.map(classReadItem),
    pagination: {
      page: filters.page, pageSize: filters.pageSize, totalItems,
      totalPages: Math.ceil(totalItems / filters.pageSize)
    }
  };
}

export async function listActiveSchoolYears(knex: Knex): Promise<{ items: Array<{ schoolYear: number }> }> {
  const rows = await knex("turma").distinct({ schoolYear: "ano_letivo" })
    .orderBy("ano_letivo", "desc") as Array<{ schoolYear: number }>;
  return { items: rows };
}

export async function getClass(
  knex: Knex,
  classId: string
): Promise<{ schoolClass: ClassReadRepresentation; etag: string } | undefined> {
  const row = await schoolClassById(knex, classId);
  if (!row) return undefined;
  const schoolClass = classReadItem(row);
  return { schoolClass, etag: classTag(row, schoolClass) };
}

type CreateClassResult =
  | { status: "created"; schoolClass: SchoolClass; etag: string }
  | { status: "selection-invalid" };

export async function createClass(
  knex: Knex,
  input: NewClass,
  actor: MutationActor
): Promise<CreateClassResult> {
  const selected = input.closeClassIds ?? [];
  try {
    return await knex.transaction(async (transaction) => {
      const selectedIds = selected.map((entry) => entry.classId);
      if (new Set(selectedIds).size !== selectedIds.length) return { status: "selection-invalid" };
      const classRows = selectedIds.length === 0 ? [] : await transaction("turma")
        .select("id_turma", "serie", "ano_letivo", "inicio_em", "fechada_em", "version")
        .whereIn("id_turma", selectedIds)
        .orderBy("id_turma", "asc")
        .forUpdate() as Array<Pick<ClassRow, "id_turma" | "serie" | "ano_letivo" | "inicio_em" | "fechada_em" | "version">>;
      const byId = new Map(classRows.map((row) => [String(row.id_turma), row]));
      const businessDateResult = await transaction.raw("SELECT CURRENT_DATE::text AS business_date");
      const businessDate = String(businessDateResult.rows[0].business_date);
      const valid = selected.every((selection) => {
        const row = byId.get(selection.classId);
        return row !== undefined
          && typeof selection.etag === "string"
          && isStrongOpaqueEtag(selection.etag)
          && row.fechada_em === null
          && Number(row.serie) === input.series
          && Number(row.ano_letivo) === input.schoolYear - 1
          && (row.inicio_em instanceof Date
            ? row.inicio_em.toISOString().slice(0, 10)
            : String(row.inicio_em).slice(0, 10)) <= businessDate
          && classTag(row) === selection.etag;
      });
      if (!valid) return { status: "selection-invalid" };

      const classIds = selectedIds;
      const studentRows = classIds.length === 0 ? [] : await transaction("matricula")
        .distinct("id_usuario_aluno")
        .whereIn("id_turma", classIds)
        .whereRaw("(fim_vigencia IS NULL OR fim_vigencia > CURRENT_DATE)")
        .whereRaw("(fim_vigencia IS NOT NULL OR cancelada_em IS NULL)")
        .orderBy("id_usuario_aluno", "asc") as Array<{ id_usuario_aluno: string | number }>;
      const teacherRows = classIds.length === 0 ? [] : await transaction("turma_disciplina_professor as tdp")
        .join("turma_disciplina as td", "td.id_turma_disciplina", "tdp.id_turma_disciplina")
        .distinct("tdp.id_usuario_professor")
        .whereIn("td.id_turma", classIds)
        .orderBy("tdp.id_usuario_professor", "asc") as Array<{ id_usuario_professor: string | number }>;
      const studentIds = studentRows.map((row) => String(row.id_usuario_aluno));
      const teacherIds = teacherRows.map((row) => String(row.id_usuario_professor));
      await lockUsers(transaction, [actor.actorId, ...studentIds, ...teacherIds]);
      await lockProfiles(transaction, studentIds, teacherIds);

      if (classIds.length > 0) {
        await transaction("matricula").select("id_matricula").whereIn("id_turma", classIds)
          .orderBy("id_matricula", "asc").forUpdate();
        const offers = await transaction("turma_disciplina").select("id_turma_disciplina")
          .whereIn("id_turma", classIds).orderBy("id_turma_disciplina", "asc").forUpdate() as Array<{ id_turma_disciplina: string | number }>;
        for (const offer of offers) {
          await transaction("turma_disciplina_professor").select("id_usuario_professor")
            .where({ id_turma_disciplina: offer.id_turma_disciplina })
            .orderBy("id_usuario_professor", "asc").forUpdate();
        }
      }

      const sessionIds = await validateActor(transaction, actor, [...studentIds, ...teacherIds]);
      if (selectedIds.length > 0) {
        await transaction("turma").whereIn("id_turma", selectedIds).whereNull("fechada_em")
          .update({ fechada_em: transaction.raw("clock_timestamp()"), version: transaction.raw("version + 1") });
        await revokeSessions(transaction, sessionIds);
      }
      const [created] = await transaction("turma").insert({
        serie: input.series, ano_letivo: input.schoolYear, inicio_em: input.startDate
      }).returning(["id_turma", "serie", "ano_letivo", "inicio_em", "fechada_em", "version", "subjects_version"]) as ClassRow[];
      return { status: "created", schoolClass: classItem(created), etag: classTag(created) };
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw error;
    throw error;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

async function hasAnyClassLinks(transaction: Knex.Transaction, classId: string): Promise<boolean> {
  const enrollment = await transaction("matricula").select("id_matricula")
    .where({ id_turma: classId }).orderBy("id_matricula", "asc").forUpdate().first();
  if (enrollment) return true;
  const offer = await transaction("turma_disciplina").select("id_turma_disciplina")
    .where({ id_turma: classId }).orderBy("id_turma_disciplina", "asc").forUpdate().first();
  if (offer) return true;
  const simulation = await transaction("simulado").select("id_simulado")
    .where({ id_turma: classId }).orderBy("id_simulado", "asc").forUpdate().first();
  return Boolean(simulation);
}

export type UpdateClassResult =
  | { status: "ok"; schoolClass: SchoolClass; etag: string }
  | { status: "not-found" }
  | { status: "has-linked-data" }
  | { status: "stale" };

export async function updateClass(
  knex: Knex,
  classId: string,
  input: ClassPatch,
  ifMatch: string,
  actor: MutationActor
): Promise<UpdateClassResult> {
  return knex.transaction(async (transaction) => {
    const current = await schoolClassById(transaction, classId, true);
    if (!current) return { status: "not-found" };
    if (classTag(current) !== ifMatch) return { status: "stale" };
    await lockUsers(transaction, [actor.actorId]);
    await validateActor(transaction, actor);
    const nextSeries = input.series ?? current.serie;
    const nextSchoolYear = input.schoolYear ?? current.ano_letivo;
    if (nextSeries === current.serie && nextSchoolYear === current.ano_letivo) {
      return { status: "ok", schoolClass: classItem(current), etag: classTag(current) };
    }
    if (await hasAnyClassLinks(transaction, classId)) return { status: "has-linked-data" };
    const [updated] = await transaction("turma").where({ id_turma: classId })
      .update({ serie: nextSeries, ano_letivo: nextSchoolYear, version: transaction.raw("version + 1") })
      .returning(["id_turma", "serie", "ano_letivo", "inicio_em", "fechada_em", "version", "subjects_version"]) as ClassRow[];
    return updated
      ? { status: "ok", schoolClass: classItem(updated), etag: classTag(updated) }
      : { status: "not-found" };
  });
}

export type CloseClassResult =
  | { status: "closed"; etag: string }
  | { status: "not-found" }
  | { status: "stale" };

export async function closeClass(
  knex: Knex,
  classId: string,
  ifMatch: string,
  actor: MutationActor
): Promise<CloseClassResult> {
  return knex.transaction(async (transaction) => {
    const current = await schoolClassById(transaction, classId, true);
    if (!current) return { status: "not-found" };
    if (classTag(current) !== ifMatch) return { status: "stale" };

    const studentRows = await transaction("matricula").distinct("id_usuario_aluno")
      .where({ id_turma: classId })
      .whereRaw("(fim_vigencia IS NULL OR fim_vigencia > CURRENT_DATE)")
      .whereRaw("(fim_vigencia IS NOT NULL OR cancelada_em IS NULL)")
      .orderBy("id_usuario_aluno", "asc") as Array<{ id_usuario_aluno: string | number }>;
    const teacherRows = await transaction("turma_disciplina_professor as tdp")
      .join("turma_disciplina as td", "td.id_turma_disciplina", "tdp.id_turma_disciplina")
      .distinct("tdp.id_usuario_professor").where("td.id_turma", classId)
      .orderBy("tdp.id_usuario_professor", "asc") as Array<{ id_usuario_professor: string | number }>;
    const studentIds = studentRows.map((row) => String(row.id_usuario_aluno));
    const teacherIds = teacherRows.map((row) => String(row.id_usuario_professor));
    await lockUsers(transaction, [actor.actorId, ...studentIds, ...teacherIds]);
    await lockProfiles(transaction, studentIds, teacherIds);
    await transaction("matricula").select("id_matricula").where({ id_turma: classId})
      .orderBy("id_matricula", "asc").forUpdate();
    const offers = await transaction("turma_disciplina").select("id_turma_disciplina")
      .where({ id_turma: classId }).orderBy("id_turma_disciplina", "asc").forUpdate() as Array<{ id_turma_disciplina: string | number }>;
    for (const offer of offers) {
      await transaction("turma_disciplina_professor").select("id_usuario_professor")
        .where({ id_turma_disciplina: offer.id_turma_disciplina })
        .orderBy("id_usuario_professor", "asc").forUpdate();
    }
    const sessions = await validateActor(transaction, actor, [...studentIds, ...teacherIds]);
    if (current.fechada_em === null) {
      const [closed] = await transaction("turma").where({ id_turma: classId }).whereNull("fechada_em")
        .update({ fechada_em: transaction.raw("clock_timestamp()"), version: transaction.raw("version + 1") })
        .returning(["id_turma", "serie", "ano_letivo", "inicio_em", "fechada_em", "version", "subjects_version"]) as ClassRow[];
      await revokeSessions(transaction, sessions);
      return { status: "closed", etag: classTag(closed) };
    }
    return { status: "closed", etag: classTag(current) };
  });
}

export type ClassSubject = { subjectId: string; name: string; description: string | null };
type SubjectRow = { id_materia: string | number; nome: string; descricao: string | null };

async function subjectItems(
  queryable: Knex | Knex.Transaction,
  classId: string
): Promise<ClassSubject[]> {
  const rows = await queryable("turma_disciplina as td")
    .join("materia as m", "m.id_materia", "td.id_materia")
    .select("m.id_materia", "m.nome", "m.descricao")
    .where("td.id_turma", classId).whereNull("m.excluido_em")
    .orderBy("m.id_materia", "asc") as SubjectRow[];
  return rows.map((row) => ({
    subjectId: String(row.id_materia), name: row.nome, description: row.descricao
  })).sort((a, b) => a.name.localeCompare(b.name) || numericSort(a.subjectId, b.subjectId));
}

export async function listClassSubjects(
  knex: Knex,
  classId: string
): Promise<{ status: "ok"; items: ClassSubject[]; etag: string } | { status: "not-found" }> {
  return knex.transaction(async (transaction) => {
    const schoolClass = await schoolClassById(transaction, classId, true);
    if (!schoolClass) return { status: "not-found" };
    const ids = await transaction("turma_disciplina").distinct("id_materia")
      .where({ id_turma: classId }).orderBy("id_materia", "asc") as Array<{ id_materia: string | number }>;
    for (const row of ids) {
      await transaction("materia").select("id_materia")
        .where({ id_materia: row.id_materia }).forUpdate().first();
    }
    await transaction("turma_disciplina").select("id_turma_disciplina")
      .where({ id_turma: classId }).orderBy("id_turma_disciplina", "asc").forUpdate();
    const items = await subjectItems(transaction, classId);
    return { status: "ok", items, etag: strongEtag({ version: Number(schoolClass.subjects_version), items }) };
  });
}

type CollectionMutationResult =
  | { status: "ok"; etag: string }
  | { status: "not-found" }
  | { status: "stale" }
  | { status: "class-closed" };

async function lockedSubjectCollection(
  transaction: Knex.Transaction,
  classId: string,
  targetSubjectId?: string
): Promise<{ items: ClassSubject[]; subjectIds: string[] }> {
  const idsResult = await transaction("turma_disciplina")
    .distinct("id_materia").where({ id_turma: classId }).orderBy("id_materia", "asc") as Array<{ id_materia: string | number }>;
  const ids = [...new Set([...idsResult.map((row) => String(row.id_materia)), ...(targetSubjectId ? [targetSubjectId] : [])])]
    .sort(numericSort);
  for (const id of ids) {
    await transaction("materia").select("id_materia").where({ id_materia: id }).forUpdate().first();
  }
  return { items: await subjectItems(transaction, classId), subjectIds: ids };
}

async function lockClassForSubjectMutation(
  transaction: Knex.Transaction,
  classId: string,
  actor: MutationActor,
  ifMatch: string,
  subjectId: string
): Promise<{
  status: "locked";
  schoolClass: ClassRow;
  collection: { items: ClassSubject[]; subjectIds: string[] };
  teacherIds: string[];
  offerId?: string;
} | { status: "not-found" | "stale" | "class-closed" }> {
  const schoolClass = await schoolClassById(transaction, classId, true);
  if (!schoolClass) return { status: "not-found" };
  if (schoolClass.fechada_em !== null) return { status: "class-closed" };
  const collection = await lockedSubjectCollection(transaction, classId, subjectId);
  const subject = await transaction("materia").select("id_materia").where({ id_materia: subjectId })
    .whereNull("excluido_em").first();
  if (!subject) return { status: "not-found" };
  const offerReference = await transaction("turma_disciplina")
    .select("id_turma_disciplina").where({ id_turma: classId, id_materia: subjectId })
    .first() as { id_turma_disciplina: string | number } | undefined;
  const offerId = offerReference ? String(offerReference.id_turma_disciplina) : undefined;
  let teacherRows: Array<{ id_usuario_professor: string | number }> = [];
  if (offerId) {
    const rows = await transaction("turma_disciplina_professor").select("id_usuario_professor")
      .where({ id_turma_disciplina: offerId }).orderBy("id_usuario_professor", "asc");
    teacherRows = rows as Array<{ id_usuario_professor: string | number }>;
  }
  const teacherIds = [...new Set(teacherRows.map((row) => String(row.id_usuario_professor)))].sort(numericSort);
  await lockUsers(transaction, [actor.actorId, ...teacherIds]);
  for (const teacherId of teacherIds) {
    await transaction("professor").select("id_usuario").where({ id_usuario: teacherId }).forUpdate().first();
  }
  if (offerId) {
    await transaction("turma_disciplina").select("id_turma_disciplina")
      .where({ id_turma_disciplina: offerId }).forUpdate().first();
    await transaction("turma_disciplina_professor").select("id_usuario_professor")
      .where({ id_turma_disciplina: offerId }).orderBy("id_usuario_professor", "asc").forUpdate();
  }
  const tag = strongEtag({ version: Number(schoolClass.subjects_version), items: collection.items });
  if (tag !== ifMatch) return { status: "stale" };
  return { status: "locked", schoolClass, collection, teacherIds, offerId };
}

export async function addClassSubject(
  knex: Knex,
  classId: string,
  subjectId: string,
  ifMatch: string,
  actor: MutationActor
): Promise<CollectionMutationResult> {
  return knex.transaction(async (transaction) => {
    const locked = await lockClassForSubjectMutation(transaction, classId, actor, ifMatch, subjectId);
    if (locked.status !== "locked") return { status: locked.status };
    const sessions = await lockAdminMutationSessions(transaction, actor.token, actor.actorId);
    if (!sessions.authorized) throw new AdminSessionRevokedError();
    const existing = locked.collection.items.some((item) => item.subjectId === subjectId);
    if (!existing) {
      await transaction("turma_disciplina").insert({ id_turma: classId, id_materia: subjectId });
      await transaction("turma").where({ id_turma: classId })
        .update({ subjects_version: transaction.raw("subjects_version + 1") });
    }
    const current = await schoolClassById(transaction, classId);
    const items = await subjectItems(transaction, classId);
    return { status: "ok", etag: strongEtag({ version: Number(current?.subjects_version), items }) };
  });
}

export type RemoveClassSubjectResult = CollectionMutationResult
  | { status: "completed-simulations" }
  | { status: "has-simulation-results" };

export async function removeClassSubject(
  knex: Knex,
  classId: string,
  subjectId: string,
  ifMatch: string,
  actor: MutationActor
): Promise<RemoveClassSubjectResult> {
  return knex.transaction(async (transaction) => {
    const locked = await lockClassForSubjectMutation(transaction, classId, actor, ifMatch, subjectId);
    if (locked.status !== "locked") return { status: locked.status };
    const offerId = locked.offerId;
    const sessions = await lockAdminMutationSessions(
      transaction, actor.token, actor.actorId, offerId ? locked.teacherIds : []
    );
    if (!sessions.authorized) throw new AdminSessionRevokedError();
    if (!offerId) return {
      status: "ok",
      etag: strongEtag({ version: Number(locked.schoolClass.subjects_version), items: locked.collection.items })
    };

    const simulations = await transaction("simulado_disciplina as sd")
      .join("simulado as s", "s.id_simulado", "sd.id_simulado")
      .select("s.id_simulado", "s.instante_confirmacao_realizacao", "s.excluido_em")
      .where("sd.id_turma", classId).where("sd.id_materia", subjectId)
      .orderBy("s.id_simulado", "asc").forUpdate() as Array<{
        id_simulado: string | number;
        instante_confirmacao_realizacao: Date | string | null;
        excluido_em: Date | string | null;
      }>;
    if (simulations.some((simulation) => simulation.instante_confirmacao_realizacao !== null)) {
      return { status: "completed-simulations" };
    }
    const simulationIds = simulations.map((simulation) => String(simulation.id_simulado));
    if (simulationIds.length > 0) {
      const results = await transaction("resultado").select("id_simulado", "id_usuario_aluno")
        .where({ id_turma: classId, id_materia: subjectId })
        .whereIn("id_simulado", simulationIds)
        .orderBy("id_simulado", "asc")
        .orderBy("id_usuario_aluno", "asc")
        .forUpdate();
      if (results.length > 0) return { status: "has-simulation-results" };
      await transaction("simulado_disciplina").where({ id_turma: classId, id_materia: subjectId })
        .whereIn("id_simulado", simulationIds).delete();
    }
    await removeCurrentTeachersForOffer(transaction, offerId);
    await transaction("turma_disciplina").where({ id_turma: classId, id_materia: subjectId }).delete();
    await transaction("turma").where({ id_turma: classId })
      .update({ subjects_version: transaction.raw("subjects_version + 1") });
    await revokeSessions(transaction, sessions.affectedSessionIds);
    const current = await schoolClassById(transaction, classId);
    const items = await subjectItems(transaction, classId);
    return { status: "ok", etag: strongEtag({ version: Number(current?.subjects_version), items }) };
  });
}
