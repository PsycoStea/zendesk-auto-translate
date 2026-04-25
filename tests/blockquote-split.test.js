// splitCommentAtFirstBlockquote tests. The customer's new reply lives
// before the first <blockquote>; the quoted email history sits inside
// and after it. The split is what keeps us from re-translating the
// already-translated quoted history on every reply that references it.

const test = require('node:test');
const assert = require('node:assert');
const { core, dom } = require('./_setup.js');

const { splitCommentAtFirstBlockquote } = core;

// Build a detached element so the helper has something to clone.
function elementFromHtml(html) {
    const div = dom.window.document.createElement('div');
    div.innerHTML = html;
    return div;
}

test('no blockquote: full content goes to beforeHtml', () => {
    const el = elementFromHtml('<p>Just my reply</p>');
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '<p>Just my reply</p>');
    assert.equal(afterHtml, '');
});

test('top-level blockquote: split is clean', () => {
    // The simplest shape: reply paragraphs at the top, then a
    // <blockquote> containing prior history.
    const el = elementFromHtml(
        '<p>My new reply.</p>' +
        '<blockquote><p>previous email</p></blockquote>'
    );
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '<p>My new reply.</p>');
    assert.equal(afterHtml, '<blockquote><p>previous email</p></blockquote>');
});

test('multiple paragraphs before blockquote stay in beforeHtml', () => {
    const el = elementFromHtml(
        '<p>Hi,</p>' +
        '<p>Thanks for your reply.</p>' +
        '<blockquote><p>quoted</p></blockquote>'
    );
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '<p>Hi,</p><p>Thanks for your reply.</p>');
    assert.equal(afterHtml, '<blockquote><p>quoted</p></blockquote>');
});

test('content after blockquote (e.g. signature) joins afterHtml', () => {
    // Some Zendesk variants put the agent's signature after the quote
    // block. We don't want to translate it twice if it's already in
    // English.
    const el = elementFromHtml(
        '<p>Reply</p>' +
        '<blockquote><p>quoted</p></blockquote>' +
        '<p>--</p><p>Sent from mobile</p>'
    );
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '<p>Reply</p>');
    assert.equal(
        afterHtml,
        '<blockquote><p>quoted</p></blockquote><p>--</p><p>Sent from mobile</p>'
    );
});

test('nested blockquote: only the OUTERMOST first one splits', () => {
    // querySelector('blockquote') returns the first in document order.
    // For nested blockquotes the outer one is hit first; the entire
    // nested structure goes to afterHtml.
    const el = elementFromHtml(
        '<p>Reply</p>' +
        '<blockquote>' +
            '<p>outer quote</p>' +
            '<blockquote><p>inner quote</p></blockquote>' +
        '</blockquote>'
    );
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '<p>Reply</p>');
    assert.equal(
        afterHtml,
        '<blockquote><p>outer quote</p><blockquote><p>inner quote</p></blockquote></blockquote>'
    );
});

test('blockquote nested under a wrapper div: ancestors preserved on both sides', () => {
    // The trim helpers walk up from the blockquote and strip trailing
    // siblings at each ancestor level. The wrapper itself stays — it
    // holds content from before the blockquote.
    const el = elementFromHtml(
        '<div>' +
            '<p>Hello,</p>' +
            '<blockquote><p>quoted</p></blockquote>' +
            '<p>after-quote</p>' +
        '</div>'
    );
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '<div><p>Hello,</p></div>');
    // afterHtml keeps the <div> wrapper for structural symmetry.
    assert.equal(
        afterHtml,
        '<div><blockquote><p>quoted</p></blockquote><p>after-quote</p></div>'
    );
});

test('blockquote at root with no preceding content: beforeHtml is empty', () => {
    const el = elementFromHtml('<blockquote><p>only quoted</p></blockquote>');
    const { beforeHtml, afterHtml } = splitCommentAtFirstBlockquote(el);
    assert.equal(beforeHtml, '');
    assert.equal(afterHtml, '<blockquote><p>only quoted</p></blockquote>');
});

test('original element is not mutated', () => {
    // splitCommentAtFirstBlockquote uses cloneNode(true) for both
    // sides, so the input element is left exactly as it was.
    const original = '<p>Reply</p><blockquote><p>quoted</p></blockquote>';
    const el = elementFromHtml(original);
    splitCommentAtFirstBlockquote(el);
    assert.equal(el.innerHTML, original);
});
