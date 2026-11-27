// Contract tests of the real mod module against a deterministic native host.
// No Claude process, account, network request or paid model call is made here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { register } from './register.ts';

const PLUGIN = 'sniffer-memory';
const AGENT = `${PLUGIN}:memory-agent`;
const MODEL = 'claude-haiku-5-5';
const tool = (name) => `mcp__${PLUGIN}__${name}`;
const revision = '0123456789abcdef0123456789abcdef01234567';
const picked = { decision: 'inject', references: [{ id: 'fictional-rule', revision }], reason: 'Relevant deployment rule' };
const none = { decision: 'none', references: [], reason: 'No useful memory' };
const canonical = 'Ein / Sniffer memory references. Fictional canonical memory body.';

function harness(options = {}) {
  const handlers = new Map(), calls = [], trace = [], specs = [], toolSpecs = [], agents = new Map(), timers = [];
  let request = 0, child = 0, turn = 0, delivery = 0;
  const h = { handlers, calls, trace, specs, toolSpecs, agents, timers, active: undefined,
    session: 'main-session', cwd: '/fictional/project', messages: [], sends: [], spawns: [], stops: [], sleeps: [], review: 'cleared',
    afterToolRun: undefined, denyPermission: false, autoReport: options.autoReport, spawnModel: MODEL,
    beginGate: undefined, completeStatus: undefined, failBridge: false, throwReview: false,
    processOverride: undefined, permissionChecks: 0, env: options.env || { EIN_SNIFFER_BIN: '/fictional/sniffer' } };
  register((name, match, fn) => {
    if (typeof match === 'function') { fn = match; match = undefined; }
    const row = { match, fn, recovery: undefined };
    if (!handlers.has(name)) handlers.set(name, []);
    handlers.get(name).push(row);
    return { catch(recovery) { row.recovery = recovery; return this; } };
  });

  h.emit = async (name, event = {}, base, origin = 'engine', signal = { aborted: false }) => {
    const chain = (handlers.get(name) || []).filter((row) => !row.match || Object.entries(row.match).every(([key, value]) => event[key] === value));
    async function dispatch(index, input) {
      if (index === chain.length) {
        if (base) return base(input);
        if (name === 'agent.report') return { text: input.text, review: h.review };
        if (name === 'tool.offer' || name === 'agent.offer') return { isOffered: true };
        return input;
      }
      const row = chain[index];
      const next = Object.assign(async (value) => { next.called = true; return dispatch(index + 1, value); },
        { signal, origin: { plugin: origin, tier: origin === 'engine' ? 'core' : 'user' }, called: false });
      try { return await row.fn(h.$, input, next); }
      catch (error) { if (row.recovery) return row.recovery(h.$, input, next, error); throw error; }
    }
    return dispatch(0, event);
  };

  h.$ = {
    env: { get: async (name) => h.env[name] },
    fs: { exists: async (path) => options.exists?.includes(path) || false },
    clock: {
      sleep: async (ms) => { h.sleeps.push(ms); await tick(); },
      after: (ms, fn) => { const timer = { ms, fn, cancelled: false, cancel() { this.cancelled = true; } }; timers.push(timer); return timer; },
    },
    tool: {
      register: async (spec) => { toolSpecs.push(spec); return { tool: tool(spec.name), dispose: async () => {} }; },
      call: async (event) => h.call(event, PLUGIN),
    },
    agent: {
      register: async (spec) => { specs.push(spec); return { agent: AGENT, dispose: async () => {} }; },
      list: async () => [...agents.values()],
      spawn: async (args) => {
        h.spawns.push(args);
        return h.emit('agent.spawn', { ...args, parentModel: 'claude-opus-main', background: true, fork: false,
          provider: { plugin: PLUGIN, tier: 'user' }, tool_use_id: '' }, async (event) => {
          const id = `child-${++child}`;
          agents.set(id, { id, type: AGENT, spawnedBy: PLUGIN, name: event.name, status: 'running', kind: 'local_agent',
            cwd: event.cwd, model: h.spawnModel, effort: 'medium' });
          // Deliberately exercise first-child-turn-before-spawn-return ordering.
          await h.emit('turn.start', { agentId: id, turnId: `child-turn-${child}`, text: event.prompt });
          if (h.autoReport) await h.report(id, h.autoReport);
          return { agentId: id, model: h.spawnModel };
        }, PLUGIN);
      },
    },
    session: {
      id: async () => h.session, cwd: async () => h.cwd, messages: async () => h.messages,
      send: async ({ to, text }) => {
        h.sends.push({ to, text });
        const info = agents.get(to.agentId);
        const response = await h.emit('agent.spawn', { subagentType: AGENT, resume: { agentId: to.agentId },
          prompt: text, parentModel: 'claude-opus-main', provider: { plugin: PLUGIN, tier: 'user' }, background: true,
          fork: false, tool_use_id: '' }, async () => {
          info.status = 'running';
          await h.emit('turn.start', { agentId: info.id, turnId: `resume-${++turn}`, text });
          if (h.autoReport) await h.report(info.id, h.autoReport);
          return { agentId: info.id, model: info.model };
        }, PLUGIN);
        return response.deny ? { isDelivered: false, reason: response.deny } : { isDelivered: true };
      },
    },
    process: { run: async (argv, processOptions) => {
      const input = JSON.parse(processOptions.stdin), op = argv[2];
      const call = { argv, op, input, timeoutMs: processOptions.timeoutMs };
      calls.push(call); trace.push(op);
      if (h.failBridge) throw new Error('fictional local process failure');
      if (h.processOverride) { const value = await h.processOverride(call); if (value !== undefined) return value; }
      let value = {};
      if (op === 'begin') {
        if (h.beginGate) await h.beginGate;
        h.active = { ...input, request_id: `request-${++request}` };
        value = { status: 'started', request_id: h.active.request_id, epoch: 0, project_id: 'fictional-project',
          system_prompt: 'Native system prompt', prompt: JSON.stringify(h.active) };
      } else if (op === 'tool') {
        if (input.request_id !== h.active?.request_id) throw new Error('stale');
        if (input.name === 'memory_search') value = { memories: [{ id: 'fictional-rule', revision, description: input.arguments.query }] };
        else if (input.name === 'memory_read') value = { id: input.arguments.id, revision, body: 'Fictional complete body at requested page', offset: input.arguments.offset || 0 };
        else value = { query: h.active.query, context: h.active.context };
      } else if (op === 'complete') {
        const status = h.completeStatus || (input.request_id === h.active?.request_id ? (input.decision.decision === 'none' ? 'none_selected' : 'claimed') : 'stale');
        value = status === 'claimed' ? { status, context: canonical, delivery_id: `delivery-${++delivery}`, epoch: 0 } : { status, epoch: 0 };
      } else if (op === 'write') value = { status: input.name === 'memory_save' ? 'saved' : input.arguments.apply ? 'promoted' : 'preview', fictional: true };
      else if (op === 'reset') value = { status: 'cancelled', epoch: 1 };
      else value = { status: 'ok' };
      return { exitCode: 0, stdout: JSON.stringify(value), stderr: '', isStdoutTruncated: false, isStderrTruncated: false };
    } },
  };

  h.call = async (event, origin = 'engine', fixture = { result: { content: 'real result' }, text: 'real result', ref: 42 }) =>
    h.emit('tool.call', event, async (input) => {
      h.permissionChecks++;
      if (h.denyPermission) return { deny: 'host permission denied' };
      const result = await h.emit('tool.run', input, async (executed) => {
        if (executed.tool === 'TaskStop') { h.stops.push(executed.task_id); return { result: { stopped: executed.task_id } }; }
        return fixture;
      }, origin);
      trace.push('tool-result-returned');
      return h.afterToolRun ? h.afterToolRun(result) : result;
    }, origin);
  h.report = async (id, value = picked, status = 'completed') => {
    const event = { agentId: id, subagentType: AGENT, status, provider: { plugin: PLUGIN, tier: 'user' }, text: typeof value === 'string' ? value : JSON.stringify(value) };
    const result = await h.emit('agent.report', event, async (input) => {
      if (h.throwReview) throw new Error('review interrupted');
      trace.push('review'); return { text: input.text, review: h.review };
    });
    if (agents.has(id)) agents.get(id).status = 'completed';
    trace.push(result.consumed ? 'report-consumed' : 'report-delivered');
    return result;
  };
  h.flush = async () => { for (let i = 0; i < 4; i++) await tick(); };
  h.prompt = async (text = '가상 배포 규칙', extra = {}, base) => {
    const value = await h.emit('prompt.submit', { text, wait: false, origin: { type: 'user' }, ...extra }, base || (async (event) => {
      trace.push('prompt-entered'); return { text: event.text, context: event.context };
    }));
    await h.flush(); return value;
  };
  h.start = async (id = `main-turn-${++turn}`) => { await h.emit('turn.start', { turnId: id, text: 'main prompt' }); return id; };
  h.op = (op) => calls.filter((call) => call.op === op);
  h.step = async (agentId, model = MODEL, effort = 'medium') => {
    const row = handlers.get('turn.step')[0];
    let reachedModel = false;
    const next = async function* (event) { reachedModel = true; return { ...event, answer: 'ok', toolUses: [], stopReason: 'end_turn', usage: null }; };
    const iterator = row.fn(h.$, { agentId, model, effort, turnId: 'step-turn', index: 0 }, next);
    let result = await iterator.next();
    while (!result.done) result = await iterator.next();
    return { reachedModel, value: result.value };
  };
  return h;
}

