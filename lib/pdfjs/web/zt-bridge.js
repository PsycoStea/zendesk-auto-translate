// Zendesk Auto Translator — PDF.js viewer bridge.
//
// Loaded by viewer.html. Listens for { type: 'zt-pdf-load',
// data: ArrayBuffer } from the parent content script and hands the
// bytes to PDF.js's PDFViewerApplication.open({ data }).
//
// Why bytes-via-postMessage instead of a URL: Zendesk's
// `/attachments/<token>/` redirector requires the agent's session
// cookie. The content script can't fetch it credentialed in MV3
// (cross-origin from chrome-extension://), but the background service
// worker can — it then ships the bytes to the content script, which
// posts them here.
//
// Why an external file (not inline in viewer.html): Chrome extensions'
// default CSP forbids inline <script> tags. The CSP error in v1.0.48
// was: "Executing inline script violates the following Content
// Security Policy directive 'script-src 'self''."

(function () {
    'use strict';

    window.addEventListener('message', function (ev) {
        var msg = ev && ev.data;
        if (!msg || msg.type !== 'zt-pdf-load' || !msg.data) return;

        var openWith = function () {
            try {
                window.PDFViewerApplication.open({ data: msg.data });
            } catch (err) {
                console.error('[zt-pdf viewer] open() failed:', err);
            }
        };

        var app = window.PDFViewerApplication;
        if (app && app.initialized) {
            openWith();
        } else if (app && app.initializedPromise) {
            app.initializedPromise.then(openWith);
        } else {
            // viewer.mjs hasn't executed yet — retry briefly.
            var tries = 0;
            var retry = function () {
                if (window.PDFViewerApplication && window.PDFViewerApplication.initializedPromise) {
                    window.PDFViewerApplication.initializedPromise.then(openWith);
                } else if (tries++ < 50) {
                    setTimeout(retry, 50);
                } else {
                    console.error('[zt-pdf viewer] PDFViewerApplication never became ready');
                }
            };
            retry();
        }
    }, false);
})();
