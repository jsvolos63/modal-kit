// @jfs/modal-kit — accessible dialog plumbing for the JFS family of buildless
// static PWAs: focus trap + focus save/restore, iOS-safe scroll-lock, a
// central Escape stack, marker-guarded inert/aria-hidden siblings, bfcache
// cleanup, and an opt-in history-sentinel so the browser Back button (and iOS
// edge-swipe) closes the topmost dialog.
//
// Six repos hand-roll this, ranging from best-in-class to buggy. Bears'
// js/lib/modal.js has the robust *environment* layer (position:fixed
// scroll-lock with offset restore, marker-guarded inert siblings, soft-keyboard
// blur, pagehide cleanup) but no Tab trap; JFS-Sports' modal-focus.js and
// Art-Gallery's createModalSession have the *lifecycle* layer (a real focus
// trap, a reference-counted open stack, history-back close). This module is the
// promoted superset: Bears' scroll-lock/inert/pagehide + Art-Gallery's
// trap/stack/history, in one ESM API.
//
// Pure ESM, dependency-free. It reads the ambient `document` / `window` /
// `history` (like every reference impl — these are page scripts), so calling an
// instance's open()/close() requires a DOM. Importing the module does not.
//
// One call per dialog:
//
//   import { createModal } from './modal-kit/index.js';
//   const modal = createModal(document.getElementById('sheet'), {
//     focusTarget: '#sheet-close',
//     onClose: () => resetForm(),
//   });
//   openBtn.addEventListener('click', () => modal.open());
//
// Scroll-lock uses a `position: fixed` body class (default `.modal-open`); ship
//   .modal-open { position: fixed; width: 100%; }
// in your CSS so the page can't scroll behind the dialog.

// ───────────────────────── shared module state ─────────────────────────

// Sessions currently open, in open order. The last entry is the topmost dialog
// (the one Escape and the Back button act on). Reference-counted for scroll-lock.
const openStack = [];

let globalsWired = false;
let savedScrollY = 0;
// Set right before we call history.back() ourselves, so the popstate it fires
// is recognized as our own and doesn't double-close.
let expectOwnPopstate = false;

// Scroll-lock is reference-counted across every OPEN dialog that asked for it —
// independent of the Escape/history stack. Without a dedicated count, a
// `scrollLock:false` dialog closing last could leave the body frozen, or one
// opening second could suppress a `scrollLock:true` dialog's lock. We remember
// the doc + class used to lock so the unlock (possibly triggered by a different
// dialog or pagehide) reverses exactly that.
let scrollLockCount = 0;
let lockedDoc = null;
let lockedClass = null;

// History-sentinel sessions in push order, so a programmatic close only pops the
// browser history entry when it's the topmost sentinel (popping a buried one
// would desync the guard from the visible dialog).
const historyStack = [];

// The standard focusable set, plus contenteditable and positive-tabindex nodes.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  'object',
  'embed',
  'audio[controls]',
  'video[controls]',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function winOf(el) {
  return (el.ownerDocument && el.ownerDocument.defaultView) || globalThis.window || globalThis;
}

// Run a user-supplied lifecycle callback without letting it escape. A throwing
// onOpen/onClose must not propagate out of a shared document/window handler
// (Escape, popstate) or out of open()/close() and leave the page with scroll
// still locked or siblings still inert.
function safeCall(fn, arg) {
  if (typeof fn !== 'function') return;
  try {
    fn(arg);
  } catch (err) {
    // Surface for debugging without breaking modal teardown.
    if (typeof console !== 'undefined' && console.error) {
      console.error('[modal-kit] lifecycle callback threw:', err);
    }
  }
}

