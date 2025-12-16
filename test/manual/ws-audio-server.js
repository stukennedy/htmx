const http = require('http');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');

const PORT = 3001;

// Create HTTP server
const server = http.createServer(async (req, res) => {
    console.log(`[${new Date().toISOString()}] HTTP ${req.method} ${req.url}`);

    // Route handlers
    const routes = {
        '/': async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(await fs.readFile('test/manual/ws-audio.html'));
        },
        '/dist/htmx.js': async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(await fs.readFile('dist/htmx.js'));
        },
        '/src/ext/hx-ws.js': async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(await fs.readFile('src/ext/hx-ws.js'));
        },
        '/src/ext/hx-ws-audio.js': async (req, res) => {
            res.writeHead(200, { 'Content-Type': 'application/javascript' });
            res.end(await fs.readFile('src/ext/hx-ws-audio.js'));
        }
    };

    try {
        if (routes[req.url]) {
            console.log(`[${new Date().toISOString()}] HTTP ${req.method} ${req.url} -> .${req.url}`);
            await routes[req.url](req, res);
        } else {
            res.writeHead(404);
            res.end('Not Found');
        }
    } catch (error) {
        console.error('Error handling request:', error);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

// Connection tracking
const connections = new Map();

// Mock transcription responses (simulate real transcription)
const mockTranscripts = [
    "Hello, this is a test of the audio streaming system.",
    "The quick brown fox jumps over the lazy dog.",
    "WebSockets provide real-time bidirectional communication.",
    "HTMX makes building modern web applications easier.",
    "Audio streaming requires careful handling of data chunks.",
    "Latency is an important metric for real-time systems.",
    "This is a simulated transcription response.",
    "Testing audio quality and connection stability.",
    "Real-time processing is essential for voice applications.",
    "Thank you for testing the WebSocket audio extension."
];

function getRandomTranscript() {
    return mockTranscripts[Math.floor(Math.random() * mockTranscripts.length)];
}

wss.on('connection', (ws, req) => {
    const url = req.url;
    console.log(`[${new Date().toISOString()}] New WebSocket connection: ${url}`);

    // Store connection metadata
    const connectionId = Math.random().toString(36).substring(7);
    connections.set(connectionId, {
        ws,
        url,
        startTime: Date.now(),
        chunksReceived: 0,
        bytesReceived: 0
    });

    ws.channel = url.substring(1); // Remove leading slash

    // Handle audio channel
    if (ws.channel === 'audio') {
        handleAudioConnection(ws, connectionId);
    }

    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data.toString());
            console.log(`[${new Date().toISOString()}] Message from ${ws.channel}:`, message);
            
            handleMessage(ws, message, connectionId);
        } catch (error) {
            console.error('Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        console.log(`[${new Date().toISOString()}] Connection closed: ${ws.channel}`);
        connections.delete(connectionId);
    });

    ws.on('error', (error) => {
        console.error(`[${new Date().toISOString()}] WebSocket error:`, error);
    });
});

function handleAudioConnection(ws, connectionId) {
    // Send welcome message
    ws.send(JSON.stringify({
        payload: `<div class="transcript-item text-white mb-3 p-3 bg-white bg-opacity-10 rounded-lg">
                    <div class="text-xs text-gray-300 mb-1">${new Date().toLocaleTimeString()}</div>
                    <div class="text-sm">🎙️ <strong>System:</strong> Audio connection established. Ready to receive audio.</div>
                  </div>`
    }));
}

function handleMessage(ws, message, connectionId) {
    const conn = connections.get(connectionId);
    if (!conn) return;

    // Handle audio data chunks
    if (message.channel === 'audio' && message.format === 'pcm16') {
        conn.chunksReceived++;
        
        if (message.data) {
            // In a real implementation, this would be the audio data
            // For simulation, we'll just count the chunks
            conn.bytesReceived += (message.data.length || 1000); // Estimate
        }

        console.log(`[${new Date().toISOString()}] Audio chunk #${conn.chunksReceived} received`);

        // Simulate transcription every 5 chunks (or when end_of_speech is detected)
        if (conn.chunksReceived % 5 === 0 || message.end_of_speech) {
            const receiveTime = Date.now();
            const transcript = getRandomTranscript();
            
            // Simulate processing delay (50-200ms)
            const processingDelay = 50 + Math.random() * 150;
            
            setTimeout(() => {
                const latency = Math.round(Date.now() - receiveTime);
                
                // Send transcript back
                ws.send(JSON.stringify({
                    payload: `<div class="transcript-item text-white mb-3 p-3 bg-white bg-opacity-10 rounded-lg">
                                <div class="text-xs text-gray-300 mb-1">${new Date().toLocaleTimeString()} · Latency: ${latency}ms</div>
                                <div><strong>Transcript:</strong> ${transcript}</div>
                              </div>`,
                    latency: latency
                }));

                console.log(`[${new Date().toISOString()}] Sent transcript (latency: ${latency}ms): "${transcript}"`);
            }, processingDelay);
        }
    }

    // Handle control messages
    if (message.type === 'control') {
        if (message.action === 'start') {
            console.log(`[${new Date().toISOString()}] Audio recording started`);
            conn.chunksReceived = 0;
            conn.bytesReceived = 0;
            
            ws.send(JSON.stringify({
                payload: `<div class="transcript-item text-white mb-3 p-3 bg-green-500 bg-opacity-20 rounded-lg">
                            <div class="text-xs text-gray-300 mb-1">${new Date().toLocaleTimeString()}</div>
                            <div class="text-sm">🎤 <strong>System:</strong> Recording started</div>
                          </div>`
            }));
        } else if (message.action === 'stop') {
            console.log(`[${new Date().toISOString()}] Audio recording stopped`);
            
            const stats = `Received ${conn.chunksReceived} chunks (${(conn.bytesReceived / 1024).toFixed(1)} KB)`;
            ws.send(JSON.stringify({
                payload: `<div class="transcript-item text-white mb-3 p-3 bg-red-500 bg-opacity-20 rounded-lg">
                            <div class="text-xs text-gray-300 mb-1">${new Date().toLocaleTimeString()}</div>
                            <div class="text-sm">⏹️ <strong>System:</strong> Recording stopped · ${stats}</div>
                          </div>`
            }));
        } else if (message.action === 'interrupt') {
            console.log(`[${new Date().toISOString()}] Audio recording interrupted`);
            
            ws.send(JSON.stringify({
                payload: `<div class="transcript-item text-white mb-3 p-3 bg-yellow-500 bg-opacity-20 rounded-lg">
                            <div class="text-xs text-gray-300 mb-1">${new Date().toLocaleTimeString()}</div>
                            <div class="text-sm">✋ <strong>System:</strong> Recording interrupted</div>
                          </div>`
            }));
        }
    }
}

// Broadcast to all connections on a channel
function broadcast(channel, message) {
    connections.forEach(({ ws }) => {
        if (ws.channel === channel && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(message));
        }
    });
}

// Start server
server.listen(PORT, () => {
    console.log('\n╔═══════════════════════════════════════════════════════════╗');
    console.log('║                                                           ║');
    console.log('║   🎙️  HTMX WebSocket Audio Demo Server                   ║');
    console.log('║                                                           ║');
    console.log(`║   HTTP Server: http://localhost:${PORT}                       ║`);
    console.log(`║   WebSocket Server: ws://localhost:${PORT}                    ║`);
    console.log('║                                                           ║');
    console.log(`║   Open http://localhost:${PORT} in your browser              ║`);
    console.log('║                                                           ║');
    console.log('╚═══════════════════════════════════════════════════════════╝\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
    });
});

