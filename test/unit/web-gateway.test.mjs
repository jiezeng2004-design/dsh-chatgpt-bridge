import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  asApiProxy,
  compositionHasWebGateway,
  respondApproval,
  respondQuestion,
  cancelQuestion,
  startMuxMirror,
} from '../../lib/web-gateway.js';

test('compositionHasWebGateway sees api-gateway before it starts', () => {
  assert.equal(compositionHasWebGateway({ get: () => ({ entries: () => [
    { id: 'api-gateway', options: { name: '@deepseek-ai/dsh-api-gateway' } },
  ] }) }), false);
  assert.equal(compositionHasWebGateway({ get: () => undefined }), false);
  assert.equal(compositionHasWebGateway({
    get: () => ({ entries: () => [{ id: 'workspace', options: { name: '@deepseek-ai/dsh-workspace' } }] }),
  }), false);
  assert.equal(compositionHasWebGateway({
    get: (name) => name === 'loader'
      ? { entries: () => [{ id: 'api-gateway', options: { id: 'api-gateway', name: '@deepseek-ai/dsh-host-apiproxy' } }] }
      : undefined,
  }), true);
  assert.equal(compositionHasWebGateway({
    get: (name) => name === 'loader'
      ? { store: { row1: { id: 'api-gateway', options: { name: '@deepseek-ai/dsh-host-apiproxy' } } } }
      : undefined,
  }), true);
});

test('asApiProxy accepts only mux+respond shapes', () => {
  assert.equal(asApiProxy(undefined), undefined);
  assert.equal(asApiProxy(null), undefined);
  assert.equal(asApiProxy(123), undefined);
  assert.equal(asApiProxy('string'), undefined);
  assert.equal(asApiProxy({}), undefined);
  assert.equal(asApiProxy({ respond: () => {}, events: {} }), undefined);
  const api = { respond: async () => ({ accepted: true }), events: { mux: async function* () {} } };
  assert.equal(asApiProxy(api), api);
});

test('respond helpers use the official client-response envelope', async () => {
  const seen = [];
  const api = {
    events: { mux: async function* () {} },
    respond: async (message) => { seen.push(message); return { accepted: true }; },
  };
  await respondApproval(api, 'rpc-1', 'session-1', 'appr-1', 'rejected');
  await cancelQuestion(api, 'rpc-2');
  assert.equal(seen[0].type, 'client-response');
  assert.equal(seen[0].result.ok, true);
  assert.equal(seen[0].result.value.outcome, 'rejected');
  assert.equal(seen[1].result.ok, false);
  assert.equal(seen[1].result.error.code, 'cancelled');
});

test('startMuxMirror: approval requested contract parses payload and dispatches correctly', async () => {
  const approvals = [];
  const ac = new AbortController();

  async function* generateFrames() {
    yield {
      rpcId: 'rpc-appr-101',
      payload: {
        type: 'approval/requested',
        sessionId: 'sess-alpha',
        approvalId: 'appr-alpha-1',
        toolName: 'fs_write',
        callId: 'call-w-1',
        reason: 'write permission needed',
      },
    };
  }

  const api = {
    events: { mux: () => generateFrames() },
    respond: async () => ({ accepted: true }),
  };

  const handlers = {
    onApprovalRequested: (pending) => approvals.push(pending),
    onApprovalResolved: () => {},
    onQuestionRequested: () => {},
    onQuestionResolved: () => {},
  };

  startMuxMirror(api, handlers, ac.signal);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(approvals.length, 1);
  assert.deepEqual(approvals[0], {
    rpcId: 'rpc-appr-101',
    sessionId: 'sess-alpha',
    approvalId: 'appr-alpha-1',
    toolName: 'fs_write',
    callId: 'call-w-1',
    reason: 'write permission needed',
  });

  // Respond to approval and verify envelope
  const seenResponses = [];
  api.respond = async (msg) => {
    seenResponses.push(msg);
    return { accepted: true };
  };

  const receipt = await respondApproval(api, approvals[0].rpcId, approvals[0].sessionId, approvals[0].approvalId, 'allowed-once');
  assert.equal(receipt.accepted, true);
  assert.equal(seenResponses.length, 1);
  assert.deepEqual(seenResponses[0], {
    type: 'client-response',
    rpcId: 'rpc-appr-101',
    result: {
      ok: true,
      value: {
        sessionId: 'sess-alpha',
        approvalId: 'appr-alpha-1',
        outcome: 'allowed-once',
      },
    },
  });
  ac.abort();
});