test('native setup fixes Haiku/medium, three reader tools, and no CLI LLM subprocess', async () => {
  const h = harness();
  await h.prompt();
  assert.equal(h.specs.length, 1);
  assert.equal(h.specs[0].model, MODEL); assert.equal(h.specs[0].effort, 'medium');
  assert.equal(h.specs[0].background, true); assert.equal(h.specs[0].omitClaudeMd, true);
  assert.deepEqual(h.specs[0].tools, ['memory_search', 'memory_read', 'memory_context'].map(tool));
  assert.equal(h.spawns.length, 1); assert.equal(h.spawns[0].cwd, h.cwd);
  assert.ok(h.spawns[0].name);
  assert.ok(h.calls.every((call) => call.argv[0] === '/fictional/sniffer' && call.argv[1] === 'bridge'));
  assert.equal(h.op('tool').length, 0, 'Go does not preselect a fixed candidate set');
  assert.deepEqual(await h.emit('agent.offer', { agent: AGENT }), { isOffered: false });
  const reloaded = harness(); await reloaded.prompt();
  assert.notEqual(h.op('begin')[0].input.event_id, reloaded.op('begin')[0].input.event_id,
    'a reloaded mod must not reuse a previous begin idempotency key');
});

test('fast native report is consumed, canonical context enters prompt, ACK follows handoff', async () => {
  const h = harness({ autoReport: picked });
  const value = await h.prompt('한글 query', { context: ['another mod'] });
  assert.equal(value.text, '한글 query');
  assert.deepEqual(value.context, ['another mod', canonical]);
  assert.equal(h.trace.includes('report-delivered'), false);
  assert.equal(h.op('complete').length, 1);
  assert.equal(h.op('ack')[0].input.outcome, 'emitted');
  assert.ok(h.trace.indexOf('complete') < h.trace.indexOf('prompt-entered'));
  assert.ok(h.trace.indexOf('ack') > h.trace.indexOf('prompt-entered'));
  assert.equal(JSON.stringify(value).includes('Relevant deployment rule'), false);
});

