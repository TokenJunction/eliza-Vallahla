import type { IAgentRuntime } from '@elizaos/core';
import type { ValhallaRoleId } from './character.ts';

const runtimes = new Map<ValhallaRoleId, IAgentRuntime>();

export function registerRuntime(roleId: ValhallaRoleId, runtime: IAgentRuntime): void {
  runtimes.set(roleId, runtime);
}

export function getRuntime(roleId: ValhallaRoleId): IAgentRuntime | null {
  return runtimes.get(roleId) ?? null;
}

export function registeredRoles(): ValhallaRoleId[] {
  return [...runtimes.keys()];
}
