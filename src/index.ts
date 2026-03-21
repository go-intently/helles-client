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

export type HellesErrorContext = {
  operation: 'logTraceEvent' | 'upsertTraceFlows' | 'deleteTrace';
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

const BASE_SYNC_INTERVAL_MS = 30_000;
const BACKOFF_STEP_MS = 15_000;
const MAX_SYNC_INTERVAL_MS = 180_000;
const RETRY_DELAY_MS = 3_000;
const MAX_NETWORK_ATTEMPTS = 2;

/**
 * Client for interacting with the Helles tracing service.
 * Handles trace registration, event logging, time synchronization, and trace deletion.
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
        setTimeout(() => {
          void sync(false);
        }, this.timeSync.nextIntervalMs);
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
   * Logs an event to a trace. Automatically registers the trace if it hasn't been registered yet.
   * The trace key will have the configured trace suffix appended automatically.
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
   * @returns The response data from the Helles server
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
  }): Promise<any> {
    let failedStage = 'validate';
    const _traceKey = this.applyTraceSuffix(traceKey);
    let _eventTimestampUtc: number | undefined;
    let _eventSender: string | undefined;

    try {
      if (eventTypeLabel) eventAttributes.eventTypeLabel = eventTypeLabel;
      if (eventTypeIcon) eventAttributes.eventTypeIcon = eventTypeIcon;

      const defaultTimestamp = this.defaults?.eventTimestampFunc?.() ?? this.now();
      _eventTimestampUtc =
        eventTimestampUtc !== undefined ? eventTimestampUtc : defaultTimestamp;
      if (_eventTimestampUtc === undefined) {
        throw new Error('eventTimestampUtc could not be resolved');
      }

      if (
        _eventTimestampUtc > 2565000000000 ||
        _eventTimestampUtc < 1665000000000
      ) {
        throw new Error(
          `eventTimestampUtc value ${_eventTimestampUtc} is out of range - expected Unix millisecond timestamp`
        );
      }

      _eventSender = eventSender || this.defaults?.sender;
      if (_eventSender == undefined) {
        throw new Error(`eventSender is required`);
      }

      // only register trace if it hasn't been registered yet
      if (!this.registeredTraces.has(_traceKey)) {
        failedStage = 'registerTrace';
        try {
          const registerPayload = {
            traceKey: _traceKey,
            traceType: this.defaults.traceType ?? 'TRACE',
            traceString: _traceKey
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
              throw new Error(`registerTrace err: ${errorDetails}`);
            }

            await this.drainBody(response);
          });
        } catch (error: any) {
          if (error.message?.includes('registerTrace err:')) {
            throw error;
          }
          const errorDetails = error.message || String(error);
          throw new Error(`registerTrace err: ${errorDetails}`);
        }

        this.registeredTraces.add(_traceKey);
      }

      failedStage = 'postEvent';
      const postPayload: any = {
        traceKey: _traceKey,
        eventTypeKey: eventType,
        eventString,
        eventAttributes,
        eventSender: _eventSender,
        eventTimestampUtc: _eventTimestampUtc,
        eventUniquer
      };

      if (eventPermission !== undefined) {
        postPayload.permission = eventPermission;
      }

      try {
        return await this.runWithSingleRetry(async () => {
          const response = await this.requestWithBodyGuard(`${this.hellesHost}/events`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: wf_stringify(postPayload)
          });

          if (response.statusCode >= 400) {
            const errorBody: any = await response.body.json().catch(() => ({}));
            if (typeof errorBody?.error === 'string') {
              throw new Error(`logTraceEvent err: ${errorBody.error}`);
            } else {
              const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
              throw new Error(`logTraceEvent err: ${errorDetails}`);
            }
          }

          return await response.body.json();
        });
      } catch (error: any) {
        if (typeof error?.error === 'string') {
          throw new Error(`logTraceEvent err: ${error.error}`);
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(`logTraceEvent err: ${errorDetails}`);
        }
      }
    } catch (error: any) {
      this.dispatchError(error, onError, {
        operation: 'logTraceEvent',
        stage: failedStage,
        endpoint: failedStage === 'registerTrace'
          ? '/traces'
          : failedStage === 'postEvent'
            ? '/events'
            : undefined,
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
   * @param params - Upsert parameters
   * @param params.items - Array of trace flow items to upsert. Each item must include tracekey and flow_key; other fields are optional. Use order, type, chainid, asset_label at top level; estimated and actual in nested objects.
   * @param params.items[].tracekey - Trace key (required). Normalized to uppercase on the server.
   * @param params.items[].flow_key - Flow key (required). Unique per trace.
   * @param params.items[].idempotency - Optional numeric idempotency value; lower values for the same (tracekey, flow_key) are ignored.
   * @param params.items[].order - Optional order of the flow within the trace.
   * @param params.items[].type - Optional type/category of the flow.
   * @param params.items[].chainid - Optional chain identifier.
   * @param params.items[].asset_label - Optional asset label.
   * @param params.items[].asset_decimals - Optional asset decimals (integer).
   * @param params.items[].estimated - Optional object: units, raw, usd, unitsapprox, timestamp.
   * @param params.items[].actual - Optional object: units, raw, usd, unitsapprox, timestamp, hash, entity.
   * @param params.onError - Optional error handler for this call: (error, context) => void
   * @returns The response from the Helles server: { accepted: number, skipped: number }, or undefined if onError handled the error.
   */
  async upsertTraceFlows({
    items,
    onError
  }: {
    items: TraceFlowItem[];
    onError?: HellesErrorHandler;
  }): Promise<{ accepted: number; skipped: number } | undefined> {
    let failedStage = 'validate';
    try {
      if (!Array.isArray(items) || items.length === 0) {
        throw new Error('items array is required and must be non-empty');
      }

      failedStage = 'postUpsert';
      const payload = items.map((item) => {
        const rawTraceKey = item.tracekey != null ? String(item.tracekey) : null;
        const tracekey = rawTraceKey ? this.applyTraceSuffix(rawTraceKey).toUpperCase() : null;
        const flow_key = item.flow_key != null ? String(item.flow_key) : null;
        const row = traceFlowItemToServerRow(item);
        return { ...row, tracekey, flow_key };
      });

      return await this.runWithSingleRetry(async () => {
        const response = await this.requestWithBodyGuard(`${this.hellesHost}/api/trace-flows/upsert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: wf_stringify({ items: payload })
        });

        if (response.statusCode >= 400) {
          const errorBody: any = await response.body.json().catch(() => ({}));
          if (typeof errorBody?.error === 'string') {
            throw new Error(`upsertTraceFlows err: ${errorBody.error}`);
          } else {
            const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
            throw new Error(`upsertTraceFlows err: ${errorDetails}`);
          }
        }

        const result = (await response.body.json()) as { accepted: number; skipped: number };
        return result;
      });
    } catch (error: any) {
      this.dispatchError(error, onError, {
        operation: 'upsertTraceFlows',
        stage: failedStage,
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
    let failedStage = 'validate';
    const _traceKey = this.applyTraceSuffix(traceKey);
    const normalizedTraceKey = _traceKey.toUpperCase();

    try {
      if (!this.apiKey) {
        throw new Error('API key is required for deleteTrace');
      }

      if (!traceKey) {
        throw new Error('traceKey is required');
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
              throw new Error(`deleteTrace err: ${errorBody.error}`);
            } else {
              const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
              throw new Error(`deleteTrace err: ${errorDetails}`);
            }
          }

          if (this.registeredTraces.has(normalizedTraceKey)) {
            this.registeredTraces.delete(normalizedTraceKey);
          }

          return await response.body.json();
        });
      } catch (error: any) {
        if (typeof error?.error === 'string') {
          throw new Error(`deleteTrace err: ${error.error}`);
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(`deleteTrace err: ${errorDetails}`);
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
}

