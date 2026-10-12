import type {
  HttpRequest,
  HttpResponseInit,
  InvocationContext
} from "@azure/functions";
import { logDevelopmentEvent } from "../http/security-event";

export type HealthProbe = () => Promise<boolean>;

export function createHealthHandler(probe: HealthProbe) {
  return async (
    _request: HttpRequest,
    context: InvocationContext
  ): Promise<HttpResponseInit> => {
    const startedAt = Date.now();
    let healthy = false;

    try {
      healthy = await probe();
    } catch {
      // The default false value represents a failed or unavailable probe.
    }

    const durationMs = Math.max(0, Date.now() - startedAt);
    logDevelopmentEvent(context, {
      event: "health_check",
      invocationId: context.invocationId,
      outcome: healthy ? "ok" : "unavailable",
      durationMs
    });

    if (healthy) {
      return {
        status: 200,
        jsonBody: { status: "ok" }
      };
    }

    return {
      status: 503,
      headers: { "content-type": "application/problem+json" },
      jsonBody: {
        type: "about:blank",
        title: "Service Unavailable",
        status: 503,
        code: "HEALTH_CHECK_UNAVAILABLE"
      }
    };
  };
}
