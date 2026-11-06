import { useEffect, useState } from "react";
import { DeskApp, type DeskAppProps } from "./DeskApp.tsx";
import {
  componentReadiness,
  defaultServiceHealth,
  type ServiceHealth,
} from "./readiness.ts";
import type { TaskTransport } from "./task-client.ts";
import {
  readWorkspacePreference,
  sanitizeDisplayName,
  writeWorkspacePreference,
} from "./workspace-preference.ts";

export type AuthCheck =
  | { state: "verified"; source: string; displayName: string }
  | { state: "unavailable"; message: string }
  | { state: "rejected"; message: string };

export type AuthSource = () => Promise<AuthCheck>;

const SESSION_PATH = "/api/v1/session";

export async function defaultAuthSource(
  fetchImpl: typeof fetch = fetch,
): Promise<AuthCheck> {
  try {
    const response = await fetchImpl(SESSION_PATH, {
      method: "GET",
      credentials: "include",
    });
    if (!response.ok) {
      return {
        state: "unavailable",
        message: `GET ${SESSION_PATH} returned HTTP ${String(response.status)}. You are not signed in and you are not an admin.`,
      };
    }
    return readSessionBody(await response.json());
  } catch {
    return {
      state: "unavailable",
      message: `GET ${SESSION_PATH} could not be reached. You are not signed in and you are not an admin.`,
    };
  }
}

function readSessionBody(body: unknown): AuthCheck {
  if (!body || typeof body !== "object") {
    return {
      state: "unavailable",
      message: `GET ${SESSION_PATH} did not return a session record. You are not signed in and you are not an admin.`,
    };
  }
  const record = body as Record<string, unknown>;
  if (record.available === false) {
    const reason =
      typeof record.reason === "string" ? record.reason : "unavailable";
    return {
      state: "unavailable",
      message: `Session service reported ${reason}. You are not signed in and you are not an admin.`,
    };
  }
  if (typeof record.id !== "string" || record.id.length === 0) {
    return {
      state: "unavailable",
      message: `GET ${SESSION_PATH} did not return a session id. You are not signed in and you are not an admin.`,
    };
  }
  return {
    state: "verified",
    source: `GET ${SESSION_PATH}`,
    displayName:
      typeof record.displayName === "string" ? record.displayName : "",
  };
}

export type ValhallaWorkspaceProps = {
  authSource?: AuthSource;
  serviceHealth?: () => Promise<ServiceHealth>;
  storage?: Storage;
  reducedMotion?: boolean;
  taskTransport?: TaskTransport;
  deskProps?: DeskAppProps;
};

type Phase = "auth" | "name" | "prepare" | "desktop";

