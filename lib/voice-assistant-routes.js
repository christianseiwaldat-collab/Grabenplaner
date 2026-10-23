"use strict";

function registerVoiceAssistantRoutes(app, { assistant, assertCsrf }) {
  const base = "/api/portal/v1/me/assistant";
  const route = handler => async (request, response, next) => {
    try { await handler(request, response); }
    catch (error) {
      if (error.code?.startsWith("ASSISTANT_")) {
        response.status(error.status || 503).json({ error: error.message, code: error.code, ...(error.draft ? { draft: error.draft } : {}) });
      } else next(error);
    }
  };
  function body(request, keys) {
    const value = request.body || {};
    if (typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
      throw Object.assign(new Error("Die Anfrage enthält nicht unterstützte Parameter. Fremde Personaldaten sind hier nicht verfügbar."), { status: 400, code: "ASSISTANT_PARAMETERS_INVALID" });
    }
    return value;
  }
  app.get(base + "/status", route(async (req, res) => {
    if (Object.keys(req.query).length) body({ body: req.query }, []);
    res.json(await assistant.status(req));
  }));
  app.post(base + "/conversations", route(async (req, res) => {
    assertCsrf(req);
    res.status(201).json(await assistant.start(req, body(req, ["sdp"])));
  }));
  app.post(base + "/conversations/:id/messages", route(async (req, res) => {
    assertCsrf(req);
    res.json(await assistant.message(req, req.params.id, body(req, ["text", "operationId"])));
  }));
  app.post(base + "/conversations/:id/confirm", route(async (req, res) => {
    assertCsrf(req);
    res.json(await assistant.confirm(req, req.params.id, body(req, ["draftId", "confirmationToken", "confirmation"])));
  }));
  app.get(base + "/conversations/:id/draft", route(async (req, res) => {
    body({ body: req.query }, []);
    res.json(await assistant.currentDraft(req, req.params.id));
  }));
  app.delete(base + "/conversations/:id/draft", route(async (req, res) => {
    assertCsrf(req);
    body(req, []);
    await assistant.discardDraft(req, req.params.id);
    res.status(204).end();
  }));
  app.delete(base + "/conversations/:id", route(async (req, res) => {
    assertCsrf(req);
    body(req, []);
    await assistant.close(req, req.params.id);
    res.status(204).end();
  }));
}

module.exports = { registerVoiceAssistantRoutes };
