// ============================================
// translate-core.js
// ============================================
//
// Pure / DOM-only helpers extracted from content.js (Phase 2 #11) so
// they can be unit-tested under Node with jsdom. The same file loads as
// the first content script in the browser; the UMD wrapper at the
// bottom exposes the helpers as `window.__ztCore` there and as
// `module.exports` under Node.
//
// Loaded BEFORE content.js in manifest.json's content_scripts.js array,
// so the destructuring at the top of content.js's IIFE picks up these
// names from the namespace.
//
// What lives here:
//   - escapeHtml
//   - serializeNodeAsMarkdown / htmlToMarkdownish (DOM walk → markdown,
//     captures <img> outerHTML into the imgs array)
//   - markdownishToHtml (markdown + imgs → HTML, restores image tokens)
//   - stripMarkdownSyntax
//   - extractEnglishSourceFromMarkdown
//   - protectUrls / restoreUrls / makeUrlToken (URL token shielding
//     across the translator call)
//   - splitCommentAtFirstBlockquote and the trim helpers it depends on
//
// What stays in content.js:
//   - everything that touches chrome.* APIs, Zendesk-specific selectors,
//     event listeners, the extension's UI rendering, or the
//     extension-wide stateful objects (autoRetranslate, cacheStats,
//     ticketLanguages, etc.). Those are integration concerns and don't
//     belong in unit-testable core.