test('settled native child is resumed with send across main turns', async () => {
  const h = harness(); await h.prompt(); const first = h.spawns[0];
  const turnId = await h.start();
  await h.report('child-1', none);
  await h.emit('turn.complete', { turnId, reason: 'answer' });
  await h.prompt('다음 관련 질문');
  assert.equal(h.spawns.length, 1); assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].to.agentId, 'child-1');
  assert.notEqual(JSON.parse(first.prompt).request_id, JSON.parse(h.sends[0].text).request_id);
  assert.equal(h.stops.includes('child-1'), false);
});

test('child chooses multiple Korean/English searches and pages full memory through bound Go tools', async () => {
  const h = harness(); await h.prompt();
  for (const query of ['배포 승인', 'deployment approval', 'rollback']) {
    const result = await h.call({ tool: tool('memory_search'), query, limit: 7, agentId: 'child-1', tool_use_id: query });
    assert.equal(result.result.memories[0].description, query);
  }
  const page = await h.call({ tool: tool('memory_read'), id: 'fictional-rule', offset: 1200, limit: 6000, agentId: 'child-1' });
  assert.equal(page.result.offset, 1200);
  await h.call({ tool: tool('memory_context'), agentId: 'child-1' });
  assert.equal(h.op('tool').length, 5);
  assert.ok(h.op('tool').every((call) => call.input.request_id === h.active.request_id && call.input.conversation_id === h.session));
  assert.deepEqual(h.op('tool')[3].input.arguments, { id: 'fictional-rule', offset: 1200, limit: 6000 });
  assert.equal(h.op('write').length, 0);
});