test('startMuxMirror: question requested supports single-select, multi-select, and custom answers', async () => {
  const questions = [];
  const ac = new AbortController();

  async function* generateFrames() {
    // Single-select question
    yield {
      rpcId: 'rpc-q-single',
      payload: {
        type: 'question/requested',
        sessionId: 'sess-q1',
        questions: [{ id: 'item-1', text: 'Select one option', options: [{ label: 'Yes' }, { label: 'No' }] }],
      },
    };
    // Multi-select question
    yield {
      rpcId: 'rpc-q-multi',
      payload: {
        type: 'question/requested',
        sessionId: 'sess-q2',
        questions: [{ id: 'item-2', text: 'Select multiple', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] }],
      },
    };
    // Custom text answer question
    yield {
      rpcId: 'rpc-q-custom',
      payload: {
        type: 'question/requested',
        sessionId: 'sess-q3',
        questions: [{ id: 'item-3', text: 'Please enter feedback', options: [] }],
      },
    };
  }

  const seenResponses = [];
  const api = {
    events: { mux: () => generateFrames() },
    respond: async (msg) => {
      seenResponses.push(msg);
      return { accepted: true };
    },
  };

  const handlers = {
    onApprovalRequested: () => {},
    onApprovalResolved: () => {},
    onQuestionRequested: (pending) => questions.push(pending),
    onQuestionResolved: () => {},
  };

  startMuxMirror(api, handlers, ac.signal);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(questions.length, 3);
  assert.equal(questions[0].rpcId, 'rpc-q-single');
  assert.equal(questions[0].sessionId, 'sess-q1');
  assert.equal(questions[1].rpcId, 'rpc-q-multi');
  assert.equal(questions[1].sessionId, 'sess-q2');
  assert.equal(questions[2].rpcId, 'rpc-q-custom');
  assert.equal(questions[2].sessionId, 'sess-q3');

  // Test single-select response
  await respondQuestion(api, 'rpc-q-single', 'sess-q1', {
    answers: [{ id: 'item-1', selected: ['Yes'] }],
  });
  // Test multi-select response
  await respondQuestion(api, 'rpc-q-multi', 'sess-q2', {
    answers: [{ id: 'item-2', selected: ['A', 'C'] }],
  });
  // Test custom text response
  await respondQuestion(api, 'rpc-q-custom', 'sess-q3', {
    answers: [{ id: 'item-3', selected: [], custom: 'Custom feedback text' }],
  });

  assert.equal(seenResponses.length, 3);
  assert.deepEqual(seenResponses[0], {
    type: 'client-response',
    rpcId: 'rpc-q-single',
    result: {
      ok: true,
      value: {
        sessionId: 'sess-q1',
        answer: { answers: [{ id: 'item-1', selected: ['Yes'] }] },
      },
    },
  });
  assert.deepEqual(seenResponses[1], {
    type: 'client-response',
    rpcId: 'rpc-q-multi',
    result: {
      ok: true,
      value: {
        sessionId: 'sess-q2',
        answer: { answers: [{ id: 'item-2', selected: ['A', 'C'] }] },
      },
    },
  });
  assert.deepEqual(seenResponses[2], {
    type: 'client-response',
    rpcId: 'rpc-q-custom',
    result: {
      ok: true,
      value: {
        sessionId: 'sess-q3',
        answer: { answers: [{ id: 'item-3', selected: [], custom: 'Custom feedback text' }] },
      },
    },
  });
  ac.abort();
});

