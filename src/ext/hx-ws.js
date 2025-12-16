(() => {
    let api;
    
    // Helper to get attribute value, checking colon, hyphen, and plain variants
    function getWsAttribute(element, attrName) {
        // Try colon variant first (hx-ws:connect)
        let colonValue = api.attributeValue(element, 'hx-ws:' + attrName);
        if (colonValue !== null && colonValue !== undefined) return colonValue;
        
        // Try hyphen variant for JSX (hx-ws-connect)
        let hyphenValue = api.attributeValue(element, 'hx-ws-' + attrName);
        if (hyphenValue !== null && hyphenValue !== undefined) return hyphenValue;
        
        // For 'send', also check plain 'hx-ws' (marker attribute)
        if (attrName === 'send') {
            let plainValue = api.attributeValue(element, 'hx-ws');
            if (plainValue !== null && plainValue !== undefined) return plainValue;
        }
        
        return null;
    }
    
    // Helper to check if element has WebSocket attribute (any variant)
    function hasWsAttribute(element, attrName) {
        let value = getWsAttribute(element, attrName);
        return value !== null && value !== undefined;
    }
    
    // ========================================
    // URL NORMALIZATION
    // ========================================
    
    function normalizeWebSocketUrl(url) {
        // Already absolute WebSocket URL
        if (url.startsWith('ws://') || url.startsWith('wss://')) {
            return url;
        }
        
        // Absolute HTTP/HTTPS URL - convert to ws(s)://
        if (url.startsWith('http://')) {
            return 'ws://' + url.substring(7);
        }
        if (url.startsWith('https://')) {
            return 'wss://' + url.substring(8);
        }
        
        // Relative path - construct from current location
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const host = window.location.host;
        
        if (url.startsWith('/')) {
            // Absolute path
            return `${protocol}//${host}${url}`;
        } else {
            // Relative path
            const basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
            return `${protocol}//${host}${basePath}${url}`;
        }
    }
    
    // ========================================
    // CONFIGURATION
    // ========================================
    
    function getConfig() {
        const defaults = {
            reconnect: true,
            reconnectDelay: 1000,
            reconnectMaxDelay: 30000,
            reconnectJitter: true,
            autoConnect: false,
            pauseInBackground: true,
            requestTimeout: 60000  // 60 seconds TTL for pending requests
        };
        return { ...defaults, ...(htmx.config.websockets || {}) };
    }
    
    // ========================================
    // CONNECTION REGISTRY
    // ========================================
    
    const connectionRegistry = new Map();
    
    function getOrCreateConnection(url, element) {
        if (connectionRegistry.has(url)) {
            let entry = connectionRegistry.get(url);
            entry.refCount++;
            entry.elements.add(element);
            return entry;
        }
        
        let entry = {
            socket: null,
            refCount: 1,
            elements: new Set([element]),
            reconnectAttempts: 0,
            reconnectTimer: null,
            pendingRequests: new Map()
        };
        
        // Don't add to registry until connection is approved
        let connected = createWebSocket(url, entry);
        if (connected) {
            connectionRegistry.set(url, entry);
        }
        return entry;
    }
    
    function createWebSocket(url, entry) {
        let firstElement = entry.elements.values().next().value;
        if (firstElement) {
            if (!triggerEvent(firstElement, 'htmx:before:ws:connect', { url })) {
                // Connection cancelled by event handler
                return false;
            }
        }
        
        try {
            entry.socket = new WebSocket(url);
            
            entry.socket.addEventListener('open', () => {
                // Reset reconnect attempts on successful connection
                entry.reconnectAttempts = 0;
                
                if (firstElement) {
                    triggerEvent(firstElement, 'htmx:after:ws:connect', { url, socket: entry.socket });
                }
            });
            
            entry.socket.addEventListener('message', (event) => {
                handleMessage(entry, event);
            });
            
            entry.socket.addEventListener('close', () => {
                if (firstElement) {
                    triggerEvent(firstElement, 'htmx:ws:close', { url });
                }
                
                // Clear all pending requests on close
                entry.pendingRequests.clear();
                
                // Check if entry is still valid (not cleared)
                if (!connectionRegistry.has(url)) return;
                
                let config = getConfig();
                if (config.reconnect && entry.refCount > 0) {
                    scheduleReconnect(url, entry);
                } else {
                    connectionRegistry.delete(url);
                }
            });
            
            entry.socket.addEventListener('error', (error) => {
                if (firstElement) {
                    triggerEvent(firstElement, 'htmx:ws:error', { url, error });
                }
            });
            
            return true;
        } catch (error) {
            if (firstElement) {
                triggerEvent(firstElement, 'htmx:ws:error', { url, error });
            }
            return false;
        }
    }
    
    function scheduleReconnect(url, entry) {
        let config = getConfig();
        
        // Increment attempts before calculating delay for proper exponential backoff
        let attempts = entry.reconnectAttempts;
        entry.reconnectAttempts++;
        
        let delay = Math.min(
            (config.reconnectDelay || 1000) * Math.pow(2, attempts),
            config.reconnectMaxDelay || 30000
        );
        
        if (config.reconnectJitter) {
            delay = delay * (0.75 + Math.random() * 0.5);
        }
        
        entry.reconnectTimer = setTimeout(() => {
            if (entry.refCount > 0) {
                let firstElement = entry.elements.values().next().value;
                if (firstElement) {
                    triggerEvent(firstElement, 'htmx:ws:reconnect', { url, attempts });
                }
                createWebSocket(url, entry);
            }
        }, delay);
    }
    
    function decrementRef(url, element) {
        if (!connectionRegistry.has(url)) return;
        
        let entry = connectionRegistry.get(url);
        entry.elements.delete(element);
        entry.refCount--;
        
        if (entry.refCount <= 0) {
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
            }
            if (entry.socket && entry.socket.readyState === WebSocket.OPEN) {
                entry.socket.close();
            }
            connectionRegistry.delete(url);
        }
    }
    
    // ========================================
    // MESSAGE SENDING
    // ========================================
    
    function sendMessage(element, event) {
        // Find connection URL
        let url = getWsAttribute(element, 'send');
        if (!url) {
            // Look for nearest ancestor with hx-ws:connect or hx-ws-connect
            let prefix = htmx.config.prefix || '';
            let ancestor = element.closest('[' + prefix + 'hx-ws\\:connect],[' + prefix + 'hx-ws-connect]');
            if (ancestor) {
                url = getWsAttribute(ancestor, 'connect');
            }
        }
        
        if (!url) {
            console.error('No WebSocket connection found for hx-ws:send element', element);
            return;
        }
        
        // Normalize URL to match how it's stored in registry
        url = normalizeWebSocketUrl(url);
        
        let entry = connectionRegistry.get(url);
        if (!entry || !entry.socket || entry.socket.readyState !== WebSocket.OPEN) {
            triggerEvent(element, 'htmx:ws:sendError', { url, error: 'Connection not open' });
            return;
        }
        
        // Build message
        let form = element.form || element.closest('form');
        let body = api.collectFormData(element, form, event.submitter);
        api.handleHxVals(element, body);
        
        // Convert FormData to object, preserving multi-value fields
        let values = {};
        for (let [key, value] of body) {
            if (values.hasOwnProperty(key)) {
                // Key already exists - convert to array if needed
                if (!Array.isArray(values[key])) {
                    values[key] = [values[key]];
                }
                values[key].push(value);
            } else {
                values[key] = value;
            }
        }
        
        let requestId = generateUUID();
        let message = {
            request_id: requestId,
            values: values
        };
        
        if (element.id) {
            message.id = element.id;
        }
        
        // Allow modification via event
        let detail = { message, element, url };
        if (!triggerEvent(element, 'htmx:before:ws:send', detail)) {
            return;
        }
        
        try {
            entry.socket.send(JSON.stringify(detail.message));
            
            // Store pending request for response matching
            entry.pendingRequests.set(requestId, { element, timestamp: Date.now() });
            
            triggerEvent(element, 'htmx:after:ws:send', { message: detail.message, url });
        } catch (error) {
            triggerEvent(element, 'htmx:ws:sendError', { url, error });
        }
    }
    
    function generateUUID() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
            let r = Math.random() * 16 | 0;
            let v = c === 'x' ? r : (r & 0x3 | 0x8);
            return v.toString(16);
        });
    }
    
    // ========================================
    // PENDING REQUEST MANAGEMENT
    // ========================================
    
    function cleanExpiredRequests(entry) {
        let config = getConfig();
        let now = Date.now();
        let expired = [];
        
        for (let [requestId, request] of entry.pendingRequests) {
            if (now - request.timestamp > config.requestTimeout) {
                expired.push(requestId);
            }
        }
        
        expired.forEach(id => entry.pendingRequests.delete(id));
    }
    
    // ========================================
    // MESSAGE RECEIVING & ROUTING
    // ========================================
    
    async function handleMessage(entry, event) {
        // Clean expired pending requests
        cleanExpiredRequests(entry);
        let envelope;
        try {
            envelope = JSON.parse(event.data);
        } catch (e) {
            // Not JSON, emit unknown message event
            let firstElement = entry.elements.values().next().value;
            if (firstElement) {
                triggerEvent(firstElement, 'htmx:ws:unknownMessage', { data: event.data });
            }
            return;
        }
        
        // Apply defaults for channel and format
        envelope.channel = envelope.channel || 'ui';
        envelope.format = envelope.format || 'html';
        
        // Find target element for this message
        let targetElement = null;
        if (envelope.request_id && entry.pendingRequests.has(envelope.request_id)) {
            targetElement = entry.pendingRequests.get(envelope.request_id).element;
            entry.pendingRequests.delete(envelope.request_id);
        } else {
            // Use first element in the connection
            targetElement = entry.elements.values().next().value;
        }
        
        // Emit before:message event (cancelable)
        if (!triggerEvent(targetElement, 'htmx:before:ws:message', { envelope, element: targetElement })) {
            return;
        }
        
        // Route based on channel and format
        if (envelope.channel === 'ui' && envelope.format === 'html') {
            await handleHtmlMessage(targetElement, envelope);
        } else {
            // Any other channel/format - emit event for extensions or application to handle
            triggerEvent(targetElement, 'htmx:ws:message', { ...envelope, element: targetElement });
        }
        
        triggerEvent(targetElement, 'htmx:after:ws:message', { envelope, element: targetElement });
    }
    
    // ========================================
    // HTML PARTIAL HANDLING
    // ========================================
    
    async function handleHtmlMessage(element, envelope) {
        // Parse the HTML to handle <hx-partial> elements
        let parser = new DOMParser();
        let doc = parser.parseFromString(envelope.payload, 'text/html');
        let partials = doc.querySelectorAll('hx-partial');
        
        if (partials.length > 0) {
            // Handle partials - each hx-partial targets an element by ID
            for (let partial of partials) {
                let targetId = partial.getAttribute('id');
                if (!targetId) continue;
                
                let target = document.getElementById(targetId);
                if (!target) continue;
                
                // Get swap strategy
                let swapStyle = envelope.swap || api.attributeValue(element, 'hx-swap') || htmx.config.defaultSwap || 'innerHTML';
                swapStyle = swapStyle.split(' ')[0]; // Remove modifiers
                
                // Perform swap
                doSwap(target, partial.innerHTML, swapStyle);
                
                // Process with htmx
                htmx.process(target);
            }
        } else {
            // No partials - swap entire payload into target
            let targetSelector = envelope.target || api.attributeValue(element, 'hx-target');
            let target;
            
            if (targetSelector) {
                if (targetSelector === 'this') {
                    target = element;
                } else {
                    target = document.getElementById(targetSelector.replace(/^#/, '')) || 
                             document.querySelector(targetSelector);
                }
            }
            
            if (!target) {
                target = element;
            }
            
            let swapStyle = envelope.swap || api.attributeValue(element, 'hx-swap') || htmx.config.defaultSwap || 'innerHTML';
            swapStyle = swapStyle.split(' ')[0]; // Remove modifiers
            
            doSwap(target, envelope.payload, swapStyle);
            htmx.process(target);
        }
    }
    
    function doSwap(target, content, style) {
        switch (style) {
            case 'innerHTML':
                target.innerHTML = content;
                break;
            case 'outerHTML':
                target.outerHTML = content;
                break;
            case 'beforebegin':
                target.insertAdjacentHTML('beforebegin', content);
                break;
            case 'afterbegin':
                target.insertAdjacentHTML('afterbegin', content);
                break;
            case 'beforeend':
                target.insertAdjacentHTML('beforeend', content);
                break;
            case 'afterend':
                target.insertAdjacentHTML('afterend', content);
                break;
            case 'delete':
                target.remove();
                break;
            case 'none':
                // Do nothing
                break;
            default:
                target.innerHTML = content;
        }
    }
    
    // ========================================
    // EVENT HELPERS
    // ========================================
    
    function triggerEvent(element, eventName, detail = {}) {
        if (!element) return true;
        return htmx.trigger(element, eventName, detail);
    }
    
    // ========================================
    // ELEMENT LIFECYCLE
    // ========================================
    
    function initializeElement(element) {
        if (element._htmx?.wsInitialized) return;

        let connectUrl = getWsAttribute(element, 'connect');
        if (!connectUrl) return;

        // Normalize URL to ws:// or wss://
        connectUrl = normalizeWebSocketUrl(connectUrl);

        element._htmx = element._htmx || {};
        element._htmx.wsInitialized = true;
        
        let config = getConfig();
        let triggerSpec = api.attributeValue(element, 'hx-trigger');
        
        if (!triggerSpec && config.autoConnect === true) {
            // Auto-connect on element initialization
            getOrCreateConnection(connectUrl, element);
            element._htmx = element._htmx || {};
            element._htmx.wsUrl = connectUrl;
        } else if (triggerSpec) {
            // Connect based on trigger
            let specs = api.parseTriggerSpecs(triggerSpec);
            if (specs.length > 0) {
                let spec = specs[0];
                if (spec.name === 'load') {
                    getOrCreateConnection(connectUrl, element);
                    element._htmx = element._htmx || {};
                    element._htmx.wsUrl = connectUrl;
                } else {
                    // Set up event listener for other triggers
                    element.addEventListener(spec.name, () => {
                        if (!element._htmx?.wsUrl) {
                            getOrCreateConnection(connectUrl, element);
                            element._htmx = element._htmx || {};
                            element._htmx.wsUrl = connectUrl;
                        }
                    }, { once: true });
                }
            }
        }
    }
    
    function initializeSendElement(element) {
        if (element._htmx?.wsSendInitialized) return;

        let sendUrl = getWsAttribute(element, 'send');
        
        // Normalize URL if provided
        if (sendUrl) {
            sendUrl = normalizeWebSocketUrl(sendUrl);
        }
        
        let triggerSpec = api.attributeValue(element, 'hx-trigger');
        
        if (!triggerSpec) {
            // Default trigger based on element type
            triggerSpec = element.matches('form') ? 'submit' :
                         element.matches('input:not([type=button]),select,textarea') ? 'change' :
                         'click';
        }
        
        let specs = api.parseTriggerSpecs(triggerSpec);
        if (specs.length > 0) {
            let spec = specs[0];
            
            let handler = (evt) => {
                // Prevent default for forms
                if (element.matches('form') && evt.type === 'submit') {
                    evt.preventDefault();
                }
                
                // If this element has its own URL, ensure connection exists
                if (sendUrl) {
                    if (!element._htmx?.wsUrl) {
                        getOrCreateConnection(sendUrl, element);
                        element._htmx = element._htmx || {};
                        element._htmx.wsUrl = sendUrl;
                    }
                }
                
                sendMessage(element, evt);
            };
            
            element.addEventListener(spec.name, handler);
            element._htmx = element._htmx || {};
            element._htmx.wsSendInitialized = true;
            element._htmx.wsSendHandler = handler;
            element._htmx.wsSendEvent = spec.name;
        }
    }
    
    function cleanupElement(element) {
        if (element._htmx?.wsUrl) {
            decrementRef(element._htmx.wsUrl, element);
        }
        
        if (element._htmx?.wsSendHandler) {
            element.removeEventListener(element._htmx.wsSendEvent, element._htmx.wsSendHandler);
        }
    }
    
    // ========================================
    // BACKWARD COMPATIBILITY
    // ========================================
    
    function checkLegacyAttributes(element) {
        // Check for old ws-connect / ws-send attributes
        if (element.hasAttribute('ws-connect') || element.hasAttribute('ws-send')) {
            console.warn('HTMX WebSocket: Legacy attributes ws-connect and ws-send are deprecated. Please use hx-ws:connect/hx-ws-connect and hx-ws:send/hx-ws-send instead.');
            
            // Map legacy attributes to new ones (prefer hyphen variant for broader compatibility)
            if (element.hasAttribute('ws-connect')) {
                let url = element.getAttribute('ws-connect');
                if (!element.hasAttribute('hx-ws-connect')) {
                    element.setAttribute('hx-ws-connect', url);
                }
            }
            
            if (element.hasAttribute('ws-send')) {
                if (!element.hasAttribute('hx-ws-send')) {
                    element.setAttribute('hx-ws-send', '');
                }
            }
        }
    }
    
    // ========================================
    // EXTENSION REGISTRATION
    // ========================================
    
    // Helper to process WebSocket elements globally
    function processWebSocketElements(root) {
        // Don't process if API not initialized yet
        if (!api) return;
        
        const processNode = (node) => {
            // Check for legacy attributes
            checkLegacyAttributes(node);
            
            // Initialize WebSocket connection elements (check both variants)
            if (hasWsAttribute(node, 'connect')) {
                initializeElement(node);
            }
            
            // Initialize send elements (check both variants)
            if (hasWsAttribute(node, 'send')) {
                initializeSendElement(node);
            }
        };

        // Process the root itself
        if (root.nodeType === Node.ELEMENT_NODE) {
            processNode(root);
        }
        
        // Build selector with prefix support
        let prefix = htmx.config.prefix || 'hx-';
        // Remove trailing hyphen if present since we'll add it
        if (prefix.endsWith('-')) prefix = prefix.slice(0, -1);
        
        let selector = [
            `[${prefix}-ws\\:connect]`, `[${prefix}-ws-connect]`, `[${prefix}-ws\\:send]`, 
            `[${prefix}-ws-send]`, `[${prefix}-ws]`,
            '[ws-connect]', '[ws-send]'  // Legacy
        ].join(', ');
        
        // Process descendants
        if (root.querySelectorAll) {
            root.querySelectorAll(selector).forEach(processNode);
        }
    }
    
    htmx.registerExtension('ws', {
        init: (internalAPI) => {
            api = internalAPI;
            
            // Initialize default config if not set
            if (!htmx.config.websockets) {
                htmx.config.websockets = {};
            }
            
            // Process any existing elements on init
            if (document.body) {
                processWebSocketElements(document.body);
            }
            
            // Implement pauseInBackground
            let config = getConfig();
            if (config.pauseInBackground) {
                document.addEventListener('visibilitychange', () => {
                    if (document.hidden) {
                        // Page hidden - pause all reconnect timers
                        for (let entry of connectionRegistry.values()) {
                            if (entry.reconnectTimer) {
                                clearTimeout(entry.reconnectTimer);
                                entry.reconnectTimer = null;
                                entry._pausedForBackground = true;
                            }
                        }
                    } else {
                        // Page visible - resume reconnects for paused connections
                        for (let [url, entry] of connectionRegistry.entries()) {
                            if (entry._pausedForBackground && (!entry.socket || entry.socket.readyState !== WebSocket.OPEN)) {
                                delete entry._pausedForBackground;
                                scheduleReconnect(url, entry);
                            }
                        }
                    }
                });
            }
        },
        
        htmx_after_process: (element) => {
            // Process WebSocket elements even without hx-ext="ws"
            processWebSocketElements(element);
        },
        
        htmx_before_cleanup: (element) => {
            cleanupElement(element);
        },
        
        // Global event handler - processes all htmx events
        onEvent: (name, evt) => {
            // Process nodes as they're added to the DOM by htmx
            if (name === 'htmx:load' && evt.detail && evt.detail.elt) {
                processWebSocketElements(evt.detail.elt);
            } else if (name === 'htmx:afterProcessNode' && evt.detail && evt.detail.elt) {
                processWebSocketElements(evt.detail.elt);
            } else if (name === 'htmx:afterSwap' && evt.target) {
                processWebSocketElements(evt.target);
            }
            return true; // Allow event to continue
        }
    });
    
    
    // ========================================
    // PUBLIC API FOR COMPANION EXTENSIONS
    // ========================================
    
    /**
     * Send data over a WebSocket connection associated with an element.
     * 
     * @param {HTMLElement} element - Element with a WebSocket connection
     * @param {*} data - Data to send (will be JSON.stringify'd)
     * @returns {boolean} - True if sent successfully, false otherwise
     */
    function sendRaw(element, data) {
        let url = element._htmx?.wsUrl;
        if (!url) {
            // Try to find parent with connection
            let prefix = htmx.config.prefix || '';
            let ancestor = element.closest('[' + prefix + 'hx-ws\\:connect],[' + prefix + 'hx-ws-connect]');
            if (ancestor) {
                url = normalizeWebSocketUrl(getWsAttribute(ancestor, 'connect'));
            }
        }
        
        if (!url) {
            return false;
        }
        
        let entry = connectionRegistry.get(url);
        if (entry?.socket?.readyState === WebSocket.OPEN) {
            entry.socket.send(JSON.stringify(data));
            return true;
        }
        
        return false;
    }
    
    // Expose API for testing and companion extensions
    if (typeof window !== 'undefined' && window.htmx) {
        window.htmx.ext = window.htmx.ext || {};
        window.htmx.ext.ws = {
            // Public API for companion extensions
            send: sendRaw,
            
            // Testing API
            getRegistry: () => ({
                clear: () => {
                    let entries = Array.from(connectionRegistry.values());
                    connectionRegistry.clear(); // Clear first to prevent reconnects
                    
                    entries.forEach(entry => {
                        entry.refCount = 0; // Prevent pending timeouts from reconnecting
                        if (entry.reconnectTimer) {
                            clearTimeout(entry.reconnectTimer);
                        }
                        if (entry.socket) {
                            // Remove listeners if possible or just close
                            entry.socket.close();
                        }
                        entry.elements.clear();
                        entry.pendingRequests.clear();
                    });
                },
                get: (key) => connectionRegistry.get(key),
                has: (key) => connectionRegistry.has(key),
                size: connectionRegistry.size
            })
        };
    }
})();
