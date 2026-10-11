(function attach(host, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host) host.GpXoffiImport = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function xoffiImportPresentation() {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const minutes = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
  const hours = value => minutes(value) === null ? '–' : (value / 60).toLocaleString('de-AT', { maximumFractionDigits: 2 });
  const inputHours = value => minutes(value) === null ? '' : (value / 60).toFixed(2);
  const weekdays = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  const warningText = value => value.slice(0, 1000).replace(/\bhttps?:\/\/\S+/gi, '[Quelladresse]');
  const warnings = values => (Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()).map(value => `<p class="xoffi-source-warning">${escape(warningText(value))}</p>`).join('');
  function date(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'unbekannt';
    const d = new Date(value + 'T12:00:00Z');
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value
      ? d.toLocaleDateString('de-AT', { timeZone:'UTC', day:'2-digit', month:'2-digit', year:'numeric' }) : 'unbekannt';
  }
  function diagnostic(item) {
    if (item?.reason === 'day_values') {
      const day = Number.isInteger(item.dayIndex) && weekdays[item.dayIndex] ? weekdays[item.dayIndex] + ' · ' : '';
      return `${day}${date(item.workDate)}: Ein Tageswert fehlt oder passt nicht zu den Zeitintervallen und Zuschlägen.`;
    }
    if (item?.reason === 'weekly_totals') {
      const values = [`Tagesbewertungen ${hours(item.dailyValuedMinutes)} h`, `Quellwoche ${hours(item.sourceWeeklyValuedMinutes)} h`];
      if (minutes(item.sourceWeeklyHolidayMinutes) !== null) values.push(`angeführte Feiertagsstunden ${hours(item.sourceWeeklyHolidayMinutes)} h`);
      if (item.dailySurchargeMinutes !== item.sourceWeeklySurchargeMinutes) values.push(`Tageszuschläge ${hours(item.dailySurchargeMinutes)} h / Wochenzuschläge ${hours(item.sourceWeeklySurchargeMinutes)} h`);
      return values.join(' · ') + '. Die Quellwerte erklären die Differenz nicht vollständig.';
    }
    return 'Ein Wert im Quellstand oder in der Wochenübersicht fehlt oder ist ungültig.';
  }
  function field(label, attribute, value, maximum) {
    return `<label>${label}<input ${attribute} type="number" inputmode="decimal" step="0.01" min="0" max="${maximum}" value="${inputHours(value)}" /></label>`;
  }
  function sourceSnapshot(employee) {
    const source = employee.snapshot;
    if (!source) return '';
    const proof = source.valuationReconciliation;
    const holiday = proof?.status === 'weekly_holiday' && minutes(proof.unallocatedHolidayMinutes) > 0;
    return `${holiday ? `<aside class="xoffi-week-credit"><strong>Quelle: ${hours(proof.dailyValuedMinutes)} h Tagesbewertung + ${hours(proof.unallocatedHolidayMinutes)} h Feiertagsstunden = ${hours(source.sourceWeeklyValuedMinutes)} h Woche</strong><p>${proof.roundingDifferenceMinutes ? `Enthält ${escape(proof.roundingDifferenceMinutes)} Minuten Quellrundung. ` : ''}Die Feiertagsstunden sind nur für die gesamte Woche belegt. Sie werden keinem Tag und keiner Anwesenheitszeit zugeschrieben. Für einen Teilzeitraum ist damit keine vollständige Bewertung möglich.</p></aside>` : ''}
      <details class="xoffi-source-snapshot"><summary>Unveränderter Quellstand · ${date(source.balanceDate)}</summary><dl>
        <div><dt>Zeitkonto am Stichtag</dt><dd>${hours(source.openingBalanceMinutes)} h</dd></div>
        <div><dt>Resturlaub am Stichtag</dt><dd>${typeof source.remainingVacationDays === 'number' && Number.isFinite(source.remainingVacationDays) ? escape(source.remainingVacationDays.toLocaleString('de-AT')) : '–'} Tage</dd></div>
        <div><dt>Quellvertrag / Woche</dt><dd>${escape(source.workdaysPerWeek)} × ${hours(source.dailyTargetMinutes)} h</dd></div>
        <div><dt>Mehrstunden dieser Woche</dt><dd>${hours(source.weeklyBalanceDeltaMinutes)} h</dd></div>
      </dl><p>Der gespeicherte Quellstand bleibt erhalten. Der GP-Vertrag und der GP-Urlaubsstand werden durch diesen Import nicht geändert.</p></details>`;
  }
  function render(preview) {
    const employees = Array.isArray(preview?.employees) ? preview.employees : [];
    const invalid = employees.filter(row => row.reviewStatus === 'invalid').length;
    const candidates = Array.isArray(preview?.candidates) ? preview.candidates : [];
    return `<section class="xoffi-preview-heading" aria-label="Erkannte Quelle"><div><span class="xoffi-section-label">2 · Quelle prüfen</span><strong>KW ${escape(preview.calendarWeek)} · ${escape(preview.context?.locationName || preview.context?.locationId)}</strong><small>${date(preview.weekStart)}–${date(preview.weekEnd)} · ${escape(preview.clientFileName || (preview.sourceKind === 'mhtml' ? 'MHTML-Datei' : 'Bilddatei'))}</small></div><span>${employees.length} Zeilen · ${employees.length - invalid} prüfbar${invalid ? ` · ${invalid} ungeklärt` : ''}</span></section>
      <p class="xoffi-review-intro">Zuordnung und Review-Werte prüfen. Die Originalwerte bleiben als Quellnachweis erhalten. Ungeklärte Zeilen können ausdrücklich ausgeschlossen werden.</p>
      ${warnings(preview.warnings)}
      <aside class="xoffi-import-blocker" role="alert" aria-atomic="true" data-xoffi-mapping-blocker hidden><strong>Import noch nicht möglich</strong><p data-xoffi-mapping-message></p></aside>
      <div class="xoffi-preview-rows">${employees.map((employee, rowIndex) => {
        const invalidRow = employee.reviewStatus === 'invalid';
        const options = invalidRow ? '' : candidates.map(person => `<option value="${escape(person.employeeNumber)}" ${person.employeeNumber === employee.employeeNumber ? 'selected' : ''}>${escape(person.employeeNumber)} · ${escape(person.nickname || person.fullName)}</option>`).join('');
        return `<article class="xoffi-preview-row ${invalidRow ? 'xoffi-row-invalid' : ''}" data-xoffi-row="${rowIndex}" data-source-name="${escape(employee.sourceName)}" data-review-status="${invalidRow ? 'invalid' : 'valid'}" data-match-confidence="${Number.isFinite(employee.matchConfidence) ? employee.matchConfidence : 0}">
          <div class="xoffi-row-heading"><div><span class="xoffi-section-label">Quellzeile ${rowIndex + 1}${invalidRow ? ' · Nicht prüfbar' : ''}</span><strong>${escape(employee.sourceName)}</strong><small>${invalidRow ? 'Ausschluss muss ausdrücklich gewählt werden' : employee.employeeNumber ? 'Namensvorschlag · bitte prüfen' : 'Zuordnung erforderlich'}</small></div>
            <label>${invalidRow ? 'Diese Quellzeile' : 'GP-Teammitglied'}<select data-xoffi-employee><option value="">${invalidRow ? 'Bitte Entscheidung wählen' : 'Bitte zuordnen'}</option>${options}<option value="__skip__">Diese Zeile nicht übernehmen</option></select></label></div>
          ${invalidRow ? `<aside class="xoffi-row-diagnostic" aria-label="Fehler in Quellzeile ${rowIndex + 1}"><strong>Werte können nicht sicher übernommen werden</strong>${(employee.diagnostics || [{}]).map(item => `<p>${escape(diagnostic(item))}</p>`).join('')}<p>Es werden keine Tageswerte ergänzt. Diese Zeile ausschließen, um die übrigen gültigen Zuordnungen zu importieren.</p></aside>` : `${sourceSnapshot(employee)}
          <section class="xoffi-row-review" aria-label="Review für ${escape(employee.sourceName)}"><h3>Mein Review · Woche</h3><div class="xoffi-week-values">
            ${field('Anwesenheit (h)', 'data-xoffi-week-actual', employee.weeklyActualMinutes, 168)}${field('Bewertung (h)', 'data-xoffi-week-valued', employee.weeklyValuedMinutes, 336)}${field('Zuschläge (h)', 'data-xoffi-week-surcharge', employee.weeklySurchargeMinutes, 168)}
            ${employee.snapshot ? '' : `<label>Stundenkonto (h)<input data-xoffi-balance type="number" inputmode="decimal" step="0.01" min="-10000" max="10000" value="${inputHours(employee.closingBalanceMinutes)}" /></label>`}</div>
            <details class="xoffi-row-days"><summary>Tageswerte prüfen · ${employee.days.length} Tage</summary><div class="xoffi-days">${employee.days.map((day, dayIndex) => `<div class="xoffi-day" data-xoffi-day="${dayIndex}" data-work-date="${escape(day.workDate)}" data-confidence="${Number.isFinite(day.confidence) ? day.confidence : 0}"><strong>${weekdays[dayIndex]}<small>${date(day.workDate)}${day.absence ? ' · ' + escape(({ sick:'Krankenstand', vacation:'Urlaub' })[day.absence] || day.absence) : ''}</small></strong>
              <label class="xoffi-day-times">Zeitintervalle<input data-xoffi-intervals type="text" value="${escape((day.intervals || []).join(', '))}" placeholder="09:00-12:30, 13:00-17:00" /></label>${field('Anwesenheit (h)', 'data-xoffi-day-actual', day.actualMinutes, 24)}${field('Bewertung (h)', 'data-xoffi-day-valued', day.valuedMinutes, 48)}${field('Zuschlag (h)', 'data-xoffi-day-surcharge', day.surchargeMinutes, 24)}</div>`).join('')}</div></details></section>`}
          ${warnings(employee.warnings)}</article>`;
      }).join('')}</div>`;
  }
  function weeklyEvidence(row) {
    const credits = row.weeklyCredits || [];
    if (!credits.length && !row.valuationAllocationIncomplete) return '';
    const missingProof = credits.some(credit => credit.status !== 'verified');
    return `<aside class="xoffi-week-credit"><strong>${missingProof ? 'Bewertung ohne bestätigten Wochennachweis' : row.valuationAllocationIncomplete ? 'Wochenposten nicht im Zeitraum zuordenbar' : 'Getrennte Wochenposten'}</strong>
      ${credits.map(credit => `<p>${date(credit.weekStart)}–${date(credit.weekEnd)}: ${credit.status === 'verified' ? `${hours(credit.minutes)} h belegte Feiertagsstunden${credit.roundingDifferenceMinutes ? ` · ${escape(credit.roundingDifferenceMinutes)} Minuten Quellrundung` : ''}` : 'Kein passender bestätigter Nachweis für die Wochendifferenz.'}</p>`).join('')}
      <p>Gesicherte Tagesbewertungen im Zeitraum: ${hours(row.knownDailyValuedMinutes)} h.${row.valuationAllocationIncomplete ? ' Der Teilstand ist keine vollständige Zeitraum-Bewertung; eine Gesamtabweichung wird nicht berechnet.' : ' Wochenposten ergänzen die Gesamtsumme, ohne einzelne Tage oder Anwesenheitszeiten zu verändern.'}</p></aside>`;
  }
  return { render, diagnostic, weeklyEvidence };
}));
