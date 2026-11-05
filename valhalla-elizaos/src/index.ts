import { logger, type IAgentRuntime, type Project, type ProjectAgent } from '@elizaos/core';
import { character, gorgoCharacter, cerberusCharacter } from './character.ts';
import { cerberusPlugin } from './cerberus.ts';
import { valhallaStatusPlugin } from './plugin.ts';

const initializeAgent = (name: string) => async (runtime: IAgentRuntime) => {
  logger.info({ agent: name, agentId: runtime.agentId }, 'Valhalla read-only agent initialized');
};

const zeusAgent: ProjectAgent = {
  character,
  init: initializeAgent(character.name),
  plugins: [valhallaStatusPlugin],
};

const gorgoAgent: ProjectAgent = {
  character: gorgoCharacter,
  init: initializeAgent(gorgoCharacter.name),
};

const cerberusAgent: ProjectAgent = {
  character: cerberusCharacter,
  init: initializeAgent(cerberusCharacter.name),
  plugins: [cerberusPlugin],
};

const project: Project = {
  agents: [zeusAgent, gorgoAgent, cerberusAgent],
};

export { character, gorgoCharacter, cerberusCharacter } from './character.ts';

export default project;
