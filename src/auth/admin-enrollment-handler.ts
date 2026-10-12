import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { withSecurityEvent } from "../http/security-event";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import { ifMatchProblem, readIfMatch } from "../http/etag";
import {
  authenticationRequired,
  configuredOrigins,
  internalFailure,
  mutationRejection,
  requireAdminSession
} from "./handler";
import { cancelEnrollment, createEnrollment, getEnrollment } from "./admin-enrollment-service";

const MAX_BODY_BYTES = 8 * 1024;
const MAX_POSTGRES_ID = 9223372036854775807n;

const idSchema = z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value)
  && BigInt(value) <= MAX_POSTGRES_ID);
const cancellationPathSchema = z.strictObject({ enrollmentId: idSchema });
const cancellationBodySchema = z.strictObject({ cancellationDate: z.iso.date() });
const createPathSchema = z.strictObject({ classId: idSchema });
const createBodySchema = z.strictObject({
  studentId: idSchema,
  startDate: z.iso.date(),
  confirmPreviousEnrollmentId: idSchema.optional()
});

type RequestHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

function enrollmentNotFound(): HttpResponseInit {
  return createProblemResponse({
    status: 404,
    title: "Matrícula não encontrada",
    code: "ENROLLMENT_NOT_FOUND",
    detail: "A matrícula solicitada não foi encontrada.",
    headers: { "cache-control": "no-store" }
  });
}

function classNotFound(): HttpResponseInit {
  return createProblemResponse({
    status: 404,
    title: "Turma não encontrada",
    code: "CLASS_NOT_FOUND",
    detail: "A turma solicitada não foi encontrada.",
    headers: { "cache-control": "no-store" }
  });
}

function classClosed(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Turma fechada",
    code: "CLASS_CLOSED",
    detail: "A operação não pode ser concluída porque a turma está fechada.",
    headers: { "cache-control": "no-store" }
  });
}

function sessionWasRevoked(error: unknown): boolean {
  return error instanceof Error && error.name === "AdminSessionRevokedError";
}

function studentNotFound(): HttpResponseInit {
  return createProblemResponse({
    status: 404,
    title: "Aluno não encontrado",
    code: "STUDENT_NOT_FOUND",
    detail: "O aluno solicitado não foi encontrado.",
    headers: { "cache-control": "no-store" }
  });
}

function enrollmentAlreadyActive(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Matrícula já vigente",
    code: "ENROLLMENT_ALREADY_ACTIVE",
    detail: "O aluno já possui uma matrícula incompatível com a turma solicitada para essa data.",
    headers: { "cache-control": "no-store" }
  });
}

function stalePreviousEnrollmentConfirmation(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Confirmação de renovação desatualizada",
    code: "ENROLLMENT_ALREADY_ACTIVE",
    detail: "A matrícula anterior mudou desde a confirmação e a renovação não foi aplicada. Atualize os dados e tente novamente.",
    headers: { "cache-control": "no-store" }
  });
}

function previousYearConfirmationRequired(previousEnrollmentId: string): HttpResponseInit {
  const problem = createProblemResponse({
    status: 409,
    title: "Confirmação de renovação necessária",
    code: "PREVIOUS_YEAR_ENROLLMENT_CONFIRMATION_REQUIRED",
    detail: "Confirme o encerramento da matrícula do ano letivo anterior antes de renová-la.",
    headers: { "cache-control": "no-store" }
  });
  return {
    ...problem,
    jsonBody: {
      ...(problem.jsonBody as Record<string, unknown>),
      previousEnrollmentId
    }
  };
}

function previousYearEnrollmentCannotBeRenewed(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Renovação não permitida",
    code: "PREVIOUS_YEAR_ENROLLMENT_CANNOT_BE_RENEWED",
    detail: "A matrícula anterior não pode ser renovada quando começa na mesma data solicitada.",
    headers: { "cache-control": "no-store" }
  });
}

function invalidStartDate(): HttpResponseInit {
  return createProblemResponse({
    status: 422,
    title: "Conteúdo não processável",
    code: "VALIDATION_ERROR",
    detail: "O conteúdo enviado não atende aos critérios de validação.",
    errors: [{
      code: "INVALID_VALUE",
      detail: "A data de início deve ser hoje ou futura em America/Sao_Paulo.",
      source: { in: "body", pointer: "/startDate" }
    }],
    headers: { "cache-control": "no-store" }
  });
}

function invalidClassStartDate(): HttpResponseInit {
  return createProblemResponse({
    status: 422,
    title: "Conteúdo não processável",
    code: "VALIDATION_ERROR",
    detail: "O conteúdo enviado não atende aos critérios de validação.",
    errors: [{
      code: "INVALID_VALUE",
      detail: "A data de início não pode anteceder o início da turma.",
      source: { in: "body", pointer: "/startDate" }
    }],
    headers: { "cache-control": "no-store" }
  });
}