(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        // Node — for tests
        module.exports = factory();
    } else {
        // Browser — content.js destructures from window.__ztCore
        root.__ztCore = factory();
    }
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // ---- HTML escaping ----

    function escapeHtml(s) {
        return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ---- URL token shielding ----
    //
    // Translators sometimes mangle markdown-style links and bare URLs.
    // protectUrls swaps each URL for a `{{ztlinkN}}` token before the
    // translator call; restoreUrls swaps the token back to the captured
    // URL after. Tokens shaped like Zendesk's own `{{...}}` placeholders
    // ride through translators verbatim.

    function makeUrlToken(idx) {
        return `{{ztlink${idx}}}`;
    }

    function protectUrls(text) {
        const urls = [];
        let out = text;

        // Markdown links first. Allow one level of nested parens in the
        // URL so Wikipedia-style links (…Foo_(bar)) survive.
        out = out.replace(
            /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g,
            (_match, txt, url) => {
                urls.push(url);
                return `[${txt}](${makeUrlToken(urls.length - 1)})`;
            }
        );

        // Bare http(s) URLs. Trailing punctuation (period, comma, close
        // paren, etc.) is split off so "See https://example.com." doesn't
        // capture the period as part of the URL.
        out = out.replace(
            /https?:\/\/[^\s<>"'`]+/g,
            (url) => {
                const trailMatch = url.match(/[.,;:!?"'\])]+$/);
                const trailing = trailMatch ? trailMatch[0] : '';
                const cleanUrl = trailing ? url.slice(0, -trailing.length) : url;
                urls.push(cleanUrl);
                return makeUrlToken(urls.length - 1) + trailing;
            }
        );

        return { text: out, urls };
    }

    function restoreUrls(text, urls) {
        return text.replace(/\{\{ztlink(\d+)\}\}/g, (match, idx) => {
            const i = parseInt(idx, 10);
            return i < urls.length && urls[i] != null ? urls[i] : match;
        });
    }

    // ---- Blockquote split ----
    //
    // Splits a comment body at its first <blockquote> so we only feed
    // the customer's new reply (content before the blockquote) through
    // translation, leaving the quoted email history untouched.

    function splitCommentAtFirstBlockquote(commentEl) {
        if (!commentEl.querySelector('blockquote')) {
            return { beforeHtml: commentEl.innerHTML, afterHtml: '' };
        }
        const beforeClone = commentEl.cloneNode(true);
        const afterClone = commentEl.cloneNode(true);
        trimFromFirstBlockquote(beforeClone);
        trimBeforeFirstBlockquote(afterClone);
        return { beforeHtml: beforeClone.innerHTML, afterHtml: afterClone.innerHTML };
    }

    function trimFromFirstBlockquote(root) {
        const bq = root.querySelector('blockquote');
        if (!bq) return;
        // Remove bq's following siblings and bq itself.
        while (bq.nextSibling) bq.parentNode.removeChild(bq.nextSibling);
        let current = bq.parentNode;
        bq.parentNode.removeChild(bq);
        // Walk up: at each ancestor level, strip trailing siblings (keep
        // ancestors themselves — they still hold content that came before
        // the blockquote).
        while (current && current !== root) {
            while (current.nextSibling) current.parentNode.removeChild(current.nextSibling);
            current = current.parentNode;
        }
    }

    function trimBeforeFirstBlockquote(root) {
        const bq = root.querySelector('blockquote');
        if (!bq) return;
        while (bq.previousSibling) bq.parentNode.removeChild(bq.previousSibling);
        let current = bq.parentNode;
        while (current && current !== root) {
            while (current.previousSibling) current.parentNode.removeChild(current.previousSibling);
            current = current.parentNode;
        }
    }

    // ---- HTML → markdown roundtrip ----
    //
    // Zendesk's composer accepts HTML on paste and serializes rich text
    // as HTML. We convert to a lightweight markdown for translation
    // (translation engines preserve markdown syntax reliably) and
    // rehydrate to HTML before injection.
    //
    // Image preservation (Phase 2 #9): each <img> is captured into the
    // supplied `imgs` array as its outerHTML, and the markdown gets a
    // `{{ztimgN}}` token. markdownishToHtml swaps the token back to
    // raw <img> markup. Alt text intentionally not translated.

    function serializeNodeAsMarkdown(node, imgs) {
        let out = '';
        for (const child of node.childNodes) {
            if (child.nodeType === Node.TEXT_NODE) {
                // HTML collapses runs of whitespace (including literal
                // newlines between tags, which are just source formatting)
                // into a single space when rendering. Do the same here so
                // those formatting newlines don't show up as real line
                // breaks in the markdown — only <br> and block elements
                // should produce newlines.
                out += child.textContent.replace(/\s+/g, ' ');
                continue;
            }
            if (child.nodeType !== Node.ELEMENT_NODE) continue;
            const tag = child.tagName.toLowerCase();
            if (tag === 'img') {
                // No recursion — <img> is void. Token records the
                // outerHTML so all attributes (src, alt, width, height,
                // style) round-trip exactly.
                imgs.push(child.outerHTML);
                out += `{{ztimg${imgs.length - 1}}}`;
                continue;
            }
            const inner = serializeNodeAsMarkdown(child, imgs);
            switch (tag) {
                case 'br':
                    out += '\n';
                    break;
                case 'hr':
                    // Horizontal rule becomes '---' on its own line in
                    // markdown. Surround with blank lines so it's a
                    // distinct block when we split on /\n{2,}/ later.
                    out += '\n\n---\n\n';
                    break;
                case 'p':
                case 'div':
                    // Single newline per paragraph. In Zendesk's CKEditor,
                    // adjacent <p> tags render as consecutive lines without
                    // a visible blank line — only an empty <p><br></p>
                    // sentinel produces a visible blank. Serializing as one
                    // '\n' per paragraph means:
                    //   <p>A</p><p>B</p>       → "A\nB"   (adjacent)
                    //   <p>A</p><p><br></p><p>B</p> → "A\n\n\nB" → "A\n\nB" (blank)
                    // after normalization of \n{3,} to \n\n. The distinction
                    // is carried through the translator and rehydrated with
                    // sentinels in markdownishToHtml.
                    out += inner + '\n';
                    break;
                case 'strong':
                case 'b':
                    out += inner ? `**${inner}**` : '';
                    break;
                case 'em':
                case 'i':
                    out += inner ? `*${inner}*` : '';
                    break;
                case 'u':
                    out += inner ? `__${inner}__` : '';
                    break;
                case 'ul':
                case 'ol':
                    out += inner + '\n';
                    break;
                case 'li':
                    out += `- ${inner}\n`;
                    break;
                case 'a': {
                    const href = child.getAttribute('href') || '';
                    out += href && inner ? `[${inner}](${href})` : inner;
                    break;
                }
                default:
                    out += inner;
            }
        }
        return out;
    }

    // Returns { md, imgs }. `imgs` is the array of <img> outerHTML
    // strings indexed by the `{{ztimgN}}` tokens embedded in `md`. Pass
    // both through to `markdownishToHtml(translated, imgs)` after
    // translating to restore the originals exactly.
    function htmlToMarkdownish(html) {
        const container = document.createElement('div');
        container.innerHTML = html || '';
        const imgs = [];
        let md = serializeNodeAsMarkdown(container, imgs).replace(/\n{3,}/g, '\n\n');
        // Trim leading/trailing whitespace on each line. After the text-node
        // whitespace collapse above, formatting whitespace near <br>/<p>
        // boundaries shows up as a single space at line edges (e.g.
        // ".\n Alternativt" from "</a>\n<br>\n<b>"). Stripping per-line
        // cleans that up without affecting intentional spaces inside lines.
        md = md.split('\n').map(line => line.trim()).join('\n');
        return { md: md.trim(), imgs };
    }

    function markdownishToHtml(md, imgs) {
        // `imgs` is the array returned alongside the markdown by
        // htmlToMarkdownish — outerHTML for each <img>, indexed by the
        // {{ztimgN}} tokens embedded in `md`. Optional; when absent or
        // empty, image tokens are simply removed from the output (e.g.
        // a translation produced from text without images).
        const imgList = Array.isArray(imgs) ? imgs : [];

        // Split on blank lines into "blocks". Each block is a group of
        // consecutive lines with no blank line between them (i.e. what the
        // agent typed as a single continuous thought — greeting, body, or
        // sign-off). Between blocks, insert a <p><br></p> sentinel so
        // Zendesk's CKEditor renders a visible blank line. Within a block,
        // each line becomes its own <p> (Zendesk's convention for a single
        // Enter press).
        const blocks = (md || '').split(/\n{2,}/);
        const parts = [];
        let inList = false;
        let firstBlockEmitted = false;

        const closeList = () => {
            if (inList) { parts.push('</ul>'); inList = false; }
        };

        // Restore {{ztimgN}} tokens to the original <img> outerHTML.
        // Done *after* escapeHtml below so the token's raw form is what
        // we replace — escapeHtml leaves `{` and `}` untouched, so the
        // token text passes through escaping intact and we substitute
        // unescaped img markup.
        const restoreImageTokens = (s) => {
            return s.replace(/\{\{ztimg(\d+)\}\}/g, (match, idx) => {
                const i = parseInt(idx, 10);
                return i < imgList.length && imgList[i] != null ? imgList[i] : '';
            });
        };

        const inlineFmt = (s) => {
            let r = escapeHtml(s);
            // Markdown link. Allow one level of nested parens in the URL
            // (Wikipedia-style). Emit a real <a> with safe target/rel.
            r = r.replace(
                /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g,
                (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`
            );
            r = r.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            r = r.replace(/__([^_]+)__/g, '<u>$1</u>');
            r = r.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, '$1<em>$2</em>');
            // Image-token swap last so the unescaped <img> markup
            // doesn't get mangled by any of the steps above.
            r = restoreImageTokens(r);
            return r;
        };

        for (const block of blocks) {
            if (!block.trim()) continue;

            if (firstBlockEmitted) {
                closeList();
                parts.push('<p><br></p>');  // Zendesk blank-line sentinel.
            }
            firstBlockEmitted = true;

            // A block consisting of only '---' becomes a horizontal rule.
            // CKEditor preserves <hr> on paste but does not transform the
            // literal text '---' to an <hr> (that autocorrect only fires
            // on keyboard input), so we need to emit the tag directly.
            if (block.trim() === '---') {
                closeList();
                parts.push('<hr>');
                continue;
            }

            const lines = block.split('\n');
            for (const line of lines) {
                if (/^- /.test(line)) {
                    if (!inList) { parts.push('<ul>'); inList = true; }
                    parts.push('<li>' + inlineFmt(line.slice(2)) + '</li>');
                } else if (line.trim()) {
                    closeList();
                    parts.push('<p>' + inlineFmt(line) + '</p>');
                }
            }
        }

        closeList();
        return parts.join('');
    }

    function stripMarkdownSyntax(md) {
        return (md || '')
            .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
            .replace(/\*\*/g, '')
            .replace(/(^|[^*])\*/g, '$1')
            .replace(/__/g, '')
            .trim();
    }

    // Pull "everything after the last `---` separator" out of the reply's
    // markdown. Used by both the click handler (precondition check) and
    // the auto-retranslate debounce (change detection). Without a
    // separator, the whole markdown is the source.
    function extractEnglishSourceFromMarkdown(md) {
        const sepRegex = /(?:^|\n\n)---\s*(?:\n\n|$)/g;
        let lastSepEnd = -1;
        let m;
        while ((m = sepRegex.exec(md)) !== null) {
            lastSepEnd = m.index + m[0].length;
        }
        return (lastSepEnd >= 0 ? md.slice(lastSepEnd) : md).trim();
    }

    return {
        escapeHtml,
        makeUrlToken,
        protectUrls,
        restoreUrls,
        splitCommentAtFirstBlockquote,
        serializeNodeAsMarkdown,
        htmlToMarkdownish,
        markdownishToHtml,
        stripMarkdownSyntax,
        extractEnglishSourceFromMarkdown,
    };
});
