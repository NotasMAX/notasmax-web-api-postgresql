import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { withSecurityEvent } from "../http/security-event";
import { etagExposureHeaders } from "../http/cors";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import { ifMatchProblem, readIfMatch } from "../http/etag";
import {
  authenticationRequired,
  configuredOrigins,
  internalFailure,
  mutationRejection,
  requireAdminSession,
  resourceNotFound
} from "./handler";
import {
  addClassSubject,
  closeClass,
  createClass,
  getClass,
  listActiveSchoolYears,
  listClasses,
  listClassSubjects,
  removeClassSubject,
  updateClass,
  type ClassListQuery,
  type ClassPatch,
  type NewClass
} from "./admin-class-service";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_POSTGRES_ID = 9223372036854775807n;
const POSTGRES_INTEGER_MIN = -2147483648;
const POSTGRES_INTEGER_MAX = 2147483647;

const idSchema = z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value)
  && BigInt(value) <= MAX_POSTGRES_ID);
const positiveIntegerString = z.string().regex(/^[1-9]\d*$/);
const postgresInteger = z.number().int().min(POSTGRES_INTEGER_MIN).max(POSTGRES_INTEGER_MAX);
const schoolYearQueryValue = z.string()
  .regex(/^(?:0|-?[1-9]\d*)$/)
  .transform(Number)
  .pipe(postgresInteger);
const classListQuerySchema = z.strictObject({
  schoolYear: schoolYearQueryValue.optional(),
  page: positiveIntegerString.default("1").transform(Number).pipe(z.number().int().safe().positive()),
  pageSize: positiveIntegerString.default("20").transform(Number)
    .pipe(z.number().int().safe().positive().max(100))
}).transform((query) => ({
  ...query
}));
const classIdSchema = z.strictObject({ classId: idSchema });
const classSubjectPathSchema = classIdSchema.extend({ subjectId: idSchema });
const seriesSchema = z.number().int().refine((value) => value === 1 || value === 2 || value === 3);
const createSchema = z.strictObject({
  series: seriesSchema,
  schoolYear: postgresInteger,
  startDate: z.iso.date(),
  closeClassIds: z.array(z.strictObject({
    classId: idSchema,
    etag: z.unknown().optional()
  })).optional()
});
const patchSchema = z.strictObject({
  series: seriesSchema.optional(),
  schoolYear: postgresInteger.optional()
}).refine((value) => value.series !== undefined || value.schoolYear !== undefined);

type RequestHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

function classNotFound(): HttpResponseInit {
  return createProblemResponse({
    status: 404,
    title: "Turma não encontrada",
    code: "CLASS_NOT_FOUND",
    detail: "A turma solicitada não foi encontrada.",
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

function classAlreadyExists(): HttpResponseInit {
  return conflict(
    "CLASS_ALREADY_EXISTS",
    "Turma já cadastrada",
    "Já existe uma turma ativa para essa série e ano letivo."
  );
}

function classSelectionInvalid(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Seleção de turmas inválida",
    code: "CLASS_SELECTION_INVALID",
    detail: "A seleção de turmas não pôde ser aplicada. Atualize os dados e tente novamente.",
    errors: [{
      code: "INVALID_VALUE",
      detail: "A seleção de turmas não pôde ser aplicada.",
      source: { in: "body", pointer: "/closeClassIds" }
    }],
    headers: { "cache-control": "no-store" }
  });
}

function sessionWasRevoked(error: unknown): boolean {
  return error instanceof Error && error.name === "AdminSessionRevokedError";
}

function classHasLinkedData(): HttpResponseInit {
  return conflict(
    "CLASS_HAS_LINKED_DATA",
    "Turma possui vínculos",
    "A operação não pode ser concluída enquanto a turma possuir os vínculos definidos para esta ação."
  );
}

function classClosed(): HttpResponseInit {
  return conflict(
    "CLASS_CLOSED",
    "Turma fechada",
    "A operação não pode ser concluída porque a turma está fechada."
  );
}

function completedSimulations(): HttpResponseInit {
  return conflict(
    "SUBJECT_HAS_COMPLETED_SIMULATIONS",
    "Matéria vinculada a simulado realizado",
    "Não é possível remover a matéria da turma porque ela está vinculada a um simulado realizado."
  );
}

function simulationResults(): HttpResponseInit {
  return conflict(
    "SUBJECT_HAS_SIMULATION_RESULTS",
    "Matéria vinculada a resultados",
    "Não é possível remover a matéria da turma porque há resultados vinculados a um simulado ainda não realizado."
  );
}

function isClassUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && "constraint" in error
    && (error as { code?: unknown }).code === "23505"
    && ((error as { constraint?: unknown }).constraint === "turma_serie_ano_uk"
      || (error as { constraint?: unknown }).constraint === "turma_serie_ano_ativa_uk");
}

export type AdminClassHandlerOptions = {
  getDatabase?: () => Knex;
  allowedOrigins?: readonly string[];
};

