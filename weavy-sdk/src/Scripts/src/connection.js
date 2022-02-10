/* eslint-env commonjs, amd, jquery */

// UMD based on https://github.com/umdjs/umd/blob/master/templates/returnExports.js
// TODO: move to ES6 and transpiler

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define([
            'jquery',
            './utils',
            './promise',
            './console',
            './wvy'
        ], factory);
    } else if (typeof module === 'object' && module.exports) {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        root.wvy = root.wvy || {};
        module.exports = factory(
            require('jquery'),
            require('./utils'),
            require('./promise'),
            require('./console'),
            require('./wvy')
        );
    } else {
        // Browser globals (root is window)
        //root.wvy = root.wvy || {};
        root.wvy.connection = root.wvy.connection || new factory(jQuery, root.wvy.utils, root.wvy.promise, root.wvy.console, root.wvy);
    }
}(typeof self !== 'undefined' ? self : this, function ($, WeavyUtils, WeavyPromise, WeavyConsole, wvy) {


    //console.debug("connection.js", window.name);

    function sanitizeObject(obj) {
        return JSON.parse(JSON.stringify(obj, WeavyUtils.sanitizeJSON));
    }

    var connections = this;

    // CONNECTION HANDLING
    var _connections = new Map();

    function WeavyConnection(url) {
        /**
         *  Reference to this instance
         *  @lends WeavyConnection#
         */
        var weavyConnection = this;

        var console = new WeavyConsole("WeavyConnection");

        var initialized = false;
        var reconnecting = false;

        // use configured transport or fallback to "auto"
        // REVIEW: looks like it performs negotiation even if we explicitly specify a transport?
        var transport = wvy.config && wvy.config.transport || "auto";

        // Set explicit self url
        url = url || window.location.origin + (wvy.config && wvy.config.applicationPath || "/");

        // Remove trailing slash
        url = /\/$/.test(url) ? url.slice(0, -1) : url;

        var connectionUrl = url + "/signalr";

        // create a new hub connection
        var connection = $.hubConnection(connectionUrl, { useDefaultPath: false });

        // configure logging and connection lifetime events
        //connection.logging = true;

        // create hub proxy (why multiple? do we have a client hub?)
        //var hubProxies = { rtm: connection.createHubProxy('rtm'), client: connection.createHubProxy('client') }; 
        var hubProxies = { rtm: connection.createHubProxy('rtm') };

        // we have to register (at least one) event handler before calling the start method
        hubProxies["rtm"].on("eventReceived", rtmEventRecieved);

        var _events = [];
        var _reconnectMessageTimeout = null;
        var _reconnectInterval = null;
        var reconnectRetries = 0;
        var explicitlyDisconnected = false;

        var whenConnectionStart;
        var whenConnected = new WeavyPromise();
        var whenLeaderElected = new WeavyPromise();
        var whenAuthenticated = new WeavyPromise();

        var states = $.signalR.connectionState;

        // Provide reverse readable state strings
        // And convert strings to int
        for (var stateName in states) {
            if (Object.prototype.hasOwnProperty.call(states, stateName)) {
                states[states[stateName]] = stateName;
                states[stateName] = parseInt(states[stateName]);
            }
        }

        var state = parseInt(states.disconnected);
        var childConnection = null;
        var connectedAt = null;


        //----------------------------------------------------------
        // Init the connection
        // url: the url to the /signalr 
        // windows: initial [] of windows to post incoming events to when embedded
        // force: if to connect event if the user is not logged in
        //----------------------------------------------------------
        function init(connectAfterInit, authentication) {
            if (!initialized) {
                initialized = true;
                console.debug("init" + (!window.name ? "self" : "") + " to " + url, connectAfterInit ? "and connect" : "");

                wvy.postal.whenLeader().then(function (isLeader) {
                    if (isLeader) {
                        console.debug("is leader, let's go");
                        childConnection = false;
                        whenLeaderElected.resolve(true);
                    } else {
                        childConnection = true;
                        whenLeaderElected.resolve(false);
                    }
                });

                authentication = authentication || wvy.authentication.get(url);

                authentication.whenAuthenticated().then(function () {
                    whenAuthenticated.resolve();
                });

                authentication.on("user", function (e, auth) {
                    if (auth.state !== "updated") {
                        disconnectAndConnect();
                    }
                });

                on("reconnected.connection.weavy", function (e) {
                    if (authentication.isAuthenticated()) {
                        // Check if user state is still valid
                        authentication.updateUserState("wvy.connection:reconnected");
                    }
                });

                wvy.postal.on("distribute", { weavyId: "wvy.connection", connectionUrl: connectionUrl }, onParentMessageReceived);
                wvy.postal.on("message", { weavyId: "wvy.connection", connectionUrl: connectionUrl }, onChildMessageReceived);
            }

            if (connectAfterInit) {
                // Only explicitly connect the leader
                return whenLeaderElected().then(function (leader) {
                    if (leader) {
                        connectionStart();
                    }
                    return whenConnected();
                });
            } else {
                return whenLeaderElected();
            }
        }

        function connect() {
            return whenLeaderElected().then(function (leader) {
                if (leader) {
                    connectionStart();
                } else {
                    wvy.postal.postToParent({ name: "request:connection-start", weavyId: "wvy.connection", connectionUrl: connectionUrl });
                }
                return whenConnected();
            });
        }

        // start the connection
        function connectionStart() {
            return whenAuthenticated().then(function () {
                explicitlyDisconnected = false;

                if (status() === states.disconnected) {
                    state = states.connecting;
                    triggerEvent("state-changed.connection.weavy", { state: state });

                    whenConnectionStart = connection.start({ transport: transport }).always(function () {
                        console.debug((childConnection ? "child " : "") + "connection started");
                        wvy.postal.postToChildren({ name: "connection-started", weavyId: "wvy.connection", connectionUrl: connectionUrl });
                        whenConnected.resolve();
                    }).catch(function (error) {
                        console.warn((childConnection ? "child " : "") + "could not start connection")
                    });
                }

                return whenConnectionStart;
            });
        }

        // stop connection
        function disconnect(async, notify) {
            if (!childConnection && connection.state !== states.disconnected && explicitlyDisconnected === false) {
                explicitlyDisconnected = true;
                whenConnected.reset();

                try {
                    connection.stop(async === true, notify !== false).then(function () {
                        return Promise.resolve();
                    }).catch(function () {
                        return Promise.resolve();
                    });
                } catch (e) {
                    return Promise.resolve();
                }
            } else {
                return Promise.resolve();
            }
        }

        function disconnectAndConnect() {
            return new Promise(function (resolve) {
                if (!childConnection && connection.state !== states.disconnected) {
                    explicitlyDisconnected = false;
                    disconnect(true, false).then(function () {
                        connect().then(resolve);
                    });
                } else {
                    resolve();
                }
            });
        }

        function status() {
            return parseInt(state);
        }

        // attach an event handler for the specified connection or server event, e.g. "presence", "typing" etc (see PushService for a list of built-in events)
        function on(event, handler) {
            if (event.indexOf(".connection") !== -1) {
                // .connection.weavy (connection events)
                event = event.indexOf(".weavy") === -1 ? event + ".weavy" : event;
            } else {
                // .rtmweavy (realtime events)
                event = event.indexOf(".rtmweavy") === -1 ? event + ".rtmweavy" : event;
            }
            _events.push([event, handler]);
            $(weavyConnection).on(event, null, null, handler);
        }

        function off(event, handler) {
            if (event.indexOf(".connection") !== -1) {
                // .connection.weavy (connection events)
                event = event.indexOf(".weavy") === -1 ? event + ".weavy" : event;
            } else {
                // .rtmweavy (realtime events)
                event = event.indexOf(".rtmweavy") === -1 ? event + ".rtmweavy" : event;
            }

            _events = _events.filter(function (eventHandler) {
                if (eventHandler[0] === event && eventHandler[1] === handler) {
                    $(weavyConnection).off(event, null, handler);
                    return false;
                } else {
                    return true;
                }
            })
        }

        function triggerEvent(name) {
            console.debug("triggering event " + name);
            var event = $.Event(name);

            // trigger event (with json object instead of string), handle any number of json objects passed from hub (args)
            var argumentArray = [].slice.call(arguments, 1);
            var data = argumentArray.map(function (a) {
                if (a && !$.isArray(a) && !$.isPlainObject(a)) {
                    try {
                        return JSON.parse(a);
                    } catch (e) {
                        console.warn((childConnection ? "child " : "") + "could not parse event data;", name);
                    }
                }
                return a;
            });

            $(weavyConnection).triggerHandler(event, data);
            triggerToChildren("distribute-event", name, data);
        }

        // trigger a message distribute
        function triggerToChildren(name, eventName, data) {
            try {
                wvy.postal.postToChildren({ name: name, eventName: eventName, data: data, weavyId: "wvy.connection", connectionUrl: connectionUrl });
            } catch (e) {
                console.warn((childConnection ? "child " : "") + "could not distribute relay realtime message", { name: name, eventName: eventName }, e);
            }
        }

        // invoke a method on a server hub, e.g. "SetActive" on the RealTimeHub (rtm) or "Typing" on the MessengerHub (messenger).
        function invoke(hub, method, data) {
            var args = data ? [method, sanitizeObject(data)] : [method];

            var whenInvoked = new Promise(function (resolve, reject) {

                whenLeaderElected().then(function (leader) {
                    if (leader) {

                        console.debug("wvy.connection: invoke as leader", hub, args[0]);
                        var proxy = hubProxies[hub];

                        connect().then(function () {
                            proxy.invoke.apply(proxy, args)
                                .then(function (invokeResult) {

                                    // Try JSON parse
                                    if (typeof invokeResult === "string") {
                                        try {
                                            invokeResult = JSON.parse(invokeResult);
                                        } catch (e) { /* Ignore catch */ }
                                    }

                                    resolve(invokeResult);
                                })
                                .catch(function (error) {
                                    //console.warn(error, hub, args);
                                    reject(error);
                                });
                        });
                    } else {
                        // Invoke via parent
                        var invokeId = "wvy.connection-" + Math.random().toString().substr(2);
                        console.debug("invoke via parent", hub, args[0], invokeId);

                        var invokeResult = function (msg) {
                            if (msg.data.name === "invokeResult" && msg.data.invokeId === invokeId) {
                                console.debug("parent invokeResult received", invokeId);
                                if (msg.data.error) {
                                    reject(msg.data.error);
                                } else {
                                    var invokeResult = msg.data.result;

                                    // Try JSON parse
                                    if (typeof invokeResult === "string") {
                                        try {
                                            invokeResult = JSON.parse(invokeResult);
                                        } catch (e) { /* Ignore catch */ }
                                    }
                                    resolve(invokeResult);
                                }
                                wvy.postal.off("invokeResult", { weavyId: "wvy.connection", connectionUrl: connectionUrl }, invokeResult);
                            }
                        };

                        wvy.postal.on("invokeResult", { weavyId: "wvy.connection", connectionUrl: connectionUrl }, invokeResult);

                        wvy.postal.postToParent({ name: "invoke", hub: hub, args: args, invokeId: invokeId, weavyId: "wvy.connection", connectionUrl: connectionUrl });
                    }
                });
            });

            return whenInvoked;
        }




        connection.stateChanged(function (connectionState) {
            // Make sure connectionState is int
            var newState = parseInt(connectionState.newState);

            if (newState === states.connected) {
                if (childConnection) {
                    console.debug("child connected " + connection.id + " (" + connection.transport.name + ")");
                } else {
                    console.log("connected " + connection.id + " (" + connection.transport.name + ")");
                }

                // clear timeouts
                window.clearTimeout(_reconnectMessageTimeout);
                window.clearInterval(_reconnectInterval);

                // reset retries
                reconnectRetries = 0;

                if (wvy.alert) {
                    wvy.alert.close("connection-state");
                } else {
                    triggerToChildren("alert", "close", "connection-state");
                }

                whenConnected.resolve();

                // Trigger reconnected on connect excluding the first connect
                if (connectedAt) {
                    triggerEvent("reconnected.connection.weavy");
                }

                connectedAt = new Date();
            }

            state = newState;
            // trigger event
            triggerEvent("state-changed.connection.weavy", { state: newState });
        });

        connection.reconnected(function () {
            reconnecting = false;
        });

        connection.reconnecting(function () {
            reconnecting = true;
            if (childConnection) {
                console.debug("child reconnecting...");
            } else {
                console.log("reconnecting...");
            }

            // wait 2 seconds before showing message
            if (_reconnectMessageTimeout !== null) {
                window.clearTimeout(_reconnectMessageTimeout);
            }

            _reconnectMessageTimeout = setTimeout(function () {
                if (wvy.alert) {
                    wvy.alert.alert("primary", wvy.t("Reconnecting..."), null, "connection-state");
                } else {
                    triggerToChildren("alert", "show", { type: "primary", title: wvy.t("Reconnecting..."), id: "connection-state" });
                }
            }, 2000);
        });

        connection.disconnected(function () {
            console.debug((childConnection ? "child " : "") + "disconnected");

            if (!explicitlyDisconnected) {
                reconnectRetries++;
                window.clearInterval(_reconnectInterval);

                if (reconnecting) {
                    connection.start({ transport: transport }).catch((reason) => {
                        console.warn("could not connect", reason)

                    });
                    reconnecting = false;
                } else {
                    // connection dropped, try to connect again after 5s
                    _reconnectInterval = window.setInterval(function () {
                        if (window.navigator.onLine) {
                            connection.start({ transport: transport }).catch((reason) => {
                                console.warn("could not reconnect", reason)
                            });
                            window.clearInterval(_reconnectInterval)
                        } else {
                            console.debug("waiting for online")
                        }
                    }, 5000);
                }
            }

            // trigger event
            triggerEvent("disconnected.connection.weavy", { retries: reconnectRetries, explicitlyDisconnected: explicitlyDisconnected });

        });

        // REALTIME EVENTS

        // generic callback used by server to notify clients that a realtime event happened
        // NOTE: we only need to hook this up in standalone, in the weavy client we wrap realtime events in the cross-frame-event and post to the frames
        function rtmEventRecieved(name, args) {
            console.debug("received event " + name);
            name = name.indexOf(".rtmweavy" === -1) ? name + ".rtmweavy" : name;
            triggerEvent(name, args);
        }

        // REALTIME CROSS WINDOW MESSAGE
        // handle cross frame events from rtm
        var onChildMessageReceived = function (e) {
            var msg = e.data;
            switch (msg.name) {
                case "invoke":
                    whenLeaderElected().then(function (leader) {
                        if (leader) {
                            var proxy = hubProxies[msg.hub];
                            var args = msg.args;
                            console.debug("processing invoke request", msg.invokeId, msg.args);
                            connect().then(function () {
                                proxy.invoke.apply(proxy, args)
                                    .then(function (invokeResult) {
                                        console.debug("returning invoke request result", msg.args[0], msg.invokeId);
                                        wvy.postal.postToSource(e, {
                                            name: "invokeResult",
                                            hub: msg.hub,
                                            args: args,
                                            result: invokeResult,
                                            invokeId: msg.invokeId,
                                            weavyId: "wvy.connection",
                                            connectionUrl: connectionUrl
                                        });
                                    })
                                    .catch(function (error) {
                                        console.warn(error);
                                        wvy.postal.postToSource(e, {
                                            name: "invokeResult",
                                            hub: msg.hub,
                                            args: args,
                                            error: error,
                                            invokeId: msg.invokeId,
                                            weavyId: "wvy.connection",
                                            connectionUrl: connectionUrl
                                        });
                                    });
                            });
                        }

                    });
                    break;
                case "request:connection-start":
                    whenLeaderElected().then(function (leader) {
                        if (leader) {
                            //console.debug("processing connect request");
                            connect().then(function () {
                                wvy.postal.postToChildren({ name: "connection-started", weavyId: "wvy.connection", connectionUrl: connectionUrl });
                            });
                        }
                    });
                    break;
                default:
                    return;
            }
        };

        var onParentMessageReceived = function (e) {
            var msg = e.data;
            switch (msg.name) {
                case "connection-started":
                    whenLeaderElected().then(function (leader) {
                        if (!leader) {
                            //console.debug((childConnection ? "child " : "") + "distribute received", msg.name, msg.eventName || "");
                            state = states.connected;
                            whenConnected.resolve();
                        }
                    });
                    break;
                case "distribute-event":
                    var name = msg.eventName;
                    var event = $.Event(name);
                    var data = msg.data;

                    // Extract array with single value
                    if (Array.isArray(data) && data.length === 1) {
                        data = data[0];
                    }

                    if (name === "state-changed.connection.weavy") {
                        state = parseInt(data.state);
                        if (state === states.connected) {
                            whenConnected.resolve();
                        }
                    }

                    //console.debug((childConnection ? "child " : "") + "triggering received distribute-event", name);
                    $(weavyConnection).triggerHandler(event, msg.data);
                    break;
                case "alert":
                    if (wvy.alert) {
                        if (msg.eventName === "show") {
                            console.debug("alert show received", msg.data.title);
                            wvy.alert.alert(msg.data.type, msg.data.title, null, msg.data.id);
                        } else {
                            wvy.alert.close(msg.data);
                        }
                    }
                    break;
                default:
                    return;
            }
        };


        function destroy() {
            disconnect();

            reconnecting = false;

            window.clearTimeout(_reconnectMessageTimeout);
            window.clearTimeout(_reconnectInterval);

            try {
                wvy.postal.off("distribute", { weavyId: "wvy.connection", connectionUrl: connectionUrl }, onParentMessageReceived);
                wvy.postal.off("message", { weavyId: "wvy.connection", connectionUrl: connectionUrl }, onChildMessageReceived);
            } catch (e) { /* Ignore catch */ }

            try {
                hubProxies["rtm"].off("eventReceived", rtmEventRecieved);
            } catch (e) { /* Ignore catch */ }

            _events.forEach(function (eventHandler) {
                var name = eventHandler[0], handler = eventHandler[1];
                $(weavyConnection).off(name, null, handler);
            });
            _events = [];
        }

        this.connect = connect;
        this.destroy = destroy;
        this.disconnect = disconnect;
        this.disconnectAndConnect = disconnectAndConnect;
        this.init = init;
        this.invoke = invoke;
        this.on = on;
        this.off = off;
        this.proxies = hubProxies;
        this.states = states;
        this.status = status;
        this.transport = function () { return connection.transport.name; };
    }

    connections.get = function (url) {
        var sameOrigin = false;

        url = url && String(url);

        var urlExtract;
        try {
            urlExtract = url && /^(https?:\/(\/[^/]+)+)\/?$/.exec(url)
        } catch (e) {
            console.error("Unable to parse connection URL, make sure to connect to a valid domain.")
        }
        if (urlExtract) {
            sameOrigin = window.location.origin === urlExtract[1]
            url = urlExtract[1];
        }
        url = (sameOrigin ? "" : url) || "";
        if (_connections.has(url)) {
            return _connections.get(url);
        } else {
            var connection = new WeavyConnection(url);
            _connections.set(url, connection);
            return connection;
        }
    };

    connections.remove = function (url) {
        url = url && String(url) || "";
        try {
            var connection = _connections.get(url);
            if (connection && connection.destroy) {
                connection.destroy();
            }
            _connections.delete(url);
        } catch (e) {
            console.warn("Could not remove connection", url, e);
        }
    };

    // expose wvy.connection.default. self initiatied upon access and no other connections are active 
    Object.defineProperty(connections, "default", {
        get: function () {
            if (_connections.has("")) {
                return _connections.get("");
            } else {
                var connection = connections.get();

                WeavyUtils.ready(function () {
                    setTimeout(function () {
                        if (_connections.size === 1) {
                            connection.init(true, wvy.authentication.default);
                        }
                    }, 1);
                });

                return connection;
            }
        }
    });

    // Bridge for simple syntax and backward compatibility with the mobile apps
    Object.defineProperty(connections, "on", {
        get: function () {
            return connections.default.on;
        }
    });

    // Bridge for simple syntax
    Object.defineProperty(connections, "invoke", {
        get: function () {
            return connections.default.invoke;
        }
    });
}));


/**
 * @external Promise
 * @see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Using_promises
 */

/**
 * @external jqXHR
 * @see http://api.jquery.com/jQuery.ajax/#jqXHR
 */

/**
 * @external jqAjaxSettings
 * @see http://api.jquery.com/jquery.ajax/#jQuery-ajax-settings
 */
