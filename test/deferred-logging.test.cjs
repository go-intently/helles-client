const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it, mock } = require('node:test');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const { HellesClient } = require('../dist/cjs/index.js');

const HOST = 'http://helles.test';

function createMockEnv() {
  const agent = new MockAgent();
  agent.disableNetConnect();
  const pool = agent.get(HOST);
  const captured = [];

  pool
    .intercept({ path: '/time', method: 'GET' })
    .reply(200, { serverUtcMilliseconds: Date.now() })
    .persist();

  const interceptJson = (path, method, statusCode, responseBody = {}) => {
    pool
      .intercept({ path, method })
      .reply((opts) => {
        let body;
        if (typeof opts.body === 'string') {
          try {
            body = JSON.parse(opts.body);
          } catch {
            body = opts.body;
          }
        }
        captured.push({ path, method, body });
        return {
          statusCode,
          data: responseBody,
          responseOptions: { headers: { 'content-type': 'application/json' } }
        };
      })
      .persist();
  };

  return { agent, pool, captured, interceptJson };
}

describe('HellesClient deferred logging', () => {
  let previousDispatcher;
  let mockEnv;
  let warnMock;

  beforeEach(() => {
    previousDispatcher = getGlobalDispatcher();
    mockEnv = createMockEnv();
    setGlobalDispatcher(mockEnv.agent);
    warnMock = mock.method(console, 'warn', () => {});
  });

  afterEach(async () => {
    setGlobalDispatcher(previousDispatcher);
    await mockEnv.agent.close();
    warnMock.mock.restore();
  });

  function makeClient(overrides = {}) {
    return new HellesClient({
      hellesHost: HOST,
      apiKey: 'test-key',
      defaults: {
        sender: 'test-sender',
        traceType: 'testTrace',
        eventTimestampFunc: overrides.eventTimestampFunc,
        onError: overrides.onError
      }
    });
  }

  it('captures eventTimestampUtc at enqueue time, not flush time', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 200, { ok: true });

    let clock = 1_700_000_000_000;
    const client = makeClient({ eventTimestampFunc: () => clock });

    const returned = await client.logTraceEvent({
      traceKey: 'deposit_1',
      eventType: 'NOTE',
      eventString: 'enqueue-time'
    });
    assert.equal(returned, undefined);
    assert.equal(
      mockEnv.captured.filter((r) => r.path === '/events').length,
      0,
      'network must not run on caller turn'
    );

    clock = 1_800_000_000_000;
    await client.flush();

    const eventPosts = mockEnv.captured.filter((r) => r.path === '/events');
    assert.equal(eventPosts.length, 1);
    assert.equal(eventPosts[0].body.eventTimestampUtc, 1_700_000_000_000);
  });

  it('does not mutate caller eventAttributes', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 200, { ok: true });

    const client = makeClient();
    const eventAttributes = { amount: 1000 };

    await client.logTraceEvent({
      traceKey: 'deposit_2',
      eventType: 'NOTE',
      eventAttributes,
      eventTypeLabel: 'Alert',
      eventTypeIcon: 'x'
    });
    await client.flush();

    assert.equal(eventAttributes.eventTypeLabel, undefined);
    assert.equal(eventAttributes.eventTypeIcon, undefined);
    assert.deepEqual(eventAttributes, { amount: 1000 });

    const eventPosts = mockEnv.captured.filter((r) => r.path === '/events');
    assert.equal(eventPosts[0].body.eventAttributes.eventTypeLabel, 'Alert');
    assert.equal(eventPosts[0].body.eventAttributes.eventTypeIcon, 'x');
    assert.equal(eventPosts[0].body.eventAttributes.amount, 1000);
  });

  it('resolves logTraceEvent before flush network work', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 200, { ok: true });

    const client = makeClient();
    const done = await client.logTraceEvent({
      traceKey: 'deposit_3',
      eventType: 'NOTE'
    });

    assert.equal(done, undefined);
    assert.equal(mockEnv.captured.length, 0);

    await client.flush();
    assert.ok(mockEnv.captured.some((r) => r.path === '/events'));
  });

  it('calls onError on flush failure and does not reject logTraceEvent', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 500, { error: 'boom' });

    const errors = [];
    const client = makeClient({
      onError: (error) => {
        errors.push(error);
      }
    });

    await assert.doesNotReject(async () => {
      await client.logTraceEvent({
        traceKey: 'deposit_4',
        eventType: 'NOTE'
      });
    });

    await client.flush();
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /boom/);
  });

  it('warns and swallows flush failure when no onError handler', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 500, { error: 'no-handler' });

    const client = makeClient();
    await client.logTraceEvent({
      traceKey: 'deposit_5',
      eventType: 'NOTE'
    });
    await client.flush();

    assert.ok(
      warnMock.mock.calls.some((call) =>
        String(call.arguments[0] ?? '').includes('no onError handler')
      )
    );
  });

  it('registers a new trace once, then posts events', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 200, { ok: true });

    const client = makeClient();
    await client.logTraceEvent({ traceKey: 'deposit_6', eventType: 'NOTE', eventString: 'a' });
    await client.logTraceEvent({ traceKey: 'deposit_6', eventType: 'NOTE', eventString: 'b' });
    await client.flush();

    const registers = mockEnv.captured.filter((r) => r.path === '/traces');
    const events = mockEnv.captured.filter((r) => r.path === '/events');
    assert.equal(registers.length, 1);
    assert.equal(events.length, 2);
  });

  it('validates missing eventSender on the caller turn', async () => {
    const client = new HellesClient({
      hellesHost: HOST,
      defaults: {}
    });

    await assert.rejects(
      () =>
        client.logTraceEvent({
          traceKey: 'deposit_7',
          eventType: 'NOTE'
        }),
      /eventSender is required/
    );
    assert.equal(mockEnv.captured.length, 0);
  });

  it('does not mutate upsertTraceFlows items (shallow + nested estimated/actual)', async () => {
    mockEnv.interceptJson('/api/trace-flows/upsert', 'POST', 200, { accepted: 1, skipped: 0 });

    const client = makeClient();
    const estimated = { units: '1', timestamp: 1_700_000_000_000 };
    const items = [
      {
        tracekey: 'deposit_8',
        flow_key: 'flow_a',
        estimated
      }
    ];

    const returned = await client.upsertTraceFlows({ items });
    assert.equal(returned, undefined);
    assert.equal(mockEnv.captured.length, 0);

    estimated.units = 'mutated';
    await client.flush();

    const upserts = mockEnv.captured.filter((r) => r.path === '/api/trace-flows/upsert');
    assert.equal(upserts.length, 1);
    assert.equal(upserts[0].body.items[0].flow_units_estimated, '1');
    assert.equal(items[0].estimated.units, 'mutated');
  });

  it('flushes pending events before deleteTrace', async () => {
    mockEnv.interceptJson('/traces', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/events', 'POST', 200, { ok: true });
    mockEnv.interceptJson('/traces/delete', 'POST', 200, { ok: true });

    const client = makeClient();
    await client.logTraceEvent({
      traceKey: 'deposit_9',
      eventType: 'NOTE'
    });

    assert.equal(mockEnv.captured.filter((r) => r.path === '/events').length, 0);

    await client.deleteTrace({ traceKey: 'deposit_9' });

    const paths = mockEnv.captured.map((r) => r.path);
    const eventIdx = paths.indexOf('/events');
    const deleteIdx = paths.indexOf('/traces/delete');
    assert.ok(eventIdx >= 0);
    assert.ok(deleteIdx >= 0);
    assert.ok(eventIdx < deleteIdx, 'event must post before delete');
  });
});
