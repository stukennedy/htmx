# HTMX WebSocket Extension - Manual Test

Manual testing demo for the `hx-ws` extension.

## Running the Demo

1. Install dependencies (if not already installed):
   ```bash
   npm install
   ```

2. Start the WebSocket server:
   ```bash
   node test/manual/ws-server.js
   ```

3. Open browser to `http://localhost:8080`

## Test Features

### 1. Live Chat
- Tests `hx-ws:send` with form submission
- Tests message receiving and display
- Tests `hx-swap="beforeend"` for appending messages

### 2. Live Notifications
- Tests server-push notifications
- Tests automatic HTML swapping
- Updates every 5-8 seconds

### 3. Shared Counter
- Tests bidirectional communication
- Tests `hx-vals` for sending data
- Tests state synchronization across clients

### 4. Stock Ticker
- Tests continuous server streaming
- Tests frequent updates (every 2-3 seconds)
- Tests dynamic content updates

### 5. System Dashboard
- Tests multiple `<hx-partial>` elements in one message
- Tests concurrent partial updates
- Updates every second

### 6. Event Log
- Displays all WebSocket events for debugging
- Shows connection lifecycle events
- Shows message send/receive events

## What to Test

- Connection establishment on page load
- Reconnection after server restart
- Multiple simultaneous connections
- Form submission via WebSocket
- Server-pushed updates
- Multiple partials in one message
- Event emission and handling

## Server Implementation

The server (`ws-server.js`) implements:
- HTTP server for static files on port 8080
- WebSocket server on port 8080
- Message routing by channel
- Broadcast support for shared state
- Simulated real-time data streams
