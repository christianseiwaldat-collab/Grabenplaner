(function attachAmuPdfClient(root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerAmuPdfClient = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createPdfClientModule(root) {
  "use strict";

  const MAXIMUM_PAGE_COUNT = 3;
  const DEFAULT_ASSET_PATHS = Object.freeze({
    modulePath: "/vendor/pdfjs-v6.1.200/build/pdf.min.mjs",
    workerPath: "/vendor/pdfjs-v6.1.200/build/pdf.worker.min.mjs",
    cMapUrl: "/vendor/pdfjs-v6.1.200/cmaps/",
    standardFontDataUrl: "/vendor/pdfjs-v6.1.200/standard_fonts/",
    wasmUrl: "/vendor/pdfjs-v6.1.200/wasm/",
    iccUrl: "/vendor/pdfjs-v6.1.200/iccs/",
  });
  const DEFAULT_LIMITS = Object.freeze({
    maxFileBytes: 10 * 1024 * 1024,
    maxPages: MAXIMUM_PAGE_COUNT,
    maxCanvasPixels: 5_000_000,
    maxCanvasWidth: 2400,
    maxRenderScale: 200 / 72,
    maxSourceImagePixels: 20_000_000,
    canvasMaxAreaInBytes: 32 * 1024 * 1024,
    minDigitalTextCharacters: 24,
    maxTextItems: 20_000,
    maxTextCharacters: 100_000,
  });

  function defaultParser() {
    if (root && root.GrabenplanerAmuOcrParser) return root.GrabenplanerAmuOcrParser;
    if (typeof require === "function") return require("./amu-ocr-parser");
    return null;
  }

  function positiveLimit(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  function normalizeLimits(input = {}) {
    return Object.freeze({
      maxFileBytes: Math.floor(positiveLimit(input.maxFileBytes, DEFAULT_LIMITS.maxFileBytes)),
      maxPages: Math.min(MAXIMUM_PAGE_COUNT, Math.floor(positiveLimit(input.maxPages, DEFAULT_LIMITS.maxPages))),
      maxCanvasPixels: Math.floor(positiveLimit(input.maxCanvasPixels, DEFAULT_LIMITS.maxCanvasPixels)),
      maxCanvasWidth: Math.floor(positiveLimit(input.maxCanvasWidth, DEFAULT_LIMITS.maxCanvasWidth)),
      maxRenderScale: positiveLimit(input.maxRenderScale, DEFAULT_LIMITS.maxRenderScale),
      maxSourceImagePixels: Math.floor(positiveLimit(input.maxSourceImagePixels, DEFAULT_LIMITS.maxSourceImagePixels)),
      canvasMaxAreaInBytes: Math.floor(positiveLimit(input.canvasMaxAreaInBytes, DEFAULT_LIMITS.canvasMaxAreaInBytes)),
      minDigitalTextCharacters: Math.floor(positiveLimit(input.minDigitalTextCharacters, DEFAULT_LIMITS.minDigitalTextCharacters)),
      maxTextItems: Math.floor(positiveLimit(input.maxTextItems, DEFAULT_LIMITS.maxTextItems)),
      maxTextCharacters: Math.floor(positiveLimit(input.maxTextCharacters, DEFAULT_LIMITS.maxTextCharacters)),
    });
  }

  function localAssetPaths(input = {}) {
    const paths = { ...DEFAULT_ASSET_PATHS, ...input };
    for (const value of Object.values(paths)) {
      if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("://")) {
        throw new Error("PDF.js darf nur aus lokalen, gleichurspr\u00fcnglichen Pfaden geladen werden.");
      }
    }
    return Object.freeze(paths);
  }

  function clientError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function clamp(value, minimum = 0, maximum = 1) {
    return Math.min(maximum, Math.max(minimum, Number(value) || 0));
  }

  function safeWarnings(input) {
    if (!Array.isArray(input)) return [];
    return [...new Set(input
      .map((value) => String(value || ""))
      .filter((value) => /^[a-z][a-z0-9_]{0,63}$/.test(value)))]
      .slice(0, 12);
  }

  function sanitizeDerivedResult(input, additionalWarnings = []) {
    const result = input && typeof input === "object" ? input : {};
    const dateFrom = /^\d{4}-\d{2}-\d{2}$/.test(String(result.dateFrom || "")) ? String(result.dateFrom) : "";
    const dateTo = /^\d{4}-\d{2}-\d{2}$/.test(String(result.dateTo || "")) ? String(result.dateTo) : "";
    const chronological = !dateFrom || !dateTo || dateTo >= dateFrom;
    const complete = Boolean(dateFrom && dateTo && chronological);
    const dateFromConfidence = dateFrom ? clamp(result.fieldConfidence && result.fieldConfidence.dateFrom) : 0;
    const dateToConfidence = dateTo ? clamp(result.fieldConfidence && result.fieldConfidence.dateTo) : 0;
    const confidence = complete
      ? clamp(Number.isFinite(Number(result.confidence)) ? result.confidence : Math.min(dateFromConfidence, dateToConfidence))
      : 0;
    const warnings = safeWarnings([
      ...(Array.isArray(result.warnings) ? result.warnings : []),
      ...(Array.isArray(additionalWarnings) ? additionalWarnings : []),
    ]);
    const autoFillFields = Object.freeze({
      dateFrom: Boolean(dateFrom && (result.autoFillFields?.dateFrom === true || (complete && result.autoFill === true))),
      dateTo: Boolean(chronological && dateTo && (result.autoFillFields?.dateTo === true || (complete && result.autoFill === true))),
    });
    const socialSecurityStatus = ["detected", "not_detected", "ambiguous"].includes(String(result.socialSecurityStatus || ""))
      ? String(result.socialSecurityStatus) : "not_detected";
    const socialSecurityNumber = socialSecurityStatus === "detected" && /^\d{10}$/.test(String(result.socialSecurityNumber || ""))
      ? String(result.socialSecurityNumber) : "";
    if (complete) {
      for (const transient of ["no_date_detected", "period_incomplete"]) {
        const index = warnings.indexOf(transient);
        if (index >= 0) warnings.splice(index, 1);
      }
    }
    return Object.freeze({
      dateFrom,
      dateTo: chronological ? dateTo : "",
      confidence,
      fieldConfidence: Object.freeze({
        dateFrom: dateFromConfidence,
        dateTo: chronological ? dateToConfidence : 0,
      }),
      autoFillFields,
      complete,
      autoFill: complete && autoFillFields.dateFrom && autoFillFields.dateTo
        && dateFromConfidence >= 0.72 && dateToConfidence >= 0.72,
      requiresConfirmation: true,
      warnings: Object.freeze(warnings),
      socialSecurityNumber,
      socialSecurityConfidence: socialSecurityNumber ? clamp(result.socialSecurityConfidence) : 0,
      socialSecurityStatus: socialSecurityNumber ? "detected" : socialSecurityStatus === "ambiguous" ? "ambiguous" : "not_detected",
    });
  }

  function mergeDerivedResults(results, additionalWarnings = []) {
    const candidates = results.map((entry) => sanitizeDerivedResult(entry));
    const identityValues = [...new Set(candidates
      .filter((entry) => entry.socialSecurityStatus === "detected" && entry.socialSecurityNumber)
      .map((entry) => entry.socialSecurityNumber))];
    const identity = identityValues.length === 1
      ? candidates.filter((entry) => entry.socialSecurityNumber === identityValues[0])
        .sort((left, right) => right.socialSecurityConfidence - left.socialSecurityConfidence)[0]
      : null;
    const identityFields = {
      socialSecurityNumber: identity?.socialSecurityNumber || "",
      socialSecurityConfidence: identity?.socialSecurityConfidence || 0,
      socialSecurityStatus: identityValues.length > 1 ? "ambiguous" : identity ? "detected" : "not_detected",
    };
    const complete = candidates
      .filter((entry) => entry.complete)
      .sort((left, right) => right.confidence - left.confidence)[0];
    if (complete) return sanitizeDerivedResult({ ...complete, ...identityFields }, additionalWarnings);

    const bestField = (field) => candidates
      .filter((entry) => entry[field])
      .sort((left, right) => right.fieldConfidence[field] - left.fieldConfidence[field])[0] || null;
    const start = bestField("dateFrom");
    const end = bestField("dateTo");
    const dateFrom = start ? start.dateFrom : "";
    const dateTo = end ? end.dateTo : "";
    const chronological = !dateFrom || !dateTo || dateTo >= dateFrom;
    const fieldConfidence = {
      dateFrom: start ? start.fieldConfidence.dateFrom : 0,
      dateTo: chronological && end ? end.fieldConfidence.dateTo : 0,
    };
    const autoFillFields = {
      dateFrom: Boolean(start?.autoFillFields?.dateFrom),
      dateTo: Boolean(chronological && end?.autoFillFields?.dateTo),
    };
    const mergedWarnings = [
      ...candidates.flatMap((entry) => entry.warnings),
      ...additionalWarnings,
      ...(dateFrom && dateTo && !chronological ? ["chronology_invalid"] : []),
    ];
    return sanitizeDerivedResult({
      dateFrom,
      dateTo: chronological ? dateTo : "",
      fieldConfidence,
      autoFillFields,
      confidence: chronological && dateFrom && dateTo ? Math.min(fieldConfidence.dateFrom, fieldConfidence.dateTo) : 0,
      complete: Boolean(chronological && dateFrom && dateTo),
      autoFill: Boolean(chronological && dateFrom && dateTo && autoFillFields.dateFrom && autoFillFields.dateTo
        && fieldConfidence.dateFrom >= 0.72 && fieldConfidence.dateTo >= 0.72),
      warnings: mergedWarnings,
      ...identityFields,
    });
  }

  function textFromContent(content, limits) {
    if (!content || !Array.isArray(content.items)) return "";
    const parts = [];
    let characters = 0;
    const itemCount = Math.min(content.items.length, limits.maxTextItems);
    for (let index = 0; index < itemCount && characters < limits.maxTextCharacters; index += 1) {
      const value = content.items[index] && typeof content.items[index].str === "string" ? content.items[index].str : "";
      if (!value) continue;
      const remaining = limits.maxTextCharacters - characters;
      const part = value.slice(0, remaining);
      if (!part) break;
      parts.push(part);
      characters += part.length + 1;
    }
    return parts.join(" ");
  }

  function defaultCanvasFactory() {
    if (!root || !root.document || typeof root.document.createElement !== "function") {
      throw clientError("AMU_PDF_CANVAS_UNAVAILABLE", "Die lokale PDF-Texterkennung ist auf diesem Ger\u00e4t nicht verf\u00fcgbar.");
    }
    return root.document.createElement("canvas");
  }

  function renderViewport(page, limits) {
    const base = page.getViewport({ scale: 1 });
    const width = Number(base && base.width);
    const height = Number(base && base.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw clientError("AMU_PDF_PAGE_INVALID", "Eine PDF-Seite konnte lokal nicht ausgewertet werden.");
    }
    const widthScale = limits.maxCanvasWidth / width;
    const pixelScale = Math.sqrt(limits.maxCanvasPixels / (width * height));
    const scale = Math.max(0.05, Math.min(limits.maxRenderScale, widthScale, pixelScale));
    return page.getViewport({ scale });
  }

  function createAmuPdfClient(options = {}) {
    const parser = options.parser || defaultParser();
    if (!parser || typeof parser.extractAumDates !== "function") {
      throw new Error("Der AUM-OCR-Parser ist nicht verf\u00fcgbar.");
    }
    const paths = localAssetPaths(options.paths);
    const limits = normalizeLimits(options.limits);
    const recognizeCanvas = typeof options.recognizeCanvas === "function" ? options.recognizeCanvas : null;
    const createCanvas = typeof options.createCanvas === "function" ? options.createCanvas : defaultCanvasFactory;
    let pdfModulePromise = null;
    let activeLoadingTask = null;
    let activeRenderTask = null;
    let runGeneration = 0;
    let disposed = false;

    function progress(event, pageNumber = 0, pageCount = 0) {
      if (typeof options.onProgress !== "function") return;
      try {
        options.onProgress(Object.freeze({ event: String(event), pageNumber, pageCount }));
      } catch {
        // UI callbacks must never interrupt local document processing.
      }
    }

    async function pdfjsModule() {
      if (!pdfModulePromise) {
        if (options.pdfjs) pdfModulePromise = Promise.resolve(options.pdfjs);
        else if (typeof options.loadPdfJs === "function") pdfModulePromise = Promise.resolve(options.loadPdfJs(paths.modulePath));
        else pdfModulePromise = import(paths.modulePath);
      }
      const module = await pdfModulePromise;
      if (!module || typeof module.getDocument !== "function") {
        pdfModulePromise = null;
        throw clientError("AMU_PDF_LIBRARY_UNAVAILABLE", "Die lokale PDF-Bibliothek ist nicht verf\u00fcgbar.");
      }
      if (module.GlobalWorkerOptions) module.GlobalWorkerOptions.workerSrc = paths.workerPath;
      return module;
    }

    function checkActive(generation, signal) {
      if (disposed || generation !== runGeneration || (signal && signal.aborted)) {
        throw clientError("AMU_PDF_ABORTED", "Die lokale PDF-Texterkennung wurde beendet.");
      }
    }

    async function cancel() {
      runGeneration += 1;
      const renderTask = activeRenderTask;
      const loadingTask = activeLoadingTask;
      activeRenderTask = null;
      activeLoadingTask = null;
      try { renderTask && typeof renderTask.cancel === "function" && renderTask.cancel(); } catch { /* ignore */ }
      try { loadingTask && typeof loadingTask.destroy === "function" && await loadingTask.destroy(); } catch { /* ignore */ }
    }

    async function recognize(file, recognitionOptions = {}) {
      if (disposed) throw clientError("AMU_PDF_DISPOSED", "Die lokale PDF-Texterkennung wurde bereits beendet.");
      if (!file || typeof file.arrayBuffer !== "function") {
        throw clientError("AMU_PDF_FILE_REQUIRED", "Bitte eine lokale PDF-Datei ausw\u00e4hlen.");
      }
      if (Number.isFinite(Number(file.size)) && Number(file.size) > limits.maxFileBytes) {
        throw clientError("AMU_PDF_FILE_TOO_LARGE", "Die PDF ist f\u00fcr die lokale Texterkennung zu gro\u00df. Die Datumswerte k\u00f6nnen manuell eingetragen werden.");
      }

      await cancel();
      const generation = ++runGeneration;
      const signal = recognitionOptions.signal || null;
      let bytes = null;
      let loadingTask = null;
      let pdf = null;
      let currentPage = null;
      let currentCanvas = null;
      let currentRenderTask = null;
      try {
        checkActive(generation, signal);
        const arrayBuffer = await file.arrayBuffer();
        checkActive(generation, signal);
        bytes = new Uint8Array(arrayBuffer);
        if (bytes.byteLength > limits.maxFileBytes) {
          throw clientError("AMU_PDF_FILE_TOO_LARGE", "Die PDF ist f\u00fcr die lokale Texterkennung zu gro\u00df. Die Datumswerte k\u00f6nnen manuell eingetragen werden.");
        }

        const pdfjs = await pdfjsModule();
        checkActive(generation, signal);
        progress("loading");
        loadingTask = pdfjs.getDocument({
          data: bytes,
          cMapUrl: paths.cMapUrl,
          cMapPacked: true,
          standardFontDataUrl: paths.standardFontDataUrl,
          wasmUrl: paths.wasmUrl,
          iccUrl: paths.iccUrl,
          useWorkerFetch: true,
          useWasm: true,
          stopAtErrors: true,
          maxImageSize: limits.maxSourceImagePixels,
          canvasMaxAreaInBytes: limits.canvasMaxAreaInBytes,
          disableFontFace: true,
          useSystemFonts: false,
          enableXfa: false,
          enableHWA: false,
          disableRange: true,
          disableStream: true,
          disableAutoFetch: true,
        });
        activeLoadingTask = loadingTask;
        pdf = await loadingTask.promise;
        checkActive(generation, signal);

        const pageCount = Math.min(limits.maxPages, Math.max(0, Number(pdf.numPages) || 0));
        if (!pageCount) throw clientError("AMU_PDF_EMPTY", "Die PDF enth\u00e4lt keine auswertbare Seite.");
        const warnings = Number(pdf.numPages) > pageCount ? ["pdf_page_limit"] : [];
        const scannedPages = [];
        const digitalParts = [];

        progress("extracting_text", 0, pageCount);
        for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
          checkActive(generation, signal);
          currentPage = await pdf.getPage(pageNumber);
          const content = await currentPage.getTextContent({ includeMarkedContent: false, disableNormalization: false });
          const text = textFromContent(content, limits);
          digitalParts.push(text);
          if (text.replace(/\s/g, "").length < limits.minDigitalTextCharacters) scannedPages.push(pageNumber);
          if (typeof currentPage.cleanup === "function") currentPage.cleanup();
          currentPage = null;
          progress("extracting_text", pageNumber, pageCount);
        }

        let digitalText = digitalParts.join("\n");
        digitalParts.length = 0;
        const digitalResult = sanitizeDerivedResult(parser.extractAumDates(digitalText, {
          referenceDate: recognitionOptions.referenceDate,
        }));
        digitalText = "";
        const digitalResultComplete = digitalResult.complete && digitalResult.socialSecurityStatus === "detected";
        if (digitalResultComplete || !scannedPages.length || !recognizeCanvas) {
          const fallbackWarnings = !digitalResult.complete && scannedPages.length && !recognizeCanvas
            ? [...warnings, "pdf_ocr_unavailable"]
            : warnings;
          return sanitizeDerivedResult(digitalResult, fallbackWarnings);
        }

        const candidates = [digitalResult];
        for (const pageNumber of scannedPages) {
          checkActive(generation, signal);
          progress("rendering", pageNumber, pageCount);
          currentPage = await pdf.getPage(pageNumber);
          const viewport = renderViewport(currentPage, limits);
          currentCanvas = createCanvas();
          if (!currentCanvas || typeof currentCanvas.getContext !== "function") {
            throw clientError("AMU_PDF_CANVAS_UNAVAILABLE", "Die lokale PDF-Texterkennung ist auf diesem Ger\u00e4t nicht verf\u00fcgbar.");
          }
          currentCanvas.width = Math.max(1, Math.floor(viewport.width));
          currentCanvas.height = Math.max(1, Math.floor(viewport.height));
          if (currentCanvas.width > limits.maxCanvasWidth || currentCanvas.width * currentCanvas.height > limits.maxCanvasPixels) {
            throw clientError("AMU_PDF_CANVAS_LIMIT", "Eine PDF-Seite ist f\u00fcr die lokale Texterkennung zu gro\u00df.");
          }
          const context = currentCanvas.getContext("2d", { alpha: false, willReadFrequently: true });
          if (!context) throw clientError("AMU_PDF_CANVAS_UNAVAILABLE", "Die lokale PDF-Texterkennung ist auf diesem Ger\u00e4t nicht verf\u00fcgbar.");
          currentRenderTask = currentPage.render({
            canvasContext: context,
            viewport,
            background: "#ffffff",
            annotationMode: pdfjs.AnnotationMode && pdfjs.AnnotationMode.DISABLE !== undefined
              ? pdfjs.AnnotationMode.DISABLE
              : 0,
          });
          activeRenderTask = currentRenderTask;
          await currentRenderTask.promise;
          if (activeRenderTask === currentRenderTask) activeRenderTask = null;
          currentRenderTask = null;
          checkActive(generation, signal);
          progress("recognizing", pageNumber, pageCount);
          const recognized = await recognizeCanvas(currentCanvas, {
            pageNumber,
            pageCount,
            referenceDate: recognitionOptions.referenceDate,
          });
          candidates.push(sanitizeDerivedResult(recognized));
          if (typeof currentPage.cleanup === "function") currentPage.cleanup();
          currentPage = null;
          currentCanvas.width = 0;
          currentCanvas.height = 0;
          currentCanvas = null;
          const merged = mergeDerivedResults(candidates, warnings);
          if (merged.complete && merged.socialSecurityStatus === "detected") return merged;
        }
        return mergeDerivedResults(candidates, warnings);
      } catch (error) {
        if (error && /^AMU_PDF_/.test(String(error.code || ""))) throw error;
        if (disposed || generation !== runGeneration || (signal && signal.aborted)) {
          throw clientError("AMU_PDF_ABORTED", "Die lokale PDF-Texterkennung wurde beendet.");
        }
        throw clientError("AMU_PDF_INVALID", "Die PDF konnte lokal nicht ausgewertet werden. Die Datumswerte k\u00f6nnen manuell eingetragen werden.");
      } finally {
        try { currentRenderTask && typeof currentRenderTask.cancel === "function" && currentRenderTask.cancel(); } catch { /* ignore */ }
        if (activeRenderTask === currentRenderTask) activeRenderTask = null;
        if (currentPage && typeof currentPage.cleanup === "function") {
          try { currentPage.cleanup(); } catch { /* ignore */ }
        }
        if (currentCanvas) {
          currentCanvas.width = 0;
          currentCanvas.height = 0;
        }
        if (pdf && typeof pdf.cleanup === "function") {
          try { await pdf.cleanup(); } catch { /* ignore */ }
        }
        if (loadingTask && typeof loadingTask.destroy === "function") {
          try { await loadingTask.destroy(); } catch { /* ignore */ }
        }
        if (activeLoadingTask === loadingTask) activeLoadingTask = null;
        bytes = null;
      }
    }

    async function dispose() {
      disposed = true;
      await cancel();
      pdfModulePromise = null;
    }

    return Object.freeze({ recognize, cancel, dispose, paths, limits });
  }

  return Object.freeze({
    createAmuPdfClient,
    DEFAULT_ASSET_PATHS,
    DEFAULT_LIMITS,
    MAXIMUM_PAGE_COUNT,
  });
}));
