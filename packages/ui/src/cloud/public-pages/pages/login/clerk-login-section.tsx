import { ClerkProvider, SignIn, useAuth } from "@clerk/react";
import { readStoredStewardToken } from "@elizaos/plugin-elizacloud/steward-session-client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { clearSsoLoggedOut } from "../../../sso-bridge/sso-bridge";
import {
  consumePendingOAuthReturnTo,
  resolveLoginReturnTo,
} from "../../lib/login-return-to";
import {
  resolveStewardAuthEndpoint,
  syncStewardSessionCookie,
} from "../../lib/steward-session";
import { resolveClerkJwtTemplate } from "./login-provider";

type ClerkMfaChallenge = {
  type: "totp" | "sms";
  challengeId: string;
};

type ClerkAuthResponse = {
  error?: string;
  token?: string;
  refreshToken?: string;
  mfaRequired?: boolean;
  mfa?: ClerkMfaChallenge;
};

type ClerkReadiness = "checking" | "ready" | "unavailable";

function isPublishableKey(value: string | undefined): value is string {
  return Boolean(
    value &&
      /^pk_(?:test|live)_[A-Za-z0-9_=-]+\$?$/.test(value.trim()) &&
      value.trim().length > 20,
  );
}

async function postClerkAuth(
  path: string,
  body: object,
  stewardToken?: string,
): Promise<{ response: Response; data: ClerkAuthResponse }> {
  const response = await fetch(resolveStewardAuthEndpoint(path), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Eliza-CSRF": "1",
      ...(stewardToken
        ? { Authorization: ["Bearer", stewardToken].join(" ") }
        : {}),
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as ClerkAuthResponse;
  return { response, data };
}

function ClerkLoginFlow({
  stewardToken,
  jwtTemplate,
}: {
  stewardToken: string | null;
  jwtTemplate: string;
}): React.JSX.Element {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [linked, setLinked] = useState(false);
  const [readyToLink, setReadyToLink] = useState(false);
  const [challenge, setChallenge] = useState<ClerkMfaChallenge | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const started = useRef(false);

  const establishSession = useCallback(
    async (result: ClerkAuthResponse) => {
      if (!result.token) {
        throw new Error(
          "Clerk sign-in did not establish an Eliza Cloud session.",
        );
      }
      await syncStewardSessionCookie(result.token, result.refreshToken);
      clearSsoLoggedOut();
      navigate(
        resolveLoginReturnTo(searchParams, consumePendingOAuthReturnTo()),
        { replace: true },
      );
    },
    [navigate, searchParams],
  );

  const exchangeClerkSession = useCallback(async () => {
    const clerkToken = await getToken({ template: jwtTemplate });
    if (!clerkToken) throw new Error("Could not verify the Clerk session.");
    const { response, data } = await postClerkAuth("/auth/clerk/exchange", {
      token: clerkToken,
    });
    if (!response.ok) {
      throw new Error(data.error || "Clerk sign-in is unavailable.");
    }
    if (data.mfaRequired && data.mfa) {
      setChallenge(data.mfa);
      return;
    }
    await establishSession(data);
  }, [establishSession, getToken, jwtTemplate]);

  useEffect(() => {
    if (!isLoaded || !isSignedIn || started.current) return;
    started.current = true;
    if (stewardToken) {
      setReadyToLink(true);
      return;
    }
    setBusy(true);
    void (async () => {
      return exchangeClerkSession();
    })()
      .catch((cause: unknown) => {
        setError(
          cause instanceof Error
            ? cause.message
            : "Clerk sign-in is unavailable.",
        );
      })
      .finally(() => setBusy(false));
  }, [exchangeClerkSession, isLoaded, isSignedIn, stewardToken]);

  async function linkClerkIdentity() {
    if (busy || !stewardToken) return;
    setBusy(true);
    setError(null);
    try {
      const clerkToken = await getToken({ template: jwtTemplate });
      if (!clerkToken) throw new Error("Could not verify the Clerk session.");
      const { response, data } = await postClerkAuth(
        "/auth/clerk/link",
        { token: clerkToken },
        stewardToken,
      );
      if (!response.ok) {
        throw new Error(data.error || "Could not link the Clerk account.");
      }
      setLinked(true);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not link the Clerk account.",
      );
    } finally {
      setBusy(false);
    }
  }

  async function completeMfa(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!challenge || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { response, data } = await postClerkAuth(
        `/auth/mfa/${challenge.type}/complete`,
        { challengeId: challenge.challengeId, code: code.trim() },
      );
      if (!response.ok) {
        throw new Error(data.error || "MFA verification failed.");
      }
      await establishSession(data);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "MFA verification failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (linked) {
    return (
      <p role="status" className="text-center text-sm text-status-success">
        {t("cloud.login.clerkLinked", {
          defaultValue:
            "Clerk sign-in is linked to this Eliza Cloud account. Your current session is unchanged.",
        })}
      </p>
    );
  }

  if (challenge) {
    return (
      <form className="space-y-4" onSubmit={completeMfa}>
        <p className="text-sm text-muted">
          {challenge.type === "sms"
            ? t("cloud.login.clerkSmsMfa", {
                defaultValue: "Enter the code sent to your MFA phone.",
              })
            : t("cloud.login.clerkTotpMfa", {
                defaultValue: "Enter your Steward authenticator code.",
              })}
        </p>
        <label className="block space-y-2 text-sm" htmlFor="clerk-mfa-code">
          <span>
            {t("cloud.login.verificationCode", {
              defaultValue: "Verification code",
            })}
          </span>
          <input
            id="clerk-mfa-code"
            autoComplete="one-time-code"
            inputMode="numeric"
            required
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
            className="min-h-11 w-full rounded-md border border-border bg-bg px-3 text-txt"
          />
        </label>
        <Button type="submit" className="w-full" disabled={busy}>
          {busy
            ? t("cloud.login.verifying", { defaultValue: "Verifying…" })
            : t("cloud.login.verify", { defaultValue: "Verify" })}
        </Button>
      </form>
    );
  }

  if (readyToLink) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {t("cloud.login.clerkLinkPrompt", {
            defaultValue:
              "Link this verified Clerk account to the current Eliza Cloud account? Recent Steward MFA is required.",
          })}
        </p>
        {error ? (
          <p role="alert" className="text-sm text-status-error">
            {error}
          </p>
        ) : null}
        <Button
          type="button"
          className="w-full"
          onClick={() => void linkClerkIdentity()}
          disabled={busy}
        >
          {busy
            ? t("cloud.login.linkingClerk", { defaultValue: "Linking…" })
            : t("cloud.login.linkClerk", {
                defaultValue: "Link Clerk sign-in",
              })}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {stewardToken ? (
        <p className="text-sm text-muted">
          {t("cloud.login.clerkLinkPrompt", {
            defaultValue:
              "Sign in to your Clerk account to link it to the current Eliza Cloud account. Recent Steward MFA is required.",
          })}
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="text-sm text-status-error">
          {error}
        </div>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-muted">
          {t("cloud.login.verifying", { defaultValue: "Verifying…" })}
        </p>
      ) : null}
      <SignIn routing="hash" withSignUp={false} />
    </div>
  );
}

