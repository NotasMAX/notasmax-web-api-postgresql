import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Knex } from "knex";
import { z } from "zod";
import { getKnex } from "../database/knex";
import { createProblemResponse, validateInput, validateJsonBody } from "../http/validation";
import { logSecurityEvent, withSecurityEvent } from "../http/security-event";
import {
  authenticationFailed,
  configuredOrigins,
  internalFailure,
  mutationRejection,
  requireAdminSession,
  resourceNotFound
} from "./handler";
import {
  accountDetail,
  accountForEdit,
  createAccount,
  deleteAccount,
  listAccounts,
  updateAccount,
  type AccountListQuery,
  type AccountProfile,
  type NewAccount
} from "./admin-account-service";
import { issueActivationToken } from "./account-lifecycle-service";
import {
  accountActionUrl,
  resolveAccountEmailAdapter,
  type EmailTransport
} from "./email-transport";
import { reauthenticateAdministrator } from "./session-service";
import {
  addCurrentTeacher,
  listCurrentTeachers,
  removeCurrentTeacher
} from "./teacher-association-service";

const MAX_ADMIN_ACCOUNT_BODY_BYTES = 8 * 1024;
const MAX_POSTGRES_ID = 9223372036854775807n;

const idSchema = z.string().refine((value) => /^[1-9]\d{0,18}$/.test(value)
  && BigInt(value) <= MAX_POSTGRES_ID);
const positivePageSchema = z.string().regex(/^[1-9]\d*$/);
const paginationSchema = {
  page: positivePageSchema.default("1").transform(Number).pipe(z.number().int().safe().positive()),
  pageSize: positivePageSchema.default("20").transform(Number)
    .pipe(z.number().int().safe().positive().max(100))
};

const studentQuerySchema = z.strictObject({
  search: z.string().trim().optional(),
  activationStatus: z.enum(["pending", "activated"]).optional(),
  enrollmentStatus: z.enum(["active", "no_active_enrollment"]).optional(),
  classId: idSchema.optional(),
  ...paginationSchema
});
const teacherQuerySchema = z.strictObject({
  search: z.string().trim().optional(),
  classId: idSchema.optional(),
  subjectId: idSchema.optional(),
  ...paginationSchema
});
const administratorQuerySchema = z.strictObject({
  search: z.string().trim().optional(),
  ...paginationSchema
});

const nameSchema = z.string().trim().min(1).max(255);
const emailSchema = z.string().trim().toLowerCase().email().max(254);
const contactPhoneSchema = z.string().trim().min(1).nullable().optional();
const guardianPhoneSchema = z.string().trim().min(1);
const currentPasswordSchema = z.string().min(15).max(1024);

const studentCreateSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  contactPhone: contactPhoneSchema,
  guardianPhone: guardianPhoneSchema
});
const personCreateSchema = z.strictObject({
  name: nameSchema,
  email: emailSchema,
  contactPhone: contactPhoneSchema
});

const studentPatchSchema = z.strictObject({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  contactPhone: contactPhoneSchema,
  guardianPhone: guardianPhoneSchema.optional(),
  currentPassword: z.string().optional()
}).refine((value) => value.name !== undefined
  || value.email !== undefined
  || value.contactPhone !== undefined
  || value.guardianPhone !== undefined);
const personPatchSchema = z.strictObject({
  name: nameSchema.optional(),
  email: emailSchema.optional(),
  contactPhone: contactPhoneSchema,
  currentPassword: z.string().optional()
}).refine((value) => value.name !== undefined
  || value.email !== undefined
  || value.contactPhone !== undefined);
const emailReauthenticationSchema = z.strictObject({ currentPassword: currentPasswordSchema });

type RequestHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

export type AdminAccountHandlerOptions = {
  getDatabase?: () => Knex;
  allowedOrigins?: readonly string[];
  emailTransport?: EmailTransport;
  webBaseUrl?: string;
};

function profileNotFound(profile: AccountProfile): HttpResponseInit {
  if (profile === "aluno") {
    return createProblemResponse({
      status: 404,
      title: "Aluno não encontrado",
      code: "STUDENT_NOT_FOUND",
      detail: "O aluno solicitado não foi encontrado.",
      headers: { "cache-control": "no-store" }
    });
  }
  if (profile === "professor") {
    return createProblemResponse({
      status: 404,
      title: "Professor não encontrado",
      code: "TEACHER_NOT_FOUND",
      detail: "O professor solicitado não foi encontrado.",
      headers: { "cache-control": "no-store" }
    });
  }
  return resourceNotFound();
}

