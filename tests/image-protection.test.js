// Image preservation tests (Phase 2 #9). Each <img> in the source HTML
// is captured as its outerHTML and replaced with a {{ztimgN}} token in
// the markdown. The token survives translation as text; markdownishToHtml
// swaps it back to the original markup. Alt text intentionally not
// translated.

const test = require('node:test');
const assert = require('node:assert');
const { core } = require('./_setup.js');

const { htmlToMarkdownish, markdownishToHtml } = core;

test('single <img> with src+alt round-trips outerHTML exactly', () => {
    const html = '<p>Logo: <img src="https://example.com/logo.png" alt="Acme"></p>';
    const { md, imgs } = htmlToMarkdownish(html);
    assert.equal(md, 'Logo: {{ztimg0}}');
    assert.equal(imgs.length, 1);
    assert.match(imgs[0], /^<img[^>]*src="https:\/\/example\.com\/logo\.png"[^>]*>$/);
    assert.match(imgs[0], /alt="Acme"/);
    // Round-trip: the <img> outerHTML lands back in the rehydrated HTML
    // exactly as captured, embedded in a <p>.
    const rehydrated = markdownishToHtml(md, imgs);
    assert.match(rehydrated, /<p>Logo: <img[^>]+>\<\/p>/);
    assert.match(rehydrated, /src="https:\/\/example\.com\/logo\.png"/);
    assert.match(rehydrated, /alt="Acme"/);
});

test('image with width/height/style preserved', () => {
    // The whole point of capturing outerHTML rather than reconstructing
    // from a few attrs: any attribute the customer's email contains
    // round-trips intact.
    const html =
        '<p>Banner: <img src="https://example.com/b.png" width="600" height="200" style="border-radius:4px"></p>';
    const { md, imgs } = htmlToMarkdownish(html);
    assert.equal(md, 'Banner: {{ztimg0}}');
    assert.equal(imgs.length, 1);
    assert.match(imgs[0], /width="600"/);
    assert.match(imgs[0], /height="200"/);
    assert.match(imgs[0], /style="border-radius:4px"/);
});

test('multiple images get sequential indices and round-trip in order', () => {
    const html =
        '<p><img src="a.png">' +
        ' between ' +
        '<img src="b.png"> end</p>';
    const { md, imgs } = htmlToMarkdownish(html);
    assert.equal(md, '{{ztimg0}} between {{ztimg1}} end');
    assert.equal(imgs.length, 2);
    const out = markdownishToHtml(md, imgs);
    // Both <img>s appear in order, in the same paragraph.
    assert.match(out, /<p>.*src="a\.png".*between.*src="b\.png".*end<\/p>/s);
});

test('image token survives a "translation" that mangles surrounding text', () => {
    // Simulate the translator round-trip: the markdown changes (text
    // around the token gets translated) but the {{ztimgN}} token
    // itself is preserved verbatim. This is the production invariant
    // we rely on for both URL and image protection.
    const html = '<p>See <img src="x.png" alt="x"> here.</p>';
    const { md, imgs } = htmlToMarkdownish(html);
    const fakeTranslated = md.replace('See', 'Siehe').replace('here', 'hier');
    const out = markdownishToHtml(fakeTranslated, imgs);
    assert.match(out, /Siehe/);
    assert.match(out, /hier/);
    assert.match(out, /src="x\.png"/);
    assert.match(out, /alt="x"/);
});

test('alt text is NOT translated (token replaces the whole element)', () => {
    // The serializer doesn't extract alt text into the markdown — it
    // captures outerHTML and emits an opaque token. So even if a
    // translator could see "alt=Acme", it never gets the chance.
    const html = '<p><img src="a.png" alt="Acme Corporation"></p>';
    const { md } = htmlToMarkdownish(html);
    // The literal alt text doesn't appear anywhere in the markdown.
    assert.equal(md.includes('Acme'), false);
    assert.equal(md.includes('Corporation'), false);
});

test('image token in markdown without imgs array is safely stripped', () => {
    // Defensive: if we ever hand markdownishToHtml a `md` containing
    // image tokens but forget to pass the `imgs` array (e.g. caller
    // bug), we don't render the token text — we strip it. The
    // alternative — rendering "{{ztimg0}}" verbatim to the agent —
    // would be more confusing.
    const out = markdownishToHtml('Hello {{ztimg0}} world');
    assert.equal(out, '<p>Hello  world</p>');
});

test('out-of-range image token is dropped, not rendered as token text', () => {
    const out = markdownishToHtml('See {{ztimg3}} here', ['<img src="a.png">']);
    assert.equal(out, '<p>See  here</p>');
});
