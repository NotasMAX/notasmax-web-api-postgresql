import type { Knex } from "knex";
import { removeCurrentTeachersForOffer } from "./teacher-association-service";

export type ClassListQuery = {
  schoolYear: number;
  page: number;
  pageSize: number;
};

export type NewClass = {
  series: number;
  schoolYear: number;
};

export type ClassPatch = Partial<NewClass>;

export type SchoolClass = {
  classId: string;
  series: number;
  schoolYear: number;
};

type ClassRow = {
  id_turma: string | number;
  serie: number;
  ano_letivo: number;
  excluido_em?: Date | string | null;
};

type ActiveClassRow = {
  id_turma: string | number;
  serie: number;
  ano_letivo: number;
};

function classItem(row: ClassRow | ActiveClassRow): SchoolClass {
  return {
    classId: String(row.id_turma),
    series: row.serie,
    schoolYear: row.ano_letivo
  };
}

function activeClasses(knex: Knex, filters: ClassListQuery) {
  return knex("turma")
    .where({ ano_letivo: filters.schoolYear })
    .whereNull("excluido_em");
}

export async function listClasses(
  knex: Knex,
  filters: ClassListQuery
): Promise<{ items: SchoolClass[]; pagination: {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
} }> {
  const count = await activeClasses(knex, filters)
    .count({ total_items: "id_turma" })
    .first() as { total_items: string | number };
  const totalItems = Number(count.total_items);
  const rows = await activeClasses(knex, filters)
    .select("id_turma", "serie", "ano_letivo")
    .orderBy("ano_letivo", "asc")
    .orderBy("serie", "asc")
    .orderBy("id_turma", "asc")
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize) as ActiveClassRow[];

  return {
    items: rows.map(classItem),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / filters.pageSize)
    }
  };
}

export async function listActiveSchoolYears(knex: Knex): Promise<{ items: Array<{ schoolYear: number }> }> {
  const rows = await knex("turma")
    .distinct({ schoolYear: "ano_letivo" })
    .whereNull("excluido_em")
    .orderBy("ano_letivo", "desc") as Array<{ schoolYear: number }>;
  return { items: rows };
}

export async function getClass(knex: Knex, classId: string): Promise<SchoolClass | undefined> {
  const row = await knex("turma")
    .select("id_turma", "serie", "ano_letivo")
    .where({ id_turma: classId })
    .whereNull("excluido_em")
    .first() as ActiveClassRow | undefined;
  return row ? classItem(row) : undefined;
}

export async function createClass(knex: Knex, input: NewClass): Promise<SchoolClass> {
  const [row] = await knex("turma")
    .insert({ serie: input.series, ano_letivo: input.schoolYear })
    .returning(["id_turma", "serie", "ano_letivo"]) as ActiveClassRow[];
  return classItem(row);
}

async function hasAnyClassLinks(transaction: Knex.Transaction, classId: string): Promise<boolean> {
  const enrollment = await transaction("matricula")
    .select("id_matricula")
    .where({ id_turma: classId })
    .forUpdate()
    .first();
  if (enrollment) return true;

  const offer = await transaction("turma_disciplina")
    .select("id_turma_disciplina")
    .where({ id_turma: classId })
    .forUpdate()
    .first();
  if (offer) return true;

  const simulation = await transaction("simulado")
    .select("id_simulado")
    .where({ id_turma: classId })
    .forUpdate()
    .first();
  return Boolean(simulation);
}

export type UpdateClassResult =
  | { status: "ok"; schoolClass: SchoolClass }
  | { status: "not-found" }
  | { status: "has-linked-data" };