function isVisible(el) {
  // Layout-free visibility check: honors `aria-hidden`, the element's own
  // computed `visibility` (which inherits), and — crucially — `display:none`
  // (and the `hidden` attribute, which is UA `display:none`) ANYWHERE up the
  // ancestor chain. `display` doesn't inherit, so an element inside a
  // `display:none` wrapper has its own `display:block` and would otherwise slip
  // through, letting the Tab trap focus an unrendered control. Deliberately
  // avoids offsetParent/size so it stays correct under a layout-less test DOM
  // (jsdom) as well as in real browsers.
  if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return false;
  const view = winOf(el);
  const getCS = typeof view.getComputedStyle === 'function' ? (n) => view.getComputedStyle(n) : null;
  if (getCS) {
    const own = getCS(el);
    if (own && own.visibility === 'hidden') return false;
  }
  for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
    if (node.hasAttribute && node.hasAttribute('hidden')) return false;
    if (getCS) {
      const s = getCS(node);
      if (s && s.display === 'none') return false;
    }
  }
  return true;
}

/** Visible, focusable descendants of `container`, in DOM order. Exported so
 *  consumers/tests can reuse the same focusable definition the trap uses. */
export function getFocusable(container) {
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isVisible);
}

/** True while any dialog created by this module is open. */
export function isAnyModalOpen() {
  return openStack.length > 0;
}

function topSession() {
  return openStack[openStack.length - 1] || null;
}

// ───────────────────────── shared globals (wired once) ─────────────────────

function wireGlobals(doc) {
  if (globalsWired) return;
  globalsWired = true;

  // Escape closes the topmost dialog that opted in. `defaultPrevented` lets a
  // dialog's own handler (or a nested widget) suppress this.
  doc.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' && e.keyCode !== 27) return;
    if (e.defaultPrevented) return;
    const top = topSession();
    if (top && top.escClose) {
      e.preventDefault();
      top.requestClose();
    }
  });

  // Browser Back / iOS edge-swipe: close the topmost history-enabled dialog
  // rather than navigating the page away.
  const view = doc.defaultView || globalThis.window;
  if (view && typeof view.addEventListener === 'function') {
    view.addEventListener('popstate', () => {
      if (expectOwnPopstate) {
        expectOwnPopstate = false;
        return;
      }
      // The user popped the topmost sentinel — close the dialog that pushed it
      // (not just whatever is visually on top), and don't push another back().
      const sess = historyStack[historyStack.length - 1];
      if (sess) {
        historyStack.pop();
        sess.requestClose(true);
      }
    });

    // bfcache safety: if the page is frozen with a dialog open, make sure the
    // scroll-lock class/offset can't survive a restore and freeze the page.
    view.addEventListener('pagehide', () => {
      forceUnlockScroll();
    });
  }
}

// ───────────────────────── scroll lock (reference-counted) ──────────────────

function acquireScrollLock(doc, cls) {
  if (scrollLockCount === 0) {
    lockedDoc = doc;
    lockedClass = cls;
    const view = doc.defaultView || globalThis.window;
    savedScrollY = (view && (view.scrollY || view.pageYOffset)) || 0;
    doc.body.classList.add(cls);
    // Set via CSSOM (not an inline style attribute), so a strict CSP style-src
    // without 'unsafe-inline' still allows it.
    doc.body.style.top = `-${savedScrollY}px`;
  }
  scrollLockCount++;
}

function releaseScrollLock() {
  if (scrollLockCount === 0) return;
  scrollLockCount--;
  if (scrollLockCount === 0) forceUnlockScroll();
}

// Reverse whatever acquireScrollLock did, using the doc/class it locked with
// (the releasing dialog — or pagehide — may not be the one that locked).
function forceUnlockScroll() {
  if (!lockedDoc || !lockedDoc.body) {
    scrollLockCount = 0;
    lockedDoc = null;
    lockedClass = null;
    return;
  }
  const doc = lockedDoc;
  doc.body.classList.remove(lockedClass);
  doc.body.style.top = '';
  const view = doc.defaultView || globalThis.window;
  if (view && typeof view.scrollTo === 'function') {
    try {
      view.scrollTo(0, savedScrollY);
    } catch {
      // A layout-less test DOM may not implement scrollTo — harmless to skip.
    }
  }
  scrollLockCount = 0;
  lockedDoc = null;
  lockedClass = null;
}

// ───────────────────────── inert siblings (marker-guarded) ──────────────────

