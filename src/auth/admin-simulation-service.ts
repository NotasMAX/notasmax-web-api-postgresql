import type { Knex } from "knex";
import { effectiveEnrollmentPredicate } from "./effective-enrollment";
import { strongEtag } from "../http/etag";
import { AdminSessionRevokedError, lockAdminMutationSessions } from "./session-service";
import type { MutationActor } from "./admin-class-service";

export type SimulationSubject = { subjectId: string; totalQuestions: number; weightPercent: number };
export type Simulation = {
  simulationId: string; classId: string; number: number; type: "objetivo" | "dissertativo";
  bimester: number; scheduledDate: string; realizedAt: string | null; subjects: SimulationSubject[];
};
export type SimulationInput = Pick<Simulation, "type" | "bimester" | "scheduledDate" | "subjects">;
export type SimulationPatch = Partial<SimulationInput>;
export type SimulationQuery = { page: number; pageSize: number; bimester?: number; type?: Simulation["type"];
  subjectId?: string; fromDate?: string; toDate?: string };
type SimRow = { id_simulado: string | number; id_turma: string | number; numero: number; tipo: Simulation["type"];
  bimestre: number; data_realizacao: string; instante_confirmacao_realizacao: Date | string | null };
type SubjectRow = { id_materia: string | number; total_questoes: number; peso: string | number };
const numericSort = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
const simFields = ["id_simulado", "id_turma", "numero", "tipo", "bimestre", "data_realizacao",
  "instante_confirmacao_realizacao"];

// Lock order: class first for every class-scoped mutation. Confirmation then locks affected users
// and sessions by ID, student profiles by ID, enrollment rows by ID, the simulation, subjects by ID,
// and finally inserts the participant/result snapshot. This root class lock serializes it with
// class closure, enrollment changes, and the other simulation mutations for the same class.

function isoDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}
function representation(row: SimRow, subjects: SubjectRow[]): Simulation {
  return { simulationId: String(row.id_simulado), classId: String(row.id_turma), number: Number(row.numero),
    type: row.tipo, bimester: Number(row.bimestre), scheduledDate: isoDate(row.data_realizacao),
    realizedAt: row.instante_confirmacao_realizacao === null ? null
      : new Date(row.instante_confirmacao_realizacao).toISOString(),
    subjects: subjects.map((s) => ({ subjectId: String(s.id_materia), totalQuestions: Number(s.total_questoes),
      weightPercent: Number(s.peso) * 100 })) };
}
async function subjectRows(query: Knex | Knex.Transaction, simulationId: string): Promise<SubjectRow[]> {
  return await query("simulado_disciplina").select("id_materia", "total_questoes", "peso")
    .where({ id_simulado: simulationId }).orderBy("id_materia", "asc") as SubjectRow[];
}
async function loadSimulation(query: Knex | Knex.Transaction, classId: string, simulationId: string,
  lock = false): Promise<{ row: SimRow; subjects: SubjectRow[] } | undefined> {
  const q = query("simulado").select(...simFields).where({ id_turma: classId, id_simulado: simulationId })
    .whereNull("excluido_em");
  if (lock) q.forUpdate();
  const row = await q.first() as SimRow | undefined;
  return row ? { row, subjects: await subjectRows(query, simulationId) } : undefined;
}
function itemTag(row: SimRow, subjects: SubjectRow[]): string {
  return strongEtag(representation(row, subjects));
}
async function activeClass(query: Knex | Knex.Transaction, classId: string, lock = false) {
  const q = query("turma").select("id_turma", "fechada_em").where({ id_turma: classId });
  if (lock) q.forUpdate();
  return await q.first() as { id_turma: string | number; fechada_em: Date | string | null } | undefined;
}
async function lockActor(transaction: Knex.Transaction, actor: MutationActor, affected: string[] = []) {
  for (const id of [...new Set([actor.actorId, ...affected])].sort(numericSort)) {
    await transaction("usuario").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
  }
  const session = await lockAdminMutationSessions(transaction, actor.token, actor.actorId, affected);
  if (!session.authorized) throw new AdminSessionRevokedError();
}
async function lockedOffers(transaction: Knex.Transaction, classId: string, subjectIds: string[]) {
  const ids = [...new Set(subjectIds)].sort(numericSort);
  const offers = await transaction("turma_disciplina as td").join("materia as m", "m.id_materia", "td.id_materia")
    .select("td.id_materia").where("td.id_turma", classId).whereIn("td.id_materia", ids)
    .whereNull("m.excluido_em").orderBy("td.id_materia", "asc").forUpdate("td") as Array<{ id_materia: string | number }>;
  return offers.map((row) => String(row.id_materia));
}
async function weightExceeded(transaction: Knex.Transaction, classId: string, bimester: number,
  subjects: SimulationSubject[], exceptId?: string): Promise<boolean> {
  for (const subject of [...subjects].sort((a, b) => numericSort(a.subjectId, b.subjectId))) {
    const query = transaction("simulado_disciplina as sd").join("simulado as s", function join() {
      this.on("s.id_simulado", "=", "sd.id_simulado").andOn("s.id_turma", "=", "sd.id_turma");
    }).where("sd.id_turma", classId).where("sd.id_materia", subject.subjectId)
      .where("s.bimestre", bimester).whereNull("s.excluido_em");
    if (exceptId) query.whereNot("s.id_simulado", exceptId);
    const result = await query.sum({ total: "sd.peso" }).first() as { total: string | number | null };
    const allocatedBasisPoints = Math.round(Number(result.total ?? 0) * 10000);
    const requestedBasisPoints = Math.round(subject.weightPercent * 100);
    if (allocatedBasisPoints + requestedBasisPoints > 10000) return true;
  }
  return false;
}
async function writeSubjects(transaction: Knex.Transaction, simulationId: string, classId: string,
  subjects: SimulationSubject[]) {
  await transaction("simulado_disciplina").where({ id_simulado: simulationId, id_turma: classId }).del();
  if (subjects.length) await transaction("simulado_disciplina").insert(subjects.map((s) => ({
    id_simulado: simulationId, id_turma: classId, id_materia: s.subjectId,
    total_questoes: s.totalQuestions, peso: s.weightPercent / 100
  })));
}

export async function listSimulations(knex: Knex, classId: string, filters: SimulationQuery) {
  const schoolClass = await activeClass(knex, classId);
  if (!schoolClass) return undefined;
  const base = () => knex("simulado as s").where("s.id_turma", classId).whereNull("s.excluido_em")
    .modify((q) => {
      if (filters.bimester !== undefined) q.where("s.bimestre", filters.bimester);
      if (filters.type !== undefined) q.where("s.tipo", filters.type);
      if (filters.fromDate !== undefined) q.where("s.data_realizacao", ">=", filters.fromDate);
      if (filters.toDate !== undefined) q.where("s.data_realizacao", "<=", filters.toDate);
      if (filters.subjectId !== undefined) q.whereExists(function subject() {
        this.select(1).from("simulado_disciplina as sd").whereRaw("sd.id_simulado = s.id_simulado")
          .where("sd.id_turma", classId).where("sd.id_materia", filters.subjectId);
      });
    });
  const count = await base().count({ total: "s.id_simulado" }).first() as { total: string | number };
  const rows = await base().select(...simFields.map((name) => `s.${name}`))
    .orderBy("s.data_realizacao", "asc").orderBy("s.numero", "asc").orderBy("s.id_simulado", "asc")
    .limit(filters.pageSize).offset((filters.page - 1) * filters.pageSize) as SimRow[];
  const items: Simulation[] = [];
  for (const row of rows) items.push(representation(row, await subjectRows(knex, String(row.id_simulado))));
  const totalItems = Number(count.total);
  return { items, pagination: { page: filters.page, pageSize: filters.pageSize, totalItems,
    totalPages: Math.ceil(totalItems / filters.pageSize) } };
}
export async function getSimulation(knex: Knex, classId: string, simulationId: string) {
  const item = await loadSimulation(knex, classId, simulationId);
  return item ? { simulation: representation(item.row, item.subjects), etag: itemTag(item.row, item.subjects) } : undefined;
}

