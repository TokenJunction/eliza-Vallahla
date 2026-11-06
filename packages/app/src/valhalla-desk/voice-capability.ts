export class BrowserCapabilityError extends Error {
  readonly capability: string;

  constructor(capability: string, message: string) {
    super(message);
    this.name = "BrowserCapabilityError";
    this.capability = capability;
  }
}

export type RecognitionResult = {
  isFinal: boolean;
  0?: { transcript?: string };
};

export type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
};

export type RecognitionSession = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export type RecognitionHost = {
  SpeechRecognition?: new () => RecognitionSession;
  webkitSpeechRecognition?: new () => RecognitionSession;
};

export type SynthesisUtterance = new (text: string) => unknown;

export type SynthesisHost = {
  speechSynthesis?: {
    speak?: (utterance: unknown) => void;
    cancel?: () => void;
  };
  SpeechSynthesisUtterance?: SynthesisUtterance;
};

export const BROWSER_TTS_LABEL =
  "Outgoing speech: browser speech synthesis. This is not model-generated audio. Provider speech is not configured.";

export function readSpeechRecognition(
  host: RecognitionHost,
): new () => RecognitionSession {
  const ctor = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  if (!ctor) {
    throw new BrowserCapabilityError(
      "speech-recognition",
      "Microphone speech recognition is not available in this browser. No transcript was invented.",
    );
  }
  return ctor;
}

export function readSpeechSynthesis(host: SynthesisHost): {
  speak: (utterance: unknown) => void;
  cancel: () => void;
  Utterance: SynthesisUtterance;
} {
  const synth = host.speechSynthesis;
  const Utterance = host.SpeechSynthesisUtterance;
  if (
    !synth ||
    typeof synth.speak !== "function" ||
    typeof synth.cancel !== "function" ||
    !Utterance
  ) {
    throw new BrowserCapabilityError(
      "browser-tts",
      "Browser speech synthesis is not available. No audio was played. This is not model-generated audio.",
    );
  }
  return {
    speak: synth.speak.bind(synth),
    cancel: synth.cancel.bind(synth),
    Utterance,
  };
}

export function spokenIdempotencyKey(
  conversationId: string,
  resultIndex: number,
  transcript: string,
): string {
  return `${conversationId}:spoken:${String(resultIndex)}:${transcript.trim()}`;
}
