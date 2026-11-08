import { describe, expect, test } from "bun:test";
import { AutonomousSystemOverseer, OverseerNotReadyError } from "./autonomousOverseer.ts";
import { CrossSpeechEngine, CrossSpeechNotReadyError } from "./crossSpeechEngine.ts";

describe("unconfigured autonomous services", () => {
  test("registered peers do not produce a fabricated health report or repair", async () => {
    const engine = new CrossSpeechEngine();
    expect(engine.getPeers()).toHaveLength(3);
    for (const intent of ["NETWORK_HEALTH", "REPAIR_DISPATCH", "MARKET_GROUNDING"] as const) {
      await expect(engine.executeA2ACrossSpeech(intent, "unprobed host")).rejects.toBeInstanceOf(CrossSpeechNotReadyError);
    }
    expect(engine.getRecentA2ALogs()).toEqual([]);
  });

  test("the overseer cannot start, including when repair is requested", () => {
    const overseer = new AutonomousSystemOverseer({ autoHealEnabled: true });
    expect(() => overseer.startAutonomousLoop()).toThrow(OverseerNotReadyError);
    overseer.stopAutonomousLoop();
    expect(() => overseer.startAutonomousLoop()).toThrow(OverseerNotReadyError);
  });
});