export type SimulationMutationResult = { status: "ok" | "created"; simulation: Simulation; etag: string }
  | { status: "not-found" | "class-closed" | "stale" | "realized" | "has-linked-answers" | "invalid-subjects" | "weight-exceeded" };
export async function createSimulation(knex: Knex, classId: string, input: SimulationInput, actor: MutationActor): Promise<SimulationMutationResult> {
  return knex.transaction(async (trx) => {
    const schoolClass = await activeClass(trx, classId, true);
    if (!schoolClass) return { status: "not-found" };
    await lockActor(trx, actor);
    if (schoolClass.fechada_em !== null) return { status: "class-closed" };
    const subjectIds = input.subjects.map((s) => s.subjectId);
    if (new Set(subjectIds).size !== subjectIds.length || subjectIds.length === 0) return { status: "invalid-subjects" };
    if ((await lockedOffers(trx, classId, subjectIds)).length !== subjectIds.length) return { status: "invalid-subjects" };
    if (await weightExceeded(trx, classId, input.bimester, input.subjects)) return { status: "weight-exceeded" };
    const rows = await trx("simulado").select("numero").where({ id_turma: classId }).whereNull("excluido_em").orderBy("numero", "asc");
    const used = new Set(rows.map((r: { numero: number }) => Number(r.numero)));
    let number = 1; while (used.has(number)) number += 1;
    const [row] = await trx("simulado").insert({ id_turma: classId, numero: number, tipo: input.type,
      bimestre: input.bimester, data_realizacao: input.scheduledDate }).returning(simFields) as SimRow[];
    await writeSubjects(trx, String(row.id_simulado), classId, input.subjects);
    const subjects = await subjectRows(trx, String(row.id_simulado));
    return { status: "created", simulation: representation(row, subjects), etag: itemTag(row, subjects) };
  });
}
export async function updateSimulation(knex: Knex, classId: string, simulationId: string, input: SimulationPatch,
  ifMatch: string, actor: MutationActor): Promise<SimulationMutationResult> {
  return knex.transaction(async (trx) => {
    const schoolClass = await activeClass(trx, classId, true);
    if (!schoolClass) return { status: "not-found" };
    await lockActor(trx, actor);
    const current = await loadSimulation(trx, classId, simulationId, true);
    if (!current) return { status: "not-found" };
    if (itemTag(current.row, current.subjects) !== ifMatch) return { status: "stale" };
    if (schoolClass.fechada_em !== null) return { status: "class-closed" };
    if (current.row.instante_confirmacao_realizacao !== null) return { status: "realized" };
    const subjects = input.subjects ?? representation(current.row, current.subjects).subjects;
    if (subjects.length === 0 || new Set(subjects.map((s) => s.subjectId)).size !== subjects.length) return { status: "invalid-subjects" };
    if (input.subjects || input.bimester !== undefined) {
      if ((await lockedOffers(trx, classId, subjects.map((s) => s.subjectId))).length !== subjects.length) return { status: "invalid-subjects" };
      if (await weightExceeded(trx, classId, input.bimester ?? Number(current.row.bimestre), subjects, simulationId)) return { status: "weight-exceeded" };
    }
    const [row] = await trx("simulado").where({ id_simulado: simulationId, id_turma: classId }).update({
      tipo: input.type ?? current.row.tipo, bimestre: input.bimester ?? current.row.bimestre,
      data_realizacao: input.scheduledDate ?? current.row.data_realizacao
    }).returning(simFields) as SimRow[];
    if (input.subjects) await writeSubjects(trx, simulationId, classId, subjects);
    const resultSubjects = await subjectRows(trx, simulationId);
    return { status: "ok", simulation: representation(row, resultSubjects), etag: itemTag(row, resultSubjects) };
  });
}
export type ConfirmResult = SimulationMutationResult;
export async function confirmSimulation(knex: Knex, classId: string, simulationId: string, ifMatch: string,
  actor: MutationActor): Promise<ConfirmResult> {
  return knex.transaction(async (trx) => {
    const schoolClass = await activeClass(trx, classId, true);
    if (!schoolClass) return { status: "not-found" };
    const reference = await loadSimulation(trx, classId, simulationId);
    if (!reference) return { status: "not-found" };
    const enrollmentRows = await trx("matricula as m").distinct("m.id_usuario_aluno")
      .where("m.id_turma", classId).whereRaw(effectiveEnrollmentPredicate("m", "?::date"),
        [reference.row.data_realizacao, reference.row.data_realizacao])
      .orderBy("m.id_usuario_aluno", "asc") as Array<{ id_usuario_aluno: string | number }>;
    const studentIds = enrollmentRows.map((r) => String(r.id_usuario_aluno)).sort(numericSort);
    await lockActor(trx, actor, studentIds);
    for (const id of studentIds) await trx("aluno").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
    await trx("matricula").select("id_matricula").where({ id_turma: classId }).orderBy("id_matricula", "asc").forUpdate();
    const current = await loadSimulation(trx, classId, simulationId, true);
    if (!current) return { status: "not-found" };
    if (itemTag(current.row, current.subjects) !== ifMatch) return { status: "stale" };
    if (schoolClass.fechada_em !== null) return { status: "class-closed" };
    if (current.row.instante_confirmacao_realizacao !== null) return { status: "realized" };
    await trx("simulado_disciplina").select("id_materia").where({ id_simulado: simulationId, id_turma: classId })
      .orderBy("id_materia", "asc").forUpdate();
    const [updated] = await trx("simulado").where({ id_simulado: simulationId, id_turma: classId }).whereNull("instante_confirmacao_realizacao")
      .update({ instante_confirmacao_realizacao: trx.raw("clock_timestamp()") }).returning(simFields) as SimRow[];
    if (!updated) return { status: "realized" };
    if (studentIds.length) await trx("simulado_aluno").insert(studentIds.map((id) => ({ id_simulado: simulationId, id_usuario_aluno: id })));
    if (studentIds.length && current.subjects.length) {
      const resultRows = studentIds.flatMap((studentId) => current.subjects.map((subject) => ({
        id_simulado: simulationId, id_usuario_aluno: studentId, id_turma: classId, id_materia: subject.id_materia,
        estado: "pendente", acertos: null
      })));
      await trx("resultado").insert(resultRows);
    }
    const subjects = await subjectRows(trx, simulationId);
    return { status: "ok", simulation: representation(updated, subjects), etag: itemTag(updated, subjects) };
  });
}
export async function deleteSimulation(knex: Knex, classId: string, simulationId: string, ifMatch: string,
  actor: MutationActor): Promise<{ status: "deleted" | "not-found" | "class-closed" | "stale" | "realized" | "has-linked-answers" }> {
  return knex.transaction(async (trx) => {
    const schoolClass = await activeClass(trx, classId, true);
    if (!schoolClass) return { status: "not-found" };
    await lockActor(trx, actor);
    const current = await loadSimulation(trx, classId, simulationId, true);
    if (!current) return { status: "not-found" };
    if (itemTag(current.row, current.subjects) !== ifMatch) return { status: "stale" };
    if (schoolClass.fechada_em !== null) return { status: "class-closed" };
    if (current.row.instante_confirmacao_realizacao !== null) return { status: "has-linked-answers" };
    const result = await trx("resultado").select("id_simulado").where({ id_simulado: simulationId, id_turma: classId }).first();
    if (result) return { status: "has-linked-answers" };
    await trx("simulado").where({ id_simulado: simulationId, id_turma: classId }).update({ excluido_em: trx.raw("clock_timestamp()") });
    return { status: "deleted" };
  });
}