test('startMuxMirror: resolved events clear pending waiters without dangling state', async () => {
  const resolvedApprovals = [];
  const resolvedQuestions = [];
  const ac = new AbortController();

  async function* generateFrames() {
    yield {
      payload: {
        type: 'approval/resolved',
        sessionId: 'sess-res-1',
        approvalId: 'appr-res-10',
      },
    };
    yield {
      payload: {
        type: 'question/resolved',
        sessionId: 'sess-res-2',
        questionRpcId: 'rpc-q-res-20',
      },
    };
  }

  const api = {
    events: { mux: () => generateFrames() },
    respond: async () => ({ accepted: true }),
  };

  const handlers = {
    onApprovalRequested: () => {},
    onApprovalResolved: (sessionId, approvalId) => resolvedApprovals.push({ sessionId, approvalId }),
    onQuestionRequested: () => {},
    onQuestionResolved: (sessionId, questionRpcId) => resolvedQuestions.push({ sessionId, questionRpcId }),
  };

  startMuxMirror(api, handlers, ac.signal);
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(resolvedApprovals.length, 1);
  assert.deepEqual(resolvedApprovals[0], { sessionId: 'sess-res-1', approvalId: 'appr-res-10' });
  assert.equal(resolvedQuestions.length, 1);
  assert.deepEqual(resolvedQuestions[0], { sessionId: 'sess-res-2', questionRpcId: 'rpc-q-res-20' });
  ac.abort();
});

test('startMuxMirror: malformed frames are skipped safely and stream errors report via onError', async () => {
  const dispatched = [];
  const errors = [];
  const ac = new AbortController();

  async function* generateMalformedFrames() {
    yield undefined; // undefined envelope
    yield {}; // empty envelope
    yield { payload: {} }; // no type
    yield { payload: { type: 'unknown/type' } }; // unknown type
    yield { rpcId: 'rpc-bad-1', payload: { type: 'approval/requested' } }; // missing approvalId & toolName
    yield { rpcId: 'rpc-bad-2', payload: { type: 'question/requested' } }; // missing questions array
    yield { payload: { type: 'approval/resolved' } }; // missing approvalId
    yield { payload: { type: 'question/resolved' } }; // missing questionRpcId
    yield {
      rpcId: 'rpc-valid',
      payload: {
        type: 'approval/requested',
        sessionId: 'sess-good',
        approvalId: 'appr-good',
        toolName: 'read_file',
      },
    };
    throw new Error('Mux stream disconnected');
  }

  const api = {
    events: { mux: () => generateMalformedFrames() },
    respond: async () => ({ accepted: true }),
  };

  const handlers = {
    onApprovalRequested: (p) => dispatched.push(p),
    onApprovalResolved: () => {},
    onQuestionRequested: () => {},
    onQuestionResolved: () => {},
  };

  startMuxMirror(api, handlers, ac.signal, (err) => errors.push(err));
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].approvalId, 'appr-good');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Mux stream disconnected/);
  ac.abort();
});

