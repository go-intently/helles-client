import { request } from 'undici';

/**
 * JSON.stringify replacement. Handles BigInts
 * @param obj - The object to stringify.
 * @returns The stringified object.
 */
export function wf_stringify(obj: any): string {
  return JSON.stringify(obj, (key, value) =>
    typeof value === 'bigint' ? value.toString() : value
  );
}

/**
 * Returns the current time in milliseconds, optionally adjusted by an offset.
 * @param offsetMilliseconds - Optional offset to add to the current time
 * @returns Current timestamp in milliseconds plus the offset
 */
export function now(offsetMilliseconds: number = 0): number {
  return Date.now() + offsetMilliseconds;
}

/**
 * Internal state for time synchronization with the Helles server.
 */
type TimeSyncState = {
  latency: number | null;
  offset: number;
  lastCheck: number | null;
  nextIntervalMs: number;
};

export type TraceShareResult = {
  traceKey: string;
  shareKey: string;
  shareUrl: string;
};

export type HellesErrorContext = {
  operation: 'logTraceEvent' | 'upsertTraceFlows' | 'deleteTrace' | 'traceShare';
  stage?: string;
  endpoint?: string;
  statusCode?: number;
  params?: Record<string, unknown>;
};

export type HellesError = Error & {
  hellesContext?: HellesErrorContext;
};

export type HellesErrorHandler = (error: HellesError, context?: HellesErrorContext) => void;

/**
 * One row for the trace-flows upsert endpoint. tracekey and flow_key are required;
 * other fields are optional. estimated/actual are nested; top-level fields have no "flow_" prefix.
 */
export type TraceFlowItem = {
  tracekey: string;
  flow_key: string;
  idempotency?: number;
  order?: number | null;
  type?: string | null;
  chainid?: number | string | null;
  asset_label?: string | null;
  asset_decimals?: number | null;
  estimated?: {
    units?: number | string | null;
    raw?: number | string | null;
    usd?: number | string | null;
    unitsapprox?: number | string | null;
    timestamp?: number | null;
  } | null;
  actual?: {
    units?: number | string | null;
    raw?: number | string | null;
    usd?: number | string | null;
    unitsapprox?: number | string | null;
    timestamp?: number | null;
    hash?: string | null;
    entity?: string | null;
  } | null;
};

type QueuedEvent = {
  traceKey: string;
  resolvedTraceKey: string;
  eventType: string;
  eventString?: string;
  eventSender: string;
  eventAttributes: Record<string, unknown>;
  eventTimestampUtc: number;
  eventUniquer?: string;
  eventTypeLabel?: string;
  eventTypeIcon?: string;
  eventPermission?: string;
  onError?: HellesErrorHandler;
};

type QueuedFlowUpsert = {
  items: TraceFlowItem[];
  onError?: HellesErrorHandler;
};

function formatHellesOpError(
  operation: string,
  err: string,
  context?: { type?: string; key?: string }
): string {
  const parts: string[] = [operation];
  if (context?.type != null && context.type !== '') {
    parts.push(`type=${context.type}`);
  }
  if (context?.key != null && context.key !== '') {
    parts.push(`key=${context.key}`);
  }
  parts.push(`err=${err}`);
  return parts.join(', ');
}

function normalizeTimestamp(v: unknown): unknown {
  if (v == null) return v;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+\.?\d*$/.test(v) ? Number(v) : NaN;
  if (!Number.isFinite(n)) return v;
  return new Date(Math.floor(n)).toISOString();
}

function traceFlowItemToServerRow(item: TraceFlowItem): Record<string, unknown> {
  const e = item.estimated;
  const a = item.actual;
  return {
    tracekey: item.tracekey,
    flow_key: item.flow_key,
    idempotency: item.idempotency,
    flow_order: item.order,
    flow_type: item.type,
    flow_chainid: item.chainid,
    flow_asset_label: item.asset_label,
    flow_asset_decimals: item.asset_decimals,
    flow_units_estimated: e?.units,
    flow_raw_estimated: e?.raw,
    flow_usd_estimated: e?.usd,
    flow_unitsapprox_estimated: e?.unitsapprox,
    flow_timestamp_estimated: normalizeTimestamp(e?.timestamp),
    flow_units_actual: a?.units,
    flow_raw_actual: a?.raw,
    flow_usd_actual: a?.usd,
    flow_unitsapprox_actual: a?.unitsapprox,
    flow_timestamp_actual: normalizeTimestamp(a?.timestamp),
    flow_hash_actual: a?.hash,
    flow_entity_actual: a?.entity
  };
}

