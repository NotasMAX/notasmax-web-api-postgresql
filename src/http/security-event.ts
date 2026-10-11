import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

type SecurityEventHandler = (
  request: HttpRequest,
  context: InvocationContext
) => Promise<HttpResponseInit>;

export function logSecurityEvent(
  context: InvocationContext,
  event: string,
  result: string,
  startedAt: number
): void {
  try {
    context.log(JSON.stringify({
      event,
      invocationId: context.invocationId,
      result,
      durationMs: Math.max(0, Date.now() - startedAt)
    }));
  } catch {
    // Logging failure must not change an account operation result.
  }
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
