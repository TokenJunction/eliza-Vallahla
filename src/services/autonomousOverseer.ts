export interface OverseerConfig {
  checkIntervalMs?: number;
  autoHealEnabled?: boolean;
}

export class OverseerNotReadyError extends Error {
  readonly code = "OVERSEER_NOT_READY";

  constructor() {
    super("The overseer requires authorized runtime scheduling, measured health and verified recovery integration.");
    this.name = "OverseerNotReadyError";
  }
}

export class AutonomousSystemOverseer {
  constructor(_config: OverseerConfig = {}) {}

  startAutonomousLoop(): void {
    throw new OverseerNotReadyError();
  }

  stopAutonomousLoop(): void {}
}
