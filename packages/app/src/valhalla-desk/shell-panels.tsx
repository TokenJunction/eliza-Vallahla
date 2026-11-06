import { useRef, useState } from "react";
import {
  type BrowserTab,
  createTab,
  currentUrl,
  embedPolicy,
  goBack,
  goForward,
  loadBookmarkPreference,
  navigateTab,
  sameOriginTabUrl,
  saveBookmarkPreference,
  validatePublicUrl,
} from "./browser-nav.ts";
import { checkElizaHealth } from "./eliza-service.ts";
import { filterSensitiveText, PRIVACY_LIMIT } from "./privarun.ts";
import type { TaskClient, TaskSource, TaskStreamEvent } from "./task-client.ts";
import { THEME_IDS, THEMES, type ThemeId } from "./theme.ts";
import {
  BROWSER_TTS_LABEL,
  BrowserCapabilityError,
  type RecognitionHost,
  readSpeechRecognition,
  readSpeechSynthesis,
  type SynthesisHost,
  spokenIdempotencyKey,
} from "./voice-capability.ts";
import { readPublicEndpoint } from "./web4.ts";

export async function collectTask(
  client: TaskClient,
  input: { text: string; source: TaskSource; idempotencyKey: string },
): Promise<string[]> {
  const lines: string[] = [];
  try {
    for await (const event of client.submit(input)) {
      lines.push(eventLine(event));
    }
  } catch (error) {
    lines.push(error instanceof Error ? error.message : "The task failed.");
  }
  return lines;
}

function eventLine(event: TaskStreamEvent): string {
  if (event.kind === "delta") return event.text;
  if (event.kind === "done") return "The task stream ended.";
  return event.message;
}

export function CommandBar(props: { client: TaskClient; focusedApp: string }) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(true);
  const [allowContext, setAllowContext] = useState(false);
  const [micConsent, setMicConsent] = useState(false);
  const [listening, setListening] = useState(false);
  const [log, setLog] = useState(
    "No command has been sent. A model answer is not shown until a task service streams one.",
  );
  const nonce = useRef(0);
  const sending = useRef(false);
  const session = useRef<{ stop: () => void } | null>(null);

  async function send(source: TaskSource, command: string, key: string) {
    if (sending.current) return;
    sending.current = true;
    const body = allowContext
      ? `${command}\nFocused app: ${props.focusedApp}`
      : command;
    try {
      const lines = await collectTask(props.client, {
        text: body,
        source,
        idempotencyKey: key,
      });
      setLog(lines.join(" "));
    } finally {
      sending.current = false;
    }
  }

  async function onSubmit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const command = text.trim();
    if (!command) {
      setLog("Enter a command. Nothing was sent.");
      return;
    }
    nonce.current += 1;
    await send(
      "typed",
      command,
      `${props.client.conversationId}:typed:${String(nonce.current)}`,
    );
  }

  function startMic() {
    if (!micConsent) {
      setLog("Microphone stays off until you allow it for this task.");
      return;
    }
    try {
      const Ctor = readSpeechRecognition(window as RecognitionHost);
      const recognition = new Ctor();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        const result = event.results[event.resultIndex];
        if (!result?.isFinal) return;
        const transcript = result[0]?.transcript?.trim() ?? "";
        if (!transcript) return;
        void send(
          "spoken",
          transcript,
          spokenIdempotencyKey(
            props.client.conversationId,
            event.resultIndex,
            transcript,
          ),
        );
      };
      recognition.onerror = () => {
        setListening(false);
        setLog("Microphone error. No transcript was invented.");
      };
      recognition.onend = () => setListening(false);
      recognition.start();
      session.current = recognition;
      setListening(true);
      setLog("Microphone is on for this task. It is not always listening.");
    } catch (error) {
      setListening(false);
      setLog(
        error instanceof Error ? error.message : "Microphone is unavailable.",
      );
    }
  }

  function stopMic() {
    session.current?.stop();
    session.current = null;
    setListening(false);
    setLog("Microphone is off.");
  }

  return (
    <form
      id="command-form"
      className={open ? "agent-bar" : "agent-bar agent-bar-collapsed"}
      onSubmit={(event) => void onSubmit(event)}
    >
      <button
        type="button"
        id="agent-collapse"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? "Collapse agent bar" : "Agent bar"}
      </button>
      {open ? (
        <>
          <p id="agent-context">
            Focused app: {props.focusedApp}. Context is not attached until you
            allow it for this task. Files and wallets are not read.
          </p>
          <label htmlFor="agent-context-permit">
            <input
              id="agent-context-permit"
              type="checkbox"
              checked={allowContext}
              onChange={(event) => setAllowContext(event.target.checked)}
            />{" "}
            Allow this task to include the focused app name
          </label>
          <label htmlFor="command-input">Agent bar</label>
          <input
            id="command-input"
            value={text}
            autoComplete="off"
            onChange={(event) => setText(event.target.value)}
          />
          <button type="submit" id="command-send">
            Send
          </button>
          <label htmlFor="agent-mic-consent">
            <input
              id="agent-mic-consent"
              type="checkbox"
              checked={micConsent}
              onChange={(event) => setMicConsent(event.target.checked)}
            />{" "}
            Allow the browser microphone for this task
          </label>
          <button
            type="button"
            id="agent-mic-start"
            onClick={startMic}
            disabled={listening}
          >
            Start microphone
          </button>
          <button
            type="button"
            id="agent-mic-stop"
            onClick={stopMic}
            disabled={!listening}
          >
            Stop microphone
          </button>
        </>
      ) : null}
      <p id="command-log" role="status">
        {log}
      </p>
    </form>
  );
}

