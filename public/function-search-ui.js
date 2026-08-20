(function attachFunctionSearchUi(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerFunctionSearchUi = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createFunctionSearchUiModule() {
  "use strict";

  const FUNCTION_SEARCH_UI_VERSION = 1;

  function nextFunctionSearchActiveIndex(currentIndex, resultCount, key) {
    const count = Math.max(0, Number.parseInt(resultCount, 10) || 0);
    if (!count) return -1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    if (key === "ArrowDown") return currentIndex < 0 ? 0 : Math.min(count - 1, currentIndex + 1);
    if (key === "ArrowUp") return currentIndex < 0 ? count - 1 : Math.max(0, currentIndex - 1);
    return Math.min(count - 1, Math.max(-1, Number.parseInt(currentIndex, 10) || 0));
  }

  function functionSearchOptionId(entryId) {
    const safeId = String(entryId || "result")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 90);
    return `function-search-option-${safeId || "result"}`;
  }

  function createFunctionSearchUi(options = {}) {
    const {
      container,
      input,
      clearButton,
      popover,
      status,
      results,
      search,
      onSelect,
    } = options;
    if (!input || !clearButton || !popover || !status || !results || typeof search !== "function") {
      throw new TypeError("Die Funktionssuche benötigt Eingabe, Löschen, Trefferbereich, Status, Ergebnisliste und Suchfunktion.");
    }

    const documentRef = input.ownerDocument;
    let currentResults = [];
    let activeIndex = -1;
    let visible = true;

    function isOpen() {
      return !popover.classList.contains("hidden");
    }

    function close() {
      popover.classList.add("hidden");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      activeIndex = -1;
      [...results.querySelectorAll('[role="option"]')]
        .forEach((option) => option.setAttribute("aria-selected", "false"));
    }

    function resetResults() {
      currentResults = [];
      activeIndex = -1;
      results.replaceChildren();
      status.textContent = "";
      input.removeAttribute("aria-activedescendant");
    }

    function setActiveIndex(nextIndex, { scroll = false } = {}) {
      const optionsList = [...results.querySelectorAll('[role="option"]')];
      activeIndex = optionsList.length
        ? Math.min(optionsList.length - 1, Math.max(0, nextIndex))
        : -1;
      optionsList.forEach((option, index) => option.setAttribute("aria-selected", String(index === activeIndex)));
      const activeOption = optionsList[activeIndex];
      if (!activeOption) {
        input.removeAttribute("aria-activedescendant");
        return;
      }
      input.setAttribute("aria-activedescendant", activeOption.id);
      if (scroll) activeOption.scrollIntoView?.({ block: "nearest" });
    }

    function selectResult(index) {
      const result = currentResults[index];
      if (!result) return;
      if (typeof onSelect === "function") onSelect(result.entry, result);
      close();
    }

    function createResultOption(result, index) {
      const option = documentRef.createElement("button");
      option.type = "button";
      option.className = "function-search-option";
      option.id = `${functionSearchOptionId(result?.id || result?.entry?.id || index)}-${index}`;
      option.dataset.functionSearchIndex = String(index);
      option.setAttribute("role", "option");
      option.setAttribute("tabindex", "-1");
      option.setAttribute("aria-selected", "false");

      const label = documentRef.createElement("strong");
      label.textContent = result?.entry?.label || "Unbenannte Funktion";
      option.appendChild(label);

      const path = documentRef.createElement("span");
      path.textContent = Array.isArray(result?.entry?.path) ? result.entry.path.join(" › ") : "";
      option.appendChild(path);
      return option;
    }

    function render(foundResults) {
      currentResults = Array.isArray(foundResults) ? foundResults.slice() : [];
      results.replaceChildren(...currentResults.map(createResultOption));
      status.textContent = currentResults.length
        ? `${currentResults.length} Treffer`
        : "Keine passende Funktion gefunden.";
      popover.classList.remove("hidden");
      input.setAttribute("aria-expanded", "true");
      setActiveIndex(currentResults.length ? 0 : -1);
    }

    function refresh() {
      const query = String(input.value || "").trim();
      clearButton.classList.toggle("hidden", !query);
      if (!visible || !query) {
        resetResults();
        close();
        return [];
      }
      let foundResults = [];
      try {
        foundResults = search(query);
      } catch (_error) {
        foundResults = [];
      }
      render(foundResults);
      return currentResults.slice();
    }

    function clear() {
      input.value = "";
      clearButton.classList.add("hidden");
      resetResults();
      close();
    }

    function setVisible(nextVisible) {
      visible = nextVisible === true;
      if (!visible) clear();
      else if (input.value) refresh();
    }

    function handleInputKeydown(event) {
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        if (!isOpen()) refresh();
        if (!currentResults.length) return;
        event.preventDefault();
        const nextIndex = nextFunctionSearchActiveIndex(activeIndex, currentResults.length, event.key);
        setActiveIndex(nextIndex, { scroll: true });
        return;
      }
      if (event.key === "Enter" && isOpen() && activeIndex >= 0) {
        event.preventDefault();
        selectResult(activeIndex);
        return;
      }
      if (event.key === "Escape" && isOpen()) {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    }

    function handleResultPointerMove(event) {
      const option = event.target.closest?.("[data-function-search-index]");
      if (!option || !results.contains(option)) return;
      setActiveIndex(Number.parseInt(option.dataset.functionSearchIndex, 10));
    }

    function handleResultClick(event) {
      const option = event.target.closest?.("[data-function-search-index]");
      if (!option || !results.contains(option)) return;
      selectResult(Number.parseInt(option.dataset.functionSearchIndex, 10));
    }

    function handleDocumentPointerDown(event) {
      if (container && !container.contains(event.target)) close();
    }

    function handleInputFocus() {
      if (input.value) refresh();
    }

    function handleClearClick() {
      clear();
      input.focus({ preventScroll: true });
    }

    input.addEventListener("input", refresh);
    input.addEventListener("focus", handleInputFocus);
    input.addEventListener("keydown", handleInputKeydown);
    clearButton.addEventListener("click", handleClearClick);
    results.addEventListener("pointermove", handleResultPointerMove);
    results.addEventListener("click", handleResultClick);
    documentRef.addEventListener("pointerdown", handleDocumentPointerDown);

    return Object.freeze({
      refresh,
      close,
      clear,
      setVisible,
      destroy() {
        input.removeEventListener("input", refresh);
        input.removeEventListener("focus", handleInputFocus);
        input.removeEventListener("keydown", handleInputKeydown);
        clearButton.removeEventListener("click", handleClearClick);
        results.removeEventListener("pointermove", handleResultPointerMove);
        results.removeEventListener("click", handleResultClick);
        documentRef.removeEventListener("pointerdown", handleDocumentPointerDown);
        clear();
      },
    });
  }

  return Object.freeze({
    FUNCTION_SEARCH_UI_VERSION,
    nextFunctionSearchActiveIndex,
    functionSearchOptionId,
    createFunctionSearchUi,
  });
}));
