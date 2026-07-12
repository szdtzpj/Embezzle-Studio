import { describe, expect, it, vi } from 'vitest';

import {
  buildProviderMcpRequest,
  parseProviderMcpArguments,
  providerMcpLimits,
  runOpenAiProviderMcp,
  type ProviderMcpApprovalDecision,
  type ProviderMcpRequestBody,
  type ProviderMcpServerConfig,
} from '../src/services/providerMcp';

const authorization = 'Bearer mcp-secret-that-must-never-leak';

function server(overrides: Partial<ProviderMcpServerConfig> = {}): ProviderMcpServerConfig {
  return {
    serverLabel: 'docs_server',
    serverUrl: 'https://mcp.example.com/rpc',
    allowedTools: ['search_docs', 'read_doc'],
    authorization,
    ...overrides,
  };
}

function initialInput() {
  return [
    {
      role: 'user',
      content: [{ type: 'input_text', text: 'Find the deployment guide.' }],
    },
  ];
}

function usage(input: number, output: number, reasoning = 0, cached = 0) {
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: cached },
    output_tokens_details: { reasoning_tokens: reasoning },
  };
}

function approvalResponse({
  responseNumber,
  approvalNumber,
  toolName = 'search_docs',
  rawArguments = '{"query":"release checklist"}',
  includeList = responseNumber === 1,
  priorApprovalNumber,
}: {
  responseNumber: number;
  approvalNumber: number;
  toolName?: string;
  rawArguments?: string;
  includeList?: boolean;
  priorApprovalNumber?: number;
}) {
  const output: Record<string, unknown>[] = [
    {
      type: 'reasoning',
      id: `reasoning_${responseNumber}`,
      encrypted_content: `encrypted-${responseNumber}`,
      summary: [{ type: 'summary_text', text: `Reasoning ${responseNumber}` }],
    },
  ];
  if (priorApprovalNumber !== undefined) {
    output.push({
      type: 'mcp_call',
      id: `call_${priorApprovalNumber}`,
      approval_request_id: `approval_${priorApprovalNumber}`,
      server_label: 'docs_server',
      name: 'search_docs',
      arguments: `{"query":"round ${priorApprovalNumber}"}`,
      output: `result ${priorApprovalNumber}`,
    });
  }
  if (includeList) {
    output.push({
      type: 'mcp_list_tools',
      id: `list_${responseNumber}`,
      server_label: 'docs_server',
      tools: [{ name: 'search_docs' }, { name: 'read_doc' }],
    });
  }
  output.push({
    type: 'mcp_approval_request',
    id: `approval_${approvalNumber}`,
    server_label: 'docs_server',
    name: toolName,
    arguments: rawArguments,
  });
  return {
    id: `resp_${responseNumber}`,
    status: 'completed',
    output,
    usage: usage(10, 2, 1, 3),
  };
}

function finalResponse({
  responseNumber = 2,
  priorApprovalNumber = 1,
  includeCall = true,
  text = 'The deployment guide is ready.',
  rawArguments = '{"query":"release checklist"}',
}: {
  responseNumber?: number;
  priorApprovalNumber?: number;
  includeCall?: boolean;
  text?: string;
  rawArguments?: string;
} = {}) {
  const output: Record<string, unknown>[] = [];
  if (includeCall) {
    output.push({
      type: 'mcp_call',
      id: `call_${priorApprovalNumber}`,
      approval_request_id: `approval_${priorApprovalNumber}`,
      server_label: 'docs_server',
      name: 'search_docs',
      arguments: rawArguments,
      output: 'untrusted tool output',
    });
  }
  output.push({
    type: 'message',
    id: `message_${responseNumber}`,
    role: 'assistant',
    content: [{ type: 'output_text', text }],
  });
  return {
    id: `resp_${responseNumber}`,
    status: 'completed',
    output,
    usage: usage(7, 4, 2, 1),
  };
}