function ClerkUnavailable(): React.JSX.Element {
  const t = useCloudT();
  return (
    <div role="alert" className="space-y-2 text-center">
      <p className="font-medium text-txt-strong">
        {t("cloud.login.clerkUnavailableTitle", {
          defaultValue: "Clerk sign-in is unavailable",
        })}
      </p>
      <p className="text-sm text-muted">
        {t("cloud.login.clerkUnavailableBody", {
          defaultValue:
            "This environment is not configured for Clerk sign-in. Contact the administrator or use the approved Steward sign-in mode.",
        })}
      </p>
    </div>
  );
}

export default function ClerkLoginSection({
  linkOnly = false,
}: {
  linkOnly?: boolean;
}): React.JSX.Element {
  const [readiness, setReadiness] = useState<ClerkReadiness>("checking");
  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  const jwtTemplate = resolveClerkJwtTemplate(
    import.meta.env.VITE_CLERK_JWT_TEMPLATE,
  );
  const stewardToken = readStoredStewardToken();

  useEffect(() => {
    if (!isPublishableKey(publishableKey) || !jwtTemplate) {
      setReadiness("unavailable");
      return;
    }
    const controller = new AbortController();
    void fetch(resolveStewardAuthEndpoint("/auth/clerk/status"), {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const status = (await response.json()) as { enabled?: unknown };
        return status.enabled === true;
      })
      .then((enabled) => setReadiness(enabled ? "ready" : "unavailable"))
      .catch(() => {
        if (!controller.signal.aborted) setReadiness("unavailable");
      });
    return () => controller.abort();
  }, [jwtTemplate]);

  if (linkOnly && !stewardToken) {
    return (
      <p role="alert" className="text-sm text-status-error">
        Sign in to your existing Steward account before linking Clerk.
      </p>
    );
  }

  if (readiness === "checking") {
    return (
      <div aria-busy="true" className="min-h-32" role="status">
        <span className="sr-only">Checking sign-in availability…</span>
      </div>
    );
  }
  if (
    readiness !== "ready" ||
    !isPublishableKey(publishableKey) ||
    !jwtTemplate
  ) {
    return <ClerkUnavailable />;
  }

  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkLoginFlow stewardToken={stewardToken} jwtTemplate={jwtTemplate} />
    </ClerkProvider>
  );
}
