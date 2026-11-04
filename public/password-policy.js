(function (root) {
  "use strict";
  const selector = "input[data-gp-new-password]";
  let minimum = 15, maximum = 256;

  function errorFor(value) {
    if (!value) return ""; // Required/optional belongs to the individual form.
    const characters = Array.from(value);
    if (characters.some(character => character.length === 1 && character.charCodeAt(0) >= 0xd800 && character.charCodeAt(0) <= 0xdfff)) {
      return "Das Passwort enthält ein ungültiges Unicode-Zeichen.";
    }
    const length = characters.length;
    if (length < minimum) return `Das neue Passwort muss mindestens ${minimum} Zeichen lang sein.`;
    if (length > maximum) return `Das neue Passwort darf höchstens ${maximum} Zeichen lang sein.`;
    return "";
  }

  function validate(input, { report = false } = {}) {
    if (!input?.matches(selector)) return true;
    // HTML length constraints count UTF-16 units and can truncate astral text.
    input.removeAttribute("minlength");
    input.removeAttribute("maxlength");
    input.setCustomValidity(input.disabled ? "" : errorFor(input.value));
    return report ? input.reportValidity() : input.checkValidity();
  }

  function configure(status = {}) {
    const policy = status.passwordPolicy || status;
    const min = Number(policy.minCodePoints ?? policy.minLength ?? status.passwordMinLength);
    const max = Number(policy.maxCodePoints ?? policy.maxLength);
    minimum = Number.isSafeInteger(min) && min >= 15 && min <= 256 ? min : 15;
    maximum = Number.isSafeInteger(max) && max >= minimum && max <= 256 ? max : 256;
    root.document?.querySelectorAll(selector).forEach(input => validate(input));
  }

  root.GrabenplanerPasswordPolicy = Object.freeze({ configure, validate, errorFor });
  if (!root.document) return;
  root.document.addEventListener("input", event => validate(event.target), true);
  root.document.addEventListener("change", event => validate(event.target), true);
  root.document.addEventListener("submit", event => {
    const invalid = [...event.target.querySelectorAll(selector)].find(input => !validate(input));
    if (!invalid) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    invalid.reportValidity();
  }, true);
  root.document.addEventListener("reset", event => {
    // A previous custom error must not survive resetting/reopening the form.
    queueMicrotask(() => event.target.querySelectorAll(selector).forEach(input => validate(input)));
  }, true);
  configure();
})(typeof window === "undefined" ? globalThis : window);