function copyTraceFlowItem(item: TraceFlowItem): TraceFlowItem {
  return {
    ...item,
    estimated: item.estimated != null ? { ...item.estimated } : item.estimated,
    actual: item.actual != null ? { ...item.actual } : item.actual
  };
}

const BASE_SYNC_INTERVAL_MS = 30_000;
const BACKOFF_STEP_MS = 15_000;
const MAX_SYNC_INTERVAL_MS = 180_000;
const RETRY_DELAY_MS = 3_000;
const MAX_NETWORK_ATTEMPTS = 2;

/**
 * Client for interacting with the Helles tracing service.
 * Handles trace registration, event logging, time synchronization, and trace deletion.
 *
 * `logTraceEvent` and `upsertTraceFlows` enqueue work and return immediately; network I/O
 * runs on a deferred flush. Call `flush()` to drain pending work (also runs automatically
 * before `deleteTrace` / `traceShare`, and best-effort on `process.beforeExit`).
 */
export class HellesClient {
  private hellesHost: string;
  private apiKey?: string;
  private defaults: {
    sender?: string;
    traceType?: string;
    eventTimestampFunc?: () => number;
    onError?: HellesErrorHandler;
    traceSuffix?: string;
  };
  private registeredTraces: Set<string> = new Set();
  private timeSync: TimeSyncState = {
    latency: null,
    offset: 0,
    lastCheck: null,
    nextIntervalMs: BASE_SYNC_INTERVAL_MS
  };

  private eventQueue: QueuedEvent[] = [];
  private flowQueue: QueuedFlowUpsert[] = [];
  private flushScheduled = false;
  private activeFlush: Promise<void> | null = null;

  /**
   * Wraps undici request and installs a body error listener to prevent
   * unhandled stream errors from crashing the process.
   */
  private async requestWithBodyGuard(url: string, options: Parameters<typeof request>[1]) {
    const response = await request(url, options);
    response.body?.on?.('error', () => {
      // Keep process alive for transient socket/body stream errors.
      // Callers still receive failures via awaited body reads.
    });
    return response;
  }

  /**
   * Drains an unused response body to avoid dangling stream issues.
   */
  private async drainBody(response: Awaited<ReturnType<typeof request>>): Promise<void> {
    try {
      await response.body.dump();
    } catch {
      // Best-effort cleanup only.
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  private isRetryableNetworkError(error: any): boolean {
    const code = error?.code;
    const message = (error?.message ?? '').toLowerCase();

    if (
      code === 'UND_ERR_SOCKET' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'UND_ERR_CONNECT_TIMEOUT' ||
      code === 'UND_ERR_HEADERS_TIMEOUT' ||
      code === 'UND_ERR_BODY_TIMEOUT'
    ) {
      return true;
    }

    return (
      message.includes('other side closed') ||
      message.includes('socket hang up') ||
      message.includes('connection reset')
    );
  }

  private async runWithSingleRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        const canRetry =
          attempt < MAX_NETWORK_ATTEMPTS && this.isRetryableNetworkError(error);

        if (!canRetry) {
          throw error;
        }

        console.warn(
          `HellesClient transient network error, retrying in ${RETRY_DELAY_MS}ms: ${
            (error as any)?.message ?? String(error)
          }`
        );
        await this.sleep(RETRY_DELAY_MS);
      }
    }