export function VoicePanel(props: {
  client: TaskClient;
  recognitionHost?: RecognitionHost;
  synthesisHost?: SynthesisHost;
}) {
  const recognitionHost: RecognitionHost =
    props.recognitionHost ?? (window as RecognitionHost);
  const synthesisHost: SynthesisHost =
    props.synthesisHost ?? (window as SynthesisHost);
  const session = useRef<{ stop: () => void } | null>(null);
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("Microphone is off.");
  const [log, setLog] = useState("");

  function startMic() {
    try {
      const Ctor = readSpeechRecognition(recognitionHost);
      const recognition = new Ctor();
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.lang = "en-US";
      recognition.onresult = (event) => {
        const result = event.results[event.resultIndex];
        if (!result?.isFinal) return;
        const transcript = result[0]?.transcript?.trim() ?? "";
        if (!transcript) {
          setStatus(
            "The browser sent an empty final transcript. Nothing was sent.",
          );
          return;
        }
        const key = spokenIdempotencyKey(
          props.client.conversationId,
          event.resultIndex,
          transcript,
        );
        void collectTask(props.client, {
          text: transcript,
          source: "spoken",
          idempotencyKey: key,
        }).then((lines) => {
          setLog(lines.join(" "));
        });
      };
      recognition.onerror = (event) => {
        setListening(false);
        setStatus(
          `Microphone error: ${event.error}. No transcript was invented.`,
        );
      };
      recognition.onend = () => {
        setListening(false);
      };
      recognition.start();
      session.current = recognition;
      setListening(true);
      setStatus(
        "Microphone is on. Recognition uses this browser. Stop ends it.",
      );
    } catch (error) {
      setListening(false);
      setStatus(
        error instanceof Error ? error.message : "Microphone is unavailable.",
      );
    }
  }

  function stopMic() {
    try {
      session.current?.stop();
    } catch (error) {
      setStatus(
        error instanceof Error ? error.message : "Microphone stop failed.",
      );
    }
    session.current = null;
    setListening(false);
    setStatus("Microphone is off.");
  }

  function speakStatus() {
    try {
      const synth = readSpeechSynthesis(synthesisHost);
      synth.cancel();
      synth.speak(new synth.Utterance(BROWSER_TTS_LABEL));
      setStatus(BROWSER_TTS_LABEL);
    } catch (error) {
      if (error instanceof BrowserCapabilityError) {
        setStatus(error.message);
        return;
      }
      setStatus(
        error instanceof Error
          ? error.message
          : "Browser speech is unavailable.",
      );
    }
  }

  return (
    <div>
      <p>{BROWSER_TTS_LABEL}</p>
      <p id="voice-status" role="status">
        {status}
      </p>
      <button
        type="button"
        id="mic-start"
        onClick={startMic}
        disabled={listening}
      >
        Start microphone
      </button>
      <button
        type="button"
        id="mic-stop"
        onClick={stopMic}
        disabled={!listening}
      >
        Stop microphone
      </button>
      <button type="button" id="browser-speak" onClick={speakStatus}>
        Speak status with browser speech
      </button>
      <p id="voice-log">{log}</p>
    </div>
  );
}