test('reader-only policy denies commands, spawn, writes, unrelated child writes and unbound readers', async () => {
  const h = harness(); await h.prompt();
  for (const name of ['Bash', 'Read', 'Agent', tool('memory_save'), tool('memory_promote')]) {
    assert.ok((await h.call({ tool: name, agentId: 'child-1', command: 'bad' })).deny);
  }
  assert.ok((await h.call({ tool: tool('memory_save'), agentId: 'unrelated-child' })).deny);
  assert.ok((await h.call({ tool: tool('memory_search'), query: 'main' })).deny);
  const spawn = await h.emit('agent.spawn', { parentAgentId: 'child-1', subagentType: 'Explore' });
  assert.ok(spawn.deny);
  assert.ok((await h.emit('agent.spawn', { subagentType: AGENT, fork: false })).deny);
  assert.equal(h.op('write').length, 0);
  assert.equal((await h.emit('tool.offer', { tool: 'Bash', agentId: 'child-1', subagentType: AGENT })).isOffered, false);
});

test('main save and promote run only after host permission and keep exact writer arguments', async () => {
  const h = harness(); await h.emit('session.start');
  const input = { tool: tool('memory_save'), markdown: '---\ndescription: fictional\n---\nText', if_revision: 'new', request_id: 'save-1', tool_use_id: 'save-call' };
  h.denyPermission = true;
  assert.ok((await h.call(input)).deny); assert.equal(h.op('write').length, 0);
  h.denyPermission = false;
  assert.equal((await h.call(input)).result.status, 'saved');
  const saved = h.op('write')[0].input;
  assert.equal(saved.role, 'main'); assert.equal('agent_id' in saved, false);
  assert.deepEqual(saved.arguments, { markdown: input.markdown, if_revision: 'new', request_id: 'save-1' });
  const promote = await h.call({ tool: tool('memory_promote'), id: 'fictional-rule', to: 'global', if_revision: revision, request_id: 'promote-1', apply: false });
  assert.equal(promote.result.status, 'preview');
  assert.equal(h.permissionChecks, 3);
});

test('report only queues a decision; safe main tool handoff preserves result and ACKs context', async () => {
  const h = harness(); await h.prompt(); await h.start();
  assert.ok((await h.report('child-1')).consumed);
  assert.equal(h.op('complete').length, 0, 'no early delivery claim at report arrival');
  const original = { result: { output: 'real output' }, text: 'real output', ref: 57, context: ['another mod'] };
  const result = await h.call({ tool: 'Read', file_path: '/fictional/project/README.md', tool_use_id: 'read-1' }, 'engine', original);
  assert.deepEqual(result.result, original.result); assert.equal(result.ref, 57);
  assert.deepEqual(result.context, ['another mod', canonical]);
  assert.equal(h.op('ack')[0].input.outcome, 'emitted');
  assert.ok(h.trace.indexOf('ack') > h.trace.indexOf('tool-result-returned'));
  await h.flush();
  assert.equal(h.sends.length, 1, 'latest tool observation reuses the same child');
  assert.match(JSON.parse(h.sends[0].text).context, /README\.md/);
});

test('a removed or throwing context handoff is ACKed uncertain, never emitted', async () => {
  for (const mode of ['removed', 'throws']) {
    const h = harness(); await h.prompt(); await h.start(); await h.report('child-1');
    h.afterToolRun = (result) => { if (mode === 'throws') throw new Error('downstream failed'); const { context, ...rest } = result; return rest; };
    if (mode === 'throws') await assert.rejects(h.call({ tool: 'Read', tool_use_id: 'failure' }));
    else assert.equal((await h.call({ tool: 'Read', tool_use_id: 'failure' })).context, undefined);
    assert.equal(h.op('ack')[0].input.outcome, 'uncertain');
  }
});

