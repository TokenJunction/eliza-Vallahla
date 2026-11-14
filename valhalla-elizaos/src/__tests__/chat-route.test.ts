import { afterEach, describe, expect, it } from 'bun:test';
import type { IAgentRuntime, RouteResponse } from '@elizaos/core';
import { registerRuntime } from '../runtime-registry.ts';
import valhallaStatusPlugin from '../plugin.ts';

function responseHarness() {
  let statusCode = 0;
  let body: unknown;
  const response: RouteResponse = {
    setHeader() {
      return this;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(data) {
      body = data;
      return this;
    },
    send(data) {
      body = data;
      return this;
    },
    end() {
      return this;
    },
  };
  return { response, result: () => ({ statusCode, body }) };
}

function fakeRuntime(reply: string): IAgentRuntime {
  return {
    agentId: '11111111-1111-4111-8111-111111111111',
    character: { name: 'Zeus' },
    logger: { error() {}, info() {}, debug() {}, warn() {} },
    getRoom: async () => null,
    ensureConnection: async () => {},
    messageService: {
      handleMessage: async () => ({
        didRespond: true,
        responseContent: { text: reply },
        responseMessages: [],
        state: { values: {}, data: {}, text: '' },
      }),
    },
  } as unknown as IAgentRuntime;
}

afterEach(() => {
  registerRuntime('zeus', fakeRuntime('reset'));
});

describe('Valhalla OS chat route', () => {
  it('is public and posts a real model result back to the OS', async () => {
    registerRuntime('zeus', fakeRuntime('Paper mode is active.'));
    const route = valhallaStatusPlugin.routes?.find(({ name }) => name === 'valhalla-chat');
    expect(route?.public).toBe(true);
    expect(route?.type).toBe('POST');

    const harness = responseHarness();
    await route?.handler?.(
      { body: { text: 'Is paper mode active?', agent: 'zeus', history: [] } },
      harness.response,
      {} as never
    );

    expect(harness.result().statusCode).toBe(200);
    expect(harness.result().body).toMatchObject({
      ok: true,
      reply: 'Paper mode is active.',
      content: 'Paper mode is active.',
      agent: 'zeus',
      provider: 'elizaos',
    });
  });

  it('rejects an empty message', async () => {
    const route = valhallaStatusPlugin.routes?.find(({ name }) => name === 'valhalla-chat');
    const harness = responseHarness();
    await route?.handler?.({ body: { text: '   ' } }, harness.response, {} as never);
    expect(harness.result()).toEqual({ statusCode: 400, body: { ok: false, error: 'text_required' } });
  });

  it('fails closed when the selected agent is not ready', async () => {
    const route = valhallaStatusPlugin.routes?.find(({ name }) => name === 'valhalla-chat');
    const harness = responseHarness();
    await route?.handler?.(
      { body: { text: 'Review this pull request', agent: 'odin' } },
      harness.response,
      {} as never
    );
    expect(harness.result().statusCode).toBe(503);
    expect(harness.result().body).toMatchObject({ ok: false, error: 'agent_not_ready', agent: 'odin' });
  });
});
