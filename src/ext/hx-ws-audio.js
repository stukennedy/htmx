(() => {
    let api;
    
    // Audio context and recording state
    let audioContext = null;
    let mediaStream = null;
    let audioWorkletNode = null;
    let analyserNode = null;
    let isRecording = false;
    let sampleRate = 16000;
    
    // Helper to get attribute value
    function getAudioAttribute(element, attrName) {
        // Try colon variant first (hx-ws:audio-start)
        let colonValue = api.attributeValue(element, 'hx-ws:audio-' + attrName);
        if (colonValue !== null && colonValue !== undefined) return colonValue;
        
        // Try hyphen variant for JSX (hx-ws-audio-start)
        let hyphenValue = api.attributeValue(element, 'hx-ws-audio-' + attrName);
        if (hyphenValue !== null && hyphenValue !== undefined) return hyphenValue;
        
        // For main 'audio' attribute, also check plain 'hx-ws:audio'
        if (attrName === '') {
            let plainValue = api.attributeValue(element, 'hx-ws:audio');
            if (plainValue !== null && plainValue !== undefined) return plainValue;
        }
        
        return null;
    }
    
    // Helper to check if element has audio attribute
    function hasAudioAttribute(element, attrName) {
        let value = getAudioAttribute(element, attrName);
        return value !== null && value !== undefined;
    }
    
    // Initialize audio recording
    async function initializeAudio(element) {
        try {
            // Get sample rate from attribute
            const sampleRateAttr = getAudioAttribute(element, 'sample-rate');
            if (sampleRateAttr) {
                sampleRate = parseInt(sampleRateAttr, 10);
            }
            
            // Get microphone access
            mediaStream = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    sampleRate: sampleRate,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true
                } 
            });
            
            // Create audio context
            audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: sampleRate
            });
            
            // Create analyser for visualization
            analyserNode = audioContext.createAnalyser();
            analyserNode.fftSize = 2048;
            
            // Create source from media stream
            const source = audioContext.createMediaStreamSource(mediaStream);
            source.connect(analyserNode);
            
            console.log('Audio initialized:', { sampleRate, contextSampleRate: audioContext.sampleRate });
            
            htmx.trigger(element, 'htmx:ws:audio:ready', { sampleRate });
            
        } catch (error) {
            console.error('Failed to initialize audio:', error);
            htmx.trigger(element, 'htmx:ws:audio:error', { error: error.message });
            throw error;
        }
    }
    
    // Start recording
    async function startRecording(element) {
        if (isRecording) return;
        
        try {
            // Initialize audio if not already done
            if (!audioContext) {
                await initializeAudio(element);
            }
            
            isRecording = true;
            
            // Create script processor for audio chunks (fallback for older browsers)
            // In production, you'd want to use AudioWorklet
            const bufferSize = 4096;
            const scriptProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
            
            analyserNode.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);
            
            let chunkCount = 0;
            
            scriptProcessor.onaudioprocess = (e) => {
                if (!isRecording) return;
                
                const inputData = e.inputBuffer.getChannelData(0);
                
                // Convert to PCM16
                const pcm16 = new Int16Array(inputData.length);
                for (let i = 0; i < inputData.length; i++) {
                    const s = Math.max(-1, Math.min(1, inputData[i]));
                    pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                }
                
                chunkCount++;
                
                // Send audio chunk via WebSocket
                console.log('Sending audio chunk', chunkCount, 'from element:', element.id, 'wsUrl:', element._htmx?.wsUrl);
                htmx.trigger(element, 'htmx:wsSendRaw', {
                    data: {
                        channel: 'audio',
                        format: 'pcm16',
                        data: Array.from(pcm16),
                        sample_rate: audioContext.sampleRate,
                        chunk: chunkCount
                    }
                });
                
                // Emit chunk event
                htmx.trigger(element, 'htmx:ws:audio:chunk', { 
                    chunk: chunkCount,
                    size: pcm16.length 
                });
                
                // Calculate and emit audio level
                let sum = 0;
                for (let i = 0; i < inputData.length; i++) {
                    sum += inputData[i] * inputData[i];
                }
                const rms = Math.sqrt(sum / inputData.length);
                const db = 20 * Math.log10(rms);
                
                htmx.trigger(element, 'htmx:ws:audio:level', { 
                    level: db,
                    rms: rms 
                });
            };
            
            // Store processor for cleanup
            element._audioScriptProcessor = scriptProcessor;
            
            htmx.trigger(element, 'htmx:ws:audio:start', { sampleRate: audioContext.sampleRate });
            
        } catch (error) {
            console.error('Failed to start recording:', error);
            htmx.trigger(element, 'htmx:ws:audio:error', { error: error.message });
            isRecording = false;
        }
    }
    
    // Stop recording
    function stopRecording(element) {
        if (!isRecording) return;
        
        isRecording = false;
        
        // Clean up script processor
        if (element._audioScriptProcessor) {
            element._audioScriptProcessor.disconnect();
            element._audioScriptProcessor = null;
        }
        
        htmx.trigger(element, 'htmx:ws:audio:stop');
    }
    
    // Interrupt recording
    function interruptRecording(element) {
        stopRecording(element);
        htmx.trigger(element, 'htmx:ws:audio:interrupt');
    }
    
    // Visualizer update loop
    function updateVisualizer(canvas, analyser) {
        if (!canvas || !analyser) return;
        
        const ctx = canvas.getContext('2d');
        const width = canvas.width;
        const height = canvas.height;
        const bufferLength = analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        function draw() {
            requestAnimationFrame(draw);
            
            analyser.getByteTimeDomainData(dataArray);
            
            // Clear canvas
            ctx.fillStyle = 'rgba(0, 0, 0, 0.1)';
            ctx.fillRect(0, 0, width, height);
            
            // Draw waveform
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#10b981';
            ctx.beginPath();
            
            const sliceWidth = width / bufferLength;
            let x = 0;
            
            for (let i = 0; i < bufferLength; i++) {
                const v = dataArray[i] / 128.0;
                const y = v * height / 2;
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                
                x += sliceWidth;
            }
            
            ctx.lineTo(width, height / 2);
            ctx.stroke();
        }
        
        draw();
    }
    
    // Initialize audio container
    function initializeAudioContainer(element) {
        if (element._audioInitialized) return;
        
        element._audioInitialized = true;
        
        // Find and initialize visualizer
        const visualizer = element.querySelector('[hx-ws\\:audio-visualizer], [hx-ws-audio-visualizer]');
        if (visualizer && visualizer.tagName === 'CANVAS') {
            element._visualizerCanvas = visualizer;
        }
        
        // Find level display
        const levelDisplay = element.querySelector('[hx-ws\\:audio-level], [hx-ws-audio-level]');
        if (levelDisplay) {
            element._levelDisplay = levelDisplay;
            
            // Listen for level updates
            element.addEventListener('htmx:ws:audio:level', (e) => {
                const db = e.detail.level;
                levelDisplay.textContent = isFinite(db) ? `${Math.round(db)} dB` : '-∞ dB';
            });
        }
        
        // Start visualizer when audio is ready
        element.addEventListener('htmx:ws:audio:ready', () => {
            if (element._visualizerCanvas && analyserNode) {
                updateVisualizer(element._visualizerCanvas, analyserNode);
            }
        });
        
        // Listen for initialization request
        element.addEventListener('htmx:ws:audio:init-request', async () => {
            await initializeAudio(element);
        });
    }
    
    // Initialize start button
    function initializeStartButton(element) {
        if (element._audioStartInitialized) return;
        
        element._audioStartInitialized = true;
        
        element.addEventListener('click', async () => {
            // Find parent container with hx-ws:audio
            const container = element.closest('[hx-ws\\:audio], [hx-ws-audio]');
            if (container) {
                await startRecording(container);
            }
        });
    }
    
    // Initialize stop button
    function initializeStopButton(element) {
        if (element._audioStopInitialized) return;
        
        element._audioStopInitialized = true;
        
        element.addEventListener('click', () => {
            // Find parent container with hx-ws:audio
            const container = element.closest('[hx-ws\\:audio], [hx-ws-audio]');
            if (container) {
                stopRecording(container);
            }
        });
    }
    
    // Initialize interrupt button
    function initializeInterruptButton(element) {
        if (element._audioInterruptInitialized) return;
        
        element._audioInterruptInitialized = true;
        
        element.addEventListener('click', () => {
            // Find parent container with hx-ws:audio
            const container = element.closest('[hx-ws\\:audio], [hx-ws-audio]');
            if (container) {
                interruptRecording(container);
            }
        });
    }
    
    // Cleanup
    function cleanup() {
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        analyserNode = null;
        isRecording = false;
    }
    
    // Register extension
    htmx.registerExtension('ws-audio', {
        init: (internalAPI) => {
            api = internalAPI;
        },
        
        htmx_after_process: (element) => {
            const processNode = (node) => {
                // Initialize audio container
                if (hasAudioAttribute(node, '')) {
                    initializeAudioContainer(node);
                }
                
                // Initialize control buttons
                if (hasAudioAttribute(node, 'start')) {
                    initializeStartButton(node);
                }
                
                if (hasAudioAttribute(node, 'stop')) {
                    initializeStopButton(node);
                }
                
                if (hasAudioAttribute(node, 'interrupt')) {
                    initializeInterruptButton(node);
                }
            };
            
            // Process the element itself
            processNode(element);
            
            // Process descendants
            element.querySelectorAll('[hx-ws\\:audio], [hx-ws-audio], [hx-ws\\:audio-start], [hx-ws-audio-start], [hx-ws\\:audio-stop], [hx-ws-audio-stop], [hx-ws\\:audio-interrupt], [hx-ws-audio-interrupt]').forEach(processNode);
        },
        
        htmx_before_cleanup: (element) => {
            // Cleanup audio resources
            if (element._audioInitialized) {
                cleanup();
            }
        }
    });
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);
})();

