import type { Knex } from "knex";

export type SubjectListQuery = {
  search?: string;
  page: number;
  pageSize: number;
};

export type NewSubject = {
  name: string;
  description?: string;
};

export type SubjectPatch = {
  name?: string;
  description?: string | null;
};

type SubjectRow = {
  id_materia: string | number;
  nome: string;
  descricao: string | null;
};

export type Subject = {
  subjectId: string;
  name: string;
  description: string | null;
};

function subjectItem(row: SubjectRow): Subject {
  return {
    subjectId: String(row.id_materia),
    name: row.nome,
    description: row.descricao
  };
}

function activeSubjects(knex: Knex, filters: SubjectListQuery) {
  const query = knex("materia").whereNull("excluido_em");
  if (filters.search) query.whereILike("nome", `%${filters.search}%`);
  return query;
}

export async function listSubjects(
  knex: Knex,
  filters: SubjectListQuery
): Promise<{ items: Subject[]; pagination: {
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
} }> {
  const count = await activeSubjects(knex, filters)
    .count({ total_items: "id_materia" })
    .first() as { total_items: string | number };
  const totalItems = Number(count.total_items);
  const rows = await activeSubjects(knex, filters)
    .select("id_materia", "nome", "descricao")
    .orderBy("nome", "asc")
    .orderBy("id_materia", "asc")
    .limit(filters.pageSize)
    .offset((filters.page - 1) * filters.pageSize) as SubjectRow[];

  return {
    items: rows.map(subjectItem),
    pagination: {
      page: filters.page,
      pageSize: filters.pageSize,
      totalItems,
      totalPages: Math.ceil(totalItems / filters.pageSize)
    }
  };
}

export async function createSubject(knex: Knex, input: NewSubject): Promise<Subject> {
  const [row] = await knex("materia")
    .insert({ nome: input.name, descricao: input.description ?? null })
    .returning(["id_materia", "nome", "descricao"]) as SubjectRow[];
  return subjectItem(row);
}

export async function updateSubject(
  knex: Knex,
  subjectId: string,
  input: SubjectPatch
): Promise<Subject | undefined> {
  const values: Record<string, string | null> = {};
  if (input.name !== undefined) values.nome = input.name;
  if (input.description !== undefined) values.descricao = input.description;

  const [row] = await knex("materia")
    .where({ id_materia: subjectId })
    .whereNull("excluido_em")
    .update(values)
    .returning(["id_materia", "nome", "descricao"]) as SubjectRow[];
  return row ? subjectItem(row) : undefined;
}

export type DeleteSubjectResult = "deleted" | "not-found" | "has-class-links";

export async function deleteSubject(knex: Knex, subjectId: string): Promise<DeleteSubjectResult> {
  return knex.transaction(async (transaction) => {
    const subject = await transaction("materia")
      .select("id_materia", "excluido_em")
      .where({ id_materia: subjectId })
      .forUpdate()
      .first() as { id_materia: string | number; excluido_em: Date | string | null } | undefined;

    if (!subject) return "not-found";
    if (subject.excluido_em !== null) return "deleted";

    const offer = await transaction("turma_disciplina")
      .select("id_turma_disciplina")
      .where({ id_materia: subjectId })
      .first();
    if (offer) return "has-class-links";

    await transaction("materia")
      .where({ id_materia: subjectId })
      .whereNull("excluido_em")
      .update({ excluido_em: transaction.raw("clock_timestamp()") });
    return "deleted";
  });
}
