// Zendesk Auto Translator — PDF.js viewer bridge.
//
// Loaded by viewer.html. Listens for { type: 'zt-pdf-load', url: '...' }
// from the parent content script and hands the URL to PDF.js's
// PDFViewerApplication.open({ url, withCredentials: true }).
//
// Why pass the URL through and let PDF.js fetch it: this iframe runs
// at chrome-extension:// origin, which is an extension page. Extension
// pages with matching host_permissions can fetch with
// credentials: 'include' — Chrome uses the user's actual cookie jar
// for the target origin, CORS is bypassed, and the redirect from
// `*.zendesk.com/attachments/<token>/` to the signed URL on
// `*.zdusercontent.com` resolves correctly. PDF.js's `withCredentials`
// option is exactly the knob we need.
//
// Why this is loaded as an external file (not inline in viewer.html):
// extensions' default CSP is `script-src 'self'`, which forbids inline
// <script> tags. v1.0.48 hit that.
//
// History:
//   v1.0.48: inline (CSP-blocked).
//   v1.0.49: external file, but content script fetched and posted
//            ArrayBuffer here. chrome.runtime.sendMessage doesn't
//            structured-clone binary, so the bytes arrived as
//            undefined. Reverted in v1.0.50 to URL-passing.

(function () {
    'use strict';

    window.addEventListener('message', function (ev) {
        var msg = ev && ev.data;
        if (!msg || msg.type !== 'zt-pdf-load' || !msg.url) return;

        var openWith = function () {
            try {
                window.PDFViewerApplication.open({
                    url: msg.url,
                    withCredentials: true,
                });
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
