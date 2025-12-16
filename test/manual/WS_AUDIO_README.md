# HTMX WebSocket Audio Extension - Manual Test

Manual test for the `hx-ws-audio` extension with real-time audio streaming.

## Prerequisites

- Node.js (v14+)
- Modern browser with WebRTC support
- Microphone access

## Running the Demo

1. Start the WebSocket server:
   ```bash
   node test/manual/ws-audio-server.js
   ```

2. Open browser to `http://localhost:3001`

3. Click "Initialize Audio & Request Permissions" to grant microphone access

4. Use recording controls to test audio streaming

## Features Tested

### Audio Recording
- Microphone access and audio capture
- Configurable sample rate (16000 Hz)
- PCM16 audio encoding
- Chunked streaming over WebSocket

### Visualization
- Live waveform display
- Audio level meter
- Recording state indicators

### Controls
- Start/Stop recording
- Interrupt capability
- Permission handling

### Statistics
- Chunks sent counter
- Duration tracking
- Message count
- Latency measurement

## What to Test

- Audio initialization and permission request
- Recording start/stop functionality
- Audio data transmission to server
- Waveform and level meter responsiveness
- WebSocket connection stability during streaming
- Statistics accuracy
- Interrupt functionality
- State management

## Server Implementation

The server (`ws-audio-server.js`) handles:
- WebSocket connections on port 3001
- Audio data reception and logging
- Simulated transcription responses
- Statistics calculation

## Integration

The audio extension uses `htmx.ext.ws.send()` from the core `hx-ws` extension to transmit audio data. Both extensions must be loaded for the demo to work.

## Troubleshooting

- **No audio chunks sent**: Check console for WebSocket connection status
- **Permission denied**: Ensure HTTPS or localhost, check browser settings
- **Connection lost**: Server may have restarted, refresh page to reconnect
