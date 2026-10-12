export type AccountEmailKind = "activation" | "password-reset";

export type AccountEmail =
  | { kind: AccountEmailKind; recipient: string; url: string }
  | { kind: "email-change-notice"; recipient: string };

export type EmailTransport = {
  send(message: AccountEmail | undefined): Promise<void>;
};

export type FakeEmailAdapter = {
  transport: EmailTransport;
  webBaseUrl: string;
};

export type AccountEmailAdapterFailureReason =
  | "azure_instance_id_marker_present"
  | "azure_site_name_marker_present"
  | "azure_hostname_marker_present"
  | "node_environment_not_local"
  | "fake_transport_not_enabled"
  | "web_base_url_missing"
  | "web_base_url_invalid"
  | "custom_transport_web_base_url_missing";

export class AccountEmailAdapterConfigurationError extends Error {
  constructor(readonly reasonCodes: AccountEmailAdapterFailureReason[]) {
    super("Account email transport is unavailable.");
    this.name = "AccountEmailAdapterConfigurationError";
  }
}

export function resolveAccountEmailAdapter(options: {
  environment?: Environment;
  transport?: EmailTransport;
  webBaseUrl?: string;
} = {}): FakeEmailAdapter {
  if (!options.transport) return createFakeEmailAdapter(options.environment);
  if (!options.webBaseUrl) {
    throw new AccountEmailAdapterConfigurationError(["custom_transport_web_base_url_missing"]);
  }
  return { transport: options.transport, webBaseUrl: options.webBaseUrl };
}

type Environment = Record<string, string | undefined>;

function isLoopbackWebsiteHostname(value: string | undefined): boolean {
  if (!value) return false;

  let parsed: URL;
  try {
    parsed = new URL(`http://${value}`);
  } catch {
    return false;
  }

  return (parsed.hostname === "localhost"
    || parsed.hostname === "127.0.0.1"
    || parsed.hostname === "[::1]")
    && parsed.username === ""
    && parsed.password === ""
    && parsed.pathname === "/"
    && parsed.search === ""
    && parsed.hash === "";
}

function configuredWebBaseUrl(environment: Environment): {
  value?: string;
  reason?: "web_base_url_missing" | "web_base_url_invalid";
} {
  const configured = environment.NOTASMAX_WEB_BASE_URL;
  if (!configured) return { reason: "web_base_url_missing" };

  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    return { reason: "web_base_url_invalid" };
  }

  if (parsed.protocol !== "https:"
    || parsed.username !== ""
    || parsed.password !== ""
    || parsed.pathname !== "/"
    || parsed.search !== ""
    || parsed.hash !== "") {
    return { reason: "web_base_url_invalid" };
  }

  return { value: parsed.origin };
}

export function createFakeEmailAdapter(environment: Environment = process.env): FakeEmailAdapter {
  const isDevelopmentOrTest = environment.NODE_ENV === "development" || environment.NODE_ENV === "test";
  const configuredUrl = configuredWebBaseUrl(environment);
  const fakeTransportEnabled = environment.NOTASMAX_EMAIL_TRANSPORT === "fake";
  const isExplicitLocalMode = isDevelopmentOrTest && fakeTransportEnabled && Boolean(configuredUrl.value);
  const reasonCodes: AccountEmailAdapterFailureReason[] = [];
  if (environment.WEBSITE_INSTANCE_ID) reasonCodes.push("azure_instance_id_marker_present");
  if (environment.WEBSITE_SITE_NAME) reasonCodes.push("azure_site_name_marker_present");
  if (environment.WEBSITE_HOSTNAME
    && !(isExplicitLocalMode && isLoopbackWebsiteHostname(environment.WEBSITE_HOSTNAME))) {
    reasonCodes.push("azure_hostname_marker_present");
  }
  if (!isDevelopmentOrTest) reasonCodes.push("node_environment_not_local");
  if (!fakeTransportEnabled) reasonCodes.push("fake_transport_not_enabled");
  if (configuredUrl.reason) reasonCodes.push(configuredUrl.reason);
  if (reasonCodes.length > 0 || !configuredUrl.value) {
    throw new AccountEmailAdapterConfigurationError(reasonCodes);
  }

  return {
    webBaseUrl: configuredUrl.value,
    transport: {
      async send(_message) {
        // The local adapter acknowledges messages without delivering or displaying them.
      }
    }
  };
}

export function accountActionUrl(
  webBaseUrl: string,
  kind: AccountEmailKind,
  token: string
): string {
  const url = new URL(kind === "activation" ? "/ativar-conta" : "/redefinir-senha", webBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}