test('startMuxMirror: concurrent events across distinct sessions and rpcIds do not crosstalk', async () => {
  const approvalsBySession = new Map();
  const questionsBySession = new Map();
  const ac = new AbortController();

  async function* generateConcurrentFrames() {
    // Emit concurrent interleaved frames for session-A, session-B, session-C
    yield {
      rpcId: 'rpc-appr-A',
      payload: { type: 'approval/requested', sessionId: 'session-A', approvalId: 'appr-A', toolName: 'tool-A' },
    };
    yield {
      rpcId: 'rpc-q-B',
      payload: { type: 'question/requested', sessionId: 'session-B', questions: [{ id: 'q-B', text: 'B?' }] },
    };
    yield {
      rpcId: 'rpc-appr-C',
      payload: { type: 'approval/requested', sessionId: 'session-C', approvalId: 'appr-C', toolName: 'tool-C' },
    };
    yield {
      rpcId: 'rpc-q-A',
      payload: { type: 'question/requested', sessionId: 'session-A', questions: [{ id: 'q-A', text: 'A?' }] },
    };
  }

  const api = {
    events: { mux: () => generateConcurrentFrames() },
    respond: async () => ({ accepted: true }),
  };

  const handlers = {
    onApprovalRequested: (p) => {
      const list = approvalsBySession.get(p.sessionId) ?? [];
      list.push(p);
      approvalsBySession.set(p.sessionId, list);
    },
    onApprovalResolved: () => {},
    onQuestionRequested: (p) => {
      const list = questionsBySession.get(p.sessionId) ?? [];
      list.push(p);
      questionsBySession.set(p.sessionId, list);
    },
    onQuestionResolved: () => {},
  };

  startMuxMirror(api, handlers, ac.signal);
  await new Promise((r) => setTimeout(r, 30));

  assert.equal(approvalsBySession.get('session-A')?.length, 1);
  assert.equal(approvalsBySession.get('session-A')[0].rpcId, 'rpc-appr-A');
  assert.equal(approvalsBySession.get('session-C')?.length, 1);
  assert.equal(approvalsBySession.get('session-C')[0].rpcId, 'rpc-appr-C');
  assert.equal(approvalsBySession.has('session-B'), false);

  assert.equal(questionsBySession.get('session-B')?.length, 1);
  assert.equal(questionsBySession.get('session-B')[0].rpcId, 'rpc-q-B');
  assert.equal(questionsBySession.get('session-A')?.length, 1);
  assert.equal(questionsBySession.get('session-A')[0].rpcId, 'rpc-q-A');
  assert.equal(questionsBySession.has('session-C'), false);

  ac.abort();
});

