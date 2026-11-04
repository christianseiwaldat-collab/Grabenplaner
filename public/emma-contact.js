(function (global) {
  "use strict";
  const endpoint = "/api/portal/v1/emma-contact";
  function validContact(value) {
    return value && /^https:\/\/wa\.me\/[1-9][0-9]{6,14}$/.test(value.href)
      && typeof value.avatar === "string" && value.avatar.length < 370000
      && (!value.avatar || value.avatar === "/assets/emma-whatsapp.png" || /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatar));
  }
  function personal(session) {
    return Boolean(session?.authenticated && session.user && !session.user.mustChangePassword
      && session.user.isEmployee !== false && session.user.sessionKind !== "organization"
      && !["branch", "terminal"].includes(session.user.accountType));
  }
  function shortcut(root, { api, session }) {
    let generation = 0;
    function reset() {
      generation++; root.hidden = true; root.removeAttribute("href");
      const image = root.querySelector("img"); image.hidden = true; image.removeAttribute("src");
      root.querySelector("[data-emma-fallback]").hidden = false;
    }
    async function load() {
      reset(); const ticket = generation, actor = session();
      if (!personal(actor)) return;
      try {
        const result = await api(endpoint);
        if (ticket !== generation || actor !== session() || !personal(session()) || !validContact(result.contact)) return;
        root.href = result.contact.href;
        if (result.contact.avatar) {
          const image = root.querySelector("img");
          image.onerror = () => { image.hidden = true; root.querySelector("[data-emma-fallback]").hidden = false; };
          image.src = result.contact.avatar; image.hidden = false;
          root.querySelector("[data-emma-fallback]").hidden = true;
        }
        root.hidden = false;
      } catch { /* An unavailable contact must never block the employee portal. */ }
    }
    root.addEventListener("click", event => { if (!personal(session()) || root.hidden) event.preventDefault(); });
    reset(); return { load, reset };
  }
  function mountSettings(root, { api, session }) {
    if (!root) return null;
    const doc = root.ownerDocument;
    function node(tag, text, attributes = {}) {
      const element = doc.createElement(tag); if (text) element.textContent = text;
      for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, value);
      return element;
    }
    const editor = node("div", "", { class: "emma-contact-editor" });
    const enabled = node("input", "", { type: "checkbox" });
    const enabledLabel = node("label", "Button im mobilen Mitarbeiterkonto anzeigen"); enabledLabel.append(enabled);
    const phone = node("input", "", { type: "tel", readonly: "", "aria-label": "Emmas WhatsApp-Nummer" });
    const phoneLabel = node("label", "WhatsApp-Nummer aus Emmas Personalakt"); phoneLabel.append(phone);
    const phoneHint = node("p", "Die Nummer änderst du unter Personal → Mitarbeitende → Emma → Personalakt → Kontaktdaten. Der Button verwendet immer diese Nummer.");
    const upload = node("input", "", { type: "file", accept: "image/png,image/jpeg,image/webp", "aria-label": "Emmas Profilbild auswählen" });
    const uploadLabel = node("label", "Profilbild · PNG, JPEG oder WebP, höchstens 256 KB"); uploadLabel.append(upload);
    const image = node("img", "", { alt: "Vorschau von Emmas Profilbild", hidden: "" });
    const remove = node("button", "Emmas Standardbild verwenden", { type: "button", class: "secondary-button" });
    const picture = node("div", "", { class: "emma-contact-picture" }); picture.append(image, remove);
    const save = node("button", "Emma-Kontakt speichern", { type: "button", class: "primary-button" });
    const reload = node("button", "Gespeicherten Stand laden", { type: "button", class: "secondary-button" });
    const actions = node("div", "", { class: "emma-contact-actions" }); actions.append(save, reload);
    const status = node("p", "", { class: "emma-contact-status", role: "status", "aria-live": "polite" });
    editor.append(enabledLabel, phoneLabel, phoneHint, uploadLabel, picture, actions, status); root.append(editor);
    let actor = null, generation = 0, revision = "", avatar = "", busy = false, loaded = false;
    const allowed = () => personal(session()) && session().user.role === "developer" && session().user.permissions?.includes("settings:write");
    function controls() {
      for (const input of [enabled, phone, upload, remove, save]) input.disabled = busy || !loaded || !allowed();
      reload.disabled = busy || !allowed();
    }
    function message(text, error = false) { status.textContent = text; status.dataset.error = String(error); }
    function preview() {
      image.hidden = false;
      image.src = avatar || "/assets/emma-whatsapp.png";
    }
    function reset() {
      generation++; actor = session(); revision = ""; avatar = ""; busy = false; loaded = false;
      enabled.checked = false; phone.value = ""; upload.value = ""; preview(); message("");
      root.hidden = !allowed(); controls();
    }
    function synchronize() { if (actor !== session() || !allowed()) reset(); }
    const current = ticket => { synchronize(); return ticket === generation && allowed(); };
    function render(result) {
      revision = result.revision; enabled.checked = result.settings.enabled; phone.value = result.phone ? "+" + result.phone : "";
      avatar = result.settings.avatar; upload.value = ""; loaded = true; preview();
    }
    async function load(force = false) {
      synchronize(); if (!allowed() || busy || (loaded && !force)) return;
      const ticket = ++generation; busy = true; controls(); message("Emma-Kontakt wird geladen …");
      try {
        const result = await api(endpoint + "/settings");
        if (!current(ticket)) return; render(result); message("Gespeicherten Stand geladen.");
      } catch (error) { if (current(ticket)) message(error.message, true); }
      finally { if (current(ticket)) { busy = false; controls(); } }
    }
    upload.addEventListener("change", async () => {
      const file = upload.files?.[0]; if (!file || !allowed() || busy) return;
      if (file.size > 256 * 1024 || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        upload.value = ""; message("Bitte PNG, JPEG oder WebP mit höchstens 256 KB auswählen.", true); return;
      }
      const ticket = ++generation; busy = true; controls();
      try {
        const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        if (!current(ticket)) return; avatar = data; preview(); message("Profilbild ausgewählt. Bitte speichern.");
      } catch { if (current(ticket)) message("Das Profilbild konnte nicht gelesen werden.", true); }
      finally { if (current(ticket)) { busy = false; controls(); } }
    });
    remove.addEventListener("click", () => { if (!allowed() || busy) return; avatar = ""; upload.value = ""; preview(); message("Emmas Standardbild ausgewählt. Bitte speichern."); });
    enabled.addEventListener("input", () => message("Ungespeicherte Änderungen."));
    reload.addEventListener("click", () => void load(true));
    save.addEventListener("click", async () => {
      synchronize(); if (!allowed() || busy || !loaded) return;
      const ticket = ++generation;
      const body = JSON.stringify({ revision, settings: { enabled: enabled.checked, avatar } });
      busy = true; controls(); message("Wird gespeichert …");
      try {
        const result = await api(endpoint + "/settings", { method: "PUT", body });
        if (!current(ticket)) return; render(result); message("Emma-Kontakt gespeichert.");
      } catch (error) { if (current(ticket)) message(error.message, true); }
      finally { if (current(ticket)) { busy = false; controls(); } }
    });
    reset(); return { load, reset, synchronize };
  }
  global.GpEmmaContact = Object.freeze({ shortcut, mountSettings });
})(window);
