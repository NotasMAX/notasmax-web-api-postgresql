import { app, type Timer } from "@azure/functions";
import { deleteExpiredLifecycleTokens } from "../auth/account-lifecycle-service";
import { createAccountLifecycleHandlers } from "../auth/account-lifecycle-handler";
import { createAuthHandlers } from "../auth/handler";
import { getKnex } from "../database/knex";
import { logDevelopmentEvent } from "../http/security-event";

const authHandlers = createAuthHandlers();
const accountLifecycleHandlers = createAccountLifecycleHandlers();

app.http("authSessions", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/auth/sessions",
  handler: authHandlers.createSession
});

app.http("authCurrentSession", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "v1/auth/me",
  handler: authHandlers.currentSession
});

app.http("authDeleteCurrentSession", {
  methods: ["DELETE"],
  authLevel: "anonymous",
  route: "v1/auth/sessions/current",
  handler: authHandlers.deleteCurrentSession
});

app.http("authPasswordResetRequests", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/auth/password-reset-requests",
  handler: accountLifecycleHandlers.requestPasswordReset
});

app.http("authPasswordResets", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/auth/password-resets",
  handler: accountLifecycleHandlers.completePasswordReset
});

app.http("authActivations", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/auth/activations",
  handler: accountLifecycleHandlers.activate
});

app.http("adminUserActivationResends", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "v1/admin/users/{userId}/activation-resends",
  handler: accountLifecycleHandlers.resendActivation
});

app.timer("cleanupExpiredAccountLifecycleTokens", {
  schedule: "0 0 2 * * *",
  handler: async (_timer: Timer, context) => {
    const startedAt = Date.now();
    try {
      const deletedRecords = await deleteExpiredLifecycleTokens(getKnex());
      logDevelopmentEvent(context, {
        event: "expired_account_token_cleanup",
        invocationId: context.invocationId,
        result: "completed",
        deletedRecords,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    } catch {
      logDevelopmentEvent(context, {
        event: "expired_account_token_cleanup",
        invocationId: context.invocationId,
        result: "failed",
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    }
  }
});
