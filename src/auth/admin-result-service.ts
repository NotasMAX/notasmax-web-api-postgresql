import type { Knex } from "knex";
import { strongEtag } from "../http/etag";
import { AdminSessionRevokedError, lockAdminMutationSessions } from "./session-service";
import type { MutationActor } from "./admin-class-service";
import { resultScore, weightedContribution, type ResultState } from "./result-calculations";

const numericSort = (a: string, b: string) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0;
type Row = { id_simulado: string | number; id_usuario_aluno: string | number; id_turma: string | number;
  id_materia: string | number; estado: "pendente" | "avaliado" | "ausente"; acertos: number | null;
  total_questoes: number; peso: string | number; student_name: string; subject_name: string };
type ResultRepresentation = { simulationId: string; studentId: string; studentName: string; subjectId: string;
  subjectName: string; status: ResultState; correctAnswers: number | null; totalQuestions: number;
  weightPercent: number; score: number | null; weightedContribution: number | null };
type ResultFilters = { page: number; pageSize: number; subjectId?: string; status?: ResultState; search?: string };

function representation(row: Row): ResultRepresentation {
  const status: ResultState = row.estado === "pendente" ? "pending" : row.estado === "avaliado" ? "assessed" : "absent";
  const totalQuestions = Number(row.total_questoes);
  const correctAnswers = row.acertos === null ? null : Number(row.acertos);
  const weightPercent = Number(row.peso) * 100;
  const score = resultScore(status, correctAnswers, totalQuestions);
  return { simulationId: String(row.id_simulado), studentId: String(row.id_usuario_aluno), studentName: row.student_name,
    subjectId: String(row.id_materia), subjectName: row.subject_name, status, correctAnswers, totalQuestions,
    weightPercent, score, weightedContribution: weightedContribution(score, weightPercent) };
}

function resultQuery(knex: Knex | Knex.Transaction, classId: string, simulationId: string) {
  return knex("resultado as r")
    .join("simulado as s", function simulationJoin() {
      this.on("s.id_simulado", "=", "r.id_simulado").andOn("s.id_turma", "=", "r.id_turma");
    })
    .join("simulado_disciplina as sd", function subjectJoin() {
      this.on("sd.id_simulado", "=", "r.id_simulado").andOn("sd.id_turma", "=", "r.id_turma")
        .andOn("sd.id_materia", "=", "r.id_materia");
    })
    .join("usuario as u", "u.id_usuario", "r.id_usuario_aluno")
    .join("materia as m", "m.id_materia", "r.id_materia")
    .where("r.id_turma", classId).where("r.id_simulado", simulationId)
    .whereNotNull("s.instante_confirmacao_realizacao").whereNull("s.excluido_em")
    .select("r.id_simulado", "r.id_usuario_aluno", "r.id_turma", "r.id_materia", "r.estado", "r.acertos",
      "sd.total_questoes", "sd.peso", { student_name: "u.nome_completo" }, { subject_name: "m.nome" });
}

async function authorizedSimulation(query: Knex | Knex.Transaction, classId: string, simulationId: string) {
  return await query("simulado").select("id_simulado").where({ id_turma: classId, id_simulado: simulationId })
    .whereNull("excluido_em").whereNotNull("instante_confirmacao_realizacao").first();
}

export async function listResults(knex: Knex, classId: string, simulationId: string, filters: ResultFilters) {
  const simulation = await authorizedSimulation(knex, classId, simulationId);
  if (!simulation) return undefined;
  const base = () => resultQuery(knex, classId, simulationId).modify((q) => {
    if (filters.subjectId) q.where("r.id_materia", filters.subjectId);
    if (filters.status) q.where("r.estado", filters.status === "pending" ? "pendente" : filters.status === "assessed" ? "avaliado" : "ausente");
    if (filters.search) q.andWhere((search) => {
      search.whereILike("u.nome_completo", `%${filters.search}%`);
      if (/^[1-9]\d{0,18}$/.test(filters.search!) && BigInt(filters.search!) <= 9223372036854775807n) {
        search.orWhere("r.id_usuario_aluno", filters.search);
      }
    });
  });
  const count = await base().clearSelect().count({ total: "r.id_usuario_aluno" }).first() as { total: string | number };
  const rows = await base().orderBy("u.nome_completo", "asc").orderBy("r.id_usuario_aluno", "asc")
    .orderBy("m.nome", "asc").orderBy("r.id_materia", "asc")
    .limit(filters.pageSize).offset((filters.page - 1) * filters.pageSize) as unknown as Row[];
  const totalItems = Number(count.total);
  return { items: rows.map(representation), pagination: { page: filters.page, pageSize: filters.pageSize,
    totalItems, totalPages: Math.ceil(totalItems / filters.pageSize) } };
}