describe('provider-hosted MCP request construction', () => {
  it('builds the official OpenAI body with a hard approval policy and no server-side state', () => {
    const body = buildProviderMcpRequest({
      protocol: 'openai-official',
      modelId: ' gpt-5.6 ',
      input: initialInput(),
      server: server(),
      maxOutputTokens: 4096,
    });

    expect(body).toEqual({
      model: 'gpt-5.6',
      input: initialInput(),
      tools: [
        {
          type: 'mcp',
          server_label: 'docs_server',
          server_url: 'https://mcp.example.com/rpc',
          authorization,
          require_approval: 'always',
          allowed_tools: ['search_docs', 'read_doc'],
        },
      ],
      store: false,
      include: ['reasoning.encrypted_content'],
      parallel_tool_calls: false,
      max_output_tokens: 4096,
    });
    expect(body).not.toHaveProperty('previous_response_id');
  });

  it('encodes the future Ark allowlist shape without enabling the Ark run loop', async () => {
    const body = buildProviderMcpRequest({
      protocol: 'volcengine-ark',
      modelId: 'doubao-seed-test',
      input: initialInput(),
      server: server({ authorization: undefined }),
    });
    expect(body.tools[0].allowed_tools).toEqual({ tool_names: ['search_docs', 'read_doc'] });
    expect(body.tools[0]).not.toHaveProperty('authorization');

    const sendRequest = vi.fn();
    await expect(
      runOpenAiProviderMcp({
        // Runtime callers cannot select Ark through the public type. This cast
        // proves the runtime boundary remains fail-closed as well.
        protocol: 'volcengine-ark' as 'openai-official',
        modelId: 'doubao-seed-test',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval: () => 'approve',
      })
    ).rejects.toThrow(/only for official OpenAI/);
    expect(sendRequest).not.toHaveBeenCalled();
  });

  it('requires a bounded, unique, syntactically safe allowlist', () => {
    for (const allowedTools of [
      [],
      ['search_docs', 'search_docs'],
      ['unsafe tool'],
      ['unsafe/tool'],
      ['unsafe:tool'],
      ['a'.repeat(providerMcpLimits.maxToolNameCharacters + 1)],
    ]) {
      expect(() =>
        buildProviderMcpRequest({
          protocol: 'openai-official',
          modelId: 'gpt-5.6',
          input: initialInput(),
          server: server({ allowedTools }),
        })
      ).toThrow();
    }
    expect(buildProviderMcpRequest({
      protocol: 'openai-official',
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server({
        allowedTools: ['a'.repeat(providerMcpLimits.maxToolNameCharacters)],
      }),
    }).tools[0].allowed_tools).toEqual([
      'a'.repeat(providerMcpLimits.maxToolNameCharacters),
    ]);
    expect(() =>
      buildProviderMcpRequest({
        protocol: 'openai-official',
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server({
          allowedTools: Array.from(
            { length: providerMcpLimits.maxAllowedTools + 1 },
            (_, index) => `tool_${index}`
          ),
        }),
      })
    ).toThrow(/tool limit/);
  });
});