function alreadyCancelled(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "Matrícula já cancelada",
    code: "ENROLLMENT_ALREADY_CANCELLED",
    detail: "A matrícula solicitada já foi encerrada.",
    headers: { "cache-control": "no-store" }
  });
}

function invalidCancellationDate(pointer: string, detail: string): HttpResponseInit {
  return createProblemResponse({
    status: 422,
    title: "Conteúdo não processável",
    code: "VALIDATION_ERROR",
    detail: "O conteúdo enviado não atende aos critérios de validação.",
    errors: [{
      code: "INVALID_VALUE",
      detail,
      source: { in: "body", pointer }
    }],
    headers: { "cache-control": "no-store" }
  });
}

export type AdminEnrollmentHandlerOptions = {
  getDatabase?: () => Knex;
  allowedOrigins?: readonly string[];
};

export function createAdminEnrollmentHandlers(options: AdminEnrollmentHandlerOptions = {}): {
  createEnrollment: RequestHandler;
  getEnrollment: RequestHandler;
  cancelEnrollment: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();

  const create: RequestHandler = withSecurityEvent("admin_enrollment_create", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;

    const route = validateInput(createPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;

    let body;
    try {
      body = await validateJsonBody(request, createBodySchema, { maxBytes: MAX_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;

    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const precondition = body.data.confirmPreviousEnrollmentId === undefined
        ? undefined
        : readIfMatch(request);
      if (precondition && precondition.status !== "ok") return ifMatchProblem(precondition.status);
      const result = await createEnrollment(getDatabase(), {
        classId: route.data.classId,
        studentId: body.data.studentId,
        startDate: body.data.startDate,
        confirmPreviousEnrollmentId: body.data.confirmPreviousEnrollmentId
      }, { actorId: authorized.user.id, token: authorized.token },
      precondition?.status === "ok" ? precondition.value : undefined);
      if (result.status === "class-not-found") return classNotFound();
      if (result.status === "class-closed") return classClosed();
      if (result.status === "student-not-found") return studentNotFound();
      if (result.status === "date-before-today") return invalidStartDate();
      if (result.status === "date-before-class-start") return invalidClassStartDate();
      if (result.status === "previous-year-cannot-be-renewed") {
        return previousYearEnrollmentCannotBeRenewed();
      }
      if (result.status === "confirmation-required") {
        return previousYearConfirmationRequired(result.previousEnrollmentId);
      }
      if (result.status === "already-active") return enrollmentAlreadyActive();
      if (result.status === "confirmation-stale") return stalePreviousEnrollmentConfirmation();
      if (result.status === "etag-stale") return ifMatchProblem("stale");
      return {
        status: 201,
        headers: { "cache-control": "no-store" },
        jsonBody: { enrollmentId: result.enrollmentId }
      };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return internalFailure();
    }
  });

  const detail: RequestHandler = async (request) => {
    const route = validateInput(cancellationPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    try {
      const result = await getEnrollment(getDatabase(), route.data.enrollmentId);
      return result
        ? {
          status: 200,
          headers: { "cache-control": "no-store", etag: result.etag },
          jsonBody: result.enrollment
        }
        : enrollmentNotFound();
    } catch {
      return internalFailure();
    }
  };

  const cancel: RequestHandler = withSecurityEvent("admin_enrollment_cancel", async (request) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;

    const route = validateInput(cancellationPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;

    let body;
    try {
      body = await validateJsonBody(request, cancellationBodySchema, { maxBytes: MAX_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;

    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    const precondition = readIfMatch(request);
    if (precondition.status !== "ok") return ifMatchProblem(precondition.status);

    try {
      const result = await cancelEnrollment(
        getDatabase(),
        route.data.enrollmentId,
        body.data.cancellationDate,
        precondition.value,
        { actorId: authorized.user.id, token: authorized.token }
      );
      if (result.status === "not-found") return enrollmentNotFound();
      if (result.status === "etag-stale") return ifMatchProblem("stale");
      if (result.status === "class-closed") return classClosed();
      if (result.status === "already-closed") return alreadyCancelled();
      if (result.status === "date-before-today") {
        return invalidCancellationDate(
          "/cancellationDate",
          "A data efetiva do cancelamento deve ser hoje ou futura em America/Sao_Paulo."
        );
      }
      if (result.status === "date-not-after-start") {
        return invalidCancellationDate(
          "/cancellationDate",
          "A data efetiva do cancelamento deve ser posterior ao início da matrícula."
        );
      }
      return { status: 204, headers: { "cache-control": "no-store" } };
    } catch (error) {
      if (sessionWasRevoked(error)) return authenticationRequired();
      return internalFailure();
    }
  });

  return { createEnrollment: create, getEnrollment: detail, cancelEnrollment: cancel };
}
