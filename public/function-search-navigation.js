(function attachFunctionSearchNavigation(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerFunctionSearchNavigation = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createFunctionSearchNavigationModule() {
  "use strict";

  const FUNCTION_SEARCH_NAVIGATION_VERSION = 1;
  const TARGET_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
  const HIGHLIGHT_CLASS = "function-search-target-highlight";
  const STRUCTURAL_FOCUS_SELECTOR = [
    ".settings-field-disclosure",
    ".settings-accordion",
    ".settings-card",
    ".vacation-panel",
    ".summary-card",
    ".card",
    ".view",
  ].join(",");
  const DISCLOSURE_ONLY_ANCESTOR_CLASSES = Object.freeze([
    "nav-module-children",
    "nav-children",
    "settings-field-disclosure-body",
  ]);

  function hasClass(element, className) {
    return element?.classList?.contains?.(className) === true;
  }

  function directChildByClass(element, className) {
    return [...(element?.children || [])].find((child) => hasClass(child, className)) || null;
  }

  function openSettingsFieldDisclosure(card) {
    if (!card || !hasClass(card, "settings-field-disclosure")) return false;
    const summary = directChildByClass(card, "settings-field-disclosure-summary");
    const body = directChildByClass(card, "settings-field-disclosure-body");
    if (!summary || !body) return false;
    card.classList.add("open");
    summary.setAttribute("aria-expanded", "true");
    body.hidden = false;
    return true;
  }

  function openFunctionSearchDisclosure(element) {
    if (!element) return false;
    let opened = false;
    if (String(element.tagName || "").toUpperCase() === "DETAILS") {
      element.open = true;
      opened = true;
    }
    if (hasClass(element, "settings-field-disclosure")) {
      opened = openSettingsFieldDisclosure(element) || opened;
    }
    if (hasClass(element, "settings-field-disclosure-body")) {
      element.hidden = false;
      opened = openSettingsFieldDisclosure(element.parentElement) || true;
    }
    return opened;
  }

  function revealFunctionSearchAncestors(element) {
    const opened = [];
    let current = element;
    while (current) {
      if (openFunctionSearchDisclosure(current)) opened.push(current.id || current.tagName || "disclosure");
      current = current.parentElement;
    }
    return opened;
  }

  function functionSearchTargetIsHidden(element) {
    let current = element;
    while (current) {
      if (current.hidden === true || hasClass(current, "hidden")) return true;
      current = current.parentElement;
    }
    return false;
  }

  function functionSearchDomGateIsAvailable(gateId, options = {}) {
    const documentRef = options.document || (typeof document !== "undefined" ? document : null);
    const normalizedGateId = String(gateId || "");
    if (!documentRef?.body
      || typeof documentRef.getElementById !== "function"
      || !TARGET_ID_PATTERN.test(normalizedGateId)) return false;
    const gate = documentRef.getElementById(normalizedGateId);
    if (!gate || gate.isConnected === false || gate.closest?.("template")) return false;

    let current = gate;
    while (current && current !== documentRef.body) {
      const disclosureOnlyAncestor = current !== gate
        && DISCLOSURE_ONLY_ANCESTOR_CLASSES.some((className) => hasClass(current, className));
      if (!disclosureOnlyAncestor && (current.hidden === true || hasClass(current, "hidden"))) return false;
      current = current.parentElement;
    }
    return current === documentRef.body;
  }

  function isNativeFocusable(element) {
    const tagName = String(element?.tagName || "").toUpperCase();
    if (["BUTTON", "SELECT", "TEXTAREA", "SUMMARY"].includes(tagName)) return element.disabled !== true;
    if (tagName === "INPUT") return element.disabled !== true && String(element.type || "").toLowerCase() !== "hidden";
    if (tagName === "A") return Boolean(element.getAttribute?.("href"));
    return false;
  }

  function focusCandidate(target) {
    if (target?.disabled !== true) return target;
    return target.closest?.(STRUCTURAL_FOCUS_SELECTOR) || target.parentElement || null;
  }

  function temporaryProgrammaticFocus(element) {
    if (!element || isNativeFocusable(element) || element.hasAttribute?.("tabindex")) return () => {};
    element.setAttribute("tabindex", "-1");
    return () => element.removeAttribute("tabindex");
  }

  function boundedHighlightDuration(value) {
    const duration = Number(value);
    if (!Number.isFinite(duration)) return 2400;
    return Math.min(6000, Math.max(500, Math.round(duration)));
  }

  function presentFunctionSearchTarget(target, options = {}) {
    const documentRef = options.document || (typeof document !== "undefined" ? document : null);
    if (!documentRef || typeof documentRef.getElementById !== "function") {
      return Object.freeze({ ok: false, reason: "missing-document" });
    }
    if (!target || target.kind !== "navigation" || !TARGET_ID_PATTERN.test(String(target.focusId || ""))) {
      return Object.freeze({ ok: false, reason: "invalid-target" });
    }
    const revealIds = target.revealIds === undefined ? [] : target.revealIds;
    if (!Array.isArray(revealIds) || revealIds.some((id) => !TARGET_ID_PATTERN.test(String(id || "")))) {
      return Object.freeze({ ok: false, reason: "invalid-reveal-target" });
    }

    const openedIds = [];
    for (const revealId of revealIds) {
      const revealElement = documentRef.getElementById(revealId);
      if (!revealElement) return Object.freeze({ ok: false, reason: "missing-reveal-target" });
      if (openFunctionSearchDisclosure(revealElement)) openedIds.push(revealId);
      openedIds.push(...revealFunctionSearchAncestors(revealElement));
    }

    const targetElement = documentRef.getElementById(target.focusId);
    if (!targetElement) return Object.freeze({ ok: false, reason: "missing-focus-target" });
    openedIds.push(...revealFunctionSearchAncestors(targetElement));
    if (functionSearchTargetIsHidden(targetElement)) {
      return Object.freeze({ ok: false, reason: "hidden-focus-target" });
    }

    if (typeof options.afterReveal === "function") options.afterReveal(targetElement);
    const windowRef = options.window || documentRef.defaultView || (typeof window !== "undefined" ? window : null);
    const reducedMotion = windowRef?.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
    const behavior = reducedMotion ? "auto" : "smooth";
    targetElement.scrollIntoView?.({ block: "center", inline: "nearest", behavior });

    const focusElement = focusCandidate(targetElement);
    if (!focusElement || typeof focusElement.focus !== "function") {
      return Object.freeze({ ok: false, reason: "missing-focus-capability" });
    }
    const restoreTabIndex = temporaryProgrammaticFocus(focusElement);
    try {
      focusElement.focus({ preventScroll: true });
    } catch (_error) {
      restoreTabIndex();
      return Object.freeze({ ok: false, reason: "focus-failed" });
    }

    targetElement.classList.add(HIGHLIGHT_CLASS);
    const timeout = typeof options.setTimeout === "function"
      ? options.setTimeout
      : (typeof setTimeout === "function" ? setTimeout : null);
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      targetElement.classList.remove(HIGHLIGHT_CLASS);
      restoreTabIndex();
    };
    if (timeout) timeout(cleanup, boundedHighlightDuration(options.highlightDuration));

    return Object.freeze({
      ok: true,
      focusId: target.focusId,
      openedIds: Object.freeze([...new Set(openedIds.filter(Boolean))]),
      cleanup,
    });
  }

  return Object.freeze({
    FUNCTION_SEARCH_NAVIGATION_VERSION,
    HIGHLIGHT_CLASS,
    openFunctionSearchDisclosure,
    revealFunctionSearchAncestors,
    functionSearchTargetIsHidden,
    functionSearchDomGateIsAvailable,
    presentFunctionSearchTarget,
  });
}));
