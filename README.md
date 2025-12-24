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
    onError?: (error: any) => void;
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

##### `logTraceEvent(params): Promise<any>`

Logs an event to a trace. Automatically registers the trace if it hasn't been registered yet.

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
  onError?: (error: any) => void; // Optional: error handler for this call
});
```

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
  onError?: (error: any) => void; // Optional: error handler for this call
});
```

## Time Synchronization

The client automatically synchronizes time with the Helles server on startup and continues syncing at regular intervals. This ensures event timestamps are precise and accurate even when the client's system clock disagrees with that of the helles server.

## Error Handling

Errors can be handled globally via `defaults.onError` in the constructor, or per-operation via the `onError` parameter in method calls. If no error handler is provided, errors are thrown.

## Trace Suffix

Use `traceSuffix` in the configuration to isolate traces (e.g., distinguish test traces from production). The suffix is automatically appended to all trace keys if you use `defaults.traceSuffix`

EG: "deposit_12345" can become "deposit_12345_dev"

## Requirements

- Node.js >= 18.0.0
- TypeScript >= 5.0.0 (for TypeScript projects)

## License

MIT

