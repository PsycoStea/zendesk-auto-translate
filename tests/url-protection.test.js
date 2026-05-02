// URL token shielding tests. protectUrls swaps each URL for a
// {{ztlinkN}} token; restoreUrls swaps the token back. The translator
// call in production sits between the two and the tokens ride through
// it verbatim. Tests don't simulate translation — they just verify
// that protect → restore is the identity for the URL portion.

const test = require('node:test');
const assert = require('node:assert');
const { core } = require('./_setup.js');

const { protectUrls, restoreUrls, makeUrlToken } = core;

test('makeUrlToken returns the expected shape', () => {
    assert.equal(makeUrlToken(0), '{{ztlink0}}');
    assert.equal(makeUrlToken(7), '{{ztlink7}}');
});

test('bare http URL is tokenized and restored', () => {
    const input = 'See https://example.com for details.';
    const { text, urls } = protectUrls(input);
    assert.equal(text, 'See {{ztlink0}} for details.');
    assert.deepEqual(urls, ['https://example.com']);
    assert.equal(restoreUrls(text, urls), input);
});

test('trailing punctuation is split off the URL', () => {
    // "https://example.com." should not capture the period as part of
    // the URL — agents would otherwise see 404s when restored URLs
    // include accidental trailing punctuation.
    const input = 'Visit https://example.com.';
    const { text, urls } = protectUrls(input);
    assert.equal(text, 'Visit {{ztlink0}}.');
    assert.deepEqual(urls, ['https://example.com']);
    assert.equal(restoreUrls(text, urls), input);
});

test('multiple punctuation chars are split together', () => {
    const input = 'Open (https://example.com).';
    const { text, urls } = protectUrls(input);
    assert.equal(text, 'Open ({{ztlink0}}).');
    assert.deepEqual(urls, ['https://example.com']);
    assert.equal(restoreUrls(text, urls), input);
});

test('markdown link is tokenized — text stays, URL replaced', () => {
    const input = 'See [the docs](https://example.com/docs) for more.';
    const { text, urls } = protectUrls(input);
    assert.equal(text, 'See [the docs]({{ztlink0}}) for more.');
    assert.deepEqual(urls, ['https://example.com/docs']);
    assert.equal(restoreUrls(text, urls), input);
});

test('markdown link with parens in URL (Wikipedia-style)', () => {
    // /\[([^\]]+)\]\(((?:[^()]|\([^()]*\))*)\)/g allows one level of
    // nested parens in the URL so links like .../Foo_(bar) survive
    // intact. Two levels would still mangle, but those are rare enough
    // in customer-service replies that we accept the trade-off vs. a
    // more complex parser.
    const input = 'See [Berlin](https://en.wikipedia.org/wiki/Berlin_(disambiguation)) for context.';
    const { text, urls } = protectUrls(input);
    assert.equal(text, 'See [Berlin]({{ztlink0}}) for context.');
    assert.deepEqual(urls, ['https://en.wikipedia.org/wiki/Berlin_(disambiguation)']);
    assert.equal(restoreUrls(text, urls), input);
});

test('multiple URLs use sequential indices', () => {
    const input = 'Mirror at https://a.example or [docs](https://b.example/d).';
    const { text, urls } = protectUrls(input);
    // Note: markdown-links pass first, then bare URLs, so the markdown
    // URL gets index 0 and the bare URL gets index 1.
    assert.equal(text, 'Mirror at {{ztlink1}} or [docs]({{ztlink0}}).');
    assert.deepEqual(urls, ['https://b.example/d', 'https://a.example']);
    assert.equal(restoreUrls(text, urls), input);
});

test('restoreUrls leaves unknown tokens alone', () => {
    // Defensive: if the translator hallucinates a higher-index token
    // (we've seen this happen rarely), don't insert garbage — leave
    // the literal token in place so the agent can spot it.
    const text = 'See {{ztlink0}} and {{ztlink5}}.';
    const urls = ['https://example.com'];
    assert.equal(
        restoreUrls(text, urls),
        'See https://example.com and {{ztlink5}}.'
    );
});

test('text with no URLs is unchanged', () => {
    const input = 'Just some plain text with no URLs.';
    const { text, urls } = protectUrls(input);
    assert.equal(text, input);
    assert.deepEqual(urls, []);
    assert.equal(restoreUrls(text, urls), input);
});

test('markdown link where text equals URL round-trips cleanly', () => {
    // Regression: when an agent pastes a bare URL into the Zendesk
    // composer, Zendesk wraps it as `<a href="URL">URL</a>` — the link
    // text and href are identical. Serialized as
    // `[https://example.com](https://example.com)`, then the markdown-
    // link regex tokenizes the URL portion to
    // `[https://example.com]({{ztlink0}})`. Earlier the bare-URL regex
    // would then over-capture into the brackets/token, mangling
    // urls[1] to `https://example.com]({{ztlink0}}` and emitting
    // `[{{ztlink1}})` — totally broken on restore. The fix excludes
    // `]`, `)`, `}` from the bare-URL char class so it stops at the
    // markdown-link boundary.
    const input = '[https://example.com](https://example.com)';
    const { text, urls } = protectUrls(input);
    // Both URLs get tokenized: index 0 from the markdown link,
    // index 1 from the bare URL inside the brackets.
    assert.equal(text, '[{{ztlink1}}]({{ztlink0}})');
    assert.deepEqual(urls, ['https://example.com', 'https://example.com']);
    assert.equal(restoreUrls(text, urls), input);
});

test('bare URL stops at closing bracket of a markdown link', () => {
    // After the markdown-link regex tokenizes a link, the string holds
    // `[text]({{ztlinkN}})`. The bare-URL regex must not bleed past the
    // `]` into the token. Input: a markdown link whose text contains a
    // bare URL. After the markdown-link regex, urls = [link's href];
    // after the bare-URL regex, urls = [link's href, bracket text URL].
    const input = '[Click https://example.com here](https://example.org)';
    const { text, urls } = protectUrls(input);
    // The markdown-link regex tokenizes the href as urls[0] = example.org;
    // then the bare-URL regex tokenizes the URL inside the brackets as
    // urls[1] = example.com. Without the `]` exclusion, the bare-URL
    // regex would eat the `]({{ztlink0}})` suffix into urls[1].
    assert.equal(text, '[Click {{ztlink1}} here]({{ztlink0}})');
    assert.deepEqual(urls, ['https://example.org', 'https://example.com']);
    assert.equal(restoreUrls(text, urls), input);
});