export function createAdminClassHandlers(options: AdminClassHandlerOptions = {}): {
  listClasses: RequestHandler;
  listClassYears: RequestHandler;
  getClass: RequestHandler;
  createClass: RequestHandler;
  updateClass: RequestHandler;
  closeClass: RequestHandler;
  listClassSubjects: RequestHandler;
  addClassSubject: RequestHandler;
  removeClassSubject: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();

  const list: RequestHandler = async (request) => {
    const query = validateInput(classListQuerySchema, request.query, { in: "query" });
    if (!query.success) return query.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await listClasses(getDatabase(), query.data as ClassListQuery);
      return { status: 200, headers: { "cache-control": "no-store" }, jsonBody: result };
    } catch {
      return internalFailure();
    }
  };

  const years: RequestHandler = async (request) => {
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await listActiveSchoolYears(getDatabase());
      return { status: 200, headers: { "cache-control": "no-store" }, jsonBody: result };
    } catch {
      return internalFailure();
    }
  };

  const detail: RequestHandler = async (request) => {
    const route = validateInput(classIdSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const schoolClass = await getClass(getDatabase(), route.data.classId);
      const origin = request.headers.get("origin");
      return schoolClass
        ? {
          status: 200,
          headers: {
            "cache-control": "no-store",
            etag: schoolClass.etag,
            ...etagExposureHeaders(origin, allowedOrigins)
          },
          jsonBody: schoolClass.schoolClass
        }
        : classNotFound();
    } catch {
      return internalFailure();
    }
  };

  const create: RequestHandler = withSecurityEvent("admin_class_create", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    let body;
    try {
      body = await validateJsonBody(request, createSchema, { maxBytes: MAX_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await createClass(getDatabase(), body.data as NewClass, {
        actorId: authorized.user.id, token: authorized.token
      });
      if (result.status === "selection-invalid") return classSelectionInvalid();
      return {
        status: 201,
        headers: { "cache-control": "no-store", etag: result.etag },
        jsonBody: result.schoolClass
      };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return isClassUniqueViolation(error) ? classAlreadyExists() : internalFailure();
    }
  });

  const update: RequestHandler = withSecurityEvent("admin_class_update", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = validateInput(classIdSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    let body;
    try {
      body = await validateJsonBody(request, patchSchema, { maxBytes: MAX_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request);
    if (precondition.status !== "ok") return ifMatchProblem(precondition.status);

    try {
      const result = await updateClass(getDatabase(), route.data.classId, body.data as ClassPatch,
        precondition.value, { actorId: authorized.user.id, token: authorized.token });
      if (result.status === "not-found") return classNotFound();
      if (result.status === "has-linked-data") return classHasLinkedData();
      if (result.status === "stale") return ifMatchProblem("stale");
      return {
        status: 200,
        headers: { "cache-control": "no-store", etag: result.etag },
        jsonBody: result.schoolClass
      };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return isClassUniqueViolation(error) ? classAlreadyExists() : internalFailure();
    }
  });

  const close: RequestHandler = withSecurityEvent("admin_class_close", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = validateInput(classIdSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request);
    if (precondition.status !== "ok") return ifMatchProblem(precondition.status);

    try {
      const result = await closeClass(getDatabase(), route.data.classId, precondition.value, {
        actorId: authorized.user.id, token: authorized.token
      });
      if (result.status === "not-found") return classNotFound();
      if (result.status === "stale") return ifMatchProblem("stale");
      return { status: 204, headers: { "cache-control": "no-store", etag: result.etag } };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return internalFailure();
    }
  });

  const listSubjects: RequestHandler = async (request) => {
    const route = validateInput(classIdSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await listClassSubjects(getDatabase(), route.data.classId);
      return result.status === "not-found"
        ? resourceNotFound()
        : {
          status: 200,
          headers: {
            "cache-control": "no-store",
            etag: result.etag,
            ...etagExposureHeaders(request.headers.get("origin"), allowedOrigins)
          },
          jsonBody: { items: result.items }
        };
    } catch {
      return internalFailure();
    }
  };

  const addSubject: RequestHandler = withSecurityEvent("admin_class_subject_add", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = validateInput(classSubjectPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request);
    if (precondition.status !== "ok") return ifMatchProblem(precondition.status);

    try {
      const result = await addClassSubject(getDatabase(), route.data.classId, route.data.subjectId,
        precondition.value, { actorId: authorized.user.id, token: authorized.token });
      return result.status === "not-found"
        ? resourceNotFound()
        : result.status === "class-closed"
          ? classClosed()
        : result.status === "stale"
          ? ifMatchProblem("stale")
          : { status: 204, headers: { "cache-control": "no-store", etag: result.etag } };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return internalFailure();
    }
  });

  const removeSubject: RequestHandler = withSecurityEvent("admin_class_subject_remove", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = validateInput(classSubjectPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request);
    if (precondition.status !== "ok") return ifMatchProblem(precondition.status);

    try {
      const result = await removeClassSubject(getDatabase(), route.data.classId, route.data.subjectId,
        precondition.value, { actorId: authorized.user.id, token: authorized.token });
      if (result.status === "not-found") return resourceNotFound();
      if (result.status === "class-closed") return classClosed();
      if (result.status === "stale") return ifMatchProblem("stale");
      if (result.status === "completed-simulations") return completedSimulations();
      if (result.status === "has-simulation-results") return simulationResults();
      return { status: 204, headers: { "cache-control": "no-store", etag: result.etag } };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return internalFailure();
    }
  });

  return {
    listClasses: list,
    listClassYears: years,
    getClass: detail,
    createClass: create,
    updateClass: update,
    closeClass: close,
    listClassSubjects: listSubjects,
    addClassSubject: addSubject,
    removeClassSubject: removeSubject
  };
}
