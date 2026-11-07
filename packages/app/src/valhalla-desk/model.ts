/**
 * Pure desk rules for the Valhalla prototype.
 *
 * Reachability and authorization stay explicit. A saved address or a software
 * license is not a live connection. Odin's prefer-local then cloud path is
 * product policy. It is not native Ollama failover.
 */

export const WINDOW_IDS = [
  "setup",
  "models",
  "channels",
  "storage",
  "services",
  "apps",
  "privarun",
  "vault",
  "studio",
  "forge",
  "voice",
  "browser",
] as const;

export type WindowId = (typeof WINDOW_IDS)[number];

export const WINDOW_LABEL: Record<WindowId, string> = {
  setup: "Setup",
  models: "Models",
  channels: "Channels",
  storage: "Storage",
  services: "Services",
  apps: "Apps",
  privarun: "PrivaRun",
  vault: "Web3Vault",
  studio: "DevStudio",
  forge: "HeuristicForge",
  voice: "Voice",
  browser: "Browser",
};

export const SECRET_IDS = [
  "supabasePassword",
  "upstashToken",
  "geminiChatKey",
  "deepseekKey",
  "ollamaCloudKey",
  "openAiCompatibleKey",
] as const;

export type SecretId = (typeof SECRET_IDS)[number];

export type PublicSettings = {
  brandName: string;
  adminEmail: string;
  ownerOverrideEmail: string;
  deploymentTarget: string;
  supabaseHost: string;
  supabasePort: string;
  supabaseDatabase: string;
  supabaseUser: string;
  upstashRestUrl: string;
};

export type FieldName =
  | keyof PublicSettings
  | SecretId
  | "deepseekModel"
  | "ollamaLocalBaseUrl"
  | "openAiBaseUrl"
  | "openAiModel";

export type FieldErrors = Partial<Record<FieldName, string>>;

export type RouteStatus =
  | "auth-missing"
  | "unreachable"
  | "mock-rejected"
  | "mock-only"
  | "unsupported"
  | "not-connected";

export type ProbeResult = {
  status: RouteStatus;
  message: string;
};

export type ProbeId =
  | "gemini-chat"
  | "deepseek"
  | "ollama-local"
  | "ollama-cloud"
  | "openai-compatible";

export type ThinkingType = "enabled" | "disabled";
export type ReasoningEffort = "none" | "low" | "high" | "max";
export type MockMode = "accept" | "reject";

export type RouteRow = {
  id: string;
  title: string;
  status: RouteStatus;
  message: string;
};

