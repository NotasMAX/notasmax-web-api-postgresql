import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { withSecurityEvent } from "../http/security-event";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import {
  configuredOrigins,
  internalFailure,
  mutationRejection,
  requireAdminSession
} from "./handler";
import {
  createSubject,
  deleteSubject,
  listSubjects,
  updateSubject,
  type NewSubject,
  type SubjectListQuery,
  type SubjectPatch
} from "./admin-subject-service";

const MAX_SUBJECT_BODY_BYTES = 8 * 1024;
const MAX_POSTGRES_ID = 9223372036854775807n;

const idSchema = z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value)
  && BigInt(value) <= MAX_POSTGRES_ID);
const positivePageSchema = z.string().regex(/^[1-9]\d*$/);
const listQuerySchema = z.strictObject({
  search: z.string().trim().optional(),
  page: positivePageSchema.default("1").transform(Number).pipe(z.number().int().safe().positive()),
  pageSize: positivePageSchema.default("20").transform(Number)
    .pipe(z.number().int().safe().positive().max(100))
});
const nameSchema = z.string().trim().min(1).max(120);
const descriptionSchema = z.string().max(500);
const createSchema = z.strictObject({
  name: nameSchema,
  description: descriptionSchema.optional()
});
const patchSchema = z.strictObject({
  name: nameSchema.optional(),
  description: descriptionSchema.nullable().optional()
}).refine((value) => value.name !== undefined || value.description !== undefined);
const subjectPathSchema = z.strictObject({ subjectId: idSchema });

type RequestHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

function subjectNotFound(): HttpResponseInit {
  return createProblemResponse({
    status: 404,
    title: "Matéria não encontrada",
    code: "SUBJECT_NOT_FOUND",
    detail: "A matéria solicitada não foi encontrada.",
    headers: { "cache-control": "no-store" }
  });
}

function conflict(code: string, title: string, detail: string): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title,
    code,
    detail,
    headers: { "cache-control": "no-store" }
  });
}

function subjectAlreadyExists(): HttpResponseInit {
  return conflict(
    "SUBJECT_ALREADY_EXISTS",
    "Matéria já cadastrada",
    "Já existe uma matéria ativa com esse nome."
  );
}

function subjectHasClassLinks(): HttpResponseInit {
  return conflict(
    "SUBJECT_HAS_CLASS_LINKS",
    "Matéria usada em turmas",
    "Retire esta matéria das turmas antes de excluí-la."
  );
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

export type AdminSubjectHandlerOptions = {
  getDatabase?: () => Knex;
  allowedOrigins?: readonly string[];
};

export function createAdminSubjectHandlers(options: AdminSubjectHandlerOptions = {}): {
  listSubjects: RequestHandler;
  createSubject: RequestHandler;
  updateSubject: RequestHandler;
  deleteSubject: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();

  const list: RequestHandler = async (request) => {
    const query = validateInput(listQuerySchema, request.query, { in: "query" });
    if (!query.success) return query.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await listSubjects(getDatabase(), query.data as SubjectListQuery);
      return { status: 200, headers: { "cache-control": "no-store" }, jsonBody: result };
    } catch {
      return internalFailure();
    }
  };

  const create: RequestHandler = withSecurityEvent("admin_subject_create", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    let body;
    try {
      body = await validateJsonBody(request, createSchema, { maxBytes: MAX_SUBJECT_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const subject = await createSubject(getDatabase(), body.data as NewSubject);
      return { status: 201, headers: { "cache-control": "no-store" }, jsonBody: subject };
    } catch (error) {
      return isUniqueViolation(error) ? subjectAlreadyExists() : internalFailure();
    }
  });

  const update: RequestHandler = withSecurityEvent("admin_subject_update", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = validateInput(subjectPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    let body;
    try {
      body = await validateJsonBody(request, patchSchema, { maxBytes: MAX_SUBJECT_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const subject = await updateSubject(
        getDatabase(),
        route.data.subjectId,
        body.data as SubjectPatch
      );
      return subject
        ? { status: 200, headers: { "cache-control": "no-store" }, jsonBody: subject }
        : subjectNotFound();
    } catch (error) {
      return isUniqueViolation(error) ? subjectAlreadyExists() : internalFailure();
    }
  });

  const remove: RequestHandler = withSecurityEvent("admin_subject_delete", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = validateInput(subjectPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await deleteSubject(getDatabase(), route.data.subjectId);
      if (result === "not-found") return subjectNotFound();
      if (result === "has-class-links") return subjectHasClassLinks();
      return { status: 204, headers: { "cache-control": "no-store" } };
    } catch {
      return internalFailure();
    }
  });

  return { listSubjects: list, createSubject: create, updateSubject: update, deleteSubject: remove };
}
