// Tests for @jfs/modal-kit. Run with: node --test test.mjs  (or: npm test)
// Uses node:test + jsdom (a devDependency) so the focus-trap / scroll-lock /
// inert / Escape-stack behavior runs against a real-ish DOM. The module reads
// the ambient document via each element's ownerDocument, so a fresh JSDOM per
// test gives clean event-listener isolation; _resetModalsForTest() clears the
// shared open stack between tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createModal, isAnyModalOpen, getFocusable, _resetModalsForTest } from './index.js';

function setup(bodyHtml) {
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`);
  _resetModalsForTest();
  const { document } = dom.window;
  return { dom, window: dom.window, document, $: (sel) => document.querySelector(sel) };
}

const MODAL_HTML = `
  <button id="opener">open</button>
  <aside id="other">background</aside>
  <div id="dialog" role="dialog" hidden>
    <button id="close" data-close>×</button>
    <input id="field" />
    <a id="link" href="#">a link</a>
  </div>`;

// Simulate the CSS the scroll-lock class relies on so getComputedStyle sees it
// (jsdom applies inline <style>). Not strictly needed for the assertions, which
// check the class/offset rather than layout.

// ───────────────────────── open / close basics ─────────────────────────

test('open() reveals the dialog and marks it open; close() hides it', () => {
  const { $ } = setup(MODAL_HTML);
  const modal = createModal($('#dialog'));
  assert.equal(modal.isOpen(), false);
  assert.equal($('#dialog').hidden, true);

  modal.open();
  assert.equal(modal.isOpen(), true);
  assert.equal($('#dialog').hidden, false);
  assert.equal($('#dialog').getAttribute('aria-hidden'), 'false');
  assert.equal(isAnyModalOpen(), true);

  modal.close();
  assert.equal(modal.isOpen(), false);
  assert.equal($('#dialog').hidden, true);
  assert.equal($('#dialog').getAttribute('aria-hidden'), 'true');
  assert.equal(isAnyModalOpen(), false);
});

test('open() is idempotent; close() on a closed modal is a no-op', () => {
  const { $ } = setup(MODAL_HTML);
  const modal = createModal($('#dialog'));
  modal.open();
  modal.open();
  assert.equal(isAnyModalOpen(), true); // not pushed twice
  modal.close();
  assert.equal(isAnyModalOpen(), false);
  modal.close(); // no throw
});

test('a falsy element yields an inert no-op controller', () => {
  setup('');
  const modal = createModal(null);
  assert.equal(modal.isOpen(), false);
  modal.open();
  modal.close();
  assert.equal(isAnyModalOpen(), false);
});

test('openClass + hiddenAttr:false drives class-based visibility (JFS/Zep style)', () => {
  const { $ } = setup(`<div id="dialog" class="overlay"><button>x</button></div>`);
  const modal = createModal($('#dialog'), { hiddenAttr: false, openClass: 'is-open', ariaHidden: false });
  modal.open();
  assert.equal($('#dialog').classList.contains('is-open'), true);
  assert.equal($('#dialog').hidden, false);
  modal.close();
  assert.equal($('#dialog').classList.contains('is-open'), false);
});

// ───────────────────────── focus save / restore ─────────────────────────

test('initial focus goes to the first focusable; restored to the trigger on close', () => {
  const { $, document } = setup(MODAL_HTML);
  const opener = $('#opener');
  opener.focus();
  assert.equal(document.activeElement, opener);

  const modal = createModal($('#dialog'));
  modal.open();
  assert.equal(document.activeElement, $('#close')); // first focusable

  modal.close();
  assert.equal(document.activeElement, opener); // restored
});

test('focusTarget selector overrides the initial focus', () => {
  const { $, document } = setup(MODAL_HTML);
  const modal = createModal($('#dialog'), { focusTarget: '#field' });
  modal.open();
  assert.equal(document.activeElement, $('#field'));
});

test('a dialog with no focusables focuses itself (tabindex -1)', () => {
  const { $, document } = setup(`<div id="dialog"><p>text only</p></div>`);
  const modal = createModal($('#dialog'));
  modal.open();
  assert.equal($('#dialog').getAttribute('tabindex'), '-1');
  assert.equal(document.activeElement, $('#dialog'));
});

// ───────────────────────── focus trap ─────────────────────────

function tab(document, dialog, shift = false) {
  const e = new dialog.ownerDocument.defaultView.KeyboardEvent('keydown', {
    key: 'Tab',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  dialog.dispatchEvent(e);
  return e;
}

test('Tab at the last focusable wraps to the first', () => {
  const { $, document } = setup(MODAL_HTML);
  const dialog = $('#dialog');
  const modal = createModal(dialog);
  modal.open();
  $('#link').focus(); // last focusable
  const e = tab(document, dialog, false);
  assert.equal(e.defaultPrevented, true);
  assert.equal(document.activeElement, $('#close')); // wrapped to first
});

test('Shift+Tab at the first focusable wraps to the last', () => {
  const { $, document } = setup(MODAL_HTML);
  const dialog = $('#dialog');
  const modal = createModal(dialog);
  modal.open();
  $('#close').focus(); // first focusable
  const e = tab(document, dialog, true);
  assert.equal(e.defaultPrevented, true);
  assert.equal(document.activeElement, $('#link')); // wrapped to last
});

test('Tab from outside (focus escaped) is pulled back into the dialog', () => {
  const { $, document } = setup(MODAL_HTML);
  const dialog = $('#dialog');
  const modal = createModal(dialog);
  modal.open();
  $('#opener').focus(); // escaped outside
  const e = tab(document, dialog, false);
  assert.equal(e.defaultPrevented, true);
  assert.equal(document.activeElement, $('#close'));
});

test('trapFocus:false attaches no trap', () => {
  const { $, document } = setup(MODAL_HTML);
  const dialog = $('#dialog');
  const modal = createModal(dialog, { trapFocus: false });
  modal.open();
  $('#link').focus();
  const e = tab(document, dialog, false);
  assert.equal(e.defaultPrevented, false); // not trapped
});

// ───────────────────────── Escape stack ─────────────────────────

function esc(document) {
  const e = new document.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  document.dispatchEvent(e);
  return e;
}

test('Escape closes the topmost dialog only, unwinding one at a time', () => {
  const { document } = setup(`
    <div id="a"><button>a</button></div>
    <div id="b"><button>b</button></div>`);
  const a = createModal(document.querySelector('#a'));
  const b = createModal(document.querySelector('#b'));
  a.open();
  b.open();
  esc(document);
  assert.equal(b.isOpen(), false);
  assert.equal(a.isOpen(), true); // still open — only the top closed
  esc(document);
  assert.equal(a.isOpen(), false);
});

test('escClose:false opts a dialog out of the Escape stack', () => {
  const { document } = setup(MODAL_HTML);
  const modal = createModal(document.querySelector('#dialog'), { escClose: false });
  modal.open();
  esc(document);
  assert.equal(modal.isOpen(), true);
});

// ───────────────────────── scroll lock (reference-counted) ──────────────────

test('scroll-lock adds the class once for a stack and removes it when empty', () => {
  const { document } = setup(`
    <div id="a"><button>a</button></div>
    <div id="b"><button>b</button></div>`);
  const body = document.body;
  const a = createModal(document.querySelector('#a'));
  const b = createModal(document.querySelector('#b'));

  a.open();
  assert.equal(body.classList.contains('modal-open'), true);
  b.open();
  assert.equal(body.classList.contains('modal-open'), true);

  b.close();
  assert.equal(body.classList.contains('modal-open'), true); // a still open
  a.close();
  assert.equal(body.classList.contains('modal-open'), false); // stack empty
  assert.equal(body.style.top, '');
});

test('scrollLock:false leaves the body class alone', () => {
  const { document } = setup(MODAL_HTML);
  const modal = createModal(document.querySelector('#dialog'), { scrollLock: false });
  modal.open();
  assert.equal(document.body.classList.contains('modal-open'), false);
});

// ───────────────────────── inert siblings ─────────────────────────

test('siblings are marked inert on open and restored on close (marker-guarded)', () => {
  const { $ } = setup(MODAL_HTML);
  const other = $('#other');
  const modal = createModal($('#dialog'));
  modal.open();
  assert.equal(other.inert, true);
  assert.equal(other.dataset.jfsModalInert, '1');
  modal.close();
  assert.equal(other.inert, false);
  assert.equal(other.dataset.jfsModalInert, undefined);
});

test('an already-inert sibling is left untouched on close (no marker to strip)', () => {
  const { $ } = setup(MODAL_HTML);
  const other = $('#other');
  other.inert = true; // pre-existing inert, not ours
  const modal = createModal($('#dialog'));
  modal.open();
  assert.equal(other.dataset.jfsModalInert, undefined); // we didn't mark it
  modal.close();
  assert.equal(other.inert, true); // still inert — we didn't strip someone else's
});

// ───────────────────────── backdrop / [data-close] ─────────────────────────

function click(el, window) {
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
}

test('a click on a [data-close] element closes the dialog', () => {
  const { $, window } = setup(MODAL_HTML);
  const modal = createModal($('#dialog'));
  modal.open();
  click($('#close'), window);
  assert.equal(modal.isOpen(), false);
});

test('a click on the backdrop (the dialog element itself) closes it', () => {
  const { $, window } = setup(MODAL_HTML);
  const dialog = $('#dialog');
  const modal = createModal(dialog);
  modal.open();
  click(dialog, window);
  assert.equal(modal.isOpen(), false);
});

test('a click on inner content does not close (predicate is false)', () => {
  const { $, window } = setup(MODAL_HTML);
  const modal = createModal($('#dialog'));
  modal.open();
  click($('#field'), window);
  assert.equal(modal.isOpen(), true);
});

// ───────────────────────── history sentinel (opt-in) ─────────────────────────

test('history:true pushes a sentinel on open and closes on popstate', () => {
  const { document, window } = setup(MODAL_HTML);
  const modal = createModal(document.querySelector('#dialog'), { history: true });
  modal.open();
  assert.deepEqual(window.history.state, { __jfsModal: true });

  // Browser Back → popstate → close the top history dialog.
  window.dispatchEvent(new window.PopStateEvent('popstate', { state: null }));
  assert.equal(modal.isOpen(), false);
});

test('history is off by default (no sentinel pushed)', () => {
  const { document, window } = setup(MODAL_HTML);
  const before = window.history.length;
  const modal = createModal(document.querySelector('#dialog'));
  modal.open();
  assert.equal(window.history.length, before);
  modal.close();
});

// ───────────────────────── lifecycle callbacks ─────────────────────────

test('onOpen and onClose fire with the element', () => {
  const { $ } = setup(MODAL_HTML);
  const events = [];
  const modal = createModal($('#dialog'), {
    onOpen: ({ el }) => events.push(['open', el.id]),
    onClose: ({ el }) => events.push(['close', el.id]),
  });
  modal.open();
  modal.close();
  assert.deepEqual(events, [['open', 'dialog'], ['close', 'dialog']]);
});

// ───────────────────────── getFocusable ─────────────────────────

test('getFocusable returns visible focusables in order and skips hidden/disabled', () => {
  const { $, document } = setup(`
    <div id="dialog">
      <button id="b1">1</button>
      <button id="b2" disabled>2</button>
      <input id="i1" />
      <a id="a1">no href</a>
      <button id="b3" style="display:none">3</button>
      <div id="d1" tabindex="0">focusable div</div>
      <div id="d2" tabindex="-1">not focusable</div>
    </div>`);
  const ids = getFocusable($('#dialog')).map((n) => n.id);
  assert.deepEqual(ids, ['b1', 'i1', 'd1']);
});