export const EMPTY_PUBLIC: PublicSettings = {
  brandName: "",
  adminEmail: "",
  ownerOverrideEmail: "",
  deploymentTarget: "",
  supabaseHost: "",
  supabasePort: "",
  supabaseDatabase: "",
  supabaseUser: "",
  upstashRestUrl: "",
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function emptySecrets(): Record<SecretId, string> {
  return {
    supabasePassword: "",
    upstashToken: "",
    geminiChatKey: "",
    deepseekKey: "",
    ollamaCloudKey: "",
    openAiCompatibleKey: "",
  };
}

export function validatePublic(
  input: PublicSettings,
): { ok: true; value: PublicSettings } | { ok: false; errors: FieldErrors } {
  const value: PublicSettings = {
    brandName: input.brandName.trim(),
    adminEmail: input.adminEmail.trim(),
    ownerOverrideEmail: input.ownerOverrideEmail.trim(),
    deploymentTarget: input.deploymentTarget.trim(),
    supabaseHost: input.supabaseHost.trim(),
    supabasePort: input.supabasePort.trim(),
    supabaseDatabase: input.supabaseDatabase.trim(),
    supabaseUser: input.supabaseUser.trim(),
    upstashRestUrl: input.upstashRestUrl.trim(),
  };
  const errors: FieldErrors = {};
  if (value.brandName.length < 2 || value.brandName.length > 80) {
    errors.brandName = "Enter a brand name of 2 to 80 characters.";
  }
  if (!EMAIL.test(value.adminEmail)) {
    errors.adminEmail =
      "Enter the deployment admin email. There is no default.";
  }
  if (
    value.ownerOverrideEmail !== "" &&
    !EMAIL.test(value.ownerOverrideEmail)
  ) {
    errors.ownerOverrideEmail =
      "Enter a valid owner override email, or leave it blank.";
  }
  if (value.deploymentTarget.length < 3 || /\s/.test(value.deploymentTarget)) {
    errors.deploymentTarget =
      "Enter your own deployment address. There is no default.";
  }
  if (value.supabaseHost.length < 3 || /\s/.test(value.supabaseHost)) {
    errors.supabaseHost = "Enter your Supabase database host.";
  }
  if (!validPort(value.supabasePort)) {
    errors.supabasePort = "Enter your Supabase port from 1 to 65535.";
  }
  if (value.supabaseDatabase.length < 1) {
    errors.supabaseDatabase = "Enter your Supabase database name.";
  }
  if (value.supabaseUser.length < 1) {
    errors.supabaseUser = "Enter your Supabase database user.";
  }
  if (
    !value.upstashRestUrl.startsWith("https://") ||
    /\s/.test(value.upstashRestUrl)
  ) {
    errors.upstashRestUrl =
      "Enter your Upstash REST URL. It must start with https://.";
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, value };
}

export function validateSecret(id: SecretId, value: string): string {
  if (value.length >= 8 && !/\s/.test(value)) return "";
  switch (id) {
    case "supabasePassword":
      return "Enter the Supabase database password. Use at least 8 characters and no spaces.";
    case "upstashToken":
      return "Enter the Upstash REST token. Use at least 8 characters and no spaces.";
    case "geminiChatKey":
      return "Enter your Gemini API key. Use at least 8 characters and no spaces.";
    case "deepseekKey":
      return "Enter your DeepSeek API key. Use at least 8 characters and no spaces.";
    case "ollamaCloudKey":
      return "Enter your cloud Ollama key. Use at least 8 characters and no spaces.";
    case "openAiCompatibleKey":
      return "Enter the API key for your OpenAI-compatible provider. Use at least 8 characters and no spaces.";
    default: {
      const neverId: never = id;
      return neverId;
    }
  }
}

function validPort(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  const port = Number(value);
  return port >= 1 && port <= 65535;
}

export type ProbeInput = {
  id: ProbeId;
  keySaved: boolean;
  mockMode: MockMode;
  localMockReachable: boolean;
  localBaseUrl: string;
  openAiBaseUrl: string;
  openAiModel: string;
  deepseekModel: string;
};

/**
 * Mock probe. It never receives a secret and never claims a live call.
 * TODO(integration): a Render route should probe reachability and model
 * discovery, then return only this status shape.
 */
export function probeRoute(input: ProbeInput): ProbeResult {
  switch (input.id) {
    case "gemini-chat":
      return keyedMockResult(
        input,
        "Gemini chat needs your API key. Not connected. No call was made.",
        "The prototype mock rejected the Gemini chat test. No call was made. Not connected.",
        "The prototype mock accepted the Gemini chat credential. No call was made. Not connected. Live voice and speech generation stay disabled.",
      );
    case "deepseek":
      if (!input.keySaved) {
        return {
          status: "auth-missing",
          message:
            "DeepSeek needs your API key. A subscription does not provide one. Not connected. No call was made.",
        };
      }
      if (input.deepseekModel.trim() === "") {
        return {
          status: "not-connected",
          message:
            "Enter the DeepSeek model name. Documented names include deepseek-flash and deepseek-v4-pro. Not connected.",
        };
      }
      if (input.mockMode === "reject") {
        return {
          status: "mock-rejected",
          message:
            "The prototype mock rejected the DeepSeek test. Balance was not checked. reasoning_content was not received. Not connected.",
        };
      }
      return {
        status: "mock-only",
        message:
          "The prototype mock accepted the DeepSeek credential. No call was made. reasoning_content was not received. A subscription does not prove balance or connectivity. Not connected.",
      };
    case "ollama-local":
      return localOllamaResult(input.localMockReachable, input.localBaseUrl);
    case "ollama-cloud":
      return keyedMockResult(
        input,
        "Cloud Ollama needs its own key or sign-in. Not connected. No call was made.",
        "The prototype mock rejected the cloud Ollama test. No call was made. Not connected.",
        "The prototype mock accepted the cloud Ollama credential. No call to ollama.com was made. Not connected.",
      );
    case "openai-compatible":
      if (!input.keySaved) {
        return {
          status: "auth-missing",
          message:
            "The OpenAI-compatible provider needs your API key. Not connected. No call was made.",
        };
      }
      if (
        input.openAiBaseUrl.trim() === "" ||
        input.openAiModel.trim() === ""
      ) {
        return {
          status: "not-connected",
          message:
            "Enter the OpenAI-compatible base URL and model name. Not connected.",
        };
      }
      if (input.mockMode === "reject") {
        return {
          status: "mock-rejected",
          message:
            "The prototype mock rejected the OpenAI-compatible test. No call was made. Not connected.",
        };
      }
      return {
        status: "mock-only",
        message:
          "The prototype mock accepted the OpenAI-compatible credential. No call was made. Not connected.",
      };
    default: {
      const neverId: never = input.id;
      return neverId;
    }
  }
}

function keyedMockResult(
  input: ProbeInput,
  missing: string,
  rejected: string,
  accepted: string,
): ProbeResult {
  if (!input.keySaved) return { status: "auth-missing", message: missing };
  if (input.mockMode === "reject") {
    return { status: "mock-rejected", message: rejected };
  }
  return { status: "mock-only", message: accepted };
}

export function localOllamaResult(
  localMockReachable: boolean,
  localBaseUrl: string,
): ProbeResult {
  if (!localMockReachable) {
    return {
      status: "unreachable",
      message:
        "Local Ollama is not reachable. The computer and the Ollama process must be awake. A saved address is not a connection. Ollama does not fail over to the cloud by itself. Not connected.",
    };
  }
  if (localBaseUrl.trim() === "") {
    return {
      status: "not-connected",
      message:
        "The mock switch is on, but the local Ollama address is empty. This is not a live probe. Not connected.",
    };
  }
  return {
    status: "mock-only",
    message:
      "The mock switch says local Ollama is reachable at the address you entered. This is not a live probe. Ollama does not fail over to the cloud by itself. Not connected.",
  };
}

export function cloudFallbackCopy(input: {
  localMockReachable: boolean;
  cloudKeySaved: boolean;
}): string {
  const policy =
    "Odin policy prefers local Ollama, then an explicit cloud fallback. This is not native Ollama behavior.";
  if (input.localMockReachable) {
    return `${policy} The mock reports the local process as reachable, so the cloud fallback stays idle. Not connected.`;
  }
  if (!input.cloudKeySaved) {
    return `${policy} Local Ollama is not reachable. Explicit cloud fallback needs a separate cloud Ollama key or sign-in. That credential is missing. Not connected.`;
  }
  return `${policy} Local Ollama is not reachable. A cloud Ollama credential is only saved in the prototype mock. Not connected. No call was made.`;
}

export const GEMINI_LIVE_ROW: RouteRow = {
  id: "gemini-live",
  title: "Gemini Live voice",
  status: "unsupported",
  message:
    "Unsupported in this prototype. Gemini Live is a separate stateful WebSocket multimodal API. It is not browser speech synthesis or speech recognition. It does not come with chat or a Plus license. No Live adapter is connected.",
};

export const GEMINI_TTS_ROW: RouteRow = {
  id: "gemini-tts",
  title: "Gemini API speech generation",
  status: "unsupported",
  message:
    "Unsupported in this prototype. Gemini API speech generation is separate from Live voice and from browser speech. It needs its own adapter and credentials. Not connected.",
};

export type RouteSnapshot = {
  geminiKeySaved: boolean;
  deepseekKeySaved: boolean;
  ollamaCloudKeySaved: boolean;
  openAiKeySaved: boolean;
  localMockReachable: boolean;
  localBaseUrl: string;
  probes: Record<ProbeId, ProbeResult | null>;
};

export function buildRouteRows(input: RouteSnapshot): RouteRow[] {
  return [
    {
      id: "gemini-chat",
      title: "Gemini chat",
      status: rowStatus(input.probes["gemini-chat"], input.geminiKeySaved),
      message:
        input.probes["gemini-chat"]?.message ??
        (input.geminiKeySaved
          ? "Gemini chat key is saved in the prototype mock. It has not been tested. Not connected."
          : "Gemini chat needs your API key. Not connected. No call was made."),
    },
    GEMINI_LIVE_ROW,
    GEMINI_TTS_ROW,
    {
      id: "deepseek",
      title: "DeepSeek reasoning",
      status: rowStatus(input.probes.deepseek, input.deepseekKeySaved),
      message:
        input.probes.deepseek?.message ??
        (input.deepseekKeySaved
          ? "DeepSeek key is saved in the prototype mock. It has not been tested. thinking.type and reasoning_effort are not sent. Not connected."
          : "DeepSeek needs your API key. A subscription does not provide one. Not connected. No call was made."),
    },
    {
      id: "ollama-local",
      title: "Local Ollama",
      status:
        input.probes["ollama-local"]?.status ??
        localOllamaResult(input.localMockReachable, input.localBaseUrl).status,
      message:
        input.probes["ollama-local"]?.message ??
        localOllamaResult(input.localMockReachable, input.localBaseUrl).message,
    },
    {
      id: "ollama-cloud",
      title: "Cloud Ollama",
      status: rowStatus(
        input.probes["ollama-cloud"],
        input.ollamaCloudKeySaved,
      ),
      message:
        input.probes["ollama-cloud"]?.message ??
        (input.ollamaCloudKeySaved
          ? "Cloud Ollama key is saved in the prototype mock. It has not been tested. Not connected."
          : "Cloud Ollama needs its own key or sign-in. Not connected. No call was made."),
    },
    {
      id: "openai-compatible",
      title: "OpenAI-compatible provider",
      status: rowStatus(
        input.probes["openai-compatible"],
        input.openAiKeySaved,
      ),
      message:
        input.probes["openai-compatible"]?.message ??
        (input.openAiKeySaved
          ? "OpenAI-compatible key is saved in the prototype mock. It has not been tested. Not connected."
          : "The OpenAI-compatible provider needs your API key. Not connected. No call was made."),
    },
    {
      id: "cloud-fallback",
      title: "Explicit cloud fallback",
      status: "not-connected",
      message: cloudFallbackCopy({
        localMockReachable: input.localMockReachable,
        cloudKeySaved: input.ollamaCloudKeySaved,
      }),
    },
  ];
}

function rowStatus(probe: ProbeResult | null, keySaved: boolean): RouteStatus {
  if (probe) return probe.status;
  if (!keySaved) return "auth-missing";
  return "not-connected";
}

export const SERVICE_IDS = ["supabase", "upstash", "odin", "thalos"] as const;
export type ServiceId = (typeof SERVICE_IDS)[number];

export const SERVICE_COPY: Record<ServiceId, { name: string; detail: string }> =
  {
    supabase: {
      name: "Customer Supabase database",
      detail: "Your own Supabase project. Valhalla does not supply it.",
    },
    upstash: {
      name: "Customer Upstash cache",
      detail: "Your own Upstash database. Valhalla does not supply it.",
    },
    odin: {
      name: "Odin coordinator",
      detail:
        "General OS model coordinator. This mock does not start a process.",
    },
    thalos: {
      name: "Thalos assistant",
      detail: "Trading analysis assistant. This mock does not place trades.",
    },
  };

export const APP_IDS = ["odin", "thalos", "motoko"] as const;
export type AppId = (typeof APP_IDS)[number];

export const APP_COPY: Record<
  AppId,
  { name: string; preview: boolean; summary: string }
> = {
  odin: {
    name: "Odin",
    preview: false,
    summary:
      "General OS model coordinator. A license does not grant provider credits.",
  },
  thalos: {
    name: "Thalos",
    preview: false,
    summary:
      "Analysis assistant for the trading app. This prototype does not place trades, connect a wallet, or hold funds.",
  },
  motoko: {
    name: "Motoko",
    preview: true,
    summary:
      "Preview. Experimental Motoko canister sidecar. This does not rewrite the operating system. No canister is deployed.",
  },
};

export const CUSTOMER_AUTH_NOTE =
  "You supply your own provider authorization and API access. A software license does not include provider credits.";

export const LICENSE_NOTE =
  "A software license covers features, apps, and seats. It does not include pooled AI credit, provider balance, or fund custody. Plus does not unlock Gemini, DeepSeek, or Ollama.";

export const RENDER_NOTE =
  "A future backend would run on Render. A free Render web service spins down after about 15 minutes without traffic. This prototype does not deploy or start Render.";

export const DRIVE_NOT_AUTHORIZED =
  "Not authorized. Google Drive is separate from Valhalla sign-in. Gmail scopes are not used. Not connected.";

export const DRIVE_PENDING =
  "Authorization is pending in the prototype mock. No Google window is open.";

export const DRIVE_AUTHORIZED =
  "Authorized in the prototype mock only. No Google OAuth ran. This is not Valhalla sign-in.";

export const DRIVE_ERROR =
  "Drive authorization did not finish. No Google account was opened. Sign-in and Gmail scopes were not used.";