describe('per-call approval loop', () => {
  it('approves once, uses a stateless continuation, aggregates usage, and returns a safe receipt', async () => {
    const sentBodies: ProviderMcpRequestBody[] = [];
    const responses = [
      approvalResponse({ responseNumber: 1, approvalNumber: 1 }),
      finalResponse(),
    ];
    const requestApproval = vi.fn((_request: unknown) => 'approve' as const);
    const beforeContinuation = vi.fn();

    const completed = await runOpenAiProviderMcp({
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server(),
      sendRequest: (body) => {
        sentBodies.push(body);
        return responses[sentBodies.length - 1];
      },
      requestApproval,
      beforeContinuation,
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].store).toBe(false);
    expect(sentBodies[0].include).toEqual(['reasoning.encrypted_content']);
    expect(sentBodies[0].parallel_tool_calls).toBe(false);
    expect(sentBodies[1]).not.toHaveProperty('previous_response_id');
    expect(sentBodies[1].store).toBe(false);
    expect(sentBodies[1].include).toEqual(['reasoning.encrypted_content']);
    expect(sentBodies[1].parallel_tool_calls).toBe(false);
    expect(sentBodies[1].input).toEqual([
      ...initialInput(),
      ...responses[0].output,
      {
        type: 'mcp_approval_response',
        approval_request_id: 'approval_1',
        approve: true,
      },
    ]);
    expect(requestApproval).toHaveBeenCalledTimes(1);
    expect(requestApproval.mock.calls[0][0]).toMatchObject({
      id: 'approval_1',
      serverLabel: 'docs_server',
      toolName: 'search_docs',
      arguments: { query: 'release checklist' },
    });
    expect(beforeContinuation).toHaveBeenCalledWith({
      nextRequestNumber: 2,
      approvals: [
        {
          approvalRequestId: 'approval_1',
          serverLabel: 'docs_server',
          toolName: 'search_docs',
          decision: 'approve',
          argumentBytes: 29,
        },
      ],
      signal: undefined,
    });
    expect(completed.providerRequestCount).toBe(2);
    expect(completed.result).toMatchObject({
      content: 'The deployment guide is ready.',
      reasoningContent: 'Reasoning 1',
      usage: {
        inputTokens: 17,
        outputTokens: 6,
        reasoningTokens: 3,
        cachedInputTokens: 4,
        totalTokens: 23,
      },
    });
    expect(completed.receipt).toMatchObject({
      requestCount: 2,
      responseIds: ['resp_1', 'resp_2'],
      listedTools: ['search_docs', 'read_doc'],
      approvals: [{ approvalRequestId: 'approval_1', decision: 'approve' }],
      calls: [{ callId: 'call_1', approvalRequestId: 'approval_1', outcome: 'completed' }],
    });
    const returnedJson = JSON.stringify(completed);
    expect(returnedJson).not.toContain('release checklist');
    expect(returnedJson).not.toContain(authorization);
  });

  it('sends deny as approve:false and lets the model produce a final answer', async () => {
    const sentBodies: ProviderMcpRequestBody[] = [];
    const completed = await runOpenAiProviderMcp({
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server(),
      sendRequest: (body) => {
        sentBodies.push(body);
        return sentBodies.length === 1
          ? approvalResponse({ responseNumber: 1, approvalNumber: 1 })
          : finalResponse({ includeCall: false, text: 'The tool call was denied.' });
      },
      requestApproval: () => 'deny',
    });

    expect(sentBodies[1].input.at(-1)).toEqual({
      type: 'mcp_approval_response',
      approval_request_id: 'approval_1',
      approve: false,
    });
    expect(completed.result.content).toBe('The tool call was denied.');
    expect(completed.receipt.approvals[0].decision).toBe('deny');
    expect(completed.receipt.calls).toEqual([]);
  });

  it('cancels locally without sending a continuation', async () => {
    const sendRequest = vi.fn(() => approvalResponse({ responseNumber: 1, approvalNumber: 1 }));
    const beforeContinuation = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval: () => 'cancel',
        beforeContinuation,
      })
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(beforeContinuation).not.toHaveBeenCalled();
  });

  it('supports multiple sequential approvals but rejects a fifth before prompting for it', async () => {
    const sendRequest = vi.fn((_body: ProviderMcpRequestBody, context: { requestNumber: number }) => {
      if (context.requestNumber <= providerMcpLimits.maxApprovals) {
        return approvalResponse({
          responseNumber: context.requestNumber,
          approvalNumber: context.requestNumber,
          priorApprovalNumber: context.requestNumber === 1 ? undefined : context.requestNumber - 1,
          rawArguments: `{"query":"round ${context.requestNumber}"}`,
        });
      }
      return approvalResponse({
        responseNumber: context.requestNumber,
        approvalNumber: context.requestNumber,
        priorApprovalNumber: context.requestNumber - 1,
        rawArguments: `{"query":"round ${context.requestNumber}"}`,
      });
    });
    const requestApproval = vi.fn(() => 'approve' as const);

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/4-approval limit/);
    expect(sendRequest).toHaveBeenCalledTimes(5);
    expect(requestApproval).toHaveBeenCalledTimes(4);
  });

  it('retains the original input and every prior output and decision across two approvals', async () => {
    const first = approvalResponse({
      responseNumber: 1,
      approvalNumber: 1,
      rawArguments: '{"query":"round 1"}',
    });
    const second = approvalResponse({
      responseNumber: 2,
      approvalNumber: 2,
      priorApprovalNumber: 1,
      rawArguments: '{"query":"round 2"}',
    });
    const third = finalResponse({
      responseNumber: 3,
      priorApprovalNumber: 2,
      rawArguments: '{"query":"round 2"}',
    });
    const responses = [first, second, third];
    const bodies: ProviderMcpRequestBody[] = [];

    const completed = await runOpenAiProviderMcp({
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server(),
      sendRequest: (body) => {
        bodies.push(body);
        return responses[bodies.length - 1];
      },
      requestApproval: () => 'approve',
    });

    const approvalOne = {
      type: 'mcp_approval_response',
      approval_request_id: 'approval_1',
      approve: true,
    };
    const approvalTwo = {
      type: 'mcp_approval_response',
      approval_request_id: 'approval_2',
      approve: true,
    };
    expect(bodies[1].input).toEqual([...initialInput(), ...first.output, approvalOne]);
    expect(bodies[2].input).toEqual([
      ...initialInput(),
      ...first.output,
      approvalOne,
      ...second.output,
      approvalTwo,
    ]);
    expect(bodies[2]).not.toHaveProperty('previous_response_id');
    expect(completed.providerRequestCount).toBe(3);
    expect(completed.receipt.calls.map((call) => call.approvalRequestId)).toEqual([
      'approval_1',
      'approval_2',
    ]);
  });

  it('requires an MCP call to match the approved raw arguments exactly', async () => {
    let requestNumber = 0;
    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest: () => {
          requestNumber += 1;
          return requestNumber === 1
            ? approvalResponse({ responseNumber: 1, approvalNumber: 1 })
            : finalResponse({ rawArguments: '{"query":"changed after approval"}' });
        },
        requestApproval: () => 'approve',
      })
    ).rejects.toThrow(/does not match an approved request/);
  });

  it('accepts a call without approval_request_id only when one exact approval matches', async () => {
    let requestNumber = 0;
    const final = finalResponse();
    delete final.output[0].approval_request_id;
    const completed = await runOpenAiProviderMcp({
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server(),
      sendRequest: () => {
        requestNumber += 1;
        return requestNumber === 1
          ? approvalResponse({ responseNumber: 1, approvalNumber: 1 })
          : final;
      },
      requestApproval: () => 'approve',
    });
    expect(completed.receipt.calls[0].approvalRequestId).toBe('approval_1');
  });

  it('rejects a call without approval_request_id when exact evidence is ambiguous', async () => {
    const sharedArguments = '{"query":"same"}';
    const responses = [
      approvalResponse({
        responseNumber: 1,
        approvalNumber: 1,
        rawArguments: sharedArguments,
      }),
      approvalResponse({
        responseNumber: 2,
        approvalNumber: 2,
        rawArguments: sharedArguments,
      }),
      finalResponse({
        responseNumber: 3,
        priorApprovalNumber: 2,
        rawArguments: sharedArguments,
      }),
    ];
    delete responses[2].output[0].approval_request_id;
    let responseIndex = 0;
    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest: () => responses[responseIndex++],
        requestApproval: () => 'approve',
      })
    ).rejects.toThrow(/no unique exact approved request match/);
  });

  it.each([
    [
      'unknown label',
      { server_label: 'attacker_server' },
      /unknown server_label/,
    ],
    [
      'tool outside allowlist',
      { name: 'delete_everything' },
      /outside allowedTools/,
    ],
  ])('fails closed for an approval with %s', async (_label, override, expected) => {
    const payload = approvalResponse({ responseNumber: 1, approvalNumber: 1 });
    Object.assign(payload.output.at(-1)!, override);
    const requestApproval = vi.fn();
    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest: () => payload,
        requestApproval,
      })
    ).rejects.toThrow(expected);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('honors AbortSignal while awaiting an injected transport', async () => {
    const controller = new AbortController();
    const sendRequest = vi.fn(
      () => new Promise<unknown>(() => undefined)
    );
    const pending = runOpenAiProviderMcp({
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server(),
      signal: controller.signal,
      sendRequest,
      requestApproval: () => 'approve',
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('does not retry or expose authorization when the injected transport fails', async () => {
    const sendRequest = vi.fn((body: ProviderMcpRequestBody) => {
      throw new Error(`upstream reflected ${body.tools[0].authorization}`);
    });
    let caught: unknown;
    try {
      await runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval: () => 'approve',
      });
    } catch (error) {
      caught = error;
    }
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(authorization);
    expect(String(caught)).toContain('request failed');
  });

  it('rejects a response that echoes authorization without returning the secret', async () => {
    const payload = finalResponse({ text: `stolen ${authorization}` });
    let caught: unknown;
    try {
      await runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest: () => payload,
        requestApproval: () => 'approve',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(authorization);
    expect(String(caught)).toContain('exposed authorization');
  });
});

describe('MCP response fail-closed and replay protection', () => {
  it('rejects an unknown output item without approval or retry', async () => {
    const payload = finalResponse({ includeCall: false });
    payload.output.push({ type: 'computer_call', id: 'computer_1' });
    const sendRequest = vi.fn(() => payload);
    const requestApproval = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/unsupported item type/);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['non-array tools', { tools: 'not-an-array' }],
  ])('rejects an mcp_list_tools item with %s', async (_label, override) => {
    const payload = approvalResponse({ responseNumber: 1, approvalNumber: 1 });
    const listItem = payload.output.find((item) => item.type === 'mcp_list_tools')!;
    Object.assign(listItem, override);
    const sendRequest = vi.fn(() => payload);
    const requestApproval = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/mcp_list_tools\.tools is malformed/);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['an error without tools', { tools: undefined, error: { message: 'list failed' } }],
    ['both an error and tools', { error: { message: 'ambiguous list result' } }],
  ])('fails closed when mcp_list_tools returns %s', async (_label, override) => {
    const payload = approvalResponse({ responseNumber: 1, approvalNumber: 1 });
    const listItem = payload.output.find((item) => item.type === 'mcp_list_tools')!;
    Object.assign(listItem, override);
    const sendRequest = vi.fn(() => payload);
    const requestApproval = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/mcp_list_tools.*error/);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('rejects a reasoning item with %s encrypted_content before approval', async (_label, value) => {
    const payload = approvalResponse({ responseNumber: 1, approvalNumber: 1 });
    const reasoning = payload.output.find((item) => item.type === 'reasoning')!;
    if (value === undefined) {
      delete reasoning.encrypted_content;
    } else {
      reasoning.encrypted_content = value;
    }
    const sendRequest = vi.fn(() => payload);
    const requestApproval = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/encrypted reasoning content|encrypted_content/);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('records a failed mcp_call once and does not retry it', async () => {
    const responses = [
      approvalResponse({ responseNumber: 1, approvalNumber: 1 }),
      finalResponse(),
    ];
    responses[1].output[0].error = { message: 'remote tool failed' };
    const sendRequest = vi.fn(
      (_body: ProviderMcpRequestBody, context: { requestNumber: number }) =>
        responses[context.requestNumber - 1]
    );

    const completed = await runOpenAiProviderMcp({
      modelId: 'gpt-5.6',
      input: initialInput(),
      server: server(),
      sendRequest,
      requestApproval: () => 'approve',
    });

    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(completed.providerRequestCount).toBe(2);
    expect(completed.receipt.calls).toEqual([
      {
        callId: 'call_1',
        approvalRequestId: 'approval_1',
        serverLabel: 'docs_server',
        toolName: 'search_docs',
        outcome: 'failed',
      },
    ]);
  });

  it('rejects an approval request id replayed in a later response', async () => {
    const responses = [
      approvalResponse({ responseNumber: 1, approvalNumber: 1 }),
      approvalResponse({
        responseNumber: 2,
        approvalNumber: 1,
        includeList: false,
      }),
    ];
    const sendRequest = vi.fn(
      (_body: ProviderMcpRequestBody, context: { requestNumber: number }) =>
        responses[context.requestNumber - 1]
    );
    const requestApproval = vi.fn(() => 'approve' as const);

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/approval request id was replayed/);
    expect(sendRequest).toHaveBeenCalledTimes(2);
    expect(requestApproval).toHaveBeenCalledTimes(1);
  });

  it('rejects a response id replayed after approval', async () => {
    const responses = [
      approvalResponse({ responseNumber: 1, approvalNumber: 1 }),
      finalResponse({ responseNumber: 1 }),
    ];
    const sendRequest = vi.fn(
      (_body: ProviderMcpRequestBody, context: { requestNumber: number }) =>
        responses[context.requestNumber - 1]
    );

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval: () => 'approve',
      })
    ).rejects.toThrow(/response id was replayed/);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects multiple approval requests in one response before showing either prompt', async () => {
    const payload = approvalResponse({ responseNumber: 1, approvalNumber: 1 });
    payload.output.push({
      type: 'mcp_approval_request',
      id: 'approval_2',
      server_label: 'docs_server',
      name: 'read_doc',
      arguments: '{"id":"doc-2"}',
    });
    const sentBodies: ProviderMcpRequestBody[] = [];
    const requestApproval = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest: (body) => {
          sentBodies.push(body);
          return payload;
        },
        requestApproval,
      })
    ).rejects.toThrow(/multiple approval requests despite serial tool calls/);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0].parallel_tool_calls).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed JSON', () => '{"id":', /malformed JSON/],
    [
      'malformed output shape',
      () => ({ id: 'resp_bad_output', status: 'completed', output: {} }),
      /output is malformed/,
    ],
    [
      'non-completed status',
      () => ({ ...finalResponse({ includeCall: false }), status: 'incomplete' }),
      /did not return a completed response/,
    ],
    [
      'oversized JSON',
      () => `{"padding":"${'x'.repeat(providerMcpLimits.maxResponseJsonBytes)}"}`,
      /exceeds the response size limit/,
    ],
  ])('rejects a %s Responses payload without retry', async (_label, payload, expected) => {
    const sendRequest = vi.fn(payload);
    const requestApproval = vi.fn();

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(expected);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('rejects two calls that try to consume the same approval in one response', async () => {
    const final = finalResponse();
    const replayedCall = {
      ...final.output[0],
      id: 'call_2',
    };
    final.output.splice(1, 0, replayedCall);
    let requestNumber = 0;
    const sendRequest = vi.fn(() => {
      requestNumber += 1;
      return requestNumber === 1
        ? approvalResponse({ responseNumber: 1, approvalNumber: 1 })
        : final;
    });

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval: () => 'approve',
      })
    ).rejects.toThrow(/already consumed approval/);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  it('rejects a call that replays an approval consumed in an earlier response', async () => {
    const responses = [
      approvalResponse({
        responseNumber: 1,
        approvalNumber: 1,
        rawArguments: '{"query":"round 1"}',
      }),
      approvalResponse({
        responseNumber: 2,
        approvalNumber: 2,
        priorApprovalNumber: 1,
        rawArguments: '{"query":"round 2"}',
      }),
      finalResponse({
        responseNumber: 3,
        priorApprovalNumber: 1,
        rawArguments: '{"query":"round 1"}',
      }),
    ];
    responses[2].output[0].id = 'call_replayed_approval';
    const sendRequest = vi.fn(
      (_body: ProviderMcpRequestBody, context: { requestNumber: number }) =>
        responses[context.requestNumber - 1]
    );
    const requestApproval = vi.fn(() => 'approve' as const);

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/already consumed approval/);
    expect(sendRequest).toHaveBeenCalledTimes(3);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });

  it('rejects an mcp_call id replayed for a different approval in a later response', async () => {
    const first = approvalResponse({
      responseNumber: 1,
      approvalNumber: 1,
      rawArguments: '{"query":"round 1"}',
    });
    const second = approvalResponse({
      responseNumber: 2,
      approvalNumber: 2,
      priorApprovalNumber: 1,
      rawArguments: '{"query":"round 2"}',
      includeList: false,
    });
    const third = finalResponse({
      responseNumber: 3,
      priorApprovalNumber: 2,
      rawArguments: '{"query":"round 2"}',
    });
    third.output[0].id = 'call_1';
    const responses = [first, second, third];
    const sendRequest = vi.fn(
      (_body: ProviderMcpRequestBody, context: { requestNumber: number }) =>
        responses[context.requestNumber - 1]
    );
    const requestApproval = vi.fn(() => 'approve' as const);

    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest,
        requestApproval,
      })
    ).rejects.toThrow(/call id was replayed/);
    expect(sendRequest).toHaveBeenCalledTimes(3);
    expect(requestApproval).toHaveBeenCalledTimes(2);
  });
});

