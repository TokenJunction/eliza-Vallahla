export interface AgentPeer {
  id: string;
  name: string;
  role: "coordinator" | "repair_engineer" | "market_analyst" | "edge_monitor";
  provider: "perplexity" | "gemini" | "local_llama";
}

export interface InterAgentMessage {
  from: string;
  to: string;
  intent: "NETWORK_HEALTH" | "REPAIR_DISPATCH" | "TELEMETRY_SYNC" | "MARKET_GROUNDING";
  content: string;
  timestamp: string;
  signature?: string;
}

export interface NetworkHealthReport {
  status: "OPTIMAL" | "DEGRADED" | "CRITICAL";
  activePeers: number;
  lastRepairedAt: string;
  insights: string[];
}

export class CrossSpeechNotReadyError extends Error {
  readonly code = "CROSS_SPEECH_NOT_READY";

  constructor() {
    super("Cross-agent work requires authorized runtime adapters and budget controls.");
    this.name = "CrossSpeechNotReadyError";
  }
}

export class CrossSpeechEngine {
  private peers = new Map<string, AgentPeer>();

  constructor() {
    this.registerDefaultPeers();
  }

  private registerDefaultPeers() {
    this.registerPeer({
      id: "agent-zeus",
      name: "Zeus Coordinator",
      role: "coordinator",
      provider: "gemini",
    });
    this.registerPeer({
      id: "agent-gorgo",
      name: "Gorgo Network Repair",
      role: "repair_engineer",
      provider: "local_llama",
    });
    this.registerPeer({
      id: "agent-hermes",
      name: "Hermes Web Grounding",
      role: "market_analyst",
      provider: "perplexity",
    });
  }

  registerPeer(peer: AgentPeer): void {
    this.peers.set(peer.id, peer);
  }

  getPeers(): AgentPeer[] {
    return Array.from(this.peers.values());
  }

  async executeA2ACrossSpeech(_intent: InterAgentMessage["intent"], _diagnosticContext: string): Promise<InterAgentMessage[]> {
    throw new CrossSpeechNotReadyError();
  }

  getRecentA2ALogs(_limit = 10): InterAgentMessage[] {
    return [];
  }
}
