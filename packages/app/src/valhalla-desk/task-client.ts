export type TaskSource = "typed" | "spoken";

export type TaskRequest = {
  conversationId: string;
  idempotencyKey: string;
  text: string;
  source: TaskSource;
};

export type TaskStreamEvent =
  | { kind: "status"; message: string }
  | { kind: "delta"; text: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

export type TaskTransport = (
  request: TaskRequest,
) => AsyncIterable<TaskStreamEvent>;

export class DuplicateTaskError extends Error {
  constructor() {
    super(
      "This command was already sent. The task service was not called again.",
    );
    this.name = "DuplicateTaskError";
  }
}

export function createConversationId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== "function") {
    throw new Error("This browser cannot create a conversation id.");
  }
  return randomUUID.call(globalThis.crypto);
}

export class TaskClient {
  readonly conversationId: string;
  readonly #seen = new Set<string>();
  readonly #transport: TaskTransport;
  #calls = 0;

  constructor(transport: TaskTransport, conversationId: string) {
    this.#transport = transport;
    this.conversationId = conversationId;
  }

  get callCount(): number {
    return this.#calls;
  }

  async *submit(input: {
    text: string;
    source: TaskSource;
    idempotencyKey: string;
  }): AsyncGenerator<TaskStreamEvent> {
    if (this.#seen.has(input.idempotencyKey)) {
      throw new DuplicateTaskError();
    }
    this.#seen.add(input.idempotencyKey);
    this.#calls += 1;
    yield* this.#transport({
      conversationId: this.conversationId,
      idempotencyKey: input.idempotencyKey,
      text: input.text,
      source: input.source,
    });
  }
}

export function unavailableTaskTransport(): TaskTransport {
  return async function* unavailable() {
    yield {
      kind: "error",
      message:
        "The task service is unavailable. No model was called and no answer was invented.",
    };
  };
}
