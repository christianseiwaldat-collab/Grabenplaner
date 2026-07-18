(function attachAmuOcrClient(root, factory) {
  "use strict";

  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerAmuOcrClient = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createClientModule(root) {
  "use strict";

  const DEFAULT_ASSET_PATHS = Object.freeze({
      workerPath: "/vendor/tesseract-v7/worker.min.js",
      corePath: "/vendor/tesseract-core-v7",
      langPath: "/vendor/tesseract-data-deu-v1",
  });

  function defaultParser() {
    if (root && root.GrabenplanerAmuOcrParser) return root.GrabenplanerAmuOcrParser;
    if (typeof require === "function") return require("./amu-ocr-parser");
    return null;
  }

  function mergeAumOcrResults(results = []) {
    const safeResults = results.filter((entry) => entry && typeof entry === "object");
    const fieldCandidate = (field) => safeResults
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(String(entry[field] || "")))
      .map((entry) => ({
        value: String(entry[field]),
        confidence: Number(entry.fieldConfidence?.[field] || 0),
        autoFill: entry.autoFillFields?.[field] === true || (entry.autoFill === true && entry.complete === true),
      }))
      .sort((left, right) => Number(right.autoFill) - Number(left.autoFill) || right.confidence - left.confidence)[0] || null;
    const from = fieldCandidate("dateFrom");
    let to = fieldCandidate("dateTo");
    if (from && to && to.value < from.value) to = null;
    const complete = Boolean(from && to);
    const identityCandidates = safeResults
      .filter((entry) => entry.socialSecurityStatus === "detected" && /^\d{10}$/.test(String(entry.socialSecurityNumber || "")))
      .map((entry) => ({
        value: String(entry.socialSecurityNumber),
        confidence: Math.min(1, Math.max(0, Number(entry.socialSecurityConfidence) || 0)),
      }));
    const identityValues = [...new Set(identityCandidates.map((entry) => entry.value))];
    const identity = identityValues.length === 1
      ? identityCandidates.filter((entry) => entry.value === identityValues[0]).sort((left, right) => right.confidence - left.confidence)[0]
      : null;
    const autoFillFields = {
      dateFrom: Boolean(from?.autoFill),
      dateTo: Boolean(to?.autoFill),
    };
    const warnings = [];
    if (!from && !to) warnings.push("no_date_detected");
    else if (!complete) warnings.push("period_incomplete");
    else if (!(autoFillFields.dateFrom && autoFillFields.dateTo)) warnings.push("manual_confirmation_recommended");
    return {
      dateFrom: from?.value || "",
      dateTo: to?.value || "",
      confidence: complete ? Number(Math.min(from.confidence, to.confidence).toFixed(2)) : 0,
      fieldConfidence: { dateFrom: from?.confidence || 0, dateTo: to?.confidence || 0 },
      autoFillFields,
      complete,
      autoFill: complete && autoFillFields.dateFrom && autoFillFields.dateTo,
      requiresConfirmation: true,
      warnings,
      socialSecurityNumber: identity?.value || "",
      socialSecurityConfidence: identity?.confidence || 0,
      socialSecurityStatus: identityValues.length > 1 ? "ambiguous" : identity ? "detected" : "not_detected",
    };
  }

  function createAmuOcrClient(options = {}) {
    const tesseract = options.tesseract || (root && root.Tesseract);
    const parser = options.parser || defaultParser();
    if (!tesseract || typeof tesseract.createWorker !== "function") {
      throw new Error("Die lokale OCR-Bibliothek ist nicht verfügbar.");
    }
    if (!parser || typeof parser.extractAumDates !== "function") {
      throw new Error("Der AUM-OCR-Parser ist nicht verfügbar.");
    }

    const paths = { ...DEFAULT_ASSET_PATHS, ...(options.paths || {}) };
    const idleMs = Number.isFinite(Number(options.idleMs)) ? Math.max(0, Number(options.idleMs)) : 90000;
    let workerPromise = null;
    let queue = Promise.resolve();
    let idleTimer = null;
    let disposed = false;

    function clearIdleTimer() {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = null;
    }

    async function terminateWorker() {
      clearIdleTimer();
      const pending = workerPromise;
      workerPromise = null;
      if (!pending) return;
      try {
        const worker = await pending;
        await worker.terminate();
      } catch {
        // Initialization errors are reported by the recognition call itself.
      }
    }

    function scheduleIdleTermination() {
      clearIdleTimer();
      if (!idleMs || !workerPromise || disposed) return;
      idleTimer = setTimeout(() => { void terminateWorker(); }, idleMs);
      if (typeof idleTimer.unref === "function") idleTimer.unref();
    }

    function getWorker() {
      if (!workerPromise) {
        workerPromise = tesseract.createWorker(
          "deu",
          tesseract.OEM && tesseract.OEM.LSTM_ONLY !== undefined ? tesseract.OEM.LSTM_ONLY : 1,
          {
            workerPath: paths.workerPath,
            corePath: paths.corePath,
            langPath: paths.langPath,
            gzip: true,
            workerBlobURL: false,
            logger(message) {
              if (typeof options.onProgress !== "function") return;
              try {
                options.onProgress({
                  status: String(message && message.status || ""),
                  progress: Number.isFinite(Number(message && message.progress)) ? Number(message.progress) : null,
                });
              } catch {
                // UI progress callbacks must never interrupt OCR processing.
              }
            },
          },
        ).then(async (worker) => {
          await worker.setParameters({
            tessedit_pageseg_mode: tesseract.PSM && tesseract.PSM.AUTO !== undefined ? tesseract.PSM.AUTO : "3",
            preserve_interword_spaces: "1",
            user_defined_dpi: "300",
          });
          return worker;
        }).catch((error) => {
          workerPromise = null;
          throw error;
        });
      }
      return workerPromise;
    }

    function recognize(image, recognitionOptions = {}) {
      if (disposed) return Promise.reject(new Error("Die lokale OCR wurde bereits beendet."));
      clearIdleTimer();
      const run = queue.then(async () => {
        const worker = await getWorker();
        const result = await worker.recognize(image, { rotateAuto: true }, { text: true });
        return parser.extractAumDates(result && result.data ? result.data.text : "", {
          referenceDate: recognitionOptions.referenceDate,
        });
      });
      queue = run.catch(() => {}).finally(scheduleIdleTermination);
      return run;
    }

    async function dispose() {
      disposed = true;
      clearIdleTimer();
      await queue.catch(() => {});
      await terminateWorker();
    }

    return Object.freeze({ recognize, dispose });
  }

  return Object.freeze({ createAmuOcrClient, mergeAumOcrResults, DEFAULT_ASSET_PATHS });
}));
