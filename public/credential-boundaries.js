(function initializeCredentialBoundaries(global) {
  "use strict";

  const ACCOUNT_CREDENTIAL_FORM_IDS = new Set([
    "adminLoginForm",
    "portalLoginForm",
    "passwordResetConfirmForm",
    "passwordForm",
    "adminSetupForm",
  ]);
  const OPERATIONAL_PASSWORD_SELECTOR = 'input[data-gp-password-manager-ignore="true"]';
  const MANAGED_DISABLED_ATTRIBUTE = "data-gp-credential-boundary-disabled";
  const APPLICATION_DISABLED_ATTRIBUTE = "data-gp-credential-app-disabled";
  const PRESERVE_WHILE_PANEL_HIDDEN_ATTRIBUTE = "data-gp-credential-preserve-on-hide";

  function isAccountCredentialForm(form) {
    return Boolean(form?.id && ACCOUNT_CREDENTIAL_FORM_IDS.has(form.id));
  }

  function resetPasswordVisibility(input) {
    if (!(input instanceof HTMLInputElement)) return;
    input.type = "password";
    const escapedId = global.CSS?.escape ? global.CSS.escape(input.id || "") : String(input.id || "").replace(/(["\\])/g, "\\$1");
    const toggle = (input.id ? document.querySelector(`[data-password-toggle="${escapedId}"]`) : null)
      || input.closest(".password-field")?.querySelector("[data-password-toggle]");
    if (!toggle) return;
    toggle.textContent = "Anzeigen";
    toggle.setAttribute("aria-label", "Passwort anzeigen");
  }

  function surfaceIsActive(input) {
    if (document.body?.classList.contains("portal-locked") && input.form?.id !== "adminLoginForm") return false;
    const dialog = input.closest("dialog");
    if (dialog && !dialog.open) return false;
    if (input.closest("[hidden], .hidden, [aria-hidden=\"true\"]")) return false;
    if (input.closest("details:not([open])")) return false;
    if (typeof input.getClientRects === "function" && input.getClientRects().length === 0) return false;
    return true;
  }

  function markOperationalPassword(input) {
    const firstHardening = input.dataset.gpCredentialBoundaryHardened !== "true";
    input.setAttribute("autocomplete", "off");
    input.setAttribute("data-1p-ignore", "true");
    input.setAttribute("data-lpignore", "true");
    input.setAttribute("data-gp-password-manager-ignore", "true");
    input.setAttribute("data-gp-credential-boundary-hardened", "true");
    if (firstHardening) input.readOnly = true;
  }

  function disableManaged(input, { clear = true } = {}) {
    if (!(input instanceof HTMLInputElement) || input.dataset.gpCredentialField !== "true") return;
    if (clear) {
      input.value = "";
      input.defaultValue = "";
      input.removeAttribute("value");
    }
    resetPasswordVisibility(input);
    input.readOnly = true;
    input.disabled = true;
    input.setAttribute(MANAGED_DISABLED_ATTRIBUTE, "true");
  }

  function shouldPreserveWhilePanelHidden(input) {
    const panel = input.closest(`[${PRESERVE_WHILE_PANEL_HIDDEN_ATTRIBUTE}="true"]`);
    return Boolean(panel?.parentElement && surfaceIsActive(panel.parentElement));
  }

  function enableManaged(input) {
    if (!(input instanceof HTMLInputElement) || input.dataset.gpCredentialField !== "true") return;
    if (input.getAttribute(MANAGED_DISABLED_ATTRIBUTE) === "true") {
      if (input.getAttribute(APPLICATION_DISABLED_ATTRIBUTE) !== "true") input.disabled = false;
      input.removeAttribute(MANAGED_DISABLED_ATTRIBUTE);
    }
  }

  function setApplicationDisabled(input, disabled) {
    if (!(input instanceof HTMLInputElement)) return;
    reconcilePassword(input);
    if (disabled) {
      input.setAttribute(APPLICATION_DISABLED_ATTRIBUTE, "true");
      input.disabled = true;
      return;
    }
    input.removeAttribute(APPLICATION_DISABLED_ATTRIBUTE);
    if (surfaceIsActive(input)) {
      input.disabled = false;
      input.removeAttribute(MANAGED_DISABLED_ATTRIBUTE);
    } else {
      disableManaged(input, { clear: false });
    }
  }

  function reconcilePassword(input) {
    if (!(input instanceof HTMLInputElement)
      || (input.type !== "password" && input.dataset.gpCredentialField !== "true")) return;
    input.setAttribute("data-gp-credential-field", "true");
    const accountForm = isAccountCredentialForm(input.form);
    if (!accountForm) markOperationalPassword(input);
    if (surfaceIsActive(input)) {
      enableManaged(input);
      if (accountForm) input.readOnly = false;
      return;
    }
    disableManaged(input, { clear: !shouldPreserveWhilePanelHidden(input) });
  }

  function hardenOperationalForm(form) {
    if (!(form instanceof HTMLFormElement) || isAccountCredentialForm(form)) return;
    const passwordInputs = [...form.querySelectorAll('input[type="password"]')];
    if (!passwordInputs.length && form.dataset.gpNoncredentialForm !== "true") return;
    form.setAttribute("autocomplete", "off");
    passwordInputs.forEach(reconcilePassword);
  }

  function hardenRoot(root) {
    if (!root) return;
    if (root instanceof HTMLFormElement) hardenOperationalForm(root);
    if (root instanceof HTMLInputElement && root.type === "password") reconcilePassword(root);
    root.querySelectorAll?.("form").forEach(hardenOperationalForm);
    root.querySelectorAll?.('input[type="password"], input[data-gp-credential-field="true"]').forEach(reconcilePassword);
  }

  function reconcileAll() {
    document.querySelectorAll('input[type="password"], input[data-gp-credential-field="true"]').forEach(reconcilePassword);
  }

  function unlockOperationalPassword(input) {
    if (!input?.matches?.(OPERATIONAL_PASSWORD_SELECTOR) || input.disabled || !surfaceIsActive(input)) return;
    input.readOnly = false;
  }

  function unlockSubmitterPasswords(target) {
    const submitter = target?.closest?.('button[type="submit"], input[type="submit"]');
    submitter?.form?.querySelectorAll(OPERATIONAL_PASSWORD_SELECTOR).forEach(unlockOperationalPassword);
  }

  hardenRoot(document);
  document.addEventListener("pointerdown", (event) => unlockOperationalPassword(event.target), true);
  document.addEventListener("focusin", (event) => unlockOperationalPassword(event.target), true);
  document.addEventListener("focusout", (event) => {
    const input = event.target;
    if (!input?.matches?.(OPERATIONAL_PASSWORD_SELECTOR)) return;
    queueMicrotask(() => { input.readOnly = true; });
  }, true);
  document.addEventListener("click", (event) => unlockSubmitterPasswords(event.target), true);
  document.addEventListener("keydown", (event) => {
    unlockOperationalPassword(event.target);
    if (event.key !== "Enter") return;
    event.target?.form?.querySelectorAll(OPERATIONAL_PASSWORD_SELECTOR).forEach(unlockOperationalPassword);
  }, true);
  document.addEventListener("submit", (event) => {
    const inputs = [...(event.target?.querySelectorAll?.(OPERATIONAL_PASSWORD_SELECTOR) || [])];
    queueMicrotask(() => inputs.forEach((input) => { input.readOnly = true; }));
  }, true);
  document.addEventListener("reset", (event) => {
    const inputs = [...(event.target?.querySelectorAll?.('input[type="password"], input[data-gp-credential-field="true"]') || [])];
    inputs.forEach((input) => {
      input.value = "";
      input.defaultValue = "";
      input.removeAttribute("value");
      resetPasswordVisibility(input);
      reconcilePassword(input);
    });
  }, true);

  if (typeof MutationObserver === "function" && document.documentElement) {
    const observer = new MutationObserver((mutations) => {
      let surfaceChanged = false;
      mutations.forEach((mutation) => {
        if (mutation.type === "attributes") surfaceChanged = true;
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) hardenRoot(node);
        });
      });
      if (surfaceChanged) queueMicrotask(reconcileAll);
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["open", "class", "hidden", "aria-hidden", "style"],
      childList: true,
      subtree: true,
    });
  }
  global.addEventListener?.("resize", reconcileAll, { passive: true });

  global.GrabenplanerCredentialBoundaries = Object.freeze({
    hardenRoot,
    reconcileAll,
    resetPasswordVisibility,
    setApplicationDisabled,
  });
}(window));
