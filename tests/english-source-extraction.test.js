// extractEnglishSourceFromMarkdown tests. After the first translation
// the composer holds `<translation>\n\n---\n\n<english>`. The reply
// flag's click handler and the auto-retranslate debounce both call
// this helper to pull the *current* English half (everything after
// the LAST `---`) so subsequent edits use the agent's latest English
// as the source of truth.

const test = require('node:test');
const assert = require('node:assert');
const { core } = require('./_setup.js');

const { extractEnglishSourceFromMarkdown, stripMarkdownSyntax } = core;

test('no separator: whole markdown is the English source', () => {
    assert.equal(extractEnglishSourceFromMarkdown('Hello world'), 'Hello world');
});

test('basic separator: returns text after ---', () => {
    const md = 'Hallo Welt\n\n---\n\nHello world';
    assert.equal(extractEnglishSourceFromMarkdown(md), 'Hello world');
});

test('multiple separators: takes content after the LAST one', () => {
    // If the agent re-translates after editing English below the
    // current separator, an older `---` may still be in the markdown.
    // We always slice from the most recent one so re-translations
    // don't keep accreting old translations on top.
    const md = 'Old translation\n\n---\n\nMid edit\n\n---\n\nFinal English';
    assert.equal(extractEnglishSourceFromMarkdown(md), 'Final English');
});

test('whitespace around the separator is tolerated', () => {
    const md = 'Translated\n\n---  \n\nEnglish source';
    assert.equal(extractEnglishSourceFromMarkdown(md), 'English source');
});

test('separator at end with no English after = empty source', () => {
    // Agent deleted everything below the separator. Click handler
    // alerts "Please write your reply in English below the separator."
    const md = 'Translated text\n\n---\n\n';
    assert.equal(extractEnglishSourceFromMarkdown(md), '');
});

test('extracted source is trimmed', () => {
    const md = 'Translated\n\n---\n\n  Hello world  \n';
    assert.equal(extractEnglishSourceFromMarkdown(md), 'Hello world');
});

test('isolated --- without surrounding blank lines is NOT a separator', () => {
    // The regex requires the `---` to be its own paragraph block,
    // i.e. preceded and followed by blank lines (or string boundaries).
    // A `---` glued to content on either side stays inline, e.g. a
    // dash sequence the customer typed in their message.
    const md = 'Some text---more text';
    assert.equal(extractEnglishSourceFromMarkdown(md), 'Some text---more text');
});

test('stripMarkdownSyntax: strips bold, italic, underline, and link wrapper', () => {
    assert.equal(stripMarkdownSyntax('**bold**'), 'bold');
    assert.equal(stripMarkdownSyntax('*italic*'), 'italic');
    assert.equal(stripMarkdownSyntax('__under__'), 'under');
    assert.equal(stripMarkdownSyntax('[label](https://example.com)'), 'label');
});

test('stripMarkdownSyntax handles undefined and empty input', () => {
    assert.equal(stripMarkdownSyntax(''), '');
    assert.equal(stripMarkdownSyntax(undefined), '');
    assert.equal(stripMarkdownSyntax(null), '');
});