test('Bridge + WebGateway: full approval and question lifecycle over apiProxy', async () => {
  const { Bridge, BridgeError } = await import('../../lib/bridge.js');

  const muxQueue = [];
  let waitingConsumer = null;

  function pushFrame(frame) {
    if (waitingConsumer) {
      const resolve = waitingConsumer;
      waitingConsumer = null;
      resolve({ value: frame, done: false });
    } else {
      muxQueue.push(frame);
    }
  }

  const asyncIterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (muxQueue.length > 0) {
            return Promise.resolve({ value: muxQueue.shift(), done: false });
          }
          return new Promise((resolve) => {
            waitingConsumer = resolve;
          });
        },
      };
    },
  };

  const seenResponses = [];
  const apiProxy = {
    events: {
      mux: () => asyncIterable,
    },
    respond: async (msg) => {
      seenResponses.push(msg);
      if (msg.rpcId === 'rpc-reject-me') {
        return { accepted: false, reason: 'expired' };
      }
      return { accepted: true };
    },
  };

  const services = {
    workspaceRegistry: { list: () => [{ id: 'ws-1', title: 'ws', path: 'D:\\ws', createdAt: 'x', updatedAt: 'x', sessionIds: [] }] },
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    apiProxy,
  };
  const ctx = {
    get: (k) => services[k],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: () => () => {},
    inject: (deps, fn) => fn(),
    effect: (fn) => fn(),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bridge = new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
  bridge.start();

  // 1. Receive approval request via mux
  pushFrame({
    rpcId: 'rpc-bridge-appr-1',
    payload: {
      type: 'approval/requested',
      sessionId: 'sess-b-1',
      approvalId: 'appr-b-1',
      toolName: 'bash',
      reason: 'run command',
    },
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(bridge['approvals'].has('appr-b-1'), true);
  const pendingAppr = bridge['approvals'].get('appr-b-1');
  assert.equal(pendingAppr.toolName, 'bash');
  assert.equal(pendingAppr.sessionId, 'sess-b-1');

  // Mismatched session rejection
  await assert.rejects(
    () => bridge.approve('sess-WRONG', 'appr-b-1', 'approve'),
    (err) => err instanceof BridgeError && err.code === 'APPROVAL_SESSION_MISMATCH',
  );

  // Successful approval response
  const apprResult = await bridge.approve('sess-b-1', 'appr-b-1', 'approve');
  assert.equal(apprResult.decision, 'approve');
  assert.equal(apprResult.outcome, 'allowed-once');
  assert.equal(bridge['approvals'].has('appr-b-1'), false);

  assert.equal(seenResponses.length, 1);
  assert.deepEqual(seenResponses[0], {
    type: 'client-response',
    rpcId: 'rpc-bridge-appr-1',
    result: {
      ok: true,
      value: {
        sessionId: 'sess-b-1',
        approvalId: 'appr-b-1',
        outcome: 'allowed-once',
      },
    },
  });

  // 2. Receive question request via mux
  pushFrame({
    rpcId: 'rpc-bridge-q-1',
    payload: {
      type: 'question/requested',
      sessionId: 'sess-b-2',
      questions: [
        {
          id: 'q-item-1',
          text: 'Confirm deployment?',
          options: [{ label: 'Confirm' }, { label: 'Cancel' }],
        },
      ],
    },
  });
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(bridge['questions'].has('rpc-bridge-q-1'), true);

  // Invalid answer option rejected
  await assert.rejects(
    () => bridge.answerQuestion('rpc-bridge-q-1', 'sess-b-2', { selected: ['InvalidOption'] }),
    (err) => err instanceof BridgeError && err.code === 'INVALID_ANSWER',
  );

  // Successful answer
  const qResult = await bridge.answerQuestion('rpc-bridge-q-1', 'sess-b-2', { selected: ['Confirm'] });
  assert.equal(qResult.answered, true);
  assert.equal(bridge['questions'].has('rpc-bridge-q-1'), false);

  assert.equal(seenResponses.length, 2);
  assert.deepEqual(seenResponses[1], {
    type: 'client-response',
    rpcId: 'rpc-bridge-q-1',
    result: {
      ok: true,
      value: {
        sessionId: 'sess-b-2',
        answer: {
          answers: [{ id: 'q-item-1', selected: ['Confirm'] }],
        },
      },
    },
  });

  // 3. Upstream resolution clears pending without manual answer
  pushFrame({
    rpcId: 'rpc-bridge-appr-2',
    payload: {
      type: 'approval/requested',
      sessionId: 'sess-b-3',
      approvalId: 'appr-b-2',
      toolName: 'fs_edit',
    },
  });
  pushFrame({
    rpcId: 'rpc-bridge-q-2',
    payload: {
      type: 'question/requested',
      sessionId: 'sess-b-3',
      questions: [{ id: 'q-2', text: 'Prompt' }],
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bridge['approvals'].has('appr-b-2'), true);
  assert.equal(bridge['questions'].has('rpc-bridge-q-2'), true);

  // Upstream resolves them
  pushFrame({
    payload: {
      type: 'approval/resolved',
      sessionId: 'sess-b-3',
      approvalId: 'appr-b-2',
    },
  });
  pushFrame({
    payload: {
      type: 'question/resolved',
      sessionId: 'sess-b-3',
      questionRpcId: 'rpc-bridge-q-2',
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(bridge['approvals'].has('appr-b-2'), false);
  assert.equal(bridge['questions'].has('rpc-bridge-q-2'), false);

  // 4. Gateway rejection fails loud
  pushFrame({
    rpcId: 'rpc-reject-me',
    payload: {
      type: 'approval/requested',
      sessionId: 'sess-b-4',
      approvalId: 'appr-b-reject',
      toolName: 'cmd',
    },
  });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(
    () => bridge.approve('sess-b-4', 'appr-b-reject', 'approve'),
    (err) => err instanceof BridgeError && err.code === 'APPROVAL_UNREACHABLE' && err.message.includes('expired'),
  );
  assert.equal(bridge['approvals'].has('appr-b-reject'), true);
});
