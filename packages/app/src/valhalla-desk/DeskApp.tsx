import {
  type ChangeEvent,
  Component,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  beginMockDriveConnect,
  type DrivePhase,
  finishMockDriveConnect,
  MockCredentialVault,
  mockDriveDisconnect,
  mockServiceStart,
  mockServiceStop,
} from "./mock-adapters.ts";
import {
  APP_COPY,
  APP_IDS,
  type AppId,
  buildRouteRows,
  CUSTOMER_AUTH_NOTE,
  DRIVE_AUTHORIZED,
  DRIVE_ERROR,
  DRIVE_NOT_AUTHORIZED,
  DRIVE_PENDING,
  EMPTY_PUBLIC,
  emptySecrets,
  type FieldErrors,
  GEMINI_LIVE_ROW,
  GEMINI_TTS_ROW,
  LICENSE_NOTE,
  type MockMode,
  type ProbeId,
  type ProbeResult,
  type PublicSettings,
  probeRoute,
  RENDER_NOTE,
  type ReasoningEffort,
  SERVICE_COPY,
  SERVICE_IDS,
  type SecretId,
  type ServiceId,
  type ThinkingType,
  validatePublic,
  validateSecret,
  WINDOW_IDS,
  WINDOW_LABEL,
  type WindowId,
} from "./model.ts";
import {
  BrowserPanel,
  CommandBar,
  ExtraWindow,
  OptionalServices,
  ThemeSelect,
  VoicePanel,
} from "./shell-panels.tsx";
import {
  createConversationId,
  TaskClient,
  type TaskTransport,
  unavailableTaskTransport,
} from "./task-client.ts";
import { THEMES, type ThemeId, writeThemePreference } from "./theme.ts";
import {
  createWindowManager,
  reduceWindows,
  type WindowManagerState,
} from "./window-manager.ts";

type BoundaryProps = { children: ReactNode };
type BoundaryState = { failed: boolean };

export class DeskErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override render(): ReactNode {
    if (this.state.failed) {
      return (
        <p role="alert">
          This desk hit a problem. Technical details stay hidden.
        </p>
      );
    }
    return this.props.children;
  }
}

type DeskDialog =
  | { kind: "disconnect-drive"; returnFocusId: string }
  | { kind: "install-app"; appId: AppId; returnFocusId: string }
  | { kind: "revoke-app"; appId: AppId; returnFocusId: string };

type ServiceRun = "stopped" | "mock-start-recorded";

const PUBLIC_FIELDS: {
  id: keyof PublicSettings;
  label: string;
  hint: string;
}[] = [
  {
    id: "brandName",
    label: "Customer brand name",
    hint: "Required. This is your deployment name.",
  },
  {
    id: "adminEmail",
    label: "Deployment admin email",
    hint: "Required. There is no default admin email.",
  },
  {
    id: "ownerOverrideEmail",
    label: "Owner deployment override email",
    hint: "Optional. Use this only for the product owner's own deployment. Leave it blank for a customer. It is never filled in for you.",
  },
  {
    id: "deploymentTarget",
    label: "Deployment target",
    hint: "Required. Enter your own Render service address. Nothing is prefilled.",
  },
  {
    id: "supabaseHost",
    label: "Supabase database host",
    hint: "Required. Your own Supabase project. Valhalla does not supply a database. A free Supabase project can pause after a week without activity.",
  },
  {
    id: "supabasePort",
    label: "Supabase port",
    hint: "Required. Copy the port from your Supabase project. The pooler is often 6543 and the session port is often 5432.",
  },
  {
    id: "supabaseDatabase",
    label: "Supabase database name",
    hint: "Required. The database name from your project.",
  },
  {
    id: "supabaseUser",
    label: "Supabase database user",
    hint: "Required. This user name is not a secret.",
  },
  {
    id: "upstashRestUrl",
    label: "Upstash REST URL",
    hint: "Required. Your own Upstash database. Enter the REST token in the secret section.",
  },
];

export type DeskAppProps = {
  autoResolveDrive?: boolean;
  vault?: MockCredentialVault;
  displayName?: string;
  taskTransport?: TaskTransport;
};