export function BrowserPanel() {
  const [draft, setDraft] = useState("");
  const [message, setMessage] = useState(
    "Enter an http or https address. Nothing is loaded yet.",
  );
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [active, setActive] = useState(0);
  const [bookmarks, setBookmarks] = useState<string[]>(() => {
    try {
      return loadBookmarkPreference(window.sessionStorage);
    } catch {
      return [];
    }
  });
  const [reloads, setReloads] = useState(0);
  const tab = tabs[active];
  const url = tab ? currentUrl(tab) : "";
  const embed = url
    ? embedPolicy(url, window.location.origin)
    : { allowed: false, reason: "No address is selected." };

  function showError(text: string) {
    setMessage(text);
  }

  function go() {
    const parsed = validatePublicUrl(draft);
    if (!parsed.ok) {
      showError(parsed.message);
      return;
    }
    setTabs((current) => {
      if (current.length === 0) return [createTab("tab-1", parsed.url)];
      return current.map((item, index) =>
        index === active ? navigateTab(item, parsed.url) : item,
      );
    });
    setMessage("Address accepted. The desk did not proxy this site.");
  }

  return (
    <div>
      <p id="extension-note">
        This web page cannot load Chrome extensions. Extension loading belongs
        to a signed Chromium or Electron shell with approved unpacked
        permissions. This web view is not that shell, and no extension was
        loaded.
      </p>
      <label htmlFor="browser-url">Address</label>
      <input
        id="browser-url"
        value={draft}
        autoComplete="off"
        onChange={(event) => setDraft(event.target.value)}
      />
      <button type="button" id="browser-go" onClick={go}>
        Open
      </button>
      <button
        type="button"
        id="browser-back"
        disabled={!tab || tab.index <= 0}
        onClick={() =>
          setTabs((current) =>
            current.map((item, index) =>
              index === active ? goBack(item) : item,
            ),
          )
        }
      >
        Back
      </button>
      <button
        type="button"
        id="browser-forward"
        disabled={!tab || tab.index >= tab.history.length - 1}
        onClick={() =>
          setTabs((current) =>
            current.map((item, index) =>
              index === active ? goForward(item) : item,
            ),
          )
        }
      >
        Forward
      </button>
      <button
        type="button"
        id="browser-reload"
        disabled={!url}
        onClick={() => {
          setReloads((count) => count + 1);
          setMessage(
            "Reloaded this address in the desk list. The site was not fetched through a proxy.",
          );
        }}
      >
        Reload
      </button>
      <button
        type="button"
        id="browser-new-tab"
        onClick={() => {
          const parsed = sameOriginTabUrl(draft, window.location.origin);
          if (!parsed.ok) {
            showError(parsed.message);
            return;
          }
          setTabs((current) => [
            ...current,
            createTab(`tab-${String(current.length + 1)}`, parsed.url),
          ]);
          setActive(tabs.length);
          setMessage("Opened a same-origin desk tab. No extension was loaded.");
        }}
      >
        New tab
      </button>
      <button
        type="button"
        id="browser-bookmark"
        disabled={!url}
        onClick={() => {
          if (!url) return;
          const next = bookmarks.includes(url)
            ? bookmarks
            : [...bookmarks, url];
          setBookmarks(next);
          try {
            saveBookmarkPreference(next, window.sessionStorage);
            setMessage("Bookmark saved in this browser session only.");
          } catch {
            setMessage(
              "Bookmark kept on this page. This browser refused session storage.",
            );
          }
        }}
      >
        Bookmark
      </button>
      <p id="browser-message" role="status">
        {message}
      </p>
      <p id="browser-embed-reason">{embed.reason}</p>
      <p id="browser-reload-count">{String(reloads)}</p>
      <ul id="browser-tabs">
        {tabs.map((item, index) => (
          <li key={item.id}>
            <button type="button" onClick={() => setActive(index)}>
              {item.id}: {currentUrl(item)}
            </button>
          </li>
        ))}
      </ul>
      {url ? (
        <a
          id="browser-external"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open outside
        </a>
      ) : null}
      {embed.allowed ? (
        <iframe title="Same-origin desk page" src={url} sandbox="" />
      ) : null}
    </div>
  );
}