test('new prompt retires a busy child; late report and all old tools stay blocked', async () => {
  const h = harness(); await h.prompt('old'); await h.start('old-turn');
  await h.prompt('new', { turnId: 'old-turn' });
  assert.equal(h.spawns.length, 2); assert.ok(h.stops.includes('child-1'));
  assert.ok((await h.report('child-1')).consumed);
  assert.ok((await h.call({ tool: tool('memory_search'), query: 'late', agentId: 'child-1' })).deny);
  assert.ok((await h.call({ tool: 'Bash', agentId: 'child-1' })).deny);
  await h.emit('turn.complete', { turnId: 'old-turn', reason: 'aborted' });
  assert.equal((await h.call({ tool: tool('memory_context'), agentId: 'child-2' })).deny, undefined, 'old turn completion must not cancel the queued new prompt');
  assert.equal(h.op('complete').length, 0);
});

test('a ready old decision is discarded at a new prompt and stale Go completion never enters main', async () => {
  const h = harness(); await h.prompt('old'); await h.report('child-1');
  await h.prompt('new');
  await h.start();
  assert.equal(h.op('complete').length, 0);
  await h.report('child-1'); h.completeStatus = 'stale_memory';
  const result = await h.call({ tool: 'Read', tool_use_id: 'read-stale' });
  assert.equal(result.context, undefined); assert.equal(h.op('ack').length, 0);
});

test('malformed, failed, flagged and review-error reports are all consumed without an injection', async () => {
  for (const mode of ['malformed', 'extra-key', 'failed', 'flagged', 'review-error']) {
    const h = harness(); await h.prompt(); await h.start();
    if (mode === 'flagged') h.review = 'flagged';
    if (mode === 'review-error') h.throwReview = true;
    const value = mode === 'malformed' ? 'not JSON' : mode === 'extra-key' ? { ...picked, context: 'invented instructions' } : picked;
    assert.ok((await h.report('child-1', value, mode === 'failed' ? 'failed' : 'completed')).consumed);
    assert.equal((await h.call({ tool: 'Read', tool_use_id: `read-${mode}` })).context, undefined);
    assert.equal(h.op('complete').length, 0);
  }
});

test('only successful main compaction resets epoch and all old child state', async () => {
  const h = harness(); await h.prompt(); await h.report('child-1');
  await h.emit('session.compact', { trigger: 'precompute' }, async () => ({ messages: [] }));
  await h.emit('session.compact', { trigger: 'manual' }, async () => ({ skip: 'no' }));
  await h.emit('session.compact', { trigger: 'auto', agentId: 'other-child' }, async () => ({ messages: [] }));
  assert.equal(h.op('reset').length, 0);
  await h.emit('session.compact', { trigger: 'auto' }, async () => ({ messages: [] }));
  assert.equal(h.op('reset').length, 1);
  assert.ok((await h.call({ tool: tool('memory_read'), id: 'fictional-rule', agentId: 'child-1' })).deny);
  assert.ok((await h.report('child-1')).consumed);
  await h.prompt('after compact'); assert.equal(h.spawns.length, 2);
});

test('main completion, stop and clear retire busy children without stopping unrelated agents', async () => {
  for (const ending of ['complete', 'stop', 'clear']) {
    const h = harness(); await h.prompt(); await h.start('main-active');
    h.agents.set('unrelated', { id: 'unrelated', type: 'Explore', spawnedBy: 'another-plugin', status: 'running' });
    if (ending === 'complete') await h.emit('turn.complete', { turnId: 'main-active', reason: 'answer' });
    if (ending === 'stop') await h.emit('session.stop', {});
    if (ending === 'clear') await h.emit('session.end', { sessionId: h.session, reason: 'clear' });
    assert.ok(h.stops.includes('child-1')); assert.equal(h.stops.includes('unrelated'), false);
    assert.ok(h.timers.every((timer) => timer.cancelled));
    assert.ok((await h.report('child-1')).consumed);
    assert.equal((await h.call({ tool: 'Read', tool_use_id: 'after-end' })).context, undefined);
  }
});

test('native request timeout retires child and old IDs remain guarded', async () => {
  const h = harness(); await h.prompt();
  const timer = h.timers.find((entry) => entry.ms === 45000);
  assert.ok(timer); timer.fn(); await h.flush();
  assert.ok(h.stops.includes('child-1'));
  assert.ok((await h.call({ tool: 'Bash', agentId: 'child-1' })).deny);
  assert.ok((await h.report('child-1')).consumed);
});