function setSiblingsInert(el, on) {
  const parent = el.parentNode;
  if (!parent) return;
  for (const sib of Array.from(parent.children)) {
    if (sib === el) continue;
    const tag = sib.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') continue;
    if (on) {
      // Only inert siblings we ourselves marked, so we never strip an `inert`
      // that was set for another reason (a background dialog, say).
      if (!sib.inert) {
        sib.inert = true;
        sib.dataset.jfsModalInert = '1';
      }
    } else if (sib.dataset && sib.dataset.jfsModalInert) {
      sib.inert = false;
      delete sib.dataset.jfsModalInert;
    }
  }
}

// ───────────────────────── history sentinel (opt-in) ────────────────────────

function pushHistorySentinel(hist) {
  if (hist && typeof hist.pushState === 'function') {
    try {
      hist.pushState({ __jfsModal: true }, '');
    } catch {
      // Some embedded contexts forbid pushState; the dialog still works, it
      // just won't be Back-button-closable.
    }
  }
}

// ───────────────────────── createModal ─────────────────────────

/** Create a dialog controller for `el`. Returns `{ open, close, isOpen }`.
 *  A falsy `el` yields an inert no-op controller (defensive, matches Bears).
 *
 *  Options (all optional):
 *    focusTarget    element | selector-within-el | (default) first focusable
 *    focusDelay     ms to defer initial focus (default 0; set ~30 to let iOS
 *                   finish hiding the soft keyboard, as Bears does)
 *    escClose       Escape closes this dialog when topmost (default true)
 *    trapFocus      wrap Tab/Shift+Tab inside el (default true)
 *    scrollLock     lock body scroll while open (default true)
 *    scrollLockClass  body class supplying `position:fixed` (default 'modal-open')
 *    inertSiblings  mark sibling elements inert + aria-hide (default true)
 *    closeOnBackdrop  a pointer on el itself or any [data-close] closes it
 *                   (default true)
 *    shouldCloseOnPointer(e)  replace the default backdrop/[data-close] predicate
 *    history        push a history sentinel so Back / edge-swipe closes it
 *                   (default false — it manipulates the history stack)
 *    hiddenAttr     toggle el.hidden for visibility (default true)
 *    openClass      also toggle this class on el (for apps whose CSS keys
 *                   visibility off a class, e.g. 'is-open' / 'visible')
 *    ariaHidden     toggle el's aria-hidden with visibility (default true)
 *    onOpen({el}) / onClose({el})  lifecycle callbacks
 */