export async function updateClass(
  knex: Knex,
  classId: string,
  input: ClassPatch
): Promise<UpdateClassResult> {
  return knex.transaction(async (transaction) => {
    const current = await transaction("turma")
      .select("id_turma", "serie", "ano_letivo", "excluido_em")
      .where({ id_turma: classId })
      .forUpdate()
      .first() as ClassRow | undefined;
    if (!current || current.excluido_em !== null) return { status: "not-found" };

    const nextSeries = input.series ?? current.serie;
    const nextSchoolYear = input.schoolYear ?? current.ano_letivo;
    if (nextSeries === current.serie && nextSchoolYear === current.ano_letivo) {
      return { status: "ok", schoolClass: classItem(current) };
    }
    if (await hasAnyClassLinks(transaction, classId)) return { status: "has-linked-data" };

    const [updated] = await transaction("turma")
      .where({ id_turma: classId })
      .whereNull("excluido_em")
      .update({ serie: nextSeries, ano_letivo: nextSchoolYear })
      .returning(["id_turma", "serie", "ano_letivo"]) as ActiveClassRow[];
    return updated
      ? { status: "ok", schoolClass: classItem(updated) }
      : { status: "not-found" };
  });
}

async function hasCurrentEnrollment(transaction: Knex.Transaction, classId: string): Promise<boolean> {
  const rows = await transaction("matricula")
    .select(
      "id_matricula",
      transaction.raw(`(
        cancelada_em IS NULL
        AND inicio_vigencia <= CURRENT_DATE
        AND (fim_vigencia IS NULL OR fim_vigencia >= CURRENT_DATE)
      ) AS is_current`)
    )
    .where({ id_turma: classId })
    .forUpdate();
  const enrollments = rows as Array<{ id_matricula: string | number; is_current: boolean }>;
  return enrollments.some((enrollment) => enrollment.is_current);
}

async function hasActiveSimulation(transaction: Knex.Transaction, classId: string): Promise<boolean> {
  const simulations = await transaction("simulado")
    .select("id_simulado", "instante_confirmacao_realizacao", "excluido_em")
    .where({ id_turma: classId })
    .orderBy("id_simulado", "asc")
    .forUpdate() as Array<{
      id_simulado: string | number;
      instante_confirmacao_realizacao: Date | string | null;
      excluido_em: Date | string | null;
    }>;
  return simulations.some((simulation) =>
    simulation.instante_confirmacao_realizacao === null && simulation.excluido_em === null
  );
}

export type DeleteClassResult = "deleted" | "not-found" | "has-linked-data";

export async function deleteClass(knex: Knex, classId: string): Promise<DeleteClassResult> {
  return knex.transaction(async (transaction) => {
    const current = await transaction("turma")
      .select("id_turma", "excluido_em")
      .where({ id_turma: classId })
      .forUpdate()
      .first() as { id_turma: string | number; excluido_em: Date | string | null } | undefined;
    if (!current) return "not-found";
    if (current.excluido_em !== null) return "deleted";

    if (await hasCurrentEnrollment(transaction, classId)) return "has-linked-data";
    const offer = await transaction("turma_disciplina")
      .select("id_turma_disciplina")
      .where({ id_turma: classId })
      .forUpdate()
      .first();
    if (offer) return "has-linked-data";
    if (await hasActiveSimulation(transaction, classId)) return "has-linked-data";

    await transaction("turma")
      .where({ id_turma: classId })
      .whereNull("excluido_em")
      .update({ excluido_em: transaction.raw("clock_timestamp()") });
    return "deleted";
  });
}

export type ClassSubject = {
  subjectId: string;
  name: string;
  description: string | null;
};

export async function listClassSubjects(
  knex: Knex,
  classId: string
): Promise<{ status: "ok"; items: ClassSubject[] } | { status: "not-found" }> {
  const rows = await knex("turma as t")
    .leftJoin("turma_disciplina as td", "td.id_turma", "t.id_turma")
    .leftJoin("materia as m", function activeSubjects() {
      this.on("m.id_materia", "=", "td.id_materia").andOnNull("m.excluido_em");
    })
    .select("t.id_turma", "m.id_materia", "m.nome", "m.descricao")
    .where("t.id_turma", classId)
    .whereNull("t.excluido_em")
    .orderBy("m.nome", "asc")
    .orderBy("m.id_materia", "asc") as Array<{
      id_turma: string | number;
      id_materia: string | number | null;
      nome: string | null;
      descricao: string | null;
    }>;
  if (rows.length === 0) return { status: "not-found" };

  return {
    status: "ok",
    items: rows.flatMap((row) => row.id_materia === null ? [] : [{
      subjectId: String(row.id_materia),
      name: row.nome as string,
      description: row.descricao
    }])
  };
}