function emailAlreadyInUse(): HttpResponseInit {
  return createProblemResponse({
    status: 409,
    title: "E-mail já utilizado",
    code: "EMAIL_ALREADY_IN_USE",
    detail: "O e-mail institucional já está associado a uma conta.",
    headers: { "cache-control": "no-store" }
  });
}

function selfEmailChangeNotAllowed(): HttpResponseInit {
  return createProblemResponse({
    status: 422,
    title: "Conteúdo não processável",
    code: "VALIDATION_ERROR",
    detail: "A alteração do próprio e-mail não é permitida neste fluxo.",
    errors: [{
      code: "INVALID_VALUE",
      detail: "Não é permitido alterar o próprio e-mail institucional.",
      source: { in: "body", pointer: "/email" }
    }],
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

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error
    && (error as { code?: unknown }).code === "23505";
}

function emailAdapter(options: AdminAccountHandlerOptions) {
  return resolveAccountEmailAdapter({
    transport: options.emailTransport,
    webBaseUrl: options.webBaseUrl
  });
}

async function sendActivation(
  knex: Knex,
  userId: string,
  adapter: ReturnType<typeof emailAdapter>
): Promise<"sent" | "failed"> {
  const issue = await issueActivationToken(knex, userId);
  if (issue.status !== "issued") throw new Error("Activation token could not be issued.");
  try {
    await adapter.transport.send({
      kind: "activation",
      recipient: issue.recipient,
      url: accountActionUrl(adapter.webBaseUrl, "activation", issue.token)
    });
    return "sent";
  } catch {
    return "failed";
  }
}

function accountId(request: HttpRequest, name: string) {
  return validateInput(z.strictObject({ [name]: idSchema }), request.params, { in: "path" });
}

export function createAdminAccountHandlers(options: AdminAccountHandlerOptions = {}): {
  listStudents: RequestHandler;
  createStudent: RequestHandler;
  getStudent: RequestHandler;
  updateStudent: RequestHandler;
  deleteStudent: RequestHandler;
  listTeachers: RequestHandler;
  createTeacher: RequestHandler;
  getTeacher: RequestHandler;
  updateTeacher: RequestHandler;
  deleteTeacher: RequestHandler;
  listClassSubjectTeachers: RequestHandler;
  addClassSubjectTeacher: RequestHandler;
  removeClassSubjectTeacher: RequestHandler;
  listAdministrators: RequestHandler;
  createAdministrator: RequestHandler;
  getAdministrator: RequestHandler;
  updateAdministrator: RequestHandler;
  deleteAdministrator: RequestHandler;
} {
  const getDatabase = options.getDatabase ?? getKnex;
  const allowedOrigins = options.allowedOrigins ?? configuredOrigins();

  const list = (profile: AccountProfile, schema: z.ZodType): RequestHandler => async (request) => {
    const query = validateInput(schema, request.query, { in: "query" });
    if (!query.success) return query.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    try {
      const result = await listAccounts(getDatabase(), profile, query.data as AccountListQuery);
      return { status: 200, headers: { "cache-control": "no-store" }, jsonBody: result };
    } catch {
      return internalFailure();
    }
  };

  const create = (profile: AccountProfile, schema: z.ZodType): RequestHandler => withSecurityEvent(
    "admin_account_create",
    async (request) => {
      const rejected = mutationRejection(request, allowedOrigins);
      if (rejected) return rejected;
      let body;
      try {
        body = await validateJsonBody(request, schema, { maxBytes: MAX_ADMIN_ACCOUNT_BODY_BYTES });
      } catch {
        return internalFailure();
      }
      if (!body.success) return body.response;
      const authorized = await requireAdminSession(request, getDatabase);
      if (!authorized.authorized) return authorized.response;

      let adapter: ReturnType<typeof emailAdapter>;
      try {
        adapter = emailAdapter(options);
      } catch {
        return internalFailure();
      }

      try {
        const userId = await createAccount(getDatabase(), profile, body.data as NewAccount);
        const activationEmailStatus = await sendActivation(getDatabase(), userId, adapter);
        return {
          status: 201,
          headers: { "cache-control": "no-store" },
          jsonBody: { activationEmailStatus }
        };
      } catch (error) {
        return isUniqueViolation(error) ? emailAlreadyInUse() : internalFailure();
      }
    }
  );

  const get = (profile: AccountProfile, paramName: string): RequestHandler => async (request) => {
    const route = accountId(request, paramName);
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;
    try {
      const detail = await accountDetail(getDatabase(), profile, route.data[paramName] as string);
      return detail
        ? { status: 200, headers: { "cache-control": "no-store" }, jsonBody: detail }
        : profileNotFound(profile);
    } catch {
      return internalFailure();
    }
  };

  const update = (
    profile: AccountProfile,
    paramName: string,
    schema: z.ZodType
  ): RequestHandler => withSecurityEvent("admin_account_update", async (request, context) => {
    const rejected = mutationRejection(request, allowedOrigins);
    if (rejected) return rejected;
    const route = accountId(request, paramName);
    if (!route.success) return route.response;
    let body;
    try {
      body = await validateJsonBody(request, schema, { maxBytes: MAX_ADMIN_ACCOUNT_BODY_BYTES });
    } catch {
      return internalFailure();
    }
    if (!body.success) return body.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    const input = body.data as Partial<NewAccount> & { currentPassword?: string };
    const userId = route.data[paramName] as string;
    try {
      let current = await accountForEdit(getDatabase(), profile, userId);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (!current) return profileNotFound(profile);
        const emailChanged = input.email !== undefined && input.email !== current.email;
        if (emailChanged && profile === "administrador" && userId === authorized.user.id) {
          return selfEmailChangeNotAllowed();
        }
        let adapter: ReturnType<typeof emailAdapter> | undefined;

        if (emailChanged) {
          const reauthentication = validateInput(
            emailReauthenticationSchema,
            { currentPassword: input.currentPassword },
            { in: "body" }
          );
          if (!reauthentication.success) return reauthentication.response;
          const reauthenticationStartedAt = Date.now();
          let reauthenticationResult = "failed";
          let reauthenticated = false;
          try {
            reauthenticated = await reauthenticateAdministrator(
              getDatabase(),
              authorized.user.id,
              reauthentication.data.currentPassword
            );
            reauthenticationResult = reauthenticated ? "completed" : "rejected";
          } finally {
            logSecurityEvent(context, "admin_account_reauthentication", reauthenticationResult,
              reauthenticationStartedAt);
          }
          if (!reauthenticated) return authenticationFailed();
          try {
            adapter = emailAdapter(options);
          } catch {
            return internalFailure();
          }
        }

        const result = await updateAccount(getDatabase(), profile, userId, current.email, input);
        if (result.status === "not-found") return profileNotFound(profile);
        if (result.status === "stale") {
          current = await accountForEdit(getDatabase(), profile, userId);
          continue;
        }

        if (result.previousEmail && adapter) {
          const issue = await issueActivationToken(getDatabase(), userId);
          if (issue.status !== "issued") return internalFailure();
          await Promise.allSettled([
            adapter.transport.send({
              kind: "activation",
              recipient: issue.recipient,
              url: accountActionUrl(adapter.webBaseUrl, "activation", issue.token)
            }),
            adapter.transport.send({ kind: "email-change-notice", recipient: result.previousEmail })
          ]);
        }

        const detail = await accountDetail(getDatabase(), profile, userId);
        return detail
          ? { status: 200, headers: { "cache-control": "no-store" }, jsonBody: detail }
          : profileNotFound(profile);
      }
      return internalFailure();
    } catch (error) {
      return isUniqueViolation(error) ? emailAlreadyInUse() : internalFailure();
    }
  });

  const remove = (profile: AccountProfile, paramName: string): RequestHandler => withSecurityEvent(
    "admin_account_delete",
    async (request) => {
      const rejected = mutationRejection(request, allowedOrigins);
      if (rejected) return rejected;
      const route = accountId(request, paramName);
      if (!route.success) return route.response;
      const authorized = await requireAdminSession(request, getDatabase);
      if (!authorized.authorized) return authorized.response;
      try {
        const result = await deleteAccount(
          getDatabase(), profile, route.data[paramName] as string, authorized.user.id
        );
        if (result.status === "not-found") return profileNotFound(profile);
        if (result.status === "student-linked-data") {
          return conflict(
            "STUDENT_CANNOT_BE_DELETED",
            "Aluno não pode ser excluído",
            "O aluno possui matrícula ativa e vínculo com simulado realizado."
          );
        }
        if (result.status === "teacher-linked-data") {
          return conflict(
            "TEACHER_HAS_LINKED_DATA",
            "Professor possui vínculos",
            "Remova as associações de matéria e turma antes de excluir o professor."
          );
        }
        if (result.status === "cannot-delete-self") {
          return conflict(
            "ADMINISTRATOR_CANNOT_DELETE_SELF",
            "Operação não permitida",
            "Um administrador não pode excluir a própria conta."
          );
        }
        if (result.status === "last-active-administrator") {
          return conflict(
            "LAST_ACTIVE_ADMIN_CANNOT_BE_DELETED",
            "Operação não permitida",
            "A exclusão não pode remover o último administrador ativo."
          );
        }
        return { status: 204, headers: { "cache-control": "no-store" } };
      } catch {
        return internalFailure();
      }
    }
  );

  const classSubjectPathSchema = z.strictObject({ classId: idSchema, subjectId: idSchema });
  const teacherAssociationPathSchema = classSubjectPathSchema.extend({ teacherId: idSchema });

  const listClassSubjectTeachers: RequestHandler = async (request) => {
    const route = validateInput(classSubjectPathSchema, request.params, { in: "path" });
    if (!route.success) return route.response;
    const authorized = await requireAdminSession(request, getDatabase);
    if (!authorized.authorized) return authorized.response;

    try {
      const result = await listCurrentTeachers(
        getDatabase(), route.data.classId, route.data.subjectId
      );
      return result.status === "not-found"
        ? resourceNotFound()
        : { status: 200, headers: { "cache-control": "no-store" }, jsonBody: { items: result.items } };
    } catch {
      return internalFailure();
    }
  };

  const addClassSubjectTeacher: RequestHandler = withSecurityEvent(
    "admin_teacher_association_add",
    async (request) => {
      const rejected = mutationRejection(request, allowedOrigins);
      if (rejected) return rejected;
      const route = validateInput(teacherAssociationPathSchema, request.params, { in: "path" });
      if (!route.success) return route.response;
      const authorized = await requireAdminSession(request, getDatabase);
      if (!authorized.authorized) return authorized.response;

      try {
        const result = await addCurrentTeacher(
          getDatabase(), route.data.classId, route.data.subjectId, route.data.teacherId
        );
        return result.status === "not-found"
          ? resourceNotFound()
          : { status: 204, headers: { "cache-control": "no-store" } };
      } catch {
        return internalFailure();
      }
    }
  );

  const removeClassSubjectTeacher: RequestHandler = withSecurityEvent(
    "admin_teacher_association_remove",
    async (request) => {
      const rejected = mutationRejection(request, allowedOrigins);
      if (rejected) return rejected;
      const route = validateInput(teacherAssociationPathSchema, request.params, { in: "path" });
      if (!route.success) return route.response;
      const authorized = await requireAdminSession(request, getDatabase);
      if (!authorized.authorized) return authorized.response;

      try {
        const result = await removeCurrentTeacher(
          getDatabase(), route.data.classId, route.data.subjectId, route.data.teacherId
        );
        return result.status === "not-found"
          ? resourceNotFound()
          : { status: 204, headers: { "cache-control": "no-store" } };
      } catch {
        return internalFailure();
      }
    }
  );

  return {
    listStudents: list("aluno", studentQuerySchema),
    createStudent: create("aluno", studentCreateSchema),
    getStudent: get("aluno", "studentId"),
    updateStudent: update("aluno", "studentId", studentPatchSchema),
    deleteStudent: remove("aluno", "studentId"),
    listTeachers: list("professor", teacherQuerySchema),
    createTeacher: create("professor", personCreateSchema),
    getTeacher: get("professor", "teacherId"),
    updateTeacher: update("professor", "teacherId", personPatchSchema),
    deleteTeacher: remove("professor", "teacherId"),
    listClassSubjectTeachers,
    addClassSubjectTeacher,
    removeClassSubjectTeacher,
    listAdministrators: list("administrador", administratorQuerySchema),
    createAdministrator: create("administrador", personCreateSchema),
    getAdministrator: get("administrador", "administratorId"),
    updateAdministrator: update("administrador", "administratorId", personPatchSchema),
    deleteAdministrator: remove("administrador", "administratorId")
  };
}
