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

/** `0` means the server has not assigned a conversation id yet. */
export function createConversationId(): string {
  return "0";
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
      yield {
        kind: "status",
        message:
          "This task is still pending in this page. The browser does not store tenant idempotency. No second call was made.",
      };
      return;
    }
    this.#seen.add(input.idempotencyKey);
    this.#calls += 1;
    let sawResult = false;
    for await (const event of this.#transport({
      conversationId: this.conversationId,
      idempotencyKey: input.idempotencyKey,
      text: input.text,
      source: input.source,
    })) {
      if (event.kind !== "status") sawResult = true;
      yield event;
    }
    if (!sawResult) {
      yield {
        kind: "error",
        message:
          "The task service returned no result. The command is unavailable.",
      };
    }
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
