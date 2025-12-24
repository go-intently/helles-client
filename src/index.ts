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

const BASE_SYNC_INTERVAL_MS = 30_000;
const BACKOFF_STEP_MS = 15_000;
const MAX_SYNC_INTERVAL_MS = 180_000;

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
    onError?: (error: any) => void;
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
      onError?: (error: any) => void;
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
        const response = await request(`${this.hellesHost}/time`, {
          method: 'GET'
        });

        const receiveTime = Date.now();
        const rtt = receiveTime - sendTime;
        const latency = rtt / 2;

        const body = await response.body.json() as { serverUtcMilliseconds?: number };
        const serverUtcMilliseconds = body?.serverUtcMilliseconds;

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
          console.warn('HellesClient time sync: invalid /time response payload', body);
          this.incrementBackoff();
        }
      } catch (error: any) {
        const message = error?.message ?? String(error);
        if (isInitial) {
          throw new Error('Helles startup connection health check failed');
        } else {
          console.warn(`HellesClient time sync failed: ${message}`);
          this.incrementBackoff();
        }
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
   * @param params.onError - Optional error handler function
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
    onError?: (error: any) => void;
  }): Promise<any> {
    try {
      const _traceKey = this.applyTraceSuffix(traceKey);
      if (eventTypeLabel) eventAttributes.eventTypeLabel = eventTypeLabel;
      if (eventTypeIcon) eventAttributes.eventTypeIcon = eventTypeIcon;

      const defaultTimestamp = this.defaults!.eventTimestampFunc?.() ?? this.now();
      const _eventTimestampUtc =
        eventTimestampUtc !== undefined ? eventTimestampUtc : defaultTimestamp;

      if (
        _eventTimestampUtc > 2565000000000 ||
        _eventTimestampUtc < 1665000000000
      ) {
        throw new Error(
          `eventTimestampUtc value ${_eventTimestampUtc} is out of range - expected Unix millisecond timestamp`
        );
      }

      const _eventSender = eventSender || this.defaults!.sender;
      if (_eventSender == undefined) {
        throw new Error(`eventSender is required`);
      }

      // only register trace if it hasn't been registered yet
      if (!this.registeredTraces.has(_traceKey)) {
        try {
          const registerPayload = {
            traceKey: _traceKey,
            traceType: this.defaults.traceType ?? 'TRACE',
            traceString: _traceKey
          };

          const response = await request(`${this.hellesHost}/traces`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: wf_stringify(registerPayload)
          });

          if (response.statusCode >= 400) {
            const errorBody = await response.body.json().catch(() => ({}));
            const errorDetails = errorBody ? wf_stringify(errorBody) : `HTTP ${response.statusCode}`;
            throw new Error(`registerTrace err: ${errorDetails}`);
          }
        } catch (error: any) {
          if (error.message?.includes('registerTrace err:')) {
            throw error;
          }
          const errorDetails = error.message || String(error);
          throw new Error(`registerTrace err: ${errorDetails}`);
        }

        this.registeredTraces.add(_traceKey);
      }

      const postPayload: any = {
        traceKey: _traceKey,
        eventTypeKey: eventType,
        eventString,
        eventAttributes,
        eventSender: _eventSender,
        eventTimestampUtc: _eventTimestampUtc,
        eventUniquer
      };

      try {
        const response = await request(`${this.hellesHost}/events`, {
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
      } catch (error: any) {
        if (typeof error?.error === 'string') {
          throw new Error(`logTraceEvent err: ${error.error}`);
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(`logTraceEvent err: ${errorDetails}`);
        }
      }
    } catch (error: any) {
      // if a custom error handler is provided, use it. otherwise rethrow plain
      if (onError) {
        onError(error);
      } else if (this.defaults?.onError) {
        this.defaults.onError(error);
      } else {
        throw error;
      }
    }
  }

  /**
   * Deletes a trace from the Helles server.
   * The trace key will have the configured trace suffix appended automatically.
   * Requires an API key to be configured in the constructor.
   * @param params - Delete parameters
   * @param params.traceKey - The trace key to delete
   * @param params.onError - Optional error handler for this specific operation
   * @returns The response data from the Helles server
   */
  async deleteTrace({
    traceKey,
    onError
  }: {
    traceKey: string;
    onError?: (error: any) => void;
  }): Promise<any> {
    try {
      if (!this.apiKey) {
        throw new Error('API key is required for deleteTrace');
      }

      if (!traceKey) {
        throw new Error('traceKey is required');
      }

      const _traceKey = this.applyTraceSuffix(traceKey);
      const normalizedTraceKey = _traceKey.toUpperCase();

      try {
        const deletePayload = {
          apiKey: this.apiKey,
          traceKey: normalizedTraceKey
        };

        const response = await request(`${this.hellesHost}/traces/delete`, {
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
      } catch (error: any) {
        if (typeof error?.error === 'string') {
          throw new Error(`deleteTrace err: ${error.error}`);
        } else {
          const errorDetails = error.message || String(error);
          throw new Error(`deleteTrace err: ${errorDetails}`);
        }
      }
    } catch (error: any) {
      if (onError) {
        onError(error);
      } else if (this.defaults?.onError) {
        this.defaults.onError(error);
      } else {
        throw error;
      }
    }
  }
}

