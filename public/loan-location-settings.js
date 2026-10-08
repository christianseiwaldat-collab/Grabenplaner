(function(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LoanLocationSettings = api;
})(typeof window === "object" ? window : this, function() {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);

  function renderLocation(location, { recipients = [], policyOnly = false, returnPolicyEditable = true, open = false } = {}) {
    const witness = location.returnPolicy?.requiresWitness === true;
    const provider = location.emailDelivery?.provider || {};
    const emailAvailable = provider.loanDocumentAvailable === true;
    const emailHint = provider.configured === false ? "SMTP ist noch nicht eingerichtet."
      : !emailAvailable ? "Der Versand von Leihbelegen ist serverseitig noch nicht freigeschaltet."
        : "Versand an die bestätigte persönliche Adresse und die zusätzliche Belegadresse.";
    const recipientHint = !location.documentRecipient ? "Die zuständige Leitung erhält eine interne Mitteilung."
      : location.documentRecipient.emailDelivery?.available ? "E-Mail-Belege gehen auch an die bestätigte persönliche Adresse."
        : "Interne Mitteilung aktiv; eine bestätigte persönliche E-Mail-Adresse fehlt noch.";
    return `<details class="loan-location-disclosure" data-loan-location="${escape(location.locationId)}" ${open ? "open" : ""}>
      <summary><span class="loan-location-number">${escape(location.locationId)}</span><strong>${escape(location.locationName)}</strong><span class="loan-location-policy">${witness ? "Rückgabe mit Kontrolle" : "Rückgabe allein"}</span><span class="status-badge ${location.enabled ? "active" : "inactive"}">${location.enabled ? "Aktiv" : "Inaktiv"}</span></summary>
      <form class="loan-location-setting" data-loan-setting-location="${escape(location.locationId)}" data-loan-policy-only="${policyOnly}">
        ${policyOnly ? "" : `<label class="switch-row"><span><strong>Leihe aktiv</strong><small>Ausgabe und Rücknahme für diese Filiale freischalten.</small></span><input name="enabled" type="checkbox" ${location.enabled ? "checked" : ""} /></label>`}
        <fieldset class="loan-setting-section"><legend>Rücknahme</legend>
          <label class="switch-row"><span><strong>Zweites Teammitglied zur Kontrolle</strong><small>${returnPolicyEditable ? "Ausgeschaltet: Rückgabe selbst abschließen. Eingeschaltet: Ein anderes aktives Teammitglied dieser Filiale muss bestätigen." : "Für Änderungen an dieser Regel fehlt die Berechtigung."}</small></span><input name="requiresWitness" type="checkbox" ${witness ? "checked" : ""} ${returnPolicyEditable ? "" : "disabled"} /></label>
        </fieldset>
        ${policyOnly ? "" : `<fieldset class="loan-setting-section"><legend>Artikel</legend>
          <p class="settings-note">Der GP-Artikelstamm wird zuerst durchsucht. Fehlt der Artikel, ist eine manuelle Beschreibung möglich.</p>
          <details class="loan-setting-external"><summary>Zusätzliche externe Artikelquelle</summary>
            <label class="switch-row"><span><strong>Externe Bezeichnung nachschlagen</strong><small>Die zusätzliche Quelle wird nur bei Bedarf abgefragt.</small></span><input name="lookupEnabled" type="checkbox" ${location.articleLookup?.enabled ? "checked" : ""} /></label>
            <div class="loan-setting-fields"><label class="field"><span>Artikelquelle</span><select name="lookupProvider"><option value="none">Keine externe Suche</option><option value="shopware_storefront" ${location.articleLookup?.provider === "shopware_storefront" ? "selected" : ""}>Shopware-Onlineshop</option></select></label><label class="field"><span>Basisadresse</span><input name="lookupBaseUrl" type="url" maxlength="1000" value="${escape(location.articleLookup?.baseUrl || "")}" placeholder="https://shop.example.com" /></label></div>
          </details>
        </fieldset>
        <fieldset class="loan-setting-section"><legend>Fotos und Belege</legend>
          <div class="loan-setting-fields">
            <label class="field"><span>Foto-PDF</span><select name="photoOutputMode"><option value="grayscale" ${location.photoPdf?.outputMode !== "blackwhite" ? "selected" : ""}>Graustufen</option><option value="blackwhite" ${location.photoPdf?.outputMode === "blackwhite" ? "selected" : ""}>Schwarzweiß</option></select></label>
            <label class="field"><span>Aufbereitete Farbfassungen</span><select name="photoOriginalRetention"><option value="retain" ${location.photoPdf?.originalRetention !== "delete" ? "selected" : ""}>Geschützt aufbewahren</option><option value="delete" ${location.photoPdf?.originalRetention === "delete" ? "selected" : ""}>Nach PDF-Verarbeitung löschen</option></select></label>
            <label class="field"><span>Interner Belegempfänger</span><select name="documentRecipient"><option value="">Zuständige Leitung</option>${recipients.map(employee => `<option value="${escape(employee.personnel_number)}" ${String(employee.personnel_number) === String(location.documentRecipient?.employeeNumber) ? "selected" : ""}>${escape(employee.personnel_number)} · ${escape(employee.nickname || employee.full_name)}</option>`).join("")}</select><small>${escape(recipientHint)}</small></label>
            <label class="field"><span>Zusätzliche Beleg-E-Mail</span><input name="emailRecipient" type="email" maxlength="320" value="${escape(location.emailDelivery?.recipient || "")}" placeholder="Optional" /></label>
          </div>
          <label class="switch-row"><span><strong>Beleg zusätzlich per E-Mail</strong><small>${escape(emailHint)}</small></span><input name="emailEnabled" type="checkbox" ${location.emailDelivery?.enabled ? "checked" : ""} ${emailAvailable ? "" : "disabled"} /></label>
          <details class="loan-setting-retention"><summary>Aufbewahrung der Fotos</summary><p class="loan-photo-retention-note">Die geschützte Aufbewahrung ist der Standard. Aufbereitete Farbfassungen können für die Beurteilung von Schäden wichtig sein. Diese Auswahl gilt für neu hochgeladene Fotos; unveränderte Handydateien werden nicht gespeichert.</p></details>
        </fieldset>`}
        <div class="form-actions-inline"><span class="settings-note" data-loan-setting-message role="status" aria-live="polite"></span><button class="primary-button" type="submit">${policyOnly ? "Rücknahmeregel speichern" : "Filiale speichern"}</button></div>
      </form>
    </details>`;
  }

  function formPayload(form) {
    const fields = form.elements;
    const payload = fields.requiresWitness.disabled ? {} : { returnPolicy: { requiresWitness: fields.requiresWitness.checked } };
    if (form.dataset.loanPolicyOnly === "true") return payload;
    return {
      ...payload, enabled: fields.enabled.checked,
      articleLookup: { enabled: fields.lookupEnabled.checked, provider: fields.lookupProvider.value, baseUrl: fields.lookupBaseUrl.value },
      photoPdf: { outputMode: fields.photoOutputMode.value, originalRetention: fields.photoOriginalRetention.value },
      documentRecipientEmployeeNumber: fields.documentRecipient.value,
      emailDelivery: { enabled: fields.emailEnabled.checked, recipient: fields.emailRecipient.value },
    };
  }
  return Object.freeze({ renderLocation, formPayload });
});
