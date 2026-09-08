"use strict";

const content = document.getElementById("evaluationContent");
const status = document.getElementById("evaluationStatus");
const state = { evaluations: [], active: null, submitting: false };

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function csrfToken() {
  const cookie = document.cookie.split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("grabenplaner_csrf="));
  return cookie ? decodeURIComponent(cookie.split("=").slice(1).join("=")) : "";
}

async function api(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (!['GET', 'HEAD'].includes(method) && csrfToken()) headers["X-CSRF-Token"] = csrfToken();
  const response = await fetch(url, { ...options, method, headers, credentials: "same-origin" });
  if (!response.ok) {
    let detail = null;
    try { detail = await response.json(); } catch {}
    const error = new Error(detail?.message || detail?.error || "Die Bewertung konnte nicht verarbeitet werden.");
    error.status = response.status;
    error.code = detail?.code || "";
    throw error;
  }
  return response.status === 204 ? null : response.json();
}

function dateLabel(value) {
  const normalized = String(value || "").slice(0, 10);
  if (!normalized) return "";
  const date = new Date(`${normalized}T12:00:00`);
  return Number.isNaN(date.getTime()) ? normalized : new Intl.DateTimeFormat("de-AT", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function trialLabel(appointment) {
  if (!appointment?.dateFrom) return "";
  const from = dateLabel(appointment.dateFrom);
  const to = dateLabel(appointment.dateTo || appointment.dateFrom);
  const dates = from === to ? from : `${from}–${to}`;
  const times = [appointment.startTime, appointment.endTime].filter(Boolean).join("–");
  return times ? `${dates} · ${times} Uhr` : dates;
}

function renderComplete(submitted = false) {
  status.classList.remove("error");
  status.textContent = submitted
    ? "Die Rückmeldung wurde vollständig und revisionsgebunden übermittelt."
    : "Dir ist derzeit keine offene Bewerbungsbewertung zugewiesen.";
  content.innerHTML = `<div class="evaluation-complete"><div><strong>${submitted ? "Vielen Dank für die Bewertung." : "Keine offene Bewertung."}</strong><p>Diese Bewertungsfläche wird geschlossen. Danach steht das Mitarbeiterportal wieder regulär zur Verfügung.</p></div></div>`;
  setTimeout(() => window.location.replace("/portal.html"), 1800);
}

function renderEvaluation({ submitted = false } = {}) {
  const evaluation = state.active;
  if (!evaluation) {
    renderComplete(submitted);
    return;
  }
  const activeIndex = Math.max(0, state.evaluations.findIndex((entry) => entry.id === evaluation.id));
  const appointment = trialLabel(evaluation.trialAppointment);
  status.classList.remove("error");
  status.textContent = "Die Bewertung ist ausschließlich deinem persönlichen Zugang zugeordnet und kann einmalig abgegeben werden.";
  content.innerHTML = `<div class="evaluation-meta">
      <div><h2>${escapeHtml(evaluation.candidateName)}</h2><p>${escapeHtml(evaluation.desiredRoleTitle || "Tätigkeit nicht angegeben")}${appointment ? ` · ${escapeHtml(appointment)}` : ""}</p></div>
      <span class="evaluation-progress">Bewertung ${activeIndex + 1} von ${state.evaluations.length}</span>
    </div>
    <form class="evaluation-form" id="candidateEvaluationForm">
      ${(evaluation.criteria || []).map((criterion, index) => `<fieldset class="evaluation-criterion" data-criterion-id="${escapeHtml(criterion.id)}">
        <legend>${escapeHtml(criterion.label)}</legend>
        <div class="evaluation-stars" role="radiogroup" aria-label="${escapeHtml(`${criterion.label}: ein bis fünf Sterne`)}">
          ${[1, 2, 3, 4, 5].map((rating) => `<label class="evaluation-star" title="${rating} von 5 Sternen"><input type="radio" name="criterion-${index}" value="${rating}" ${rating === 1 ? "required" : ""} /><span><b aria-hidden="true">★</b><small>${rating}</small></span></label>`).join("")}
        </div>
        <label class="evaluation-comment"><span>Kommentar <small>optional</small></span><textarea maxlength="1000" rows="3" placeholder="Konkrete, arbeitsbezogene Beobachtung"></textarea></label>
      </fieldset>`).join("")}
      <div class="evaluation-actions"><small>Nach dem Absenden ist keine Änderung mehr möglich. Deine Einzelbewertung bleibt für die auswertende Filialleitung nachvollziehbar.</small><button class="evaluation-submit" type="submit">Bewertung verbindlich absenden</button></div>
    </form>`;
  document.getElementById("candidateEvaluationForm")?.addEventListener("submit", submitEvaluation);
}

async function loadEvaluations({ preferredId = "", submitted = false } = {}) {
  const result = await api("/api/portal/v1/me/candidate-evaluations");
  state.evaluations = Array.isArray(result?.evaluations) ? result.evaluations : [];
  state.active = state.evaluations.find((entry) => entry.id === preferredId) || state.evaluations[0] || null;
  renderEvaluation({ submitted });
}

function restoreEvaluationDraft(evaluationId, criteria) {
  if (state.active?.id !== evaluationId) return false;
  const draft = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  document.querySelectorAll("#candidateEvaluationForm [data-criterion-id]").forEach((row) => {
    const criterion = draft.get(row.dataset.criterionId);
    if (!criterion) return;
    const rating = [...row.querySelectorAll('input[type="radio"]')]
      .find((input) => Number(input.value) === criterion.rating);
    if (rating) rating.checked = true;
    const comment = row.querySelector("textarea");
    if (comment) comment.value = criterion.comment;
  });
  return true;
}

async function submitEvaluation(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!state.active || state.submitting || !form.reportValidity()) return;
  const criteria = [...form.querySelectorAll("[data-criterion-id]")].map((row) => ({
    id: row.dataset.criterionId,
    rating: Number(row.querySelector('input[type="radio"]:checked')?.value || 0),
    comment: String(row.querySelector("textarea")?.value || "").trim(),
  }));
  state.submitting = true;
  const button = form.querySelector("button[type='submit']");
  if (button) {
    button.disabled = true;
    button.textContent = "Bewertung wird übermittelt …";
  }
  try {
    await api(`/api/portal/v1/me/candidate-evaluations/${encodeURIComponent(state.active.id)}`, {
      method: "POST",
      body: JSON.stringify({ revision: state.active.applicationRevision, criteria }),
    });
    await loadEvaluations({ submitted: true });
  } catch (error) {
    status.classList.add("error");
    status.textContent = error.message;
    if ([401, 403, 428].includes(error.status)) {
      setTimeout(() => window.location.replace("/portal.html"), 1200);
    } else if (error.status === 409) {
      const evaluationId = state.active?.id || "";
      try {
        await loadEvaluations({ preferredId: evaluationId });
        if (restoreEvaluationDraft(evaluationId, criteria)) {
          status.classList.add("error");
          status.textContent = "Die Bewerbung wurde zwischenzeitlich aktualisiert. Deine Sterne und Kommentare sind erhalten geblieben. Bitte die Bewertung erneut absenden.";
        }
      } catch (refreshError) {
        status.classList.add("error");
        status.textContent = refreshError.message;
        if ([401, 403, 428].includes(refreshError.status)) {
          setTimeout(() => window.location.replace("/portal.html"), 1200);
        }
      }
    }
  } finally {
    state.submitting = false;
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = "Bewertung verbindlich absenden";
    }
  }
}

async function initialize() {
  try {
    const requestedId = new URLSearchParams(window.location.search).get("id") || "";
    await loadEvaluations({ preferredId: requestedId });
  } catch (error) {
    status.classList.add("error");
    status.textContent = error.message;
    content.innerHTML = '<div class="evaluation-loading">Die Bewertungsfläche ist derzeit nicht verfügbar.</div>';
    if ([401, 403, 428].includes(error.status)) {
      setTimeout(() => window.location.replace("/portal.html"), 1200);
    }
  }
}

initialize();
