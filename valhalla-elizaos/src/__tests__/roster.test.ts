import { describe, expect, it } from 'bun:test';
import project from '../index.ts';
import {
  characters,
  characterRoster,
  resolveCharacterId,
  VALHALLA_ROLE_IDS,
} from '../character.ts';

const REQUIRED_ROLES = [
  'conductor',
  'zeus',
  'odin',
  'wren',
  'valkyrie',
  'sentinel',
  'forge',
  'gorgo',
  'cerberus',
  'ahti',
  'hermod',
  'norns',
  'gwen',
  'merlin',
];

describe('Valhalla role roster', () => {
  it('contains every roster role exactly once', () => {
    expect([...VALHALLA_ROLE_IDS]).toEqual(REQUIRED_ROLES);
    expect(characterRoster).toHaveLength(REQUIRED_ROLES.length);
    expect(new Set(characterRoster.map((entry) => entry.id)).size).toBe(REQUIRED_ROLES.length);
  });

  it('registers all fourteen characters as project agents', () => {
    expect(project.agents).toHaveLength(REQUIRED_ROLES.length);
    expect(project.agents.map((agent) => agent.character.username)).toEqual(REQUIRED_ROLES);
  });

  it('gives every role unique agent identity and required character fields', () => {
    const names = new Set<string>();
    const usernames = new Set<string>();

    for (const role of REQUIRED_ROLES) {
      const character = characters[role as keyof typeof characters];
      expect(character).toBeDefined();
      expect(character.name.length).toBeGreaterThan(0);
      expect(character.system?.length).toBeGreaterThan(100);
      expect(character.bio.length).toBeGreaterThan(1);
      expect(character.topics?.length).toBeGreaterThan(2);
      expect(character.messageExamples?.length).toBeGreaterThan(1);
      expect(character.plugins).toContain('@elizaos/plugin-sql');
      expect(character.plugins).toContain('@elizaos/plugin-bootstrap');
      expect(new Set(character.plugins).size).toBe(character.plugins?.length);
      expect(character.settings?.EMBEDDING_DIMENSION).toBe(3072);
      names.add(character.name);
      usernames.add(character.username ?? '');
    }

    expect(names.size).toBe(REQUIRED_ROLES.length);
    expect(usernames.size).toBe(REQUIRED_ROLES.length);
  });

  it('keeps every role in the paper-mode safety boundary', () => {
    for (const role of REQUIRED_ROLES) {
      const character = characters[role as keyof typeof characters];
      expect(character.system).toMatch(/paper mode/i);
      expect(character.system).toMatch(/cannot|disabled|denied/i);
      expect(character.system).not.toMatch(/you may execute trades/i);
    }
  });

  it('routes common OS requests to the relevant specialist', () => {
    expect(resolveCharacterId('Check GPU VRAM and relay telemetry')).toBe('gorgo');
    expect(resolveCharacterId('Review this pull request against OpenSSF')).toBe('sentinel');
    expect(resolveCharacterId('Withdraw my funds now')).toBe('cerberus');
    expect(resolveCharacterId('Prepare the release pre-flight checklist')).toBe('hermod');
    expect(resolveCharacterId('Help me with onboarding and my API key')).toBe('merlin');
    expect(resolveCharacterId('Summarize the standup')).toBe('gwen');
    expect(resolveCharacterId('Hello, what can you do?')).toBe('conductor');
  });
});