export function createModal(el, options = {}) {
  if (!el) {
    return { open() {}, close() {}, isOpen() { return false; } };
  }

  const opts = {
    focusTarget: null,
    focusDelay: 0,
    escClose: true,
    trapFocus: true,
    scrollLock: true,
    scrollLockClass: 'modal-open',
    inertSiblings: true,
    closeOnBackdrop: true,
    shouldCloseOnPointer: null,
    history: false,
    hiddenAttr: true,
    openClass: null,
    ariaHidden: true,
    onOpen: null,
    onClose: null,
    ...options,
  };

  const doc = el.ownerDocument || globalThis.document;

  const session = {
    escClose: opts.escClose,
    history: opts.history,
    scrollLockClass: opts.scrollLockClass,
    opened: false,
    prevFocus: null,
    // Wired below so the shared Escape/popstate handlers can close whichever
    // session is topmost without reaching for the returned controller.
    requestClose: null,
  };

  function show() {
    if (opts.hiddenAttr) el.hidden = false;
    if (opts.openClass) el.classList.add(opts.openClass);
    if (opts.ariaHidden) el.setAttribute('aria-hidden', 'false');
  }
  function hide() {
    if (opts.hiddenAttr) el.hidden = true;
    if (opts.openClass) el.classList.remove(opts.openClass);
    if (opts.ariaHidden) el.setAttribute('aria-hidden', 'true');
  }

  function resolveFocusTarget() {
    const t = opts.focusTarget;
    if (t) {
      const node = typeof t === 'string' ? el.querySelector(t) : t;
      if (node) return node;
    }
    const focusables = getFocusable(el);
    if (focusables.length) return focusables[0];
    // Nothing focusable inside — focus the dialog itself so the trap and screen
    // readers have an anchor.
    if (!el.getAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    return el;
  }

  function onKeydown(e) {
    if (e.key !== 'Tab' && e.keyCode !== 9) return;
    const focusables = getFocusable(el);
    if (focusables.length === 0) {
      e.preventDefault();
      if (typeof el.focus === 'function') el.focus();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = doc.activeElement;
    const escaped = !el.contains(active);
    if (e.shiftKey) {
      if (active === first || escaped) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last || escaped) {
      e.preventDefault();
      first.focus();
    }
  }

  function onPointerDown(e) {
    const predicate =
      opts.shouldCloseOnPointer ||
      ((ev) =>
        ev.target === el ||
        (ev.target && typeof ev.target.closest === 'function' && ev.target.closest('[data-close]')));
    if (predicate(e)) {
      e.preventDefault();
      close();
    }
  }

  function open() {
    if (session.opened) return;
    session.opened = true;

    // Capture + blur the trigger so restore returns focus there, and iOS drops
    // the soft keyboard before we lock.
    const active = doc.activeElement;
    session.prevFocus = active && active !== doc.body ? active : null;
    if (session.prevFocus && typeof session.prevFocus.blur === 'function') session.prevFocus.blur();

    openStack.push(session);
    wireGlobals(doc);

    if (opts.scrollLock) acquireScrollLock(doc, opts.scrollLockClass);
    if (opts.inertSiblings) setSiblingsInert(el, true);

    show();

    if (opts.trapFocus) el.addEventListener('keydown', onKeydown);
    if (opts.closeOnBackdrop || opts.shouldCloseOnPointer) el.addEventListener('click', onPointerDown);
    if (opts.history) {
      pushHistorySentinel(doc.defaultView && doc.defaultView.history);
      historyStack.push(session);
    }

    const focusTarget = resolveFocusTarget();
    const doFocus = () => {
      if (session.opened && typeof focusTarget.focus === 'function') {
        focusTarget.focus({ preventScroll: true });
      }
    };
    if (opts.focusDelay > 0) setTimeout(doFocus, opts.focusDelay);
    else doFocus();

    safeCall(opts.onOpen, { el });
  }

  function close(fromHistory = false) {
    if (!session.opened) return;
    session.opened = false;

    const idx = openStack.indexOf(session);
    if (idx !== -1) openStack.splice(idx, 1);

    if (opts.trapFocus) el.removeEventListener('keydown', onKeydown);
    if (opts.closeOnBackdrop || opts.shouldCloseOnPointer) el.removeEventListener('click', onPointerDown);
    if (opts.inertSiblings) setSiblingsInert(el, false);

    hide();

    if (opts.scrollLock) releaseScrollLock();

    if (session.prevFocus && doc.contains(session.prevFocus) && typeof session.prevFocus.focus === 'function') {
      session.prevFocus.focus({ preventScroll: true });
    }
    session.prevFocus = null;

    // Reconcile the browser history sentinel — unless this close was itself
    // triggered by a history pop (the popstate handler already navigated and
    // removed the entry).
    if (opts.history && !fromHistory) {
      const hIdx = historyStack.indexOf(session);
      if (hIdx !== -1) {
        const isTopSentinel = hIdx === historyStack.length - 1;
        historyStack.splice(hIdx, 1);
        // Only pop the browser entry when it's the topmost sentinel; popping a
        // buried one would rewind the wrong dialog. A buried sentinel is left as
        // an inert history entry (a later stray Back is absorbed as a no-op).
        if (isTopSentinel) {
          const hist = doc.defaultView && doc.defaultView.history;
          if (hist && typeof hist.back === 'function') {
            expectOwnPopstate = true;
            hist.back();
          }
        }
      }
    }

    safeCall(opts.onClose, { el });
  }

  session.requestClose = close;

  return { open, close, isOpen: () => session.opened };
}

/** Test seam: force the module back to a clean slate (empty stack, globals
 *  re-wire on next open). Not part of the production surface. */
export function _resetModalsForTest() {
  openStack.length = 0;
  historyStack.length = 0;
  globalsWired = false;
  savedScrollY = 0;
  expectOwnPopstate = false;
  scrollLockCount = 0;
  lockedDoc = null;
  lockedClass = null;
}