export async function getResult(knex: Knex, classId: string, simulationId: string, studentId: string, subjectId: string) {
  const row = await resultQuery(knex, classId, simulationId).where({ "r.id_usuario_aluno": studentId, "r.id_materia": subjectId })
    .first() as Row | undefined;
  return row ? { result: representation(row), etag: strongEtag(representation(row)) } : undefined;
}

type MutationResult = { status: "ok"; result: ResultRepresentation; etag: string }
  | { status: "not-found" | "stale" | "invalid-transition" | "score-out-of-range" | "not-realized" };

// Result writes lock affected user rows by numeric ID, revalidate the admin session,
// then lock simulation, subject, and result in that order before recalculating If-Match.
export async function updateResult(knex: Knex, classId: string, simulationId: string, studentId: string, subjectId: string,
  status: ResultState, correctAnswers: number | undefined, ifMatch: string, actor: MutationActor): Promise<MutationResult> {
  return knex.transaction(async (trx) => {
    const schoolClass = await trx("turma").select("id_turma").where({ id_turma: classId }).first();
    if (!schoolClass) return { status: "not-found" };
    for (const id of [...new Set([actor.actorId, studentId])].sort(numericSort)) {
      await trx("usuario").select("id_usuario").where({ id_usuario: id }).forUpdate().first();
    }
    const session = await lockAdminMutationSessions(trx, actor.token, actor.actorId);
    if (!session.authorized) throw new AdminSessionRevokedError();
    const simulation = await trx("simulado").select("id_simulado")
      .where({ id_turma: classId, id_simulado: simulationId }).whereNull("excluido_em").forUpdate().first();
    if (!simulation) return { status: "not-found" };
    if (!(await trx("simulado").where({ id_turma: classId, id_simulado: simulationId }).whereNotNull("instante_confirmacao_realizacao").first())) {
      return { status: "not-realized" };
    }
    const subject = await trx("simulado_disciplina").select("id_materia")
      .where({ id_turma: classId, id_simulado: simulationId, id_materia: subjectId }).forUpdate().first();
    if (!subject) return { status: "not-found" };
    const current = await resultQuery(trx, classId, simulationId)
      .where({ "r.id_usuario_aluno": studentId, "r.id_materia": subjectId }).forUpdate("r").first() as Row | undefined;
    if (!current) return { status: "not-found" };
    const currentResult = representation(current);
    if (strongEtag(currentResult) !== ifMatch) return { status: "stale" };
    const oldState = currentResult.status;
    if (!((oldState === "pending" && (status === "assessed" || status === "absent"))
      || (oldState === "absent" && status === "assessed")
      || (oldState === "assessed" && status === "assessed"))) return { status: "invalid-transition" };
    if (status === "assessed") {
      if (correctAnswers === undefined || correctAnswers > currentResult.totalQuestions) return { status: "score-out-of-range" };
    } else if (correctAnswers !== undefined) return { status: "invalid-transition" };
    const [updated] = await trx("resultado").where({ id_simulado: simulationId, id_turma: classId,
      id_usuario_aluno: studentId, id_materia: subjectId }).update({
      estado: status === "assessed" ? "avaliado" : "ausente",
      acertos: status === "assessed" ? correctAnswers : null
    }).returning(["id_simulado", "id_usuario_aluno", "id_turma", "id_materia", "estado", "acertos"]) as Array<Record<string, unknown>>;
    const fresh = await resultQuery(trx, classId, simulationId)
      .where({ "r.id_usuario_aluno": studentId, "r.id_materia": subjectId }).first() as Row;
    void updated;
    const result = representation(fresh);
    return { status: "ok", result, etag: strongEtag(result) };
  });
}