export function OptionalServices() {
  const [elizaUrl, setElizaUrl] = useState("");
  const [eliza, setEliza] = useState(
    "ElizaOS is optional and has not been checked. Not connected.",
  );
  const [webUrl, setWebUrl] = useState("");
  const [web, setWeb] = useState("No public read has been requested.");

  return (
    <details id="optional-services">
      <summary>Optional services</summary>
      <label htmlFor="eliza-base">ElizaOS base address</label>
      <input
        id="eliza-base"
        value={elizaUrl}
        autoComplete="off"
        onChange={(event) => setElizaUrl(event.target.value)}
      />
      <button
        type="button"
        id="eliza-check"
        onClick={() => {
          void checkElizaHealth(elizaUrl).then((result) =>
            setEliza(result.detail),
          );
        }}
      >
        Check ElizaOS health
      </button>
      <p id="eliza-status">{eliza}</p>
      <label htmlFor="web4-url">Public https address</label>
      <input
        id="web4-url"
        value={webUrl}
        autoComplete="off"
        onChange={(event) => setWebUrl(event.target.value)}
      />
      <button
        type="button"
        id="web4-read"
        onClick={() => {
          void readPublicEndpoint(webUrl).then((result) =>
            setWeb(result.detail),
          );
        }}
      >
        Read public endpoint
      </button>
      <p id="web4-status">{web}</p>
    </details>
  );
}

export function ThemeSelect(props: {
  themeId: ThemeId;
  onChange: (id: ThemeId) => void;
}) {
  return (
    <label className="vd-theme" htmlFor="desk-theme">
      Atmosphere
      <select
        id="desk-theme"
        value={props.themeId}
        onChange={(event) => {
          const value = event.target.value;
          if (value === "navy" || value === "light" || value === "colorblind") {
            props.onChange(value);
          }
        }}
      >
        {THEME_IDS.map((id) => (
          <option key={id} value={id}>
            {THEMES[id].label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ExtraWindow(props: { id: string }) {
  if (props.id === "privarun") return <PrivaRunPanel />;
  if (props.id === "vault") {
    return (
      <p id="vault-note">
        No balance is loaded. This view does not hold a wallet, export a secret,
        or move funds.
      </p>
    );
  }
  if (props.id === "studio") {
    return (
      <div>
        <p>
          Local scratchpad. The text stays in this box. It is not run and it is
          not sent.
        </p>
        <label htmlFor="studio-scratch">Scratchpad</label>
        <textarea id="studio-scratch" />
      </div>
    );
  }
  if (props.id === "forge") {
    return (
      <p id="forge-note">
        HeuristicForge is closed. An authenticated admin session is required.
        This page cannot grant admin.
      </p>
    );
  }
  return null;
}

function PrivaRunPanel() {
  const [text, setText] = useState("");
  const [output, setOutput] = useState("");
  return (
    <div>
      <p>{PRIVACY_LIMIT}</p>
      <label htmlFor="privarun-input">Local text</label>
      <textarea
        id="privarun-input"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        type="button"
        id="privarun-filter"
        onClick={() => setOutput(filterSensitiveText(text).output)}
      >
        Filter on this page
      </button>
      <p id="privarun-output">{output}</p>
    </div>
  );
}