export function ValhallaWorkspace(props: ValhallaWorkspaceProps) {
  const authSource = props.authSource ?? defaultAuthSource;
  const serviceHealth = props.serviceHealth ?? defaultServiceHealth;
  const storage = props.storage ?? safeSessionStorage();
  const reducedMotion = props.reducedMotion ?? prefersReducedMotion();
  const saved = storage
    ? readWorkspacePreference(storage)
    : { displayName: "", bootSeen: false };
  const [phase, setPhase] = useState<Phase>("auth");
  const [attempt, setAttempt] = useState(0);
  const [auth, setAuth] = useState<AuthCheck | null>(null);
  const [displayName, setDisplayName] = useState(saved.displayName);
  const [draftName, setDraftName] = useState(saved.displayName);
  const [health, setHealth] = useState<ServiceHealth | null>(null);

  useEffect(() => {
    if (phase !== "auth") return;
    let cancel = false;
    void authSource().then((result) => {
      if (cancel) return;
      setAuth(result);
      if (result.state === "verified" && saved.bootSeen) {
        const label = sanitizeDisplayName(
          result.displayName || saved.displayName,
        );
        setDisplayName(label);
        setPhase("desktop");
      }
    });
    return () => {
      cancel = true;
    };
  }, [authSource, phase, attempt]);

  useEffect(() => {
    if (phase !== "prepare") return;
    let cancel = false;
    void serviceHealth().then((result) => {
      if (!cancel) setHealth(result);
    });
    return () => {
      cancel = true;
    };
  }, [phase, serviceHealth]);

  useEffect(() => {
    const focusId =
      phase === "name"
        ? "ascent-name"
        : phase === "desktop"
          ? "workspace-heading"
          : "ascent-primary";
    document.getElementById(focusId)?.focus();
  }, [phase]);

  async function enterWorkspace(name: string) {
    const latest = await authSource();
    setAuth(latest);
    if (latest.state !== "verified") {
      setPhase("auth");
      return;
    }
    const label = sanitizeDisplayName(name);
    setDisplayName(label);
    if (storage) {
      try {
        writeWorkspacePreference(storage, {
          displayName: label,
          bootSeen: true,
        });
      } catch {
        // The label stays in memory when this browser blocks storage.
      }
    }
    setPhase("desktop");
  }

  if (phase === "desktop") {
    return (
      <div
        className="vd-workspace"
        data-reduced-motion={reducedMotion ? "true" : "false"}
      >
        <header className="vd-workspace-bar">
          <p className="vd-overline">ValhallaOS</p>
          <h1 id="workspace-heading" tabIndex={-1}>
            Valhalla Workspace
          </h1>
          <p id="workspace-hello">
            {displayName ? "Hello, " : "Hello."}
            {displayName ? (
              <span id="workspace-name">{displayName}</span>
            ) : null}
          </p>
          <p id="workspace-name-note">
            Local display name. Guest session. This is not a sign-in and it is
            not an admin role.
          </p>
        </header>
        <DeskApp
          {...deskAppProps(props.deskProps, displayName, props.taskTransport)}
        />
      </div>
    );
  }

  const rows = health ? componentReadiness(health) : [];
  const blocked = rows.some((item) => item.id === "services" && !item.ready);

  return (
    <div
      className={reducedMotion ? "ascent ascent-static" : "ascent"}
      data-phase={phase}
      data-effects={reducedMotion ? "low" : "full"}
    >
      <div className="ascent-halo" aria-hidden="true" />
      <div className="ascent-arch" aria-hidden="true" />
      <section className="ascent-card" aria-labelledby="ascent-title">
        <p className="vd-overline">ValhallaOS</p>
        <h1 id="ascent-title">Ascent</h1>
        {phase === "auth" ? (
          <>
            <p id="ascent-auth">
              {auth === null
                ? "Checking the existing signup service."
                : auth.state === "verified"
                  ? `Signup check verified by ${auth.source}. This is not an admin role.`
                  : auth.message}
            </p>
            {auth && auth.state !== "verified" ? (
              <p id="ascent-next">
                Next step: sign in on the existing Valhalla site, then choose
                Retry session check. This page does not create an account and
                does not open the workspace.
              </p>
            ) : null}
            <button
              type="button"
              id="ascent-primary"
              disabled={auth === null}
              onClick={() => {
                if (auth?.state === "verified") {
                  if (auth.displayName) {
                    setDraftName(auth.displayName);
                    setDisplayName(auth.displayName);
                  }
                  setPhase("name");
                  return;
                }
                setAuth(null);
                setAttempt((value) => value + 1);
              }}
            >
              {auth?.state === "verified" ? "Continue" : "Retry session check"}
            </button>
          </>
        ) : null}
        {phase === "name" ? (
          <>
            <h2>What should this device call you?</h2>
            <p>
              Used as a local greeting only. This is not a sign-in and does not
              verify your identity.
            </p>
            <label htmlFor="ascent-name">Display name</label>
            <input
              id="ascent-name"
              value={draftName}
              autoComplete="off"
              maxLength={40}
              onChange={(event) => setDraftName(event.target.value)}
            />
            <button
              type="button"
              id="ascent-primary"
              onClick={() => {
                setDisplayName(sanitizeDisplayName(draftName));
                setPhase("prepare");
              }}
            >
              Continue
            </button>
          </>
        ) : null}
        {phase === "prepare" ? (
          <>
            <h2>Preparing your workspace</h2>
            {health === null ? (
              <p id="ascent-auth">Checking component readiness.</p>
            ) : (
              <ul id="ascent-readiness">
                {rows.map((item) => (
                  <li key={item.id} data-ready={item.ready ? "yes" : "no"}>
                    <span>{item.label}</span>
                    <span>{item.ready ? "Ready" : "Not ready"}</span>
                    <span>{item.detail}</span>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              id="ascent-primary"
              disabled={health === null}
              onClick={() => void enterWorkspace(displayName)}
            >
              {blocked
                ? "Continue with limited workspace"
                : "Enter Valhalla Workspace"}
            </button>
          </>
        ) : null}
      </section>
    </div>
  );
}

function deskAppProps(
  deskProps: DeskAppProps | undefined,
  displayName: string,
  taskTransport: TaskTransport | undefined,
): DeskAppProps {
  const next: DeskAppProps = { displayName };
  if (taskTransport) next.taskTransport = taskTransport;
  if (deskProps?.autoResolveDrive !== undefined) {
    next.autoResolveDrive = deskProps.autoResolveDrive;
  }
  if (deskProps?.vault) next.vault = deskProps.vault;
  return next;
}

function safeSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function prefersReducedMotion(): boolean {
  return (
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