test('fixed model/effort has no silent fallback and no recursive memory child', async () => {
  const h = harness(); await h.prompt();
  assert.equal((await h.step('child-1')).reachedModel, true);
  assert.equal((await h.step('child-1', 'claude-other-model')).reachedModel, false);
  assert.equal((await h.step('child-1')).reachedModel, false, 'retired model stays retired');
  const h2 = harness(); await h2.prompt();
  assert.equal((await h2.step('child-1', MODEL, 'high')).reachedModel, false);
  const h3 = harness(); h3.spawnModel = 'claude-other-model'; await h3.prompt();
  assert.ok(h3.stops.includes('child-1'));
  assert.equal((await h3.step(undefined, 'main-model', 'high')).reachedModel, true);
});

test('UTF-8 observation is bounded and binary resolution supports EIN_HOME then PATH', async () => {
  const h = harness({ env: { EIN_HOME: '/fictional/ein' }, exists: ['/fictional/ein/bin/sniffer'] });
  h.messages = Array.from({ length: 12 }, () => ({ role: 'user', text: '한영🙂'.repeat(2000) }));
  await h.prompt('한영🙂'.repeat(4000));
  const begin = h.op('begin')[0];
  assert.ok(Buffer.byteLength(begin.input.query) <= 8192);
  assert.ok(Buffer.byteLength(begin.input.context) <= 24000);
  assert.equal(begin.argv[0], '/fictional/ein/bin/sniffer');
  const path = harness({ env: {} }); await path.prompt(); assert.equal(path.op('begin')[0].argv[0], 'sniffer');
});

test('bridge failure does not reject or alter the main prompt', async () => {
  const h = harness(); h.failBridge = true;
  const value = await h.prompt('continue normally');
  assert.equal(value.text, 'continue normally'); assert.equal(value.context, undefined);
  assert.equal(h.spawns.length, 0);
});

test('pending begin during clear cannot create or inject a late child', async () => {
  const h = harness(); let release;
  h.beginGate = new Promise((resolve) => { release = resolve; });
  await h.prompt('slow bridge');
  const resetting = h.emit('session.end', { sessionId: h.session, reason: 'clear' });
  release(); await resetting; await h.flush();
  assert.equal(h.spawns.length, 0);
  assert.equal(h.op('complete').length, 0);
  assert.ok(h.op('cancel').length >= 1);
});

test('queued prompt context cannot drain into the preceding main turn', async () => {
  const h = harness(); await h.prompt('old'); await h.start('old-turn');
  await h.prompt('queued new prompt', { turnId: 'old-turn', wait: true });
  await h.report('child-2');
  assert.equal((await h.call({ tool: 'Read', tool_use_id: 'old-read' })).context, undefined);
  assert.equal(h.op('complete').length, 0);
  await h.emit('turn.complete', { turnId: 'old-turn', reason: 'answer' });
  await h.start('new-turn');
  assert.deepEqual((await h.call({ tool: 'Read', tool_use_id: 'new-read' })).context, [canonical]);
});

test('dropped main prompt cancels its observer and marks any claimed delivery uncertain', async () => {
  const h = harness({ autoReport: picked });
  const result = await h.prompt('dropped', {}, async () => ({ drop: 'host rejected submission' }));
  assert.equal(result.drop, 'host rejected submission');
  assert.equal(h.op('ack')[0].input.outcome, 'uncertain');
  assert.ok(h.op('cancel').length >= 1);
});

test('prompt wait defaults to one second and accepts only integers from zero through 5000', async () => {
  for (const [configured, expected] of [[undefined, 1000], ['0', 0], ['5000', 5000], ['250', 250], ['5001', 1000], ['-1', 1000], ['1.5', 1000], ['oops', 1000]]) {
    const h = harness({ env: { EIN_SNIFFER_PROMPT_WAIT_MS: configured } });
    await h.prompt();
    assert.deepEqual(h.sleeps, expected ? [expected] : []);
  }
});

test('main prompt receives the launcher delegation guide alongside memory; the private agent retrieves independently', async () => {
  const guide = 'Fictional launcher delegation guide';
  const h = harness({ env: { EIN_SNIFFER_DELEGATE_GUIDE: guide }, autoReport: picked });
  const prompt = await h.prompt('lookup', { context: ['prior context'] });
  assert.deepEqual(prompt.context, ['prior context', guide, canonical]);
  assert.equal(h.spawns.length, 1);
  assert.ok(!h.spawns[0].prompt.includes(guide));
});
