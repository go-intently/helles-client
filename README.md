# helles-client

Lightweight TypeScript client for interacting with the Helles tracing service. Provides automatic time synchronization, trace registration, event logging, and trace management.

## Installation

```bash
pnpm add helles-client
# or
npm install helles-client
# or
yarn add helles-client
```

## Features

- Automatic time synchronization with Helles server
- Automatic trace registration on first event
- Deferred (non-blocking) event / flow logging with call-time timestamps
- Event logging with deduplication support
- Trace deletion (requires API key)
- BigInt serialization support
- TypeScript support with full type definitions
- Dual ESM/CJS builds for maximum compatibility

## Quick Start

```typescript
import { HellesClient } from 'helles-client';

const client = new HellesClient({
  hellesHost: 'https://your-helles-server.com',
  apiKey: 'your-api-key',

  // all defaults are optional, and can be overridden in each logTraceEvent call as needed.
  defaults: {
    sender: 'your-service-name',
    traceType: 'your-service-action-description',
    traceSuffix: '_dev' // Optional: append as a suffix to all trace keys
  }
});

// Get current clock time of the helles server, as a millisecond unix timestamp
// This is important for precise time tracking of your events -- to eliminate the delta between helles server and you.
const syncedTime = client.now();

// EG: Log a "deposit" event
await client.logTraceEvent({
  traceKey: 'deposit_1234567',
  eventType: 'NOTE',
  eventString: 'Deposit initiated',
  eventAttributes: { amount: 1000 }
});

```

## API Reference

### `HellesClient`

Main client class for interacting with Helles.

#### Constructor

```typescript
new HellesClient(config: {
  hellesHost: string;
  apiKey?: string;
  defaults: {
    sender?: string;
    traceType?: string;
    eventTimestampFunc?: () => number;
    onError?: (error: any, context?: HellesErrorContext) => void;
    traceSuffix?: string;
  };
})
```

- `hellesHost`: Base URL of the Helles server (trailing slash will be removed)
- `apiKey`: Optional API key required for `deleteTrace` operations
- `defaults.sender`: Default sender identifier for events
- `defaults.traceType`: Default trace type label (e.g., "acxDeposit")
- `defaults.eventTimestampFunc`: Optional function to generate event timestamps (defaults to synchronized `now()`)
- `defaults.onError`: Optional global error handler for trace operations
- `defaults.traceSuffix`: Optional suffix to append to all trace keys for isolation

#### Methods

##### `now(): number`

Returns the current time in milliseconds, synchronized with the Helles server.

```typescript
const timestamp = client.now();
```

##### `getTimeSync(): TimeSyncState`

Gets the current time synchronization state.

```typescript
const syncState = client.getTimeSync();
// Returns: { latency: number | null, offset: number, lastCheck: number | null, nextIntervalMs: number }
```

##### `logTraceEvent(params): Promise<undefined>`

Enqueues an event and returns immediately. Automatically registers the trace on first flush if needed.

Timestamps are captured at call time (`eventTimestampUtc` / `eventTimestampFunc` / `now()`), so deferred flush does not shift event times. Caller `eventAttributes` are shallow-copied (label/icon applied on the copy).

Happy-path return is always `undefined` (server body is not returned). Network/register failures are reported via `onError` / `defaults.onError`, or `console.warn`'d when no handler is set — they never reject this Promise. Sync validation failures (missing sender, bad timestamp) still throw-or-`onError` on the caller turn.

```typescript
await client.logTraceEvent({
  traceKey: string;              // Required: trace identifier (e.g., "deposit_1234567")
  eventType: string;             // Required: event type (e.g., "NOTE")
  eventString?: string;           // Optional: event description
  eventSender?: string;           // Optional: sender (defaults to config.defaults.sender)
  eventAttributes?: any;          // Optional: additional attributes
  eventTimestampUtc?: number;     // Optional: timestamp (defaults to synchronized now())
  eventUniquer?: string;          // Optional: unique ID for deduplication
  eventTypeLabel?: string;        // Optional: Typically only needed for "NOTE" eventTypes - human-readable label (e.g., "Alert")
  eventTypeIcon?: string;         // Optional: Typically only needed for "NOTE" eventTypes - icon (e.g., "🎯")
  onError?: (error: any, context?: HellesErrorContext) => void; // Optional: error handler for this call
});
```

##### `upsertTraceFlows(params): Promise<undefined>`

Enqueues a flow upsert and returns immediately (same deferred-flush model as `logTraceEvent`). Items are shallow-copied (including nested `estimated` / `actual`). Happy-path return is always `undefined`.

##### `flush(): Promise<void>`

Drains pending `logTraceEvent` / `upsertTraceFlows` work. Use in tests and graceful shutdown. Also runs automatically before `deleteTrace` / `traceShare`, and best-effort on `process.beforeExit`. Hard kills (`kill -9`) can still drop the queue — call `flush()` in graceful shutdown paths.

#### "NOTE" event type

Most `eventType` options have predefined labels, output string formats, required attributes, icons, etc.

The "NOTE" option, however, is for general purpose miscellaneous logging.

When using a "NOTE" eventType you should typically supply your own `eventTypeLabel` and `eventTypeIcon` that are suitable for the event you are recording.

However, it is best to use "NOTE" sparingly - If an `eventType` exists that is already suitable for your event, you should use that type instead.

##### `deleteTrace(params): Promise<any>`

Deletes a trace from the Helles server. Requires special permissions

```typescript
await client.deleteTrace({
  traceKey: string;              // Required: trace identifier
  onError?: (error: any, context?: HellesErrorContext) => void; // Optional: error handler for this call
});
```

## Time Synchronization

The client automatically synchronizes time with the Helles server on startup and continues syncing at regular intervals. This ensures event timestamps are precise and accurate even when the client's system clock disagrees with that of the helles server.

## Deferred logging

`logTraceEvent` and `upsertTraceFlows` are enqueue-and-return: validate + queue + schedule flush on the caller turn; JSON/HTTP/retries run later via `setImmediate`. Existing `await client.logTraceEvent(...)` call sites keep working, but `await` no longer waits for the network.

- Prefer `defaults.onError` (or per-call `onError`) so flush failures are visible.
- No handler ⇒ flush failures are warned, not thrown.
- `deleteTrace` / `traceShare` auto-`flush()` first so they cannot race ahead of pending posts.

## Error Handling

Errors can be handled globally via `defaults.onError` in the constructor, or per-operation via the `onError` parameter in method calls.

- **Caller-turn validation** (missing sender, bad timestamp, empty upsert items): if no handler is provided, errors are thrown.
- **Flush-path network/register failures**: if no handler is provided, errors are `console.warn`'d and swallowed (never thrown into the caller).

Both handlers receive a second argument with failure context:

```typescript
onError(error, context) {
  console.error(error.message);
  console.error(context?.operation); // "logTraceEvent" | "upsertTraceFlows" | "deleteTrace" | "traceShare"
  console.error(context?.stage);     // e.g. "validate", "registerTrace", "postEvent"
  console.error(context?.params);    // sanitized call parameters for troubleshooting
}
```

## Trace Suffix

Use `traceSuffix` in the configuration to isolate traces (e.g., distinguish test traces from production). The suffix is automatically appended to all trace keys if you use `defaults.traceSuffix`

EG: "deposit_12345" can become "deposit_12345_dev"

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.0.0 (for TypeScript projects)

## License

MIT