    throw lastError;
  }

  /**
   * Creates a new HellesClient instance.
   * @param config - Configuration object
   * @param config.hellesHost - Base URL of the Helles server (trailing slash will be removed)
   * @param config.apiKey - Optional API key required for certain operations
   * @param config.defaults - Default values for trace operations
   * @param config.defaults.sender - Default sender identifier for events
   * @param config.defaults.traceType - Default trace type label EG: "acxDeposit"
   * @param config.defaults.eventTimestampFunc - Optional function to generate event timestamps (defaults to timesync now())
   * @param config.defaults.onError - Optional global error handler for trace operations
   * @param config.defaults.traceSuffix - Optional suffix to append to all trace keys for isolation (e.g., "test" to separate test traces from production)
   */
  constructor(config: {
    hellesHost: string;
    apiKey?: string;
    defaults: {
      sender?: string;
      traceType?: string;
      eventTimestampFunc?: () => number;
      onError?: HellesErrorHandler;
      traceSuffix?: string;
    };
  }) {
    this.hellesHost = config.hellesHost.endsWith('/')
      ? config.hellesHost.slice(0, -1)
      : config.hellesHost;
    this.apiKey = config.apiKey;
    this.defaults = config.defaults;
    this.registeredTraces = new Set();
    this.startTimeSync();
    this.installBeforeExitHook();
  }

  private installBeforeExitHook(): void {
    if (typeof process === 'undefined' || typeof process.on !== 'function') {
      return;
    }

    process.on('beforeExit', () => {
      if (
        this.eventQueue.length === 0 &&
        this.flowQueue.length === 0 &&
        !this.activeFlush &&
        !this.flushScheduled
      ) {
        return;
      }
      void this.flush();
    });
  }

  /**
   * Applies the configured trace suffix to a trace key if one is set.
   * @param traceKey - The original trace key
   * @returns The trace key with suffix appended if configured
   */
  private applyTraceSuffix(traceKey: string): string {
    const suffix = this.defaults.traceSuffix;
    return suffix ? `${traceKey}${suffix}` : traceKey;
  }

  /**
   * Gets the current time synchronization state.
   * @returns A copy of the current time sync state
   */
  public getTimeSync(): TimeSyncState {
    return { ...this.timeSync };
  }

  /**
   * Returns the current time adjusted by the server's time offset.
   * @returns Current timestamp in milliseconds synchronized with the Helles server
   */
  public now(): number {
    return now(this.timeSync.offset);
  }

  /**
   * Starts the time synchronization process with the Helles server.
   * Performs an initial sync as a health check, then continues syncing at intervals.
   * Uses exponential backoff on failures.
   */
  private startTimeSync(): void {
    const sync = async (isInitial: boolean) => {
      const sendTime = Date.now();

      try {
        const { receiveTime, latency, serverUtcMilliseconds } = await this.runWithSingleRetry(async () => {
          const response = await this.requestWithBodyGuard(`${this.hellesHost}/time`, {
            method: 'GET'
          });

          const receiveTime = Date.now();
          const rtt = receiveTime - sendTime;
          const latency = rtt / 2;

          const body = await response.body.json() as { serverUtcMilliseconds?: number };
          return {
            receiveTime,
            latency,
            serverUtcMilliseconds: body?.serverUtcMilliseconds
          };
        });

        if (typeof serverUtcMilliseconds === 'number') {
          const clientTimeAtServer = receiveTime - latency;
          const offset = serverUtcMilliseconds - clientTimeAtServer;

          this.timeSync = {
            latency,
            offset,
            lastCheck: receiveTime,
            nextIntervalMs: BASE_SYNC_INTERVAL_MS
          };
        } else {
          console.warn(
            'HellesClient time sync: invalid /time response payload',
            { serverUtcMilliseconds }
          );
          this.incrementBackoff();
        }
      } catch (error: any) {
        const message = error?.message ?? String(error);
        const phase = isInitial ? 'initial' : 'scheduled';
        console.warn(`HellesClient ${phase} time sync failed: ${message}`);
        this.incrementBackoff();
      } finally {
        const timer = setTimeout(() => {
          void sync(false);
        }, this.timeSync.nextIntervalMs);
        timer.unref?.();
      }
    };

    // fire-and-forget initial sync, also serves as startup health check
    void sync(true);
  }

  /**
   * Increases the time sync interval using exponential backoff.
   * Called when time sync requests fail.
   */
  private incrementBackoff(): void {
    const increased = this.timeSync.nextIntervalMs + BACKOFF_STEP_MS;
    const nextIntervalMs = Math.min(increased, MAX_SYNC_INTERVAL_MS);

    this.timeSync = {
      ...this.timeSync,
      nextIntervalMs
    };
  }

  /**
   * Dispatches operation errors to local/global handlers with optional context.
   * If no handler exists, the error is rethrown.
   * Used for synchronous validation on the caller turn.
   */
  private dispatchError(error: unknown, onError?: HellesErrorHandler, context?: HellesErrorContext): never | void {
    const normalized: HellesError =
      error instanceof Error ? (error as HellesError) : (new Error(String(error)) as HellesError);

    if (context) {
      normalized.hellesContext = context;
    }

    const handler = onError ?? this.defaults?.onError;
    if (handler) {
      handler(normalized, context);
      return;
    }

    throw normalized;
  }

  /**
   * Reports flush-path errors. Calls onError / defaults.onError when present;
   * otherwise console.warns and swallows (never throws, never rejects the caller).
   */
  private reportFlushError(
    error: unknown,
    onError?: HellesErrorHandler,
    context?: HellesErrorContext
  ): void {
    const normalized: HellesError =
      error instanceof Error ? (error as HellesError) : (new Error(String(error)) as HellesError);

    if (context) {
      normalized.hellesContext = context;
    }

    const handler = onError ?? this.defaults?.onError;
    if (handler) {
      try {
        handler(normalized, context);
      } catch (handlerError) {
        console.warn(
          'HellesClient onError handler threw:',
          (handlerError as any)?.message ?? String(handlerError)
        );
      }
      return;
    }

    console.warn(
      `HellesClient ${context?.operation ?? 'flush'} failed (no onError handler): ${normalized.message}`
    );
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      void this.runFlush();
    });
  }

  private runFlush(): Promise<void> {
    if (this.activeFlush) {
      return this.activeFlush.then(() => {
        if (this.eventQueue.length > 0 || this.flowQueue.length > 0) {
          return this.runFlush();
        }
      });
    }

    this.activeFlush = this.flushQueues().finally(() => {
      this.activeFlush = null;
    });

    return this.activeFlush.then(() => {
      if (this.eventQueue.length > 0 || this.flowQueue.length > 0) {
        this.scheduleFlush();
      }
    });
  }

  /**
   * Drains pending `logTraceEvent` / `upsertTraceFlows` work.
   * Safe to call for tests, graceful shutdown, or before operations that must
   * observe prior events (also invoked automatically before delete/share).
   */
  public async flush(): Promise<void> {
    for (;;) {
      if (this.activeFlush) {
        await this.activeFlush;
        continue;
      }

      if (this.eventQueue.length > 0 || this.flowQueue.length > 0) {
        await this.runFlush();
        continue;
      }

      if (this.flushScheduled) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }

      break;
    }
  }

  private async flushQueues(): Promise<void> {
    const events = this.eventQueue.splice(0, this.eventQueue.length);
    const flows = this.flowQueue.splice(0, this.flowQueue.length);

    for (const queued of events) {
      await this.flushQueuedEvent(queued);
    }

    for (const queued of flows) {
      await this.flushQueuedFlowUpsert(queued);
    }
  }

  private async flushQueuedEvent(queued: QueuedEvent): Promise<void> {
    const {
      traceKey,
      resolvedTraceKey,
      eventType,
      eventString,
      eventSender,
      eventAttributes,
      eventTimestampUtc,
      eventUniquer,
      eventTypeLabel,
      eventTypeIcon,
      eventPermission,
      onError
    } = queued;

    const logEventError = (err: string) =>
      formatHellesOpError('logTraceEvent', err, { type: eventType, key: resolvedTraceKey });

    const errorParams = {
      traceKey,
      resolvedTraceKey,
      eventType,
      eventString,
      eventSender,
      resolvedEventSender: eventSender,
      eventTimestampUtc,
      resolvedEventTimestampUtc: eventTimestampUtc,
      eventUniquer,
      eventTypeLabel,
      eventTypeIcon,
      eventPermission,
      eventAttributesKeys:
        eventAttributes && typeof eventAttributes === 'object'
          ? Object.keys(eventAttributes)
          : []
    };

    try {
      if (!this.registeredTraces.has(resolvedTraceKey)) {
        try {
          const registerPayload = {
            traceKey: resolvedTraceKey,
            traceType: this.defaults.traceType ?? 'TRACE',
            traceString: resolvedTraceKey
          };

          await this.runWithSingleRetry(async () => {
            const response = await this.requestWithBodyGuard(`${this.hellesHost}/traces`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: wf_stringify(registerPayload)
            });

            if (response.statusCode >= 400) {
              const errorBody = await response.body.json().catch(() => ({}));
              const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
              throw new Error(
                formatHellesOpError('registerTrace', errorDetails, {
                  type: eventType,
                  key: resolvedTraceKey
                })
              );
            }

            await this.drainBody(response);
          });
        } catch (error: any) {
          if (error.message?.startsWith('registerTrace ')) {
            throw error;
          }
          const errorDetails = error.message || String(error);
          throw new Error(
            formatHellesOpError('registerTrace', errorDetails, {
              type: eventType,
              key: resolvedTraceKey
            })
          );
        }

        this.registeredTraces.add(resolvedTraceKey);
      }

      const postPayload: any = {
        traceKey: resolvedTraceKey,
        eventTypeKey: eventType,
        eventString,
        eventAttributes,
        eventSender,
        eventTimestampUtc,
        eventUniquer
      };

      if (eventPermission !== undefined) {
        postPayload.permission = eventPermission;
      }

      try {
        await this.runWithSingleRetry(async () => {
          const response = await this.requestWithBodyGuard(`${this.hellesHost}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: wf_stringify(postPayload)
          });

          if (response.statusCode >= 400) {
            const errorBody: any = await response.body.json().catch(() => ({}));
            if (typeof errorBody?.error === 'string') {
              throw new Error(logEventError(errorBody.error));
            } else {
              const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
              throw new Error(logEventError(errorDetails));
            }
          }

          await this.drainBody(response);
        });
      } catch (error: any) {
        if (error.message?.startsWith('logTraceEvent ')) {
          throw error;
        }
        if (typeof error?.error === 'string') {
          throw new Error(logEventError(error.error));
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(logEventError(errorDetails));
        }
      }
    } catch (error: any) {
      const stage = typeof error?.message === 'string' && error.message.startsWith('registerTrace ')
        ? 'registerTrace'
        : 'postEvent';

      this.reportFlushError(error, onError, {
        operation: 'logTraceEvent',
        stage,
        endpoint: stage === 'registerTrace' ? '/traces' : '/events',
        params: errorParams
      });
    }
  }

  private async flushQueuedFlowUpsert(queued: QueuedFlowUpsert): Promise<void> {
    const { items, onError } = queued;

    try {
      const payload = items.map((item) => {
        const rawTraceKey = item.tracekey != null ? String(item.tracekey) : null;
        const tracekey = rawTraceKey ? this.applyTraceSuffix(rawTraceKey).toUpperCase() : null;
        const flow_key = item.flow_key != null ? String(item.flow_key) : null;
        const row = traceFlowItemToServerRow(item);
        return { ...row, tracekey, flow_key };
      });
      const upsertTraceKeys = [
        ...new Set(
          payload
            .map((row) => row.tracekey)
            .filter((tracekey): tracekey is string => tracekey != null && tracekey !== '')
        )
      ].join(',');

      const upsertFlowError = (err: string) =>
        formatHellesOpError('upsertTraceFlows', err, { key: upsertTraceKeys || undefined });

      await this.runWithSingleRetry(async () => {
        const response = await this.requestWithBodyGuard(`${this.hellesHost}/api/trace-flows/upsert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: wf_stringify({ items: payload })
        });

        if (response.statusCode >= 400) {
          const errorBody: any = await response.body.json().catch(() => ({}));
          if (typeof errorBody?.error === 'string') {
            throw new Error(upsertFlowError(errorBody.error));
          } else {
            const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
            throw new Error(upsertFlowError(errorDetails));
          }
        }

        await this.drainBody(response);
      });
    } catch (error: any) {
      this.reportFlushError(error, onError, {
        operation: 'upsertTraceFlows',
        stage: 'postUpsert',
        endpoint: '/api/trace-flows/upsert',
        params: {
          itemsCount: Array.isArray(items) ? items.length : 0,
          sample: Array.isArray(items) && items[0]
            ? { tracekey: items[0].tracekey, flow_key: items[0].flow_key }
            : null
        }
      });
    }
  }

  /**
   * Logs an event to a trace. Automatically registers the trace if it hasn't been registered yet.
   * The trace key will have the configured trace suffix appended automatically.
   *
   * Enqueues the event and returns immediately (resolved Promise). Network I/O runs on a
   * deferred flush. Timestamps are captured at call time. Happy-path return value is always
   * `undefined` (server body is not returned). Flush failures go to onError / defaults.onError,
   * or are console.warn'd when no handler is set — they never reject this Promise.
   *
   * Sync validation failures (missing sender, bad timestamp) still use throw-or-onError on
   * the caller turn.
   *
   * @param params - Event parameters
   * @param params.traceKey - The trace key to log the event to EG: "deposit_1234567"
   * @param params.eventType - Type identifier for the event EG: "NOTE"
   * @param params.eventString - Optional string description of the event
   * @param params.eventSender - Optional sender identifier (defaults to config.defaults.sender)
   * @param params.eventAttributes - Optional additional attributes to attach to the event
   * @param params.eventTimestampUtc - Optional timestamp in UTC milliseconds (defaults to eventTimestampFunc from config)
   * @param params.eventUniquer - Optional unique identifier for event deduplication (IE: You can send multiple times & it wont dupe)
   * @param params.eventTypeLabel - Optional overriding human-readable label for the event type EG: "Note" becomes "Alert"
   * @param params.eventTypeIcon - Optional overriding icon for the event type EG: "🎯"
   * @param params.eventPermission - Optional permission identifier for this event
   * @param params.onError - Optional error handler function: (error, context) => void
   * @returns Always resolves to undefined on the happy path (after enqueue)
   */
  async logTraceEvent({
    traceKey,
    eventType,
    eventString,
    eventSender,
    eventAttributes = {},
    eventTimestampUtc,
    eventUniquer,
    eventTypeIcon,
    eventTypeLabel,
    eventPermission,
    onError
  }: {
    traceKey: string;
    eventType: string;
    eventString?: string;
    eventSender?: string;
    eventAttributes?: any;
    eventTimestampUtc?: number;
    eventUniquer?: string;
    eventTypeLabel?: string;
    eventTypeIcon?: string;
    eventPermission?: string;
    onError?: HellesErrorHandler;
  }): Promise<undefined> {
    const _traceKey = this.applyTraceSuffix(traceKey);
    let _eventTimestampUtc: number | undefined;
    let _eventSender: string | undefined;

    try {
      const attrs: Record<string, unknown> = { ...(eventAttributes ?? {}) };
      if (eventTypeLabel) attrs.eventTypeLabel = eventTypeLabel;
      if (eventTypeIcon) attrs.eventTypeIcon = eventTypeIcon;

      const defaultTimestamp = this.defaults?.eventTimestampFunc?.() ?? this.now();
      _eventTimestampUtc =
        eventTimestampUtc !== undefined ? eventTimestampUtc : defaultTimestamp;
      const logEventError = (err: string) =>
        formatHellesOpError('logTraceEvent', err, { type: eventType, key: _traceKey });

      if (_eventTimestampUtc === undefined) {
        throw new Error(logEventError('eventTimestampUtc could not be resolved'));
      }

      if (
        _eventTimestampUtc > 2565000000000 ||
        _eventTimestampUtc < 1665000000000
      ) {
        throw new Error(
          logEventError(
            `eventTimestampUtc value ${_eventTimestampUtc} is out of range - expected Unix millisecond timestamp`
          )
        );
      }

      _eventSender = eventSender || this.defaults?.sender;
      if (_eventSender == undefined) {
        throw new Error(logEventError('eventSender is required'));
      }

      this.eventQueue.push({
        traceKey,
        resolvedTraceKey: _traceKey,
        eventType,
        eventString,
        eventSender: _eventSender,
        eventAttributes: attrs,
        eventTimestampUtc: _eventTimestampUtc,
        eventUniquer,
        eventTypeLabel,
        eventTypeIcon,
        eventPermission,
        onError
      });
      this.scheduleFlush();
      return undefined;
    } catch (error: any) {
      this.dispatchError(error, onError, {
        operation: 'logTraceEvent',
        stage: 'validate',
        params: {
          traceKey,
          resolvedTraceKey: _traceKey,
          eventType,
          eventString,
          eventSender,
          resolvedEventSender: _eventSender,
          eventTimestampUtc,
          resolvedEventTimestampUtc: _eventTimestampUtc,
          eventUniquer,
          eventTypeLabel,
          eventTypeIcon,
          eventPermission,
          eventAttributesKeys:
            eventAttributes && typeof eventAttributes === 'object'
              ? Object.keys(eventAttributes)
              : []
        }
      });
    }
  }

  /**
   * Upserts trace flow rows for one or more traces. Sends items to the Helles trace-flows upsert endpoint.
   * Each item must have tracekey and flow_key; tracekey is normalized to uppercase. Items with missing
   * tracekey or flow_key are skipped (counted in response.skipped). Optional idempotency values allow
   * the server to ignore older duplicates.
   *
   * Enqueues the upsert and returns immediately. Network I/O runs on a deferred flush.
   * Happy-path return value is always `undefined` (server `{ accepted, skipped }` is not returned).
   * Flush failures go to onError / defaults.onError, or are console.warn'd when no handler is set.
   *
   * @param params - Upsert parameters
   * @param params.items - Array of trace flow items to upsert. Each item must include tracekey and flow_key; other fields are optional. Use order, type, chainid, asset_label at top level; estimated and actual in nested objects.
   * @param params.onError - Optional error handler for this call: (error, context) => void
   * @returns Always resolves to undefined on the happy path (after enqueue)
   */
  async upsertTraceFlows({
    items,
    onError
  }: {
    items: TraceFlowItem[];
    onError?: HellesErrorHandler;
  }): Promise<undefined> {
    try {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('items array is required and must be non-empty');
      }

      this.flowQueue.push({
        items: items.map(copyTraceFlowItem),
        onError
      });
      this.scheduleFlush();
      return undefined;
    } catch (error: any) {
      this.dispatchError(error, onError, {
        operation: 'upsertTraceFlows',
        stage: 'validate',
        endpoint: '/api/trace-flows/upsert',
        params: {
          itemsCount: Array.isArray(items) ? items.length : 0,
          sample: Array.isArray(items) && items[0]
            ? { tracekey: items[0].tracekey, flow_key: items[0].flow_key }
            : null
        }
      });
    }
  }

  /**
   * Deletes a trace from the Helles server.
   * Flushes pending events/flows first so delete cannot race ahead of deferred posts.
   * The trace key will have the configured trace suffix appended automatically.
   * Requires an API key to be configured in the constructor.
   * @param params - Delete parameters
   * @param params.traceKey - The trace key to delete
   * @param params.onError - Optional error handler for this specific operation: (error, context) => void
   * @returns The response data from the Helles server
   */
  async deleteTrace({
    traceKey,
    onError
  }: {
    traceKey: string;
    onError?: HellesErrorHandler;
  }): Promise<any> {
    await this.flush();

    let failedStage = 'validate';
    const _traceKey = this.applyTraceSuffix(traceKey);
    const normalizedTraceKey = _traceKey.toUpperCase();

    const deleteTraceError = (err: string) =>
      formatHellesOpError('deleteTrace', err, { key: normalizedTraceKey });

    try {
      if (!this.apiKey) {
        throw new Error(deleteTraceError('API key is required for deleteTrace'));
      }

      if (!traceKey) {
        throw new Error(deleteTraceError('traceKey is required'));
      }

      try {
        failedStage = 'postDelete';
        const deletePayload = {
          apiKey: this.apiKey,
          traceKey: normalizedTraceKey
        };

        return await this.runWithSingleRetry(async () => {
          const response = await this.requestWithBodyGuard(`${this.hellesHost}/traces/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: wf_stringify(deletePayload)
          });

          if (response.statusCode >= 400) {
            const errorBody: any = await response.body.json().catch(() => ({}));
            if (typeof errorBody?.error === 'string') {
              throw new Error(deleteTraceError(errorBody.error));
            } else {
              const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
              throw new Error(deleteTraceError(errorDetails));
            }
          }

          if (this.registeredTraces.has(normalizedTraceKey)) {
            this.registeredTraces.delete(normalizedTraceKey);
          }

          return await response.body.json();
        });
      } catch (error: any) {
        if (error.message?.startsWith('deleteTrace ')) {
          throw error;
        }
        if (typeof error?.error === 'string') {
          throw new Error(deleteTraceError(error.error));
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(deleteTraceError(errorDetails));
        }
      }
    } catch (error: any) {
      this.dispatchError(error, onError, {
        operation: 'deleteTrace',
        stage: failedStage,
        endpoint: '/traces/delete',
        params: {
          traceKey,
          resolvedTraceKey: _traceKey,
          normalizedTraceKey,
          hasApiKey: Boolean(this.apiKey)
        }
      });
    }
  }

  /**
   * Creates a share link for a trace. Requires an API key configured in the constructor.
   * Flushes pending events/flows first so share cannot race ahead of deferred posts.
   * The trace key will have the configured trace suffix appended automatically.
   * @param params - Share parameters
   * @param params.traceKey - The trace key to share
   * @param params.onError - Optional error handler for this specific operation: (error, context) => void
   * @returns The share response: { traceKey, shareKey, shareUrl }
   */
  async traceShare({
    traceKey,
    onError
  }: {
    traceKey: string;
    onError?: HellesErrorHandler;
  }): Promise<TraceShareResult | undefined> {
    await this.flush();

    let failedStage = 'validate';
    const _traceKey = this.applyTraceSuffix(traceKey);
    const normalizedTraceKey = _traceKey.toUpperCase();

    const traceShareError = (err: string) =>
      formatHellesOpError('traceShare', err, { key: normalizedTraceKey });

    try {
      if (!this.apiKey) {
        throw new Error(traceShareError('API key is required for traceShare'));
      }

      if (!traceKey) {
        throw new Error(traceShareError('traceKey is required'));
      }

      try {
        failedStage = 'postShare';
        return await this.runWithSingleRetry(async () => {
          const response = await this.requestWithBodyGuard(
            `${this.hellesHost}/api/traces/${encodeURIComponent(normalizedTraceKey)}/share`,
            {
              method: 'POST',
              headers: { Cookie: `apiKey=${this.apiKey}` }
            }
          );

          if (response.statusCode >= 400) {
            const errorBody: any = await response.body.json().catch(() => ({}));
            if (typeof errorBody?.error === 'string') {
              throw new Error(traceShareError(errorBody.error));
            } else {
              const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
              throw new Error(traceShareError(errorDetails));
            }
          }

          return (await response.body.json()) as TraceShareResult;
        });
      } catch (error: any) {
        if (error.message?.startsWith('traceShare ')) {
          throw error;
        }
        if (typeof error?.error === 'string') {
          throw new Error(traceShareError(error.error));
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(traceShareError(errorDetails));
        }
      }
    } catch (error: any) {
      this.dispatchError(error, onError, {
        operation: 'traceShare',
        stage: failedStage,
        endpoint: `/api/traces/${normalizedTraceKey}/share`,
        params: {
          traceKey,
          resolvedTraceKey: _traceKey,
          normalizedTraceKey,
          hasApiKey: Boolean(this.apiKey)
        }
      });
    }
  }
}