type ActiveResourceResult = { status: "ok" } | { status: "not-found" };

async function lockActiveClass(
  transaction: Knex.Transaction,
  classId: string
): Promise<boolean> {
  const row = await transaction("turma")
    .select("id_turma")
    .where({ id_turma: classId })
    .whereNull("excluido_em")
    .forUpdate()
    .first();
  return Boolean(row);
}

async function lockActiveSubject(
  transaction: Knex.Transaction,
  subjectId: string
): Promise<boolean> {
  const row = await transaction("materia")
    .select("id_materia")
    .where({ id_materia: subjectId })
    .whereNull("excluido_em")
    .forUpdate()
    .first();
  return Boolean(row);
}

export async function addClassSubject(
  knex: Knex,
  classId: string,
  subjectId: string
): Promise<ActiveResourceResult> {
  return knex.transaction(async (transaction) => {
    if (!await lockActiveClass(transaction, classId)) return { status: "not-found" };
    if (!await lockActiveSubject(transaction, subjectId)) return { status: "not-found" };

    await transaction("turma_disciplina")
      .insert({ id_turma: classId, id_materia: subjectId })
      .onConflict(["id_turma", "id_materia"])
      .ignore();
    return { status: "ok" };
  });
}

export type RemoveClassSubjectResult =
  | { status: "removed" }
  | { status: "not-found" }
  | { status: "completed-simulations" }
  | { status: "has-simulation-results" };

export async function removeClassSubject(
  knex: Knex,
  classId: string,
  subjectId: string
): Promise<RemoveClassSubjectResult> {
  return knex.transaction(async (transaction) => {
    if (!await lockActiveClass(transaction, classId)) return { status: "not-found" };
    if (!await lockActiveSubject(transaction, subjectId)) return { status: "not-found" };

    const offer = await transaction("turma_disciplina")
      .select("id_turma_disciplina")
      .where({ id_turma: classId, id_materia: subjectId })
      .forUpdate()
      .first() as { id_turma_disciplina: string | number } | undefined;
    if (!offer) return { status: "removed" };

    const simulations = await transaction("simulado_disciplina as sd")
      .join("simulado as s", "s.id_simulado", "sd.id_simulado")
      .select("s.id_simulado", "s.instante_confirmacao_realizacao", "s.excluido_em")
      .where("sd.id_turma", classId)
      .where("sd.id_materia", subjectId)
      .orderBy("s.id_simulado", "asc")
      .forUpdate() as Array<{
        id_simulado: string | number;
        instante_confirmacao_realizacao: Date | string | null;
        excluido_em: Date | string | null;
      }>;
    if (simulations.some((simulation) => simulation.instante_confirmacao_realizacao !== null)) {
      return { status: "completed-simulations" };
    }

    const unconfirmedIds = simulations.map((simulation) => String(simulation.id_simulado));
    if (unconfirmedIds.length > 0) {
      const result = await transaction("resultado")
        .select("id_simulado")
        .where({ id_turma: classId, id_materia: subjectId })
        .whereIn("id_simulado", unconfirmedIds)
        .first();
      if (result) return { status: "has-simulation-results" };

      await transaction("simulado_disciplina")
        .where({ id_turma: classId, id_materia: subjectId })
        .whereIn("id_simulado", unconfirmedIds)
        .delete();
    }

    await removeCurrentTeachersForOffer(transaction, String(offer.id_turma_disciplina));
    await transaction("turma_disciplina")
      .where({ id_turma: classId, id_materia: subjectId })
      .delete();
    return { status: "removed" };
  });
}
