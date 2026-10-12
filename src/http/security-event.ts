import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

type SecurityEventHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

type ApplicationLogValue = string | number | readonly string[];

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

export function withSecurityEvent(event: string, handler: SecurityEventHandler): SecurityEventHandler {
  return async (request, context) => {
    const startedAt = Date.now();
    let result = "failed";
    try {
      const response = await handler(request, context);
      const status = response.status ?? 200;
      result = status >= 500 ? "failed" : status >= 400 ? "rejected" : "completed";
      return response;
    } finally {
      logSecurityEvent(context, event, result, startedAt);
    }
  };
}