describe('MCP argument hardening', () => {
  it('parses and freezes a bounded JSON object', () => {
    const parsed = parseProviderMcpArguments('{"query":"safe","options":{"limit":3}}');
    expect(parsed).toEqual({ query: 'safe', options: { limit: 3 } });
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.options)).toBe(true);
  });

  it.each([
    ['non-object root', '[1,2,3]', /JSON object/],
    ['duplicate decoded key', '{"name":1,"\\u006eame":2}', /duplicate object key/],
    ['Bidi key', '{"safe\\u202ename":1}', /unsafe object key/],
    ['control key', '{"safe\\u0000name":1}', /unsafe object key/],
    [
      'excess depth',
      `${'{"a":'.repeat(providerMcpLimits.maxArgumentDepth)}{}${'}'.repeat(providerMcpLimits.maxArgumentDepth)}`,
      /maximum JSON depth/,
    ],
  ])('rejects %s', (_label, raw, expected) => {
    expect(() => parseProviderMcpArguments(raw)).toThrow(expected);
  });

  it('enforces the React-Native-safe 32 KiB UTF-8 limit before parsing', () => {
    const raw = `{"value":"${'界'.repeat(providerMcpLimits.maxArgumentsBytes)}"}`;
    expect(providerMcpLimits.maxArgumentsBytes).toBe(32 * 1024);
    expect(() => parseProviderMcpArguments(raw)).toThrow(/32 KiB/);
  });

  it('rejects unsafe approval arguments before showing an approval UI', async () => {
    const payload = approvalResponse({
      responseNumber: 1,
      approvalNumber: 1,
      rawArguments: '{"path":"safe","path":"override"}',
    });
    const requestApproval = vi.fn(
      (): ProviderMcpApprovalDecision => 'approve'
    );
    await expect(
      runOpenAiProviderMcp({
        modelId: 'gpt-5.6',
        input: initialInput(),
        server: server(),
        sendRequest: () => payload,
        requestApproval,
      })
    ).rejects.toThrow(/duplicate object key/);
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
