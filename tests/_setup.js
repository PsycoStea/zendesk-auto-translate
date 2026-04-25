// Shared test harness setup. Required at the top of each test file.
// Primes the Node global scope with the DOM names that
// src/translate-core.js expects (document, Node, Element) using jsdom,
// then loads the core module fresh and returns it.
//
// We intentionally do NOT use a global beforeEach() to reset DOM state
// between tests — every helper in translate-core that uses the DOM
// creates a fresh detached container (e.g. document.createElement('div'))
// or operates on a passed-in element clone, so test cases can't pollute
// each other through document.body.

const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
global.window = dom.window;
global.document = dom.window.document;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.DocumentFragment = dom.window.DocumentFragment;

// translate-core.js's UMD wrapper checks `typeof module === 'object'
// && module.exports` for Node, so it returns the helpers as
// module.exports here regardless of whether `window` is global.
const core = require('../src/translate-core.js');

module.exports = { core, dom };