export function DeskApp(props: DeskAppProps) {
  const autoResolveDrive = props.autoResolveDrive ?? true;
  const vaultRef = useRef<MockCredentialVault | null>(null);
  if (!vaultRef.current) {
    vaultRef.current = props.vault ?? new MockCredentialVault();
  }
  const vault = vaultRef.current;
  const timers = useRef<number[]>([]);
  const taskRef = useRef<TaskClient | null>(null);
  if (!taskRef.current) {
    taskRef.current = new TaskClient(
      props.taskTransport ?? unavailableTaskTransport(),
      createConversationId(),
    );
  }
  const taskClient = taskRef.current;
  const [themeId, setThemeId] = useState<ThemeId>("navy");

  const [windows, setWindows] =
    useState<WindowManagerState>(createWindowManager);
  const [startOpen, setStartOpen] = useState(false);
  const [dialog, setDialog] = useState<DeskDialog | null>(null);
  const [publicDraft, setPublicDraft] = useState<PublicSettings>(EMPTY_PUBLIC);
  const [publicErrors, setPublicErrors] = useState<FieldErrors>({});
  const [publicSaved, setPublicSaved] = useState<PublicSettings | null>(null);
  const [editingPublic, setEditingPublic] = useState(true);
  const [secretDraft, setSecretDraft] = useState(emptySecrets);
  const [secretErrors, setSecretErrors] = useState<FieldErrors>({});
  const [savedSecrets, setSavedSecrets] = useState<SecretId[]>([]);
  const [thinking, setThinking] = useState<ThinkingType>("enabled");
  const [effort, setEffort] = useState<ReasoningEffort>("high");
  const [deepseekModel, setDeepseekModel] = useState("");
  const [localBaseUrl, setLocalBaseUrl] = useState("");
  const [localMockReachable, setLocalMockReachable] = useState(false);
  const [openAiBaseUrl, setOpenAiBaseUrl] = useState("");
  const [openAiModel, setOpenAiModel] = useState("");
  const [mockMode, setMockMode] = useState<MockMode>("accept");
  const [probes, setProbes] =
    useState<Record<ProbeId, ProbeResult | null>>(emptyProbes);
  const [drivePhase, setDrivePhase] = useState<DrivePhase>("not-authorized");
  const [selectedServices, setSelectedServices] = useState<ServiceId[]>([]);
  const [serviceRun, setServiceRun] =
    useState<Record<ServiceId, ServiceRun>>(stoppedServices);
  const [serviceMessage, setServiceMessage] = useState(
    "No service start is recorded.",
  );
  const [installed, setInstalled] = useState<AppId[]>([]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!dialog) return;
    document.getElementById("desk-dialog-cancel")?.focus();
    const returnFocusId = dialog.returnFocusId;
    return () => {
      document.getElementById(returnFocusId)?.focus();
    };
  }, [dialog]);

  const routes = buildRouteRows({
    geminiKeySaved: savedSecrets.includes("geminiChatKey"),
    deepseekKeySaved: savedSecrets.includes("deepseekKey"),
    ollamaCloudKeySaved: savedSecrets.includes("ollamaCloudKey"),
    openAiKeySaved: savedSecrets.includes("openAiCompatibleKey"),
    localMockReachable,
    localBaseUrl,
    probes,
  });

  function openWindow(id: WindowId) {
    setWindows((state) => reduceWindows(state, { type: "open", id }));
    setStartOpen(false);
  }

  function closeWindow(id: WindowId) {
    if (id === "voice") {
      window.dispatchEvent(new Event("valhalla-stop-mic"));
    }
    setWindows((state) => reduceWindows(state, { type: "close", id }));
    document.getElementById(`desk-icon-${id}`)?.focus();
  }

  function dispatchWindow(
    id: WindowId,
    type: "minimize" | "focus" | "taskbar",
  ) {
    setWindows((state) => reduceWindows(state, { type, id }));
  }

  function savePublic() {
    const result = validatePublic(publicDraft);
    if (!result.ok) {
      setPublicErrors(result.errors);
      return;
    }
    setPublicErrors({});
    setPublicDraft(result.value);
    setPublicSaved(result.value);
    setEditingPublic(false);
  }

  function saveDbSecrets() {
    const passwordError = validateSecret(
      "supabasePassword",
      secretDraft.supabasePassword,
    );
    const tokenError = validateSecret("upstashToken", secretDraft.upstashToken);
    if (passwordError || tokenError) {
      setSecretErrors((current) => {
        const next = { ...current };
        if (passwordError) next.supabasePassword = passwordError;
        else delete next.supabasePassword;
        if (tokenError) next.upstashToken = tokenError;
        else delete next.upstashToken;
        return next;
      });
      return;
    }
    vault.save("supabasePassword", secretDraft.supabasePassword);
    vault.save("upstashToken", secretDraft.upstashToken);
    rememberSecrets(["supabasePassword", "upstashToken"]);
    setSecretDraft((current) => ({
      ...current,
      supabasePassword: "",
      upstashToken: "",
    }));
    setSecretErrors((current) => {
      const next = { ...current };
      delete next.supabasePassword;
      delete next.upstashToken;
      return next;
    });
  }

  function saveProvider(id: SecretId) {
    const message = validateSecret(id, secretDraft[id]);
    if (message) {
      setSecretErrors((current) => ({ ...current, [id]: message }));
      return;
    }
    vault.save(id, secretDraft[id]);
    rememberSecrets([id]);
    setSecretDraft((current) => ({ ...current, [id]: "" }));
    setSecretErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    const probeId = probeForSecret(id);
    if (probeId) {
      setProbes((current) => ({ ...current, [probeId]: null }));
    }
  }

  function rememberSecrets(ids: SecretId[]) {
    setSavedSecrets((current) => {
      const next = [...current];
      for (const id of ids) {
        if (!next.includes(id)) next.push(id);
      }
      return next;
    });
  }

  function runProbe(id: ProbeId) {
    setProbes((current) => ({
      ...current,
      [id]: {
        status: "not-connected",
        message: "Testing in the prototype mock. No provider is called.",
      },
    }));
    const timer = window.setTimeout(() => {
      setProbes((current) => ({
        ...current,
        [id]: probeRoute({
          id,
          keySaved: keySaved(id, savedSecrets),
          mockMode,
          localMockReachable,
          localBaseUrl,
          openAiBaseUrl,
          openAiModel,
          deepseekModel,
        }),
      }));
    }, 0);
    timers.current.push(timer);
  }

  function connectDrive() {
    setDrivePhase(beginMockDriveConnect());
    if (!autoResolveDrive) return;
    const timer = window.setTimeout(() => {
      setDrivePhase((current) =>
        current === "pending" ? finishMockDriveConnect("authorize") : current,
      );
    }, 0);
    timers.current.push(timer);
  }

  function confirmDialog() {
    if (!dialog) return;
    if (dialog.kind === "disconnect-drive") {
      setDrivePhase(mockDriveDisconnect());
    }
    if (dialog.kind === "install-app") {
      const appId = dialog.appId;
      setInstalled((current) =>
        current.includes(appId) ? current : [...current, appId],
      );
    }
    if (dialog.kind === "revoke-app") {
      const appId = dialog.appId;
      setInstalled((current) => current.filter((item) => item !== appId));
    }
    setDialog(null);
  }

  function startSelected() {
    if (selectedServices.length === 0) {
      setServiceMessage("Select a service first.");
      return;
    }
    const started = mockServiceStart();
    setServiceRun((current) => {
      const next = { ...current };
      for (const id of selectedServices) next[id] = started;
      return next;
    });
    setServiceMessage(
      "Start recorded in the prototype mock. No Render service was started. A free Render service would spin down after about 15 minutes without traffic.",
    );
  }

  function stopSelected() {
    if (selectedServices.length === 0) {
      setServiceMessage("Select a service first.");
      return;
    }
    const stopped = mockServiceStop();
    setServiceRun((current) => {
      const next = { ...current };
      for (const id of selectedServices) next[id] = stopped;
      return next;
    });
    setServiceMessage(
      "Stop recorded in the prototype mock. No process was signaled.",
    );
  }

  useEffect(() => {
    if (!startOpen || dialog) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setStartOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [startOpen, dialog]);

  return (
    <DeskErrorBoundary>
      <div
        className="vd-desktop"
        data-theme={themeId}
        style={{ background: THEMES[themeId].desk, color: THEMES[themeId].ink }}
      >
        <p className="vd-banner">
          Valhalla desk prototype. Adapters are mocks. This page does not call a
          provider, Google, Supabase, Upstash, or Render.
        </p>
        <p className="vd-license">{LICENSE_NOTE}</p>
        <ThemeSelect
          themeId={themeId}
          onChange={(id) => {
            setThemeId(id);
            try {
              writeThemePreference(window.sessionStorage, id);
            } catch {
              // The choice stays on this page when storage is blocked.
            }
          }}
        />
        <OptionalServices />
        <CommandBar
          client={taskClient}
          focusedApp={
            windows.activeId ? WINDOW_LABEL[windows.activeId] : "none"
          }
        />
        <section id="setup-guide" aria-label="Setup guide">
          <h2>A few things to get you started</h2>
          <p>Open a desk tool. These buttons do not finish a server setup.</p>
          <button
            type="button"
            id="guide-models"
            onClick={() => openWindow("models")}
          >
            Model and BYOK
          </button>
          <button
            type="button"
            id="guide-storage"
            onClick={() => openWindow("storage")}
          >
            Storage
          </button>
          <button
            type="button"
            id="guide-browser"
            onClick={() => openWindow("browser")}
          >
            Browser
          </button>
          <button
            type="button"
            id="guide-voice"
            onClick={() => openWindow("voice")}
          >
            Voice
          </button>
          <button
            type="button"
            id="guide-apps"
            onClick={() => openWindow("apps")}
          >
            Apps
          </button>
          <button
            type="button"
            id="guide-theme"
            onClick={() => document.getElementById("desk-theme")?.focus()}
          >
            Theme
          </button>
        </section>
        <div className="vd-icons">
          {WINDOW_IDS.map((id) => (
            <button
              key={id}
              id={`desk-icon-${id}`}
              type="button"
              className="vd-icon"
              onClick={() => openWindow(id)}
            >
              <span aria-hidden="true">{WINDOW_LABEL[id].slice(0, 1)}</span>
              <span>{WINDOW_LABEL[id]}</span>
            </button>
          ))}
        </div>
        {startOpen ? (
          <div className="vd-menu" id="start-menu">
            {WINDOW_IDS.map((id) => (
              <button key={id} type="button" onClick={() => openWindow(id)}>
                Open {WINDOW_LABEL[id]}
              </button>
            ))}
          </div>
        ) : null}
        <div className="vd-windows">
          {windows.frames.map((frame) =>
            frame.open ? (
              <section
                key={frame.id}
                className="vd-window"
                data-window={frame.id}
                data-active={frame.id === windows.activeId ? "true" : "false"}
                hidden={frame.minimized}
                aria-labelledby={`vd-title-${frame.id}`}
              >
                <header className="vd-titlebar">
                  <h2 id={`vd-title-${frame.id}`}>
                    <button
                      type="button"
                      onClick={() => dispatchWindow(frame.id, "focus")}
                    >
                      {WINDOW_LABEL[frame.id]}
                    </button>
                  </h2>
                  <div className="vd-controls">
                    <button
                      type="button"
                      aria-label={`Minimize ${WINDOW_LABEL[frame.id]}`}
                      onClick={() => dispatchWindow(frame.id, "minimize")}
                    >
                      _
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${WINDOW_LABEL[frame.id]}`}
                      onClick={() => closeWindow(frame.id)}
                    >
                      X
                    </button>
                  </div>
                </header>
                <div className="vd-body">
                  {frame.id === "setup" ? (
                    <SetupPanel
                      draft={publicDraft}
                      errors={publicErrors}
                      saved={publicSaved}
                      editing={editingPublic}
                      secretDraft={secretDraft}
                      secretErrors={secretErrors}
                      savedSecrets={savedSecrets}
                      onPublic={(field, value) =>
                        setPublicDraft((current) => ({
                          ...current,
                          [field]: value,
                        }))
                      }
                      onSavePublic={savePublic}
                      onEditPublic={() => setEditingPublic(true)}
                      onSecret={(field, value) =>
                        setSecretDraft((current) => ({
                          ...current,
                          [field]: value,
                        }))
                      }
                      onSaveSecrets={saveDbSecrets}
                    />
                  ) : null}
                  {frame.id === "models" ? (
                    <ModelsPanel
                      routes={routes}
                      thinking={thinking}
                      effort={effort}
                      deepseekModel={deepseekModel}
                      localBaseUrl={localBaseUrl}
                      localMockReachable={localMockReachable}
                      openAiBaseUrl={openAiBaseUrl}
                      openAiModel={openAiModel}
                      mockMode={mockMode}
                      secretDraft={secretDraft}
                      secretErrors={secretErrors}
                      savedSecrets={savedSecrets}
                      onThinking={setThinking}
                      onEffort={setEffort}
                      onDeepseekModel={setDeepseekModel}
                      onLocalBaseUrl={(value) => {
                        setLocalBaseUrl(value);
                        setProbes((current) => ({
                          ...current,
                          "ollama-local": null,
                        }));
                      }}
                      onLocalMock={(value) => {
                        setLocalMockReachable(value);
                        setProbes((current) => ({
                          ...current,
                          "ollama-local": null,
                        }));
                      }}
                      onOpenAiBaseUrl={setOpenAiBaseUrl}
                      onOpenAiModel={setOpenAiModel}
                      onMockMode={(value) => {
                        setMockMode(value);
                        setProbes(emptyProbes());
                      }}
                      onSecret={(field, value) =>
                        setSecretDraft((current) => ({
                          ...current,
                          [field]: value,
                        }))
                      }
                      onSave={saveProvider}
                      onProbe={runProbe}
                    />
                  ) : null}
                  {frame.id === "channels" ? <ChannelsPanel /> : null}
                  {frame.id === "storage" ? (
                    <StoragePanel
                      phase={drivePhase}
                      onConnect={connectDrive}
                      onFail={() =>
                        setDrivePhase(finishMockDriveConnect("fail"))
                      }
                      onAskDisconnect={() =>
                        setDialog({
                          kind: "disconnect-drive",
                          returnFocusId: "drive-disconnect",
                        })
                      }
                    />
                  ) : null}
                  {frame.id === "services" ? (
                    <ServicesPanel
                      selected={selectedServices}
                      run={serviceRun}
                      message={serviceMessage}
                      onToggle={(id) =>
                        setSelectedServices((current) =>
                          current.includes(id)
                            ? current.filter((item) => item !== id)
                            : [...current, id],
                        )
                      }
                      onStart={startSelected}
                      onStop={stopSelected}
                    />
                  ) : null}
                  {frame.id === "voice" ? (
                    <VoicePanel client={taskClient} />
                  ) : null}
                  {frame.id === "browser" ? <BrowserPanel /> : null}
                  {frame.id === "privarun" ||
                  frame.id === "vault" ||
                  frame.id === "studio" ||
                  frame.id === "forge" ? (
                    <ExtraWindow id={frame.id} />
                  ) : null}
                  {frame.id === "apps" ? (
                    <AppsPanel
                      installed={installed}
                      onInstall={(appId) =>
                        setDialog({
                          kind: "install-app",
                          appId,
                          returnFocusId: `app-install-${appId}`,
                        })
                      }
                      onRevoke={(appId) =>
                        setDialog({
                          kind: "revoke-app",
                          appId,
                          returnFocusId: `app-revoke-${appId}`,
                        })
                      }
                    />
                  ) : null}
                </div>
              </section>
            ) : null,
          )}
        </div>
        <footer className="vd-taskbar">
          <button
            type="button"
            id="start-button"
            aria-expanded={startOpen}
            aria-controls="start-menu"
            onClick={() => setStartOpen((open) => !open)}
          >
            Start
          </button>
          <button
            type="button"
            id="voice-button"
            onClick={() => openWindow("voice")}
          >
            Voice
          </button>
          <p id="tray-status">Microphone paused</p>
          {windows.frames
            .filter((frame) => frame.open)
            .map((frame) => (
              <button
                key={frame.id}
                type="button"
                id={`taskbar-${frame.id}`}
                aria-pressed={frame.id === windows.activeId && !frame.minimized}
                onClick={() => dispatchWindow(frame.id, "taskbar")}
              >
                {WINDOW_LABEL[frame.id]}
              </button>
            ))}
        </footer>
        {dialog ? (
          <div className="vd-dialog-backdrop">
            <div
              id="desk-dialog"
              className="vd-dialog"
              role="dialog"
              aria-modal="false"
              aria-labelledby="desk-dialog-title"
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.stopPropagation();
                setDialog(null);
              }}
            >
              <h2 id="desk-dialog-title">
                {dialog.kind === "disconnect-drive"
                  ? "Disconnect Google Drive"
                  : dialog.kind === "install-app"
                    ? `Install ${APP_COPY[dialog.appId].name}`
                    : `Revoke ${APP_COPY[dialog.appId].name}`}
              </h2>
              <p id="desk-dialog-copy">
                {dialog.kind === "disconnect-drive"
                  ? "Disconnect the prototype Drive mock? No Google account is open."
                  : dialog.kind === "install-app"
                    ? `Install ${APP_COPY[dialog.appId].name} in this prototype catalog? No service is deployed.`
                    : `Revoke ${APP_COPY[dialog.appId].name} from this prototype catalog?`}
              </p>
              <p>Press Escape to cancel. Tab can leave this dialog.</p>
              <div className="vd-dialog-actions">
                <button
                  type="button"
                  id="desk-dialog-cancel"
                  onClick={() => setDialog(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  id="desk-dialog-confirm"
                  onClick={confirmDialog}
                >
                  Confirm
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </DeskErrorBoundary>
  );
}

function SetupPanel(props: {
  draft: PublicSettings;
  errors: FieldErrors;
  saved: PublicSettings | null;
  editing: boolean;
  secretDraft: Record<SecretId, string>;
  secretErrors: FieldErrors;
  savedSecrets: SecretId[];
  onPublic: (field: keyof PublicSettings, value: string) => void;
  onSavePublic: () => void;
  onEditPublic: () => void;
  onSecret: (field: SecretId, value: string) => void;
  onSaveSecrets: () => void;
}) {
  return (
    <div>
      {props.saved ? null : (
        <p id="first-run-banner" role="status">
          First-run setup is incomplete.
        </p>
      )}
      <p>
        Enter your own brand, admin email, deployment target, Supabase database,
        and Upstash cache. {RENDER_NOTE}
      </p>
      {props.saved && !props.editing ? (
        <div>
          <p>
            Public settings saved in this prototype memory. They are read-only
            until you edit them.
          </p>
          <dl className="vd-summary" id="public-summary">
            {PUBLIC_FIELDS.map((field) => (
              <div key={field.id}>
                <dt>{field.label}</dt>
                <dd>
                  {props.saved?.[field.id] === ""
                    ? "Blank"
                    : props.saved?.[field.id]}
                </dd>
              </div>
            ))}
          </dl>
          <button type="button" id="edit-public" onClick={props.onEditPublic}>
            Edit public settings
          </button>
        </div>
      ) : (
        <form
          id="public-settings-form"
          autoComplete="off"
          onSubmit={(event) => {
            event.preventDefault();
            props.onSavePublic();
          }}
        >
          {PUBLIC_FIELDS.map((field) => (
            <TextField
              key={field.id}
              id={field.id}
              label={field.label}
              hint={field.hint}
              value={props.draft[field.id]}
              error={props.errors[field.id] ?? ""}
              onChange={(value) => props.onPublic(field.id, value)}
            />
          ))}
          <button type="submit" id="save-public">
            Save public settings
          </button>
        </form>
      )}
      <form
        className="vd-secret"
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSaveSecrets();
        }}
      >
        <h3>Secret backend credentials</h3>
        <p>
          These secrets stay in the prototype mock for this page session. They
          are not written to browser storage. A future Render server must store
          them. You supply your own Supabase and Upstash access.
        </p>
        <TextField
          id="supabasePassword"
          label="Supabase database password"
          hint="Secret. The value is hidden after a successful mock save."
          type="password"
          value={props.secretDraft.supabasePassword}
          error={props.secretErrors.supabasePassword ?? ""}
          onChange={(value) => props.onSecret("supabasePassword", value)}
        />
        <TextField
          id="upstashToken"
          label="Upstash REST token"
          hint="Secret. The value is hidden after a successful mock save."
          type="password"
          value={props.secretDraft.upstashToken}
          error={props.secretErrors.upstashToken ?? ""}
          onChange={(value) => props.onSecret("upstashToken", value)}
        />
        <p
          id="secret-status-supabasePassword"
          data-status={statusFor(props.savedSecrets, "supabasePassword")}
        >
          Supabase password: {masked(props.savedSecrets, "supabasePassword")}
        </p>
        <p
          id="secret-status-upstashToken"
          data-status={statusFor(props.savedSecrets, "upstashToken")}
        >
          Upstash token: {masked(props.savedSecrets, "upstashToken")}
        </p>
        <button type="submit" id="save-db-secrets">
          Save secret credentials
        </button>
      </form>
    </div>
  );
}

function ModelsPanel(props: {
  routes: ReturnType<typeof buildRouteRows>;
  thinking: ThinkingType;
  effort: ReasoningEffort;
  deepseekModel: string;
  localBaseUrl: string;
  localMockReachable: boolean;
  openAiBaseUrl: string;
  openAiModel: string;
  mockMode: MockMode;
  secretDraft: Record<SecretId, string>;
  secretErrors: FieldErrors;
  savedSecrets: SecretId[];
  onThinking: (value: ThinkingType) => void;
  onEffort: (value: ReasoningEffort) => void;
  onDeepseekModel: (value: string) => void;
  onLocalBaseUrl: (value: string) => void;
  onLocalMock: (value: boolean) => void;
  onOpenAiBaseUrl: (value: string) => void;
  onOpenAiModel: (value: string) => void;
  onMockMode: (value: MockMode) => void;
  onSecret: (field: SecretId, value: string) => void;
  onSave: (id: SecretId) => void;
  onProbe: (id: ProbeId) => void;
}) {
  return (
    <div>
      <h3>Odin</h3>
      <p>
        Odin is the general OS model coordinator. It prefers local Ollama when
        that process is reachable, then an explicit cloud fallback. That
        fallback is Odin policy. It is not automatic Ollama behavior.
      </p>
      <h3>Thalos</h3>
      <p>
        Thalos is the trading app's analysis assistant. It can use the same
        route table. This prototype does not place trades or hold funds.
      </p>
      <p>{CUSTOMER_AUTH_NOTE}</p>
      <p>{LICENSE_NOTE}</p>
      <ul className="vd-routes" aria-label="Model routes">
        {props.routes.map((row) => (
          <li
            key={row.id}
            id={`route-${row.id}`}
            data-route={row.id}
            data-status={row.status}
          >
            <strong>{row.title}</strong>
            <p>{row.message}</p>
          </li>
        ))}
      </ul>
      <div className="vd-inline">
        <label htmlFor="mockMode">Prototype mock test result</label>
        <select
          id="mockMode"
          value={props.mockMode}
          onChange={(event) =>
            props.onMockMode(
              event.target.value === "reject" ? "reject" : "accept",
            )
          }
        >
          <option value="accept">Accept in the mock</option>
          <option value="reject">Reject in the mock</option>
        </select>
        <p className="vd-hint">
          This control does not call a provider. A saved key is still not a live
          connection.
        </p>
      </div>
      <ProviderBlock
        title="Gemini chat"
        secretId="geminiChatKey"
        probeId="gemini-chat"
        label="Gemini API key"
        hint="Secret. Used only for a future chat adapter. Live voice and speech generation stay off."
        draft={props.secretDraft}
        errors={props.secretErrors}
        savedSecrets={props.savedSecrets}
        onSecret={props.onSecret}
        onSave={props.onSave}
        onProbe={props.onProbe}
      />
      <h3>{GEMINI_LIVE_ROW.title}</h3>
      <p data-route="gemini-live" data-status="unsupported">
        {GEMINI_LIVE_ROW.message}
      </p>
      <button type="button" id="probe-gemini-live" disabled>
        Test Live voice
      </button>
      <h3>{GEMINI_TTS_ROW.title}</h3>
      <p data-route="gemini-tts" data-status="unsupported">
        {GEMINI_TTS_ROW.message}
      </p>
      <button type="button" id="probe-gemini-tts" disabled>
        Test speech generation
      </button>
      <h3>DeepSeek reasoning</h3>
      <p>
        DeepSeek reasoning is separate from generic OpenAI chat. A future
        adapter must send thinking.type and reasoning_effort, and it must read
        reasoning_content separately from the answer. Nothing is sent now.
      </p>
      <label htmlFor="deepseekThinking">thinking.type</label>
      <select
        id="deepseekThinking"
        value={props.thinking}
        onChange={(event) =>
          props.onThinking(
            event.target.value === "disabled" ? "disabled" : "enabled",
          )
        }
      >
        <option value="enabled">enabled</option>
        <option value="disabled">disabled</option>
      </select>
      <label htmlFor="deepseekEffort">reasoning_effort</label>
      <select
        id="deepseekEffort"
        value={props.effort}
        onChange={(event) => props.onEffort(effortValue(event.target.value))}
      >
        <option value="none">none</option>
        <option value="low">low</option>
        <option value="high">high</option>
        <option value="max">max</option>
      </select>
      <TextField
        id="deepseekModel"
        label="DeepSeek model name"
        hint="Not a secret. Documented names include deepseek-flash and deepseek-v4-pro."
        value={props.deepseekModel}
        error=""
        onChange={props.onDeepseekModel}
      />
      <ProviderBlock
        title="DeepSeek credential"
        secretId="deepseekKey"
        probeId="deepseek"
        label="DeepSeek API key"
        hint="Secret. A subscription does not prove DeepSeek balance or connectivity."
        draft={props.secretDraft}
        errors={props.secretErrors}
        savedSecrets={props.savedSecrets}
        onSecret={props.onSecret}
        onSave={props.onSave}
        onProbe={props.onProbe}
      />
      <h3>Local Ollama</h3>
      <p>
        Local Ollama requires this computer and the Ollama process to be awake.
        The address below is not a connection. There is no automatic cloud
        fallback.
      </p>
      <TextField
        id="ollamaLocalBaseUrl"
        label="Local Ollama address"
        hint="Public setting. Example shape: http://127.0.0.1:11434. Leave it blank until you choose your own address."
        value={props.localBaseUrl}
        error=""
        onChange={props.onLocalBaseUrl}
      />
      <div className="vd-field">
        <label htmlFor="ollamaLocalMockReachable">
          <input
            id="ollamaLocalMockReachable"
            type="checkbox"
            checked={props.localMockReachable}
            onChange={(event) => props.onLocalMock(event.target.checked)}
          />{" "}
          Prototype mock: report the local Ollama process as reachable. This
          does not probe your computer.
        </label>
      </div>
      <button
        type="button"
        id="probe-ollama-local"
        onClick={() => props.onProbe("ollama-local")}
      >
        Test local Ollama in the mock
      </button>
      <h3>Cloud Ollama</h3>
      <p>
        Cloud Ollama needs its own key or sign-in. It is separate from local
        Ollama.
      </p>
      <ProviderBlock
        title="Cloud Ollama credential"
        secretId="ollamaCloudKey"
        probeId="ollama-cloud"
        label="Cloud Ollama key"
        hint="Secret. Saving it does not mark cloud Ollama connected."
        draft={props.secretDraft}
        errors={props.secretErrors}
        savedSecrets={props.savedSecrets}
        onSecret={props.onSecret}
        onSave={props.onSave}
        onProbe={props.onProbe}
      />
      <h3>OpenAI-compatible provider</h3>
      <TextField
        id="openAiBaseUrl"
        label="Base URL"
        hint="Public setting. Enter the provider base URL you control."
        value={props.openAiBaseUrl}
        error=""
        onChange={props.onOpenAiBaseUrl}
      />
      <TextField
        id="openAiModel"
        label="Model name"
        hint="Public setting. Not a secret."
        value={props.openAiModel}
        error=""
        onChange={props.onOpenAiModel}
      />
      <ProviderBlock
        title="OpenAI-compatible credential"
        secretId="openAiCompatibleKey"
        probeId="openai-compatible"
        label="API key"
        hint="Secret. Generic chat is separate from DeepSeek reasoning."
        draft={props.secretDraft}
        errors={props.secretErrors}
        savedSecrets={props.savedSecrets}
        onSecret={props.onSecret}
        onSave={props.onSave}
        onProbe={props.onProbe}
      />
    </div>
  );
}

function ProviderBlock(props: {
  title: string;
  secretId: SecretId;
  probeId: ProbeId;
  label: string;
  hint: string;
  draft: Record<SecretId, string>;
  errors: FieldErrors;
  savedSecrets: SecretId[];
  onSecret: (field: SecretId, value: string) => void;
  onSave: (id: SecretId) => void;
  onProbe: (id: ProbeId) => void;
}) {
  return (
    <form
      className="vd-secret"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSave(props.secretId);
      }}
    >
      <h3>{props.title}</h3>
      <TextField
        id={props.secretId}
        label={props.label}
        hint={props.hint}
        type="password"
        value={props.draft[props.secretId]}
        error={props.errors[props.secretId] ?? ""}
        onChange={(value) => props.onSecret(props.secretId, value)}
      />
      <p
        id={`secret-status-${props.secretId}`}
        data-status={statusFor(props.savedSecrets, props.secretId)}
      >
        {props.label}: {masked(props.savedSecrets, props.secretId)}
      </p>
      <button type="submit" id={`save-${props.secretId}`}>
        Save in the prototype mock
      </button>
      <button
        type="button"
        id={`probe-${props.probeId}`}
        onClick={() => props.onProbe(props.probeId)}
      >
        Test in the prototype mock
      </button>
    </form>
  );
}

function ChannelsPanel() {
  return (
    <div>
      <p>
        Channel cards show customer-owned app authorization. Nothing is
        connected until that authorization exists on the server.
      </p>
      <ul className="vd-cards">
        <li data-channel="telegram" data-status="not-connected">
          <h3>Telegram</h3>
          <p>Status: not connected.</p>
          <p>Customer-owned Telegram bot authorization is not configured.</p>
          <button type="button" disabled>
            Configure on the server (not available)
          </button>
        </li>
        <li data-channel="x" data-status="not-connected">
          <h3>X</h3>
          <p>Status: not connected.</p>
          <p>Customer-owned X app authorization is not configured.</p>
          <button type="button" disabled>
            Configure on the server (not available)
          </button>
        </li>
      </ul>
    </div>
  );
}

function StoragePanel(props: {
  phase: DrivePhase;
  onConnect: () => void;
  onFail: () => void;
  onAskDisconnect: () => void;
}) {
  const message =
    props.phase === "pending"
      ? DRIVE_PENDING
      : props.phase === "authorized-mock"
        ? DRIVE_AUTHORIZED
        : props.phase === "error"
          ? DRIVE_ERROR
          : DRIVE_NOT_AUTHORIZED;
  return (
    <div>
      <p>
        Google Drive authorization is separate from Valhalla sign-in. This
        prototype does not reuse sign-in or Gmail scopes. No Google OAuth runs
        here.
      </p>
      <article
        id="drive-panel"
        data-drive-state={props.phase}
        aria-busy={props.phase === "pending"}
      >
        <h3>Google Drive</h3>
        <p role={props.phase === "error" ? "alert" : "status"}>{message}</p>
        <button type="button" id="drive-connect" onClick={props.onConnect}>
          Connect with the prototype mock
        </button>
        <button type="button" id="drive-fail" onClick={props.onFail}>
          Simulate a mock authorization error
        </button>
        <button
          type="button"
          id="drive-disconnect"
          disabled={props.phase !== "authorized-mock"}
          onClick={props.onAskDisconnect}
        >
          Disconnect
        </button>
      </article>
      <h3>Other storage</h3>
      <p data-status="unsupported">
        OneDrive and Dropbox are not available in this prototype. They are not
        connected.
      </p>
    </div>
  );
}

function ServicesPanel(props: {
  selected: ServiceId[];
  run: Record<ServiceId, ServiceRun>;
  message: string;
  onToggle: (id: ServiceId) => void;
  onStart: () => void;
  onStop: () => void;
}) {
  const noneSelected = props.selected.length === 0;
  return (
    <div>
      <p>{RENDER_NOTE}</p>
      {noneSelected ? <p>No service is selected.</p> : null}
      <ul className="vd-services">
        {SERVICE_IDS.map((id) => (
          <li key={id} data-service={id} data-run={props.run[id]}>
            <label htmlFor={`service-${id}`}>
              <input
                id={`service-${id}`}
                type="checkbox"
                checked={props.selected.includes(id)}
                onChange={() => props.onToggle(id)}
              />{" "}
              {SERVICE_COPY[id].name}
            </label>
            <p>{SERVICE_COPY[id].detail}</p>
            <p>
              State:{" "}
              {props.run[id] === "mock-start-recorded"
                ? "Start recorded in the prototype mock"
                : "Stopped"}
            </p>
          </li>
        ))}
      </ul>
      <p
        role={props.message === "Select a service first." ? "alert" : "status"}
      >
        {props.message}
      </p>
      <button type="button" id="services-start" onClick={props.onStart}>
        Start selected
      </button>
      <button type="button" id="services-stop" onClick={props.onStop}>
        Stop selected
      </button>
    </div>
  );
}

function AppsPanel(props: {
  installed: AppId[];
  onInstall: (id: AppId) => void;
  onRevoke: (id: AppId) => void;
}) {
  return (
    <div>
      {props.installed.length === 0 ? (
        <p id="apps-empty">No app is installed yet.</p>
      ) : null}
      <ul className="vd-apps">
        {APP_IDS.map((id) => {
          const app = APP_COPY[id];
          const isInstalled = props.installed.includes(id);
          return (
            <li
              key={id}
              data-app={id}
              data-installed={isInstalled ? "yes" : "no"}
            >
              <h3>
                {app.name}
                {app.preview ? <span className="vd-badge">Preview</span> : null}
              </h3>
              <p>{app.summary}</p>
              <p>
                {isInstalled
                  ? "Installed in the prototype catalog."
                  : "Not installed."}
              </p>
              {id === "motoko" ? (
                <p id="motoko-bounds">
                  Preview. Experimental only. Least privilege. No canister
                  deploy, no extra tools, and no budget is granted. Unsupported
                  actions stay blocked.
                </p>
              ) : null}
              <button
                type="button"
                id={`app-install-${id}`}
                disabled={isInstalled}
                onClick={() => props.onInstall(id)}
              >
                Install
              </button>
              <button
                type="button"
                id={`app-revoke-${id}`}
                disabled={!isInstalled}
                onClick={() => props.onRevoke(id)}
              >
                Revoke
              </button>
            </li>
          );
        })}
      </ul>
      <section id="paper-trading" aria-label="Paper trading">
        <h3>Paper trading</h3>
        <p id="paper-warning">
          Demo only. These results are simulated. Live trading can lose real
          money. This desk does not take a wallet key, send an order, or offer
          withdraw.
        </p>
        <p>Paper balance: not loaded. No exchange was contacted.</p>
      </section>
      <section id="desk-terms" aria-label="Terms and idle compute">
        <h3>Terms</h3>
        <p>
          These terms do not remove liability. Sign-in uses the smallest
          identity the existing service already asks for. Drive and Gmail
          access are not part of sign-in.
        </p>
        <p id="idle-compute">
          Optional idle compute is off. It would run only non-sensitive work
          you opt into. It does not sell privacy, read secrets, or start a paid
          background call.
        </p>
        <label htmlFor="idle-opt-in">
          <input id="idle-opt-in" type="checkbox" /> Opt in to non-sensitive
          idle compute
        </label>
      </section>
    </div>
  );
}

function TextField(props: {
  id: string;
  label: string;
  hint: string;
  value: string;
  error: string;
  onChange: (value: string) => void;
  type?: string;
}) {
  const errorId = `${props.id}-error`;
  const hintId = `${props.id}-hint`;
  return (
    <div className="vd-field">
      <label htmlFor={props.id}>{props.label}</label>
      <p id={hintId} className="vd-hint">
        {props.hint}
      </p>
      <input
        id={props.id}
        name={props.id}
        type={props.type ?? "text"}
        value={props.value}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={Boolean(props.error)}
        aria-describedby={props.error ? `${hintId} ${errorId}` : hintId}
        onChange={(event: ChangeEvent<HTMLInputElement>) =>
          props.onChange(event.target.value)
        }
      />
      {props.error ? (
        <p id={errorId} role="alert" className="vd-error">
          {props.error}
        </p>
      ) : null}
    </div>
  );
}

function emptyProbes(): Record<ProbeId, ProbeResult | null> {
  return {
    "gemini-chat": null,
    deepseek: null,
    "ollama-local": null,
    "ollama-cloud": null,
    "openai-compatible": null,
  };
}

function stoppedServices(): Record<ServiceId, ServiceRun> {
  return {
    supabase: "stopped",
    upstash: "stopped",
    odin: "stopped",
    thalos: "stopped",
  };
}

function statusFor(saved: SecretId[], id: SecretId): "saved-mock" | "missing" {
  return saved.includes(id) ? "saved-mock" : "missing";
}

function masked(saved: SecretId[], id: SecretId): string {
  return saved.includes(id)
    ? "saved in the prototype mock (hidden)"
    : "not saved";
}

function keySaved(id: ProbeId, saved: SecretId[]): boolean {
  switch (id) {
    case "gemini-chat":
      return saved.includes("geminiChatKey");
    case "deepseek":
      return saved.includes("deepseekKey");
    case "ollama-cloud":
      return saved.includes("ollamaCloudKey");
    case "openai-compatible":
      return saved.includes("openAiCompatibleKey");
    case "ollama-local":
      return false;
    default: {
      const neverId: never = id;
      return neverId;
    }
  }
}

function probeForSecret(id: SecretId): ProbeId | null {
  switch (id) {
    case "geminiChatKey":
      return "gemini-chat";
    case "deepseekKey":
      return "deepseek";
    case "ollamaCloudKey":
      return "ollama-cloud";
    case "openAiCompatibleKey":
      return "openai-compatible";
    case "supabasePassword":
    case "upstashToken":
      return null;
    default: {
      const neverId: never = id;
      return neverId;
    }
  }
}

function effortValue(value: string): ReasoningEffort {
  if (
    value === "none" ||
    value === "low" ||
    value === "high" ||
    value === "max"
  ) {
    return value;
  }
  return "high";
}
