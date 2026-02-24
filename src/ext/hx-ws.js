(() => {
    let api;
    
    // Build a CSS selector for querySelectorAll, respecting prefix + metaCharacter
    function wsSelector(suffix) {
        let attr = (htmx.config.prefix || 'hx-') + 'ws' + (htmx.config.metaCharacter || ':') + suffix;
        return `[${CSS.escape(attr)}]`;
    }

    // ========================================
    // CONFIGURATION
    // ========================================
    
    function getConfig(element) {
        const defaults = {
            reconnect: true,
            reconnectDelay: 500,
            reconnectMaxDelay: 60000,
            reconnectMaxAttempts: Infinity,
            reconnectJitter: 0.3,
            pauseOnBackground: true,
            pendingRequestTTL: 30000          // [Correlation]
        };
        let global = htmx.config.websockets || {};
        let perElement = {};
        if (element) {
            let ctx = api.createRequestContext(element, new CustomEvent('_'));
            perElement = ctx.request.ws || {};
        }
        return { ...defaults, ...global, ...perElement };
    }
    
    // ========================================
    // URL NORMALIZATION
    // ========================================
    
    function normalizeWebSocketUrl(url) {
        // Already a WebSocket URL
        if (url.startsWith('ws://') || url.startsWith('wss://')) {
            return url;
        }

        // Convert http(s):// to ws(s)://
        if (url.startsWith('http://')) {
            return 'ws://' + url.slice(7);
        }
        if (url.startsWith('https://')) {
            return 'wss://' + url.slice(8);
        }

        // Relative URL - build absolute ws(s):// URL
        let protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let host = window.location.host;
        
        if (url.startsWith('//')) {
            // Protocol-relative URL
            return protocol + url;
        }
        
        if (url.startsWith('/')) {
            // Absolute path
            return protocol + '//' + host + url;
        }
        
        // Relative path - resolve against current location
        let basePath = window.location.pathname.substring(0, window.location.pathname.lastIndexOf('/') + 1);
        return protocol + '//' + host + basePath + url;
    }
    
    // ========================================
    // CONNECTIONS
    // ========================================
    
    const connections = new Map();
    
    function getOrCreateConnection(url, element) {
        let normalizedUrl = normalizeWebSocketUrl(url);

        if (connections.has(normalizedUrl)) {
            return connections.get(normalizedUrl);
        }

        let connection = {
            url: normalizedUrl,
            config: getConfig(element),
            socket: null,
            attempt: 0,
            timer: null,
            pendingRequests: new Map(),       // [Correlation]
            abortController: null,
            visibilityHandler: null,
            cancelled: false
        };

        if (!htmx.trigger(element, 'htmx:before:ws:connection', {connection}) || connection.cancelled) {
            return null;
        }

        // Event passed - now store in registry and create socket
        connections.set(normalizedUrl, connection);
        createWebSocket(normalizedUrl, connection);

        let config = connection.config;
        if (config.pauseOnBackground) {
            connection.visibilityHandler = () => {
                if (document.hidden) {
                    if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
                        connection.socket.close();
                    }
                } else if (!connection.socket || connection.socket.readyState === WebSocket.CLOSED) {
                    connection.attempt = 0;
                    createWebSocket(normalizedUrl, connection);
                }
            };
            document.addEventListener('visibilitychange', connection.visibilityHandler);
        }

        return connection;
    }
    
    function findConnectedElement(url) {
        let sel = wsSelector('connect') + ',' + wsSelector('send');
        for (let el of document.querySelectorAll(sel)) {
            if (el._htmx?.wsUrl === url) return el;
        }
        return null;
    }

    function createWebSocket(url, connection) {
        // Abort old socket's listeners and close it
        if (connection.abortController) {
            connection.abortController.abort();
        }
        if (connection.socket) {
            let oldSocket = connection.socket;
            connection.socket = null;
            try {
                if (oldSocket.readyState === WebSocket.OPEN || oldSocket.readyState === WebSocket.CONNECTING) {
                    oldSocket.close();
                }
            } catch (e) {
                // Socket may already be in an invalid state
            }
        }

        try {
            connection.socket = new WebSocket(url);
            let ac = new AbortController();
            connection.abortController = ac;
            let opts = { signal: ac.signal };

            connection.socket.addEventListener('open', () => {
                let elt = findConnectedElement(url);
                if (elt) htmx.trigger(elt, 'htmx:after:ws:connection', {connection});
                connection.attempt = 0;
            }, opts);

            connection.socket.addEventListener('message', (event) => {
                handleMessage(connection, event);
            }, opts);

            connection.socket.addEventListener('close', (event) => {
                if (event.target !== connection.socket) return;

                let elt = findConnectedElement(url);
                if (elt) htmx.trigger(elt, 'htmx:ws:close', {
                    connection, reason: 'closed', code: event.code
                });

                if (!connections.has(url)) return;

                let config = connection.config;
                if (config.pauseOnBackground && document.hidden) return;

                if (config.reconnect && findConnectedElement(url)) {
                    scheduleReconnect(url, connection);
                } else {
                    cleanupPendingRequests(connection);
                    connections.delete(url);
                }
            }, opts);

            connection.socket.addEventListener('error', (error) => {
                let elt = findConnectedElement(url);
                if (elt) htmx.trigger(elt, 'htmx:ws:error', { url, error });
            }, opts);

        } catch (error) {
            let elt = findConnectedElement(url);
            if (elt) htmx.trigger(elt, 'htmx:ws:error', { url, error });
        }
    }
    
    function scheduleReconnect(url, connection) {
        let config = connection.config;

        connection.attempt++;
        let attempt = connection.attempt;

        if (!config.reconnect || attempt > config.reconnectMaxAttempts) {
            cleanupPendingRequests(connection);
            connections.delete(url);
            return;
        }

        let delay = Math.min(
            config.reconnectDelay * Math.pow(2, attempt - 1),
            config.reconnectMaxDelay
        );

        if (config.reconnectJitter > 0) {
            let jitterRange = delay * config.reconnectJitter;
            delay = Math.max(0, delay + (Math.random() * 2 - 1) * jitterRange);
        }

        let elt = findConnectedElement(url);
        if (elt) {
            connection.cancelled = false;
            if (!htmx.trigger(elt, 'htmx:before:ws:connection', {connection}) || connection.cancelled) {
                cleanupPendingRequests(connection);
                connections.delete(url);
                return;
            }
        }

        connection.timer = setTimeout(() => {
            if (findConnectedElement(url)) {
                createWebSocket(url, connection);
            }
        }, delay);
    }
    
    function closeConnection(url, element) {
        let connection = connections.get(url);
        if (!connection) return;

        if (connection.timer) clearTimeout(connection.timer);
        if (connection.visibilityHandler) {
            document.removeEventListener('visibilitychange', connection.visibilityHandler);
        }
        cleanupPendingRequests(connection);
        htmx.trigger(element, 'htmx:ws:close', {
            connection, reason: 'removed', code: null
        });
        if (connection.socket && connection.socket.readyState === WebSocket.OPEN) {
            connection.socket.close();
        }
        connections.delete(url);
    }
    
    // ========================================
    // PENDING REQUEST MANAGEMENT [Correlation]
    // ========================================
    
    function cleanupPendingRequests(connection) {
        connection.pendingRequests.clear();
    }

    function cleanupExpiredRequests(connection) {
        let config = connection.config;
        let now = Date.now();
        let timeout = config.pendingRequestTTL || 30000;

        for (let [requestId, pending] of connection.pendingRequests) {
            if (now - pending.timestamp > timeout) {
                connection.pendingRequests.delete(requestId);
            }
        }
    }
    
    // ========================================
    // REQUESTS
    // ========================================

    async function sendRequest(element, event) {
        // hx-ws:send="/url" creates its own connection; hx-ws:send (no value) uses ancestor's
        let sendAttr = api.attributeValue(element, 'hx-ws:send');
        let url = (sendAttr && sendAttr !== 'true') ? sendAttr : null;
        if (!url) {
            let ancestor = element.closest(wsSelector('connect'));
            if (ancestor) {
                url = api.attributeValue(ancestor, 'hx-ws:connect');
            }
        }

        if (!url) {
            htmx.trigger(element, 'htmx:ws:error', {
                url: null, error: 'No WebSocket connection found for element'
            });
            return;
        }

        let normalizedUrl = normalizeWebSocketUrl(url);
        let connection = connections.get(normalizedUrl);
        if (!connection || !connection.socket || connection.socket.readyState !== WebSocket.OPEN) {
            htmx.trigger(element, 'htmx:ws:error', { url: normalizedUrl, error: 'Connection not open' });
            return;
        }

        // [Correlation] Cleanup expired pending requests periodically
        cleanupExpiredRequests(connection);

        // Build headers using core's request context (same as HTTP requests)
        let ctx = api.createRequestContext(element, event);
        let headers = {...ctx.request.headers};
        delete headers['Accept'];

        // [Correlation] Add request ID as a header
        let requestId = crypto.randomUUID();
        headers['HX-Request-ID'] = requestId;

        // Build body from form data
        let form = element.form || element.closest('form');
        let formData = api.collectFormData(element, form, event.submitter);
        let valsResult = api.handleHxVals(element, formData);
        if (valsResult) await valsResult;

        // Preserve multi-value form fields (checkboxes, multi-selects)
        let body = {};
        for (let [key, value] of formData) {
            if (key in body) {
                if (!Array.isArray(body[key])) {
                    body[key] = [body[key]];
                }
                body[key].push(value);
            } else {
                body[key] = value;
            }
        }

        let detail = { headers, body };
        if (!htmx.trigger(element, 'htmx:before:ws:request', detail)) {
            return;
        }

        try {
            connection.socket.send(JSON.stringify(detail));

            // [Correlation] Store pending request for response matching
            connection.pendingRequests.set(requestId, { element, timestamp: Date.now() });

            htmx.trigger(element, 'htmx:after:ws:request', detail);
        } catch (error) {
            htmx.trigger(element, 'htmx:ws:error', { url: normalizedUrl, error });
        }
    }
    
    // ========================================
    // MESSAGE RECEIVING & ROUTING
    // ========================================
    
    function handleMessage(connection, event) {
        let json = null;
        try {
            json = JSON.parse(event.data);
        } catch (e) {
            // Not JSON - will be treated as raw HTML below
        }

        // [Correlation] Match response to originating element, or fall back to first subscriber
        let connectionElement = null;
        let requestId = json?.['HX-Request-ID'] || json?.request_id;
        if (requestId && connection.pendingRequests.has(requestId)) {
            connectionElement = connection.pendingRequests.get(requestId).element;
            connection.pendingRequests.delete(requestId);
        } else {
            connectionElement = findConnectedElement(connection.url);
        }

        if (!connectionElement) return;

        let detail = {
            message: { text: event.data, json, cancelled: false }
        };

        if (!htmx.trigger(connectionElement, 'htmx:before:ws:message', detail) || detail.message.cancelled) {
            return;
        }

        // JSON with 'content' field: swap the HTML
        // Raw (non-JSON) string: swap the entire string as HTML
        // JSON without 'content': data-only message, no swap (handle via events)
        let html = detail.message.json ? detail.message.json.content : detail.message.text;
        if (html != null) {
            let target = detail.message.json?.target || api.attributeValue(connectionElement, 'hx-target');
            let swap = detail.message.json?.swap || api.attributeValue(connectionElement, 'hx-swap');

            htmx.swap({
                sourceElement: connectionElement,
                target: target || connectionElement,
                swap: swap || (target ? htmx.config.defaultSwap : 'none'),
                text: html,
                transition: false
            });
        }

        htmx.trigger(connectionElement, 'htmx:after:ws:message', detail);
    }
    
    // ========================================
    // ELEMENT LIFECYCLE
    // ========================================
    
    function initializeElement(element) {
        element._htmx ??= {};
        if (element._htmx.wsInitialized) return;

        let connectUrl = api.attributeValue(element, 'hx-ws:connect');
        if (!connectUrl) return;

        let specString = api.attributeValue(element, 'hx-trigger') || 'load';
        api.onTrigger(element, specString, () => {
            if (element._htmx?.wsUrl) return;
            let connection = getOrCreateConnection(connectUrl, element);
            if (connection) {
                element._htmx.wsUrl = connection.url;
            }
        });
        element._htmx.wsInitialized = true;
    }
    
    function initializeSendElement(element) {
        element._htmx ??= {};
        if (element._htmx.wsSendInitialized) return;

        let sendAttr = api.attributeValue(element, 'hx-ws:send');
        let sendUrl = (sendAttr && sendAttr !== 'true') ? sendAttr : null;
        let specString = api.attributeValue(element, 'hx-trigger');
        if (!specString) {
            specString = element.matches('form') ? 'submit' :
                         element.matches('input:not([type=button]),select,textarea') ? 'change' :
                         'click';
        }

        api.onTrigger(element, specString, async (evt) => {
            if (element.matches('form') && evt.type === 'submit') {
                evt.preventDefault();
            }
            if (sendUrl && !element._htmx?.wsUrl) {
                let connection = getOrCreateConnection(sendUrl, element);
                if (connection) {
                    element._htmx.wsUrl = connection.url;
                }
            }
            await sendRequest(element, evt);
        });
        element._htmx.wsSendInitialized = true;
    }
    
    function cleanupElement(element) {
        let url = element._htmx?.wsUrl;
        if (!url || !connections.has(url)) return;
        element._htmx.wsUrl = null;
        if (!findConnectedElement(url)) {
            closeConnection(url, element);
        }
    }
    
    // ========================================
    // BACKWARD COMPATIBILITY
    // ========================================
    
    function checkLegacyAttributes(element) {
        if (element.hasAttribute('ws-connect') || element.hasAttribute('ws-send')) {
            console.warn('HTMX WebSocket: Legacy attributes ws-connect and ws-send are deprecated. Use hx-ws:connect and hx-ws:send instead.');

            if (element.hasAttribute('ws-connect')) {
                let url = element.getAttribute('ws-connect');
                let attr = (htmx.config.prefix || 'hx-') + 'ws' + (htmx.config.metaCharacter || ':') + 'connect';
                if (!element.hasAttribute(attr)) {
                    element.setAttribute(attr, url);
                }
            }

            if (element.hasAttribute('ws-send')) {
                let attr = (htmx.config.prefix || 'hx-') + 'ws' + (htmx.config.metaCharacter || ':') + 'send';
                if (!element.hasAttribute(attr)) {
                    element.setAttribute(attr, '');
                }
            }
        }
    }
    
    // ========================================
    // EXTENSION REGISTRATION
    // ========================================
    
    htmx.registerExtension('ws', {
        init: (internalAPI) => {
            api = internalAPI;
            
            // Initialize default config if not set
            if (!htmx.config.websockets) {
                htmx.config.websockets = {};
            }
        },
        
        htmx_after_process: (element) => {
            const processNode = (node) => {
                checkLegacyAttributes(node);

                if (api.attributeValue(node, 'hx-ws:connect') != null) {
                    initializeElement(node);
                }

                if (api.attributeValue(node, 'hx-ws:send') != null) {
                    initializeSendElement(node);
                }
            };

            processNode(element);

            let sel = wsSelector('connect') + ',' + wsSelector('send') + ',[ws-connect],[ws-send]';
            element.querySelectorAll(sel).forEach(processNode);
        },
        
        htmx_before_cleanup: (element) => {
            cleanupElement(element);
        }
    });
    
    // Expose connections for testing
    if (typeof window !== 'undefined' && window.htmx) {
        window.htmx.ext = window.htmx.ext || {};
        window.htmx.ext.ws = {
            getRegistry: () => ({
                clear: () => {
                    let activeConnections = Array.from(connections.values());
                    connections.clear(); // Clear first to prevent reconnects

                    activeConnections.forEach(connection => {
                        if (connection.timer) {
                            clearTimeout(connection.timer);
                        }
                        if (connection.visibilityHandler) {
                            document.removeEventListener('visibilitychange', connection.visibilityHandler);
                        }
                        if (connection.abortController) {
                            connection.abortController.abort();
                        }
                        if (connection.socket) {
                            connection.socket.close();
                        }
                        connection.pendingRequests.clear();
                    });
                },
                get: (key) => connections.get(normalizeWebSocketUrl(key)),
                has: (key) => connections.has(normalizeWebSocketUrl(key)),
                get size() { return connections.size; }
            })
        };
    }
})();
