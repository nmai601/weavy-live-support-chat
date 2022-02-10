﻿/* eslint-env commonjs, amd */

// UMD based on https://github.com/umdjs/umd/blob/master/templates/returnExports.js
// TODO: move to ES6 and transpiler

(function (root, factory) {
    if (typeof define === 'function' && define.amd) {
        // AMD. Register as an anonymous module.
        define([
            'weavy'
        ], factory);
    } else if (typeof module === 'object' && module.exports) {
        // Node. Does not work with strict CommonJS, but
        // only CommonJS-like environments that support module.exports,
        // like Node.
        module.exports = factory(
            require('weavy')
        );
    } else {
        // Browser globals (root is window)
        if (typeof root.Weavy === 'undefined' || !root.Weavy.plugins) {
            throw new Error("Weavy must be loaded before registering plugin");
        }

        factory(root.Weavy, root.wvy);
    }
}(typeof self !== 'undefined' ? self : this, function (Weavy, wvy) {

    /**
     * Displaying content and attachments in the full browser window.
     * 
     * @mixin PreviewPlugin
     * @returns {Weavy.plugins.preview}
     * @typicalname weavy.plugins.preview
     */
    var PreviewPlugin = function (options) {
        /** 
         *  Reference to this instance
         *  @lends PreviewPlugin#
         */
        var weavy = this;

        /**
         * The panel for previewing Content
         * @member PreviewPlugin~contentPanel
         * @type {?WeavyPanels~panel}
         * @returns {weavy.nodes.contentPanel}
         * @see {@link Weavy#nodes}
         */
        weavy.nodes.contentPanel = null;

        /**
         * The panel for previewing Attachments
         * @member PreviewPlugin~previewPanel
         * @type {?WeavyPanels~panel}
         * @returns {weavy.nodes.previewPanel}
         * @see {@link Weavy#nodes}
         */
        weavy.nodes.contentPanel = null;

        /**
         * Requests the topmost open panel to make a prev navigation
         * @param {Event} e
         */
        function requestPrev(e) {
            if (weavy.nodes.previewPanel.isOpen) {
                weavy.nodes.previewPanel.postMessage({ name: "request:prev" });
                e.stopImmediatePropagation();
            } else if (weavy.nodes.contentPanel.isOpen) {
                e.stopImmediatePropagation();
                weavy.nodes.contentPanel.postMessage({ name: "request:prev" });
            }
        }

        /**
         * Requests the topmost open panel to make a next navigation
         * @param {Event} e
         */
        function requestNext(e) {
            if (weavy.nodes.previewPanel.isOpen) {
                e.stopImmediatePropagation();
                weavy.nodes.previewPanel.postMessage({ name: "request:next" });
            } else if (weavy.nodes.contentPanel.isOpen) {
                e.stopImmediatePropagation();
                weavy.nodes.contentPanel.postMessage({ name: "request:next" });
            }
        }

        weavy.on(document, "keyup", function (e) {
            if (e.which === 27) { // Esc
                if (weavy.nodes.previewPanel.isOpen) {
                    e.stopImmediatePropagation();
                    weavy.nodes.previewPanel.close();
                } else if (weavy.nodes.contentPanel.isOpen) {
                    e.stopImmediatePropagation();
                    weavy.nodes.contentPanel.close();
                }
            }
            if (e.which === 37) { // Left
                requestPrev(e);
            }
            if (e.which === 39) { // Right
                requestNext();
            }
        })

        /**
         * Recieves a prev request from a panel and sends it to the topmost open preview panel.
         **/
        weavy.on(wvy.postal, "request:prev", weavy.getId(), function (e, message) {
            weavy.log("bouncing request:prev");
            requestPrev(e);
        });

        /**
         * Recieves a next request from a panel and sends it to the topmost open preview panel.
         **/
        weavy.on(wvy.postal, "request:next", weavy.getId(), function (e, message) {
            weavy.log("bouncing request:next");
            requestNext(e);
        });

        // ATTACHMENT PREVIEW
        weavy.on(wvy.postal, "preview-open", weavy.getId(), function (e, message) {
            weavy.log("opening preview");
            var previewUrl = new URL(message.url, weavy.url).href;

            weavy.nodes.previewPanel.open(previewUrl).then(focus);
        });

        // CONTENT PREVIEW
        weavy.on(wvy.postal, "content-open", weavy.getId(), function (e, message) {
            weavy.log("opening content");

            var contentUrl = new URL(message.url, weavy.url).href;

            weavy.nodes.contentPanel.open(contentUrl).then(focus);
        });

        weavy.on("build", function (e, build) {
            // Content panel
            if (!weavy.nodes.contentPanel) {
                weavy.nodes.contentPanel = weavy.nodes.panels.preview.addPanel(options.contentFrameName, "/content/", { controls: { close: true }, persistent: true, preload: "placeholder" });
                weavy.nodes.contentPanel.node.classList.add("weavy-panel-light");

                weavy.nodes.contentPanel.on("before:panel-open", function (e, openPanel) {
                    weavy.nodes.contentPanel.loadingStarted(true);
                });
            }

            // Preview panel
            if (!weavy.nodes.previewPanel) {
                weavy.nodes.previewPanel = weavy.nodes.panels.preview.addPanel(options.previewFrameName, "/attachments/", { controls: { close: true }, persistent: true, preload: "placeholder" });
                weavy.nodes.previewPanel.on("before:panel-open", function (e, openPanel) {
                    weavy.nodes.previewPanel.loadingStarted(true);
                });
                weavy.nodes.previewPanel.on("before:panel-close", function (e, closePanel) {
                    if (weavy.nodes.contentPanel.isOpen) {
                        focus({ panelId: options.contentFrameName });
                    }
                });
            }
        });

        /**
         * Tries to focus a preview panel frame
         * 
         * @param {Object} open - Object with panel data
         * @property {string} open.panelId - The id of the panel to focus; "content" or "preview".
         */
        function focus(open) {
            var panel = open.panelId === options.contentFrameName ? weavy.nodes.contentPanel : weavy.nodes.previewPanel
            try {
                panel.frame.contentWindow.focus();
            } catch (e) {
                panel.frame.focus();
            }
        }

        /**
         * Opens a url in a preview panel. If the url is an attachment url it will open in the preview panel.
         * 
         * @memberof PreviewPlugin#
         * @param {string} url - The url to the preview page to open
         */
        function open(url) {
            return weavy.whenLoaded().then(function () {
                var attachmentUrl = /^(.*)(\/attachments\/[0-9]+\/?)(.+)?$/.exec(url);
                if (attachmentUrl) {
                    return weavy.nodes.previewPanel.open(url).then(focus)
                } else {
                    weavy.nodes.previewPanel.close();
                    return weavy.nodes.contentPanel.open(url).then(focus);
                }
            });
        }

        /**
         * Closes all open preview panels.
         * @memberof PreviewPlugin#
         * @param {boolean} noHistory - Set to true if you want no navigation history generated when closing
         **/
        function closeAll(noHistory) {
            return weavy.whenLoaded().then(function () {
                return Promise.all([weavy.nodes.previewPanel.close(noHistory), weavy.nodes.contentPanel.close(noHistory)]);
            });
        }

        // Exports (not required)
        return {
            open: open,
            closeAll: closeAll
        }
    };

    /**
     * Default plugin options
     * 
     * @example
     * Weavy.plugins.preview.defaults = {
     *   previewFrameName: "preview",
     *   contentFrameName: "content"
     * };
     * 
     * @name defaults
     * @memberof PreviewPlugin
     * @type {Object}
     */
    PreviewPlugin.defaults = {
        previewFrameName: "preview",
        contentFrameName: "content"
    };

    //console.debug("Registering Weavy plugin: preview");
    return Weavy.plugins.preview = PreviewPlugin
}));
