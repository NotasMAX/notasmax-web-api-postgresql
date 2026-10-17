import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

type SecurityEventHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

type ApplicationLogValue = string | number | readonly string[];

export function logAdminEnrollmentCancellationAudit(
  context: InvocationContext,
  fields: {
    actorId: string | number;
    enrollmentId: string;
    cancellationMode: "immediate" | "date_based";
  }
): void {
  try {
    context.log(JSON.stringify({
      event: "admin_enrollment_cancel",
      actorId: fields.actorId,
      enrollmentId: fields.enrollmentId,
      cancellationMode: fields.cancellationMode,
      result: "completed",
      invocationId: context.invocationId
    }));
  } catch {
    // Audit logging is best-effort and must not change a completed operation.
  }
}

export function logDevelopmentEvent(
  context: InvocationContext,
  fields: Record<string, ApplicationLogValue>
): void {
  if (process.env.NODE_ENV !== "development") return;

  try {
    context.log(JSON.stringify(fields));
  } catch {
    // Logging failure must not change an operation result.
  }
}

export function logSecurityEvent(
  context: InvocationContext,
  event: string,
  result: string,
  startedAt: number
): void {
  logDevelopmentEvent(context, {
    event,
    invocationId: context.invocationId,
    result,
    durationMs: Math.max(0, Date.now() - startedAt)
  });
}

export function withSecurityEvent(
  event: string,
  handler: SecurityEventHandler,
  options: { suppressCompleted?: boolean } = {}
): SecurityEventHandler {
  return async (request, context) => {
    const startedAt = Date.now();
    let result = "failed";
    try {
      const response = await handler(request, context);
      const status = response.status ?? 200;
      result = status >= 500 ? "failed" : status >= 400 ? "rejected" : "completed";
      return response;
    } finally {
      if (!options.suppressCompleted || result !== "completed") {
        logSecurityEvent(context, event, result, startedAt);
      }
    }
  };
}
