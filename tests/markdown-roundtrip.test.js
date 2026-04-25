// HTML ↔ markdown roundtrip tests. Exercises serializeNodeAsMarkdown,
// htmlToMarkdownish, and markdownishToHtml together since they're a
// single semantic pipeline — going one direction without the other
// would test only half the invariants we care about.

const test = require('node:test');
const assert = require('node:assert');
const { core } = require('./_setup.js');

const { htmlToMarkdownish, markdownishToHtml, escapeHtml } = core;

test('escapeHtml escapes the four entities we emit', () => {
    assert.equal(
        escapeHtml('<a href="x">&y'),
        '&lt;a href=&quot;x&quot;&gt;&amp;y'
    );
});

test('adjacent <p> tags roundtrip without blank lines', () => {
    // The CKEditor convention we model: two paragraphs with no
    // blank-line sentinel between them render as consecutive lines.
    // Markdown form: single newline. Round-tripping back to HTML
    // produces two <p> tags with no <p><br></p> between them.
    const html = '<p>Hello</p><p>World</p>';
    const { md, imgs } = htmlToMarkdownish(html);
    assert.equal(md, 'Hello\nWorld');
    assert.deepEqual(imgs, []);
    assert.equal(markdownishToHtml(md, imgs), '<p>Hello</p><p>World</p>');
});

test('<p><br></p> sentinel produces visible blank line', () => {
    // The sentinel is how Zendesk's CKEditor encodes a visible blank
    // line. Markdown form: blank line (two consecutive newlines).
    const html = '<p>A</p><p><br></p><p>B</p>';
    const { md } = htmlToMarkdownish(html);
    assert.equal(md, 'A\n\nB');
    // Round-trip: rehydrate restores the sentinel.
    assert.equal(markdownishToHtml(md), '<p>A</p><p><br></p><p>B</p>');
});

test('mixed adjacent + blank-line paragraphs', () => {
    // Three blocks: greeting, body (two adjacent lines), sign-off.
    // The middle block should round-trip as two adjacent <p>s.
    const html = '<p>Hi,</p><p><br></p><p>Line one.</p><p>Line two.</p><p><br></p><p>Thanks</p>';
    const { md } = htmlToMarkdownish(html);
    assert.equal(md, 'Hi,\n\nLine one.\nLine two.\n\nThanks');
    assert.equal(
        markdownishToHtml(md),
        '<p>Hi,</p><p><br></p><p>Line one.</p><p>Line two.</p><p><br></p><p>Thanks</p>'
    );
});

test('bold and italic round-trip', () => {
    const html = '<p>This is <strong>bold</strong> and <em>italic</em>.</p>';
    const { md } = htmlToMarkdownish(html);
    assert.equal(md, 'This is **bold** and *italic*.');
    assert.equal(
        markdownishToHtml(md),
        '<p>This is <strong>bold</strong> and <em>italic</em>.</p>'
    );
});

test('underline round-trips via __token__', () => {
    const html = '<p><u>important</u></p>';
    const { md } = htmlToMarkdownish(html);
    assert.equal(md, '__important__');
    assert.equal(markdownishToHtml(md), '<p><u>important</u></p>');
});

test('unordered list round-trips', () => {
    const html = '<ul><li>one</li><li>two</li><li>three</li></ul>';
    const { md } = htmlToMarkdownish(html);
    assert.equal(md, '- one\n- two\n- three');
    assert.equal(
        markdownishToHtml(md),
        '<ul><li>one</li><li>two</li><li>three</li></ul>'
    );
});

test('horizontal rule (the bilingual-reply separator) round-trips', () => {
    // The reply pipeline injects translation, ---, original English.
    // The --- has to survive the markdown form so the click handler
    // can find the last separator and slice the English source out.
    const html = '<p>Hallo</p><p><br></p><hr><p><br></p><p>Hello</p>';
    const { md } = htmlToMarkdownish(html);
    assert.equal(md, 'Hallo\n\n---\n\nHello');
    // Rehydration: a `---` block emits <hr> directly (CKEditor doesn't
    // auto-convert literal '---' to <hr> on paste), with the standard
    // sentinel paragraphs between blocks.
    assert.equal(
        markdownishToHtml(md),
        '<p>Hallo</p><p><br></p><hr><p><br></p><p>Hello</p>'
    );
});

test('formatting whitespace in source HTML is collapsed (v1.0.26)', () => {
    // Zendesk emits literal newlines and indentation between tags for
    // readability. Those should not become real line breaks in the
    // markdown — only <br> and block elements should. The serializer
    // can leave an extra `\n` in the intermediate form when the source
    // had whitespace text nodes between blocks (the per-line trim
    // strips spaces but leaves newlines), but the rehydrator splits on
    // `\n{2,}` so 2+ newlines collapse to a single sentinel. Test the
    // round-trip rather than the exact intermediate form.
    const html = `<p>Hello</p>
        <p><br></p>
        <p>World</p>`;
    const { md, imgs } = htmlToMarkdownish(html);
    // Markdown contains no run of literal "Hello\n " or " World".
    assert.equal(md.includes(' '), false, 'markdown should have no leading/trailing whitespace on any line');
    // Round-trip rehydrates to Zendesk's canonical adjacent+sentinel
    // form regardless of how many extra blank lines accumulated in the
    // intermediate.
    assert.equal(markdownishToHtml(md, imgs), '<p>Hello</p><p><br></p><p>World</p>');
});

test('empty / whitespace-only HTML produces empty markdown', () => {
    assert.equal(htmlToMarkdownish('').md, '');
    assert.equal(htmlToMarkdownish('   ').md, '');
    assert.equal(htmlToMarkdownish('<p></p>').md, '');
});

test('markdownishToHtml is robust to empty input', () => {
    assert.equal(markdownishToHtml(''), '');
    assert.equal(markdownishToHtml(undefined), '');
    assert.equal(markdownishToHtml(null), '');
});
