(function attachFunctionSearchCatalog(root, factory) {
  "use strict";

  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root && typeof root === "object") root.GrabenplanerFunctionSearchCatalog = api;
}(typeof globalThis !== "undefined" ? globalThis : this, function createFunctionSearchCatalogModule() {
  "use strict";

  const FUNCTION_SEARCH_CATALOG_VERSION = 1;
  const SUPPORTED_VIEWS = new Set([
    "startDashboard",
    "filialAdministration",
    "personnel",
    "loans",
    "branchOrders",
    "planning",
    "vacations",
    "requests",
    "timeTracking",
    "personnelAdministration",
    "salesAdministration",
    "salesAnalytics",
    "rightsDashboard",
    "settings",
  ]);
  const SUPPORTED_PERSONNEL_ADMINISTRATION_TABS = new Set([
    "dashboard",
    "employees",
    "applications",
    "workflows",
    "learning",
    "tasks",
    "costCenters",
    "ruleDrafts",
    "collectiveAgreements",
    "vacations",
    "dataRequests",
  ]);
  const SUPPORTED_PERSONNEL_TABS = new Set(["employees", "locations"]);
  const SUPPORTED_SETTINGS_TABS = new Set([
    "general",
    "schedule",
    "personnel",
    "vacation",
    "timeTracking",
    "integrations",
    "access",
    "rights",
    "dataProtection",
    "backup",
  ]);
  const SUPPORTED_DASHBOARD_MODES = new Set(["locations", "rights", "personnelRules", "processes", "systemCenter"]);
  const SUPPORTED_REQUEST_KINDS = new Set(["vacation", "time_off", "amu"]);
  const ALLOWED_ENTRY_KEYS = new Set(["id", "label", "path", "description", "synonyms", "access", "target"]);
  const ALLOWED_TARGET_KEYS = new Set([
    "kind",
    "view",
    "personnelAdministrationTab",
    "personnelTab",
    "settingsTab",
    "dashboardMode",
    "requestKind",
    "revealIds",
    "focusId",
  ]);

  function entry(id, label, path, description, synonyms, gateIds, target) {
    return {
      id,
      label,
      path,
      description,
      synonyms,
      access: { gateIds },
      target: { kind: "navigation", ...target },
    };
  }

  const FUNCTION_SEARCH_CATALOG = [
    entry(
      "dashboard.start",
      "Startdashboard öffnen",
      ["Dashboard", "Persönlicher Überblick"],
      "Öffnet die persönliche Übersicht mit den freigegebenen und individuell angeordneten Arbeitskarten.",
      ["startseite", "startdashboard", "dashboard", "übersicht", "wochenüberblick", "schnellzugriff", "meine karten"],
      ["startDashboardNavButton"],
      { view: "startDashboard", focusId: "startDashboardGrid" },
    ),
    entry(
      "filial.overview",
      "Filialverwaltung öffnen",
      ["Filialverwaltung", "Übersicht"],
      "Öffnet die Übersicht der für den eigenen Verantwortungsbereich verfügbaren Filialfunktionen.",
      ["filiale", "standort", "filialübersicht", "filialdashboard", "arbeitsbereiche", "niederlassung"],
      ["filialDashboardNavButton"],
      { view: "filialAdministration", focusId: "filialDashboardGrid" },
    ),
    entry(
      "filial.team",
      "Team anzeigen",
      ["Filialverwaltung", "Teams & Standorte", "Team"],
      "Öffnet die Teamübersicht mit den freigegebenen Mitarbeiterstammdaten.",
      ["mitarbeiter", "mitarbeitende", "teammitglieder", "personal", "kollegen", "stammdaten", "filialteam"],
      ["filialTeamsNavButton", "filialTeamTab"],
      { view: "personnel", personnelTab: "employees", focusId: "employeeSettings" },
    ),
    entry(
      "filial.locations",
      "Standorte und Abteilungen verwalten",
      ["Filialverwaltung", "Teams & Standorte", "Standortverwaltung"],
      "Öffnet die Verwaltung von Filialen, Öffnungszeiten und Abteilungen.",
      ["standort", "filiale", "abteilung", "öffnungszeiten", "niederlassung", "location", "department"],
      ["filialTeamsNavButton", "filialLocationsTab"],
      { view: "personnel", personnelTab: "locations", focusId: "locationSettings" },
    ),
    entry(
      "filial.loans",
      "Leihverwaltung öffnen",
      ["Filialverwaltung", "Leihverwaltung"],
      "Öffnet die freigegebene Übersicht über Geräte- und Warenleihen.",
      ["leihe", "leihen", "ausgabe", "rückgabe", "gerät", "warenleihe", "offene leihen"],
      ["loanManagementNavButton"],
      { view: "loans", focusId: "loansView" },
    ),
    entry(
      "filial.branch-orders",
      "Filialbestellungen verwalten",
      ["Filialverwaltung", "Filialbestellungen"],
      "Öffnet Bestellkonfiguration, Erfassung und Bestellverlauf der freigegebenen Filialen.",
      ["bestellung", "filialkonto", "bestellliste", "warenbestellung", "mengen", "bestellverlauf", "branch order"],
      ["branchOrdersManagementNavButton"],
      { view: "branchOrders", focusId: "branchOrdersManagementWorkspace" },
    ),

    entry(
      "planning.overview",
      "Dienstplanung öffnen",
      ["Filialverwaltung", "Dienstplanung"],
      "Öffnet den Wochendienstplan der aktuell gewählten Kalenderwoche.",
      ["dienstplan", "wochenplan", "schichtplan", "einsatzplan", "kalenderwoche", "kw", "planung"],
      ["planningNavButton"],
      { view: "planning", focusId: "planningView" },
    ),
    entry(
      "planning.rule-assessment",
      "Arbeitszeit-Regelprüfung anzeigen",
      ["Filialverwaltung", "Dienstplanung", "Regelprüfung"],
      "Springt zur aufklappbaren Prüfung der im Dienstplan erkannten Arbeitszeitregeln.",
      ["regelprüfung", "arbeitszeit", "planprüfung", "warnung", "blockierung", "kollektivvertrag", "ruhezeit", "kw regelprüfung", "kalenderwochenprüfung"],
      ["planningNavButton"],
      { view: "planning", revealIds: ["workRuleAssessmentPanel"], focusId: "workRuleAssessmentPanel" },
    ),
    entry(
      "planning.auto-plan",
      "Dienstplan automatisch erstellen",
      ["Filialverwaltung", "Dienstplanung", "Automatische Planung"],
      "Navigiert zur automatischen Dienstplanerstellung, ohne sie auszulösen.",
      ["autoplan", "automatisch planen", "dienstplan generator", "schichten verteilen", "plan erstellen", "auto plan"],
      ["planningNavButton"],
      { view: "planning", focusId: "autoPlanButton" },
    ),
    entry(
      "planning.options",
      "Planungsoptionen öffnen",
      ["Filialverwaltung", "Dienstplanung", "Planungsoptionen"],
      "Navigiert zu den Optionen und Sonderfällen der Dienstplanung, ohne einen Dialog auszulösen.",
      ["sonderfall", "option", "urlaub", "krank", "filialeinsatz", "abwesenheit", "planoption"],
      ["planningNavButton"],
      { view: "planning", focusId: "optionsButton" },
    ),
    entry(
      "planning.temporary-assignment",
      "Temporären Filialeinsatz zuweisen",
      ["Filialverwaltung", "Dienstplanung", "Standortübergreifender Einsatz"],
      "Navigiert zur berechtigten Zuweisung eines temporären Einsatzes in einer anderen Filiale.",
      ["filialeinsatz", "standortübergreifend", "aushilfe", "andere filiale", "temporärer einsatz", "mitarbeitereinsatz"],
      ["planningNavButton", "employeeLendingButton"],
      { view: "planning", focusId: "employeeLendingButton" },
    ),
    entry(
      "planning.note",
      "Dienstplan-Bemerkung bearbeiten",
      ["Filialverwaltung", "Dienstplanung", "Bemerkung"],
      "Navigiert zur Wochenbemerkung des Dienstplans, ohne sie zu öffnen oder zu verändern.",
      ["bemerkung", "notiz", "wochenhinweis", "planhinweis", "kommentar", "dienstplannotiz"],
      ["planningNavButton"],
      { view: "planning", focusId: "scheduleNoteButton" },
    ),
    entry(
      "planning.pdf",
      "Dienstplan als PDF exportieren",
      ["Filialverwaltung", "Dienstplanung", "PDF"],
      "Navigiert zum PDF-Export des geöffneten Dienstplans, ohne einen Download zu starten.",
      ["pdf", "drucken", "druckansicht", "export", "dienstplan herunterladen", "wochenplan pdf"],
      ["planningNavButton"],
      { view: "planning", focusId: "pdfButton" },
    ),
    entry(
      "planning.xoffi-import",
      "xoffi-Zeitdaten importieren",
      ["Filialverwaltung", "Dienstplanung", "xoffi-Import"],
      "Navigiert zum freigegebenen Screenshotimport für vergangene xoffi-Wochen.",
      ["xoffi", "screenshot import", "ocr", "istzeit", "stundenkonto", "zeiterfassung import", "zeitbild"],
      ["planningNavButton", "xoffiImportButton"],
      { view: "planning", focusId: "xoffiImportButton" },
    ),
    entry(
      "planning.hours",
      "Wochenstunden anzeigen",
      ["Filialverwaltung", "Dienstplanung", "Stundenübersicht"],
      "Springt zur Übersicht der eingeteilten und gewerteten Wochenstunden.",
      ["stunden", "wochenstunden", "sollzeit", "istzeit", "gewertete zeit", "stundenvergleich", "arbeitszeit"],
      ["planningNavButton"],
      { view: "planning", focusId: "hoursOverview" },
    ),

    entry(
      "vacation.overview",
      "Urlaubsplanung öffnen",
      ["Filialverwaltung", "Urlaubsplanung"],
      "Öffnet die zuletzt verwendete Urlaubsansicht mit Kalender und Jahresauswahl.",
      ["urlaub", "urlaubsplan", "urlaubskalender", "ferien", "abwesenheitskalender", "jahresübersicht", "quartal"],
      ["vacationsNavButton"],
      { view: "vacations", focusId: "vacationCalendar" },
    ),
    entry(
      "vacation.balance",
      "Resturlaub anzeigen",
      ["Filialverwaltung", "Urlaubsplanung", "Resturlaub"],
      "Springt zu Jahresanspruch, verplanten Urlaubstagen und verbleibendem Resturlaub.",
      ["resturlaub", "urlaubsguthaben", "urlaubsanspruch", "urlaubskonto", "resttage", "jahresurlaub"],
      ["vacationsNavButton"],
      { view: "vacations", focusId: "vacationSummary" },
    ),
    entry(
      "vacation.approved-entry",
      "Genehmigten Urlaub eintragen",
      ["Filialverwaltung", "Urlaubsplanung", "Urlaub eintragen"],
      "Navigiert zur berechtigten Direkteingabe eines bereits genehmigten Urlaubs, ohne einen Eintrag anzulegen.",
      ["urlaub eintragen", "genehmigter urlaub", "abwesenheit anlegen", "urlaubstag", "direkteintrag", "urlaub erfassen"],
      ["vacationsNavButton", "addVacationButton"],
      { view: "vacations", focusId: "addVacationButton" },
    ),
    entry(
      "vacation.request-blackouts",
      "Antragssperren verwalten",
      ["Filialverwaltung", "Urlaubsplanung", "Antragssperren"],
      "Öffnet die Sperrzeiträume für neue Urlaubs- und Zeitausgleichseinträge.",
      ["urlaubssperre", "za sperre", "zeitausgleich sperren", "antragssperre", "sperrzeitraum", "keine urlaube", "mindestbesetzung", "antragssperre anlegen", "urlaubssperre erstellen"],
      ["vacationsNavButton", "requestBlackoutPanel"],
      { view: "vacations", revealIds: ["requestBlackoutPanel"], focusId: "requestBlackoutPanel" },
    ),
    entry(
      "vacation.pdf",
      "Urlaubsplanung als PDF exportieren",
      ["Filialverwaltung", "Urlaubsplanung", "PDF"],
      "Navigiert zum PDF-Export der aktuellen Urlaubsansicht, ohne einen Download zu starten.",
      ["urlaubs pdf", "urlaub drucken", "urlaubskalender export", "druckansicht", "ferienplan pdf", "download"],
      ["vacationsNavButton"],
      { view: "vacations", focusId: "vacationPdfButton" },
    ),

    entry(
      "requests.overview",
      "Anträge und Fälle öffnen",
      ["Personalverwaltung", "Anträge"],
      "Öffnet die freigegebene Bearbeitungsübersicht für Anträge und Fälle.",
      ["anträge", "freigaben", "fälle", "genehmigungen", "offene anträge", "entscheidungen"],
      ["requestsNavButton"],
      { view: "requests", focusId: "managerVacationRequestList" },
    ),
    entry(
      "requests.vacation",
      "Urlaubsanträge anzeigen",
      ["Personalverwaltung", "Anträge", "Urlaub"],
      "Öffnet die freigegebene Liste der Urlaubsanträge.",
      ["urlaubsantrag", "urlaub genehmigen", "urlaub ablehnen", "ferienantrag", "urlaubsfreigabe", "urlaub prüfen"],
      ["requestsNavButton", "requestVacationTab"],
      { view: "requests", requestKind: "vacation", focusId: "managerVacationRequestList" },
    ),
    entry(
      "requests.time-off",
      "Zeitausgleichsanträge anzeigen",
      ["Personalverwaltung", "Anträge", "Zeitausgleich"],
      "Öffnet die freigegebene Liste der Zeitausgleichsanträge.",
      ["za", "zeitausgleich", "zeitausgleichsantrag", "stunden abbauen", "freizeitausgleich", "za genehmigen"],
      ["requestsNavButton", "requestTimeOffTab"],
      { view: "requests", requestKind: "time_off", focusId: "managerVacationRequestList" },
    ),
    entry(
      "requests.amu",
      "Krankmeldungen und AUM-Fälle anzeigen",
      ["Personalverwaltung", "Anträge", "Krank & AUM"],
      "Öffnet die freigegebene Fallliste für Krankmeldungen und Arbeitsunfähigkeitsmeldungen.",
      ["aum", "krankmeldung", "krankenstand", "arbeitsunfähigkeit", "attest", "gesundmeldung", "krankenstandsfall"],
      ["requestsNavButton", "requestAmuTab"],
      { view: "requests", requestKind: "amu", focusId: "managerVacationRequestList" },
    ),

    entry(
      "time.live-presence",
      "Live-Anwesenheit anzeigen",
      ["Personalverwaltung", "Zeiterfassung", "Live-Anwesenheit"],
      "Öffnet den aktuellen Anwesenheitsstatus der freigegebenen Teams.",
      ["anwesenheit", "live status", "kommen", "gehen", "pause", "eingestempelt", "teamstatus"],
      ["timeTrackingNavButton"],
      { view: "timeTracking", focusId: "timePresenceSummary" },
    ),
    entry(
      "time.day-review",
      "Arbeitszeit-Tagesprüfung öffnen",
      ["Personalverwaltung", "Zeiterfassung", "Tagesprüfung"],
      "Springt zur fachlichen Prüfung von Plan, Arbeitszeit, Pausen und Samstagswertung.",
      ["tagesprüfung", "zeit prüfen", "arbeitszeit kontrollieren", "istzeit", "planzeit", "auffällige buchungen", "tagesabschluss"],
      ["timeTrackingNavButton"],
      { view: "timeTracking", focusId: "timeDayReviewPanel" },
    ),
    entry(
      "time.period-summary",
      "Arbeitszeitübersicht auswerten",
      ["Personalverwaltung", "Zeiterfassung", "Arbeitszeitübersicht"],
      "Springt zur Soll-/Ist-Auswertung für einen frei wählbaren Zeitraum.",
      ["zeitauswertung", "stundenübersicht", "soll ist", "zeitraum", "arbeitsstunden", "stundenkonto", "abweichung"],
      ["timeTrackingNavButton"],
      { view: "timeTracking", focusId: "timeSummaryList" },
    ),
    entry(
      "time.corrections",
      "Zeitkorrekturen anzeigen",
      ["Personalverwaltung", "Zeiterfassung", "Zeitkorrekturen"],
      "Springt zur freigegebenen Liste offener und bearbeitbarer Zeitkorrekturen.",
      ["zeitkorrektur", "buchung korrigieren", "falsche zeit", "stempelkorrektur", "korrekturantrag", "arbeitszeit ändern"],
      ["timeTrackingNavButton"],
      { view: "timeTracking", focusId: "timeCorrectionPanel" },
    ),
    entry(
      "time.monthly-records",
      "Monatsnachweise öffnen",
      ["Personalverwaltung", "Zeiterfassung", "Monatsnachweise"],
      "Navigiert zur berechtigten Monatsnachweis-Funktion, ohne einen Nachweis zu erzeugen.",
      ["monatsnachweis", "monatsabschluss", "zeitnachweis", "arbeitszeitnachweis", "stundenzettel", "monat prüfen"],
      ["timeTrackingNavButton", "monthlyTimeRecordsButton"],
      { view: "timeTracking", focusId: "monthlyTimeRecordsButton" },
    ),

    entry(
      "personnel.overview",
      "Personalverwaltung öffnen",
      ["Personalverwaltung", "Übersicht"],
      "Öffnet die Übersicht der für den Zugang freigegebenen Personalbereiche.",
      ["personal", "hr", "personalübersicht", "personal dashboard", "mitarbeiterverwaltung", "personalbereiche"],
      ["personnelDashboardNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "dashboard", focusId: "personnelDashboardSection" },
    ),
    entry(
      "personnel.directory",
      "Mitarbeitende verwalten",
      ["Personalverwaltung", "Mitarbeitende"],
      "Öffnet das zentrale Mitarbeiterverzeichnis und die freigegebenen Personalprofile.",
      ["mitarbeiter", "mitarbeitende", "personalstamm", "personalakte", "personalnummer", "teammitglied", "stammdaten"],
      ["personnelDirectoryNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "employees", focusId: "personnelDirectorySection" },
    ),
    entry(
      "personnel.applications",
      "Bewerbungen und Preboarding öffnen",
      ["Personalverwaltung", "Bewerbungen & Preboarding"],
      "Öffnet die freigegebene Bewerbungs- und Preboarding-Übersicht.",
      ["bewerbung", "bewerber", "kandidat", "preboarding", "einstellung", "neue mitarbeiter", "recruiting"],
      ["candidatePreboardingNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "applications", focusId: "candidatePreboardingSection" },
    ),
    entry(
      "personnel.workflows",
      "Workflow-Center öffnen",
      ["Personalverwaltung", "Workflow-Center"],
      "Öffnet die freigegebenen Personalprozesse und laufenden Workflow-Instanzen.",
      ["workflow", "prozess", "onboarding", "offboarding", "personalablauf", "workflow instanz", "lebenszyklus"],
      ["workflowCenterNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "workflows", focusId: "workflowCenterSection" },
    ),
    entry(
      "personnel.learning",
      "Schulung & Wissen öffnen",
      ["Personalverwaltung", "Schulung & Wissen", "Schulungsdashboard & Fähigkeitsbaum"],
      "Öffnet das transparente Schulungsdashboard und den berechtigten Katalog für versionierte Lernprozesse.",
      ["schulung", "wissen", "einschulung", "training", "lernprozess", "wissenskontrolle", "prozessvorlage", "lernziel", "schulungsablauf", "fortbildung", "qualifizierung", "onboarding wissen", "schulungsdashboard", "fähigkeitsbaum", "skill tree", "lernfortschritt", "kompetenzübersicht", "trainerübersicht"],
      ["personnelLearningNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "learning", focusId: "personnelLearningDashboardPanel" },
    ),
    entry(
      "personnel.learning-skills",
      "Fähigkeitskatalog öffnen",
      ["Personalverwaltung", "Schulung & Wissen", "Fähigkeitskatalog"],
      "Springt zu den versionierten Fähigkeiten mit vollständig definierten Stufen 1 bis 10.",
      ["fähigkeit", "fähigkeiten", "kompetenz", "kompetenzen", "skill", "skills", "fähigkeitsstufe", "kompetenzstufe", "stufe 1 bis 10", "level", "qualifikation", "fachwissen", "trainerfähigkeit", "drohne praxis"],
      ["personnelLearningNavButton", "personnelLearningSkillsPanel"],
      { view: "personnelAdministration", personnelAdministrationTab: "learning", focusId: "personnelLearningSkillsPanel" },
    ),
    entry(
      "personnel.learning-competencies",
      "Kompetenzprofile und Trainerfreigaben öffnen",
      ["Personalverwaltung", "Schulung & Wissen", "Kompetenzprofile & Trainerfreigaben"],
      "Springt zu den revisionsgebundenen Fähigkeitsstufen und fachbezogenen Trainerfreigaben der sichtbaren Mitarbeiter.",
      ["kompetenzprofil", "mitarbeiter kompetenz", "mitarbeiter fähigkeit", "trainer", "trainerfreigabe", "einschulen dürfen", "schulungsfähigkeit", "fähigkeitsprofil", "qualifikationsprofil", "skill profil", "kompetenzstufe mitarbeiter", "tradefoto trainer", "kassasystem trainer", "drohnen trainer", "fineart druck", "analogfilm spezialist", "systemkamera video"],
      ["personnelLearningNavButton", "personnelLearningCompetenciesPanel"],
      { view: "personnelAdministration", personnelAdministrationTab: "learning", focusId: "personnelLearningCompetenciesPanel" },
    ),
    entry(
      "personnel.learning-assignments",
      "Schulungszuweisungen und Fortschritt öffnen",
      ["Personalverwaltung", "Schulung & Wissen", "Schulungen zuordnen & durchführen"],
      "Springt zu revisionsgebundenen Schulungszuweisungen, Schrittfortschritt, Abschlussbewertungen und begründeten Korrekturen.",
      ["schulung zuweisen", "schulungszuweisung", "lernende zuordnen", "trainer zuordnen", "trainer auswählen", "filialübergreifende schulung", "einschulung zuteilen", "wissenskontrolle zuteilen", "training starten", "schulungsprozess starten", "trainerfähigkeit verbinden", "mentoring", "mentor zuweisen", "schulungsfortschritt", "fortschritt eintragen", "schritte erledigt", "schulung abschließen", "abschluss bewerten", "alles erfüllt", "nachschulung", "nicht bestanden", "bewertung korrigieren", "korrekturrevision"],
      ["personnelLearningNavButton", "personnelLearningAssignmentsPanel"],
      { view: "personnelAdministration", personnelAdministrationTab: "learning", focusId: "personnelLearningAssignmentsPanel" },
    ),
    entry(
      "personnel.lifecycle-editor",
      "Grafischen Personalprozess-Editor öffnen",
      ["Personalverwaltung", "Workflow-Center", "Grafischer Editor"],
      "Springt zum freigegebenen grafischen Editor für Personalprozesse, ohne einen Entwurf zu ändern.",
      ["grafischer editor", "prozesseditor", "workflow editor", "ablauf zeichnen", "schritte", "onboarding editor", "offboarding editor"],
      ["workflowCenterNavButton", "personnelLifecycleEditorSection"],
      { view: "personnelAdministration", personnelAdministrationTab: "workflows", focusId: "personnelLifecycleEditorSection" },
    ),
    entry(
      "personnel.lifecycle-interfaces",
      "Personalprozess-Schnittstellen anzeigen",
      ["Personalverwaltung", "Workflow-Center", "Schnittstellen"],
      "Springt zum freigegebenen Schnittstellenkatalog der Personalprozesse.",
      ["schnittstelle", "interface", "integration", "personalprozess api", "datenübergabe", "lifecycle interface"],
      ["workflowCenterNavButton", "personnelLifecycleInterfacesSection"],
      { view: "personnelAdministration", personnelAdministrationTab: "workflows", focusId: "personnelLifecycleInterfacesSection" },
    ),
    entry(
      "personnel.lifecycle-automation",
      "Personalprozess-Automationen anzeigen",
      ["Personalverwaltung", "Workflow-Center", "Automationen"],
      "Springt zum freigegebenen Automationskatalog der Personalprozesse.",
      ["automation", "automatisierung", "workflow automation", "ereignis", "trigger", "personalprozess automatisch"],
      ["workflowCenterNavButton", "personnelLifecycleAutomationSection"],
      { view: "personnelAdministration", personnelAdministrationTab: "workflows", focusId: "personnelLifecycleAutomationSection" },
    ),
    entry(
      "personnel.tasks",
      "Personalaufgaben öffnen",
      ["Personalverwaltung", "Personalaufgaben"],
      "Öffnet die freigegebene Aufgabenliste aus Personalprozessen.",
      ["aufgaben", "personalaufgabe", "to do", "todo", "fälligkeit", "onboarding aufgabe", "offboarding aufgabe"],
      ["personnelTasksNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "tasks", focusId: "personnelTasksSection" },
    ),
    entry(
      "personnel.cost-centers",
      "Kostenstellen verwalten",
      ["Personalverwaltung", "Kostenstellen"],
      "Öffnet Kostenstellen, Kostenstellentypen und deren Zuordnungen.",
      ["kostenstelle", "kostenstellentyp", "cost center", "buchhaltung", "zuordnung", "filialkostenstelle"],
      ["costCentersNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "costCenters", focusId: "costCenterSection" },
    ),
    entry(
      "personnel.work-rules",
      "Personal-Regelwerk verwalten",
      ["Personalverwaltung", "Regelwerk"],
      "Öffnet die freigegebene Governance für eigene Arbeitszeit- und Planungsregeln.",
      ["regelwerk", "arbeitszeitregel", "planungsregel", "regelprofil", "governance", "ruhezeit", "arbeitsrecht"],
      ["customWorkRulesNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "ruleDrafts", focusId: "customWorkRulesSection" },
    ),
    entry(
      "personnel.collective-agreements",
      "Kollektivverträge anzeigen",
      ["Personalverwaltung", "Kollektivverträge"],
      "Öffnet das freigegebene Register für Kollektivverträge und Geltungszuordnungen.",
      ["kollektivvertrag", "kv", "tarifvertrag", "arbeitsrecht", "geltung", "vertrag", "regelquelle"],
      ["collectiveAgreementsNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "collectiveAgreements", focusId: "collectiveAgreementsSection" },
    ),
    entry(
      "personnel.central-vacations",
      "Unternehmensweite Urlaube anzeigen",
      ["Personalverwaltung", "Urlaube im Unternehmen"],
      "Öffnet die bereichsbezogene zentrale Urlaubsübersicht.",
      ["zentrale urlaube", "unternehmen urlaub", "standortübergreifend", "urlaubsübersicht", "abwesenheiten", "alle filialen"],
      ["centralVacationsNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "vacations", focusId: "centralVacationSection" },
    ),
    entry(
      "personnel.vacation-accounts",
      "Urlaubskonten öffnen",
      ["Personalverwaltung", "Urlaube im Unternehmen", "Urlaubskonten"],
      "Navigiert zur berechtigten Übersicht der Urlaubskonten, ohne Daten zu verändern.",
      ["urlaubskonto", "urlaubsanspruch", "resturlaub", "urlaubsguthaben", "jahresurlaub", "konten"],
      ["centralVacationsNavButton", "vacationAccountsButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "vacations", focusId: "vacationAccountsButton" },
    ),
    entry(
      "personnel.data-requests",
      "Datenschutzanfragen anzeigen",
      ["Personalverwaltung", "Datenanfragen"],
      "Öffnet die freigegebene Bearbeitung von Auskunfts- und Betroffenenanfragen.",
      ["datenanfrage", "datenauskunft", "betroffenenrecht", "dsgvo anfrage", "auskunftsersuchen", "löschanfrage", "privacy request"],
      ["dataSubjectRequestsNavButton"],
      { view: "personnelAdministration", personnelAdministrationTab: "dataRequests", focusId: "dataSubjectRequestsSection" },
    ),

    entry(
      "sales.overview",
      "Verkaufsverwaltung öffnen",
      ["Verkaufsverwaltung", "Übersicht"],
      "Öffnet den fest integrierten, berechtigungsgeschützten Verkaufsbereich.",
      ["verkauf", "umsatz", "sales", "verkaufsübersicht", "berichte", "kennzahlen", "warenwirtschaft"],
      ["salesDashboardNavButton"],
      { view: "salesAdministration", focusId: "salesDashboardGrid" },
    ),
    entry(
      "sales.analytics",
      "Verkaufsanalysen öffnen",
      ["Verkaufsverwaltung", "Verkaufsanalysen"],
      "Öffnet den geschützten Desktop-Arbeitsbereich für Verkaufsberichte und Kennzahlen.",
      ["verkaufsanalyse", "umsatzanalyse", "statistik", "kennzahlen", "tradefoto", "warengruppen", "sales analytics"],
      ["salesAnalyticsNavButton"],
      { view: "salesAnalytics", focusId: "salesAnalyticsView" },
    ),
    entry(
      "sales.report-import",
      "TradeFoto-Bericht importieren",
      ["Verkaufsverwaltung", "Verkaufsanalysen", "PDF-Berichtsimport"],
      "Navigiert zum berechtigten TradeFoto-PDF-Import, ohne eine Datei auszuwählen oder zu übernehmen.",
      ["tradefoto import", "pdf import", "warengruppenvergleich", "statistikbericht", "ocr bericht", "umsatzbericht einlesen"],
      ["salesAnalyticsNavButton", "salesReportImportPanel"],
      { view: "salesAnalytics", focusId: "salesReportImportPanel" },
    ),
    entry(
      "sales.report-archive",
      "Verkaufsberichtsarchiv anzeigen",
      ["Verkaufsverwaltung", "Verkaufsanalysen", "Berichtsarchiv"],
      "Springt zum Archiv der importierten Verkaufsberichte und Zeiträume.",
      ["berichtsarchiv", "pdf archiv", "verkaufsberichte", "zeiträume", "historie", "tradefoto berichte", "statistikarchiv"],
      ["salesAnalyticsNavButton"],
      { view: "salesAnalytics", focusId: "salesReportArchive" },
    ),
    entry(
      "sales.report-details",
      "Warengruppen im Detail anzeigen",
      ["Verkaufsverwaltung", "Verkaufsanalysen", "Warengruppen"],
      "Springt zur detaillierten Tabelle der freigegebenen Verkaufskennzahlen.",
      ["warengruppe", "umsatz netto", "menge", "kunden", "vergleich", "detailtabelle", "verkaufszahlen"],
      ["salesAnalyticsNavButton"],
      { view: "salesAnalytics", focusId: "salesAnalyticsTableTitle" },
    ),

    entry(
      "dashboards.locations",
      "Filialübersicht-Dashboard öffnen",
      ["Dashboards", "Filialübersicht"],
      "Öffnet das berechtigte Dashboard zur aktuellen Situation der Filialen.",
      ["dashboard", "filialstatus", "standortübersicht", "abwesenheiten", "filialkarten", "heute", "location dashboard"],
      ["rightsDashboardNavButton", "rightsLocationsDashboardTab"],
      { view: "rightsDashboard", dashboardMode: "locations", focusId: "rightsDashboardLocationsPanel" },
    ),
    entry(
      "dashboards.rights",
      "Rechteübersicht-Dashboard öffnen",
      ["Dashboards", "Rechteübersicht"],
      "Öffnet die berechtigte Lesesicht auf Rollen, Bereiche und wirksame Rechte.",
      ["rechte dashboard", "berechtigungen", "rollen", "zugriff", "rechteherkunft", "permissions", "rechteübersicht"],
      ["rightsDashboardNavButton", "rightsPermissionsDashboardTab"],
      { view: "rightsDashboard", dashboardMode: "rights", focusId: "rightsDashboardRightsPanel" },
    ),
    entry(
      "dashboards.personnel-rules",
      "Personal-Regelwerk-Dashboard öffnen",
      ["Dashboards", "Personal-Regelwerk"],
      "Öffnet die bereichsbezogene Lesesicht und Planvorschau des Personal-Regelwerks.",
      ["regel dashboard", "arbeitszeitregeln", "planvorschau", "regelprofile", "geltung", "personalregeln", "simulation"],
      ["rightsDashboardNavButton", "personnelRulesDashboardTab"],
      { view: "rightsDashboard", dashboardMode: "personnelRules", focusId: "personnelRulesDashboardPanel" },
    ),
    entry(
      "dashboards.processes",
      "Abläufe und Prozesse öffnen",
      ["Dashboards", "Abläufe & Prozesse"],
      "Öffnet die berechtigte Prozessbibliothek und ihre unverändernde Simulation.",
      ["ablauf", "prozess", "prozessbibliothek", "zuständigkeit", "workflow", "simulation", "betriebsablauf"],
      ["rightsDashboardNavButton", "rightsProcessesDashboardTab"],
      { view: "rightsDashboard", dashboardMode: "processes", focusId: "rightsDashboardProcessesPanel" },
    ),
    entry(
      "dashboards.system-center",
      "System-Center öffnen",
      ["Dashboards", "System-Center"],
      "Öffnet die berechtigte technische Systemübersicht.",
      ["systemcenter", "systemstatus", "server", "diagnose", "technik", "betrieb", "health"],
      ["rightsDashboardNavButton", "systemCenterDashboardTab"],
      { view: "rightsDashboard", dashboardMode: "systemCenter", focusId: "systemCenterPanel" },
    ),

    entry(
      "settings.view-behavior",
      "Ansicht und Startverhalten einstellen",
      ["Einstellungen", "Grundeinstellungen", "Ansicht & Startverhalten"],
      "Öffnet die berechtigten Einstellungen für Wiedereinstieg, Sonntag, Schriftgröße und Hinweisdauer.",
      ["startansicht", "letzte ansicht", "schriftgröße", "zoom", "sonntag", "warnmeldungen", "darstellung", "startverhalten"],
      ["settingsGeneralTab", "viewBehaviorSettingsCard"],
      { view: "settings", settingsTab: "general", focusId: "viewBehaviorSettingsCard" },
    ),
    entry(
      "settings.schedule-lock",
      "Dienstplan-Bearbeitungssperre einstellen",
      ["Einstellungen", "Dienstplan", "Bearbeitungssperre"],
      "Öffnet die berechtigten Sperreinstellungen für aktuelle und vergangene Dienstpläne.",
      ["wochensperre", "dienstplan sperren", "vergangene woche", "kw sperre", "bearbeitungssperre", "sperrzeitpunkt", "plan lock"],
      ["settingsScheduleTab", "scheduleLockSettingsCard"],
      { view: "settings", settingsTab: "schedule", focusId: "scheduleLockSettingsCard" },
    ),
    entry(
      "settings.cross-location-schedule",
      "Standortübergreifende Dienstplanung einstellen",
      ["Einstellungen", "Dienstplan", "Standortübergreifende Dienstplanung"],
      "Öffnet Anzeigezeitraum sowie Anfrage- und Entscheidungsrechte für temporäre Filialeinsätze.",
      ["fremder dienstplan", "fremde filiale", "mitarbeiter anfragen", "ma anfrage", "temporärer filialeinsatz", "filialübergreifend", "aushelfen", "anzeigezeitraum", "al recht", "fl recht"],
      ["settingsScheduleTab", "crossLocationScheduleSettingsCard"],
      { view: "settings", settingsTab: "schedule", focusId: "crossLocationScheduleSettingsCard" },
    ),
    entry(
      "settings.staff-assignment-notifications",
      "E-Mails für Einsatzanfragen einstellen",
      ["Einstellungen", "Dienstplan", "E-Mail-Benachrichtigungen"],
      "Öffnet die E-Mail-Schalter für neue, genehmigte und abgelehnte Einsatzanfragen.",
      ["email einsatzanfrage", "benachrichtigung aushelfen", "mail genehmigung", "mail ablehnung", "anfrage eingang", "entscheidungsmail"],
      ["settingsScheduleTab", "staffAssignmentNotificationSettingsCard"],
      { view: "settings", settingsTab: "schedule", focusId: "staffAssignmentNotificationSettingsCard" },
    ),
    entry(
      "settings.staff-assignment-change-rules",
      "Änderungs- und Stornierungsregeln für Einsätze einstellen",
      ["Einstellungen", "Dienstplan", "Änderung & Stornierung"],
      "Öffnet die revisionssicheren Regeln für eingereichte Anfragen und bestätigte temporäre Filialeinsätze.",
      ["anfrage ändern", "anfrage zurückziehen", "einsatz stornieren", "storno", "neu einreichen", "bestätigten einsatz absagen", "änderungsregel"],
      ["settingsScheduleTab", "staffAssignmentChangeSettingsCard"],
      { view: "settings", settingsTab: "schedule", focusId: "staffAssignmentChangeSettingsCard" },
    ),
    entry(
      "settings.loans",
      "Leiheinstellungen öffnen",
      ["Einstellungen", "Grundeinstellungen", "Leihe"],
      "Öffnet die berechtigten Standort-Einstellungen für Geräte- und Warenleihen.",
      ["leiheinstellungen", "artikelquelle", "leihbeleg", "foto pdf", "warenleihe", "ausgabe", "rückgabe"],
      ["settingsGeneralTab", "loanSettingsCard"],
      { view: "settings", settingsTab: "general", revealIds: ["loanSettingsCard"], focusId: "loanSettingsCard" },
    ),
    entry(
      "settings.branding",
      "Branding verwalten",
      ["Einstellungen", "Grundeinstellungen", "Branding"],
      "Öffnet die berechtigten Einstellungen für Firmenname, Logo, Webicon und Standort-Brandings.",
      ["logo", "firmenname", "branding", "favicon", "webicon", "erscheinungsbild", "branding kit", "design"],
      ["settingsGeneralTab", "brandingSettings"],
      { view: "settings", settingsTab: "general", revealIds: ["brandingSettings"], focusId: "brandingSettings" },
    ),
    entry(
      "settings.pdf",
      "PDF-Ausgabe konfigurieren",
      ["Einstellungen", "Grundeinstellungen", "PDF-Ausgabe"],
      "Öffnet Titel, Dateinamen und Vorschau für Dienstplan- und Urlaubs-PDFs.",
      ["pdf einstellungen", "pdf titel", "dateiname", "druckausgabe", "pdf vorschau", "urlaubs pdf", "dienstplan pdf"],
      ["settingsGeneralTab", "pdfSettings"],
      { view: "settings", settingsTab: "general", revealIds: ["pdfSettings"], focusId: "pdfSettings" },
    ),
    entry(
      "settings.positions",
      "Positionen verwalten",
      ["Einstellungen", "Personal", "Positionen"],
      "Öffnet die berechtigte Verwaltung eigener Mitarbeiterpositionen.",
      ["position", "jobtitel", "stelle", "personalposition", "rollenbezeichnung", "tätigkeit"],
      ["settingsPersonnelTab", "positionSettingsCard"],
      { view: "settings", settingsTab: "personnel", focusId: "positionSettingsCard" },
    ),
    entry(
      "settings.personnel-view",
      "Filialteam-Ansicht konfigurieren",
      ["Einstellungen", "Personal", "Filialteam-Ansicht"],
      "Öffnet die berechtigten Anzeigeoptionen für inaktive Personen und Samstagsstatistik.",
      ["teamansicht", "inaktive mitarbeiter", "samstagsstatistik", "anzeigespalten", "personalansicht", "filialteam"],
      ["settingsPersonnelTab", "personnelViewSettingsCard"],
      { view: "settings", settingsTab: "personnel", focusId: "personnelViewSettingsCard" },
    ),
    entry(
      "settings.trust-levels",
      "Vertrauensstufen verwalten",
      ["Einstellungen", "Personal", "Vertrauensstufen"],
      "Öffnet die berechtigten Stufen A bis C und deren Bestätigungsrhythmen.",
      ["vertrauensstufe", "stufe a", "stufe b", "stufe c", "bestätigungsrhythmus", "wifi bestätigung", "kontrollstufe"],
      ["settingsPersonnelTab", "trustLevelSettingsCard"],
      { view: "settings", settingsTab: "personnel", focusId: "trustLevelSettingsCard" },
    ),
    entry(
      "settings.vacation-workflow",
      "Urlaubs-Freigabeworkflow einstellen",
      ["Einstellungen", "Urlaub", "Freigabeworkflow"],
      "Öffnet die berechtigte Einstellung zur zusätzlichen Genehmigung durch die Personalleitung.",
      ["urlaubsworkflow", "urlaub genehmigung", "personalleitung", "freigabe", "hr approval", "zweite genehmigung"],
      ["settingsVacationTab", "workflowSettingsCard"],
      { view: "settings", settingsTab: "vacation", focusId: "workflowSettingsCard" },
    ),
    entry(
      "settings.vacation-delegation",
      "Vertretung der Filialleitung verwalten",
      ["Einstellungen", "Urlaub", "Vertretung"],
      "Öffnet die berechtigten Vertretungszeiträume für die Antragsbearbeitung.",
      ["vertretung", "stellvertretung", "filialleitung abwesend", "delegation", "abteilungsleitung", "vertretungszeitraum"],
      ["settingsVacationTab", "delegationSettingsCard"],
      { view: "settings", settingsTab: "vacation", focusId: "delegationSettingsCard" },
    ),
    entry(
      "settings.break-rule",
      "Pausenregel einstellen",
      ["Einstellungen", "Zeiterfassung", "Pausenregel"],
      "Öffnet die berechtigte automatische Pausenregel für geplante Arbeitszeiten.",
      ["pause", "pausenabzug", "pausendauer", "arbeitszeitpause", "break rule", "nach stunden", "automatische pause"],
      ["settingsTimeTrackingTab", "breakRuleEnabled"],
      { view: "settings", settingsTab: "timeTracking", focusId: "breakRuleEnabled" },
    ),
    entry(
      "settings.saturday-bonus",
      "Samstagswertung einstellen",
      ["Einstellungen", "Zeiterfassung", "Samstagswertung"],
      "Öffnet Faktor und Startzeit der Samstagswertung.",
      ["samstagsfaktor", "samstagswertung", "samstag zuschlag", "faktor 1,5", "gewichtete zeit", "saturday bonus"],
      ["settingsTimeTrackingTab", "saturdayBonusEnabled"],
      { view: "settings", settingsTab: "timeTracking", focusId: "saturdayBonusEnabled" },
    ),
    entry(
      "settings.wifi",
      "WLAN-Zeitvorschläge verwalten",
      ["Einstellungen", "Zeiterfassung", "WLAN-Zeitvorschläge"],
      "Öffnet die berechtigten WLAN-Zuordnungen und Automationsregeln der Zeiterfassung.",
      ["wlan", "wifi", "zeitvorschlag", "controller", "automatische zeiterfassung", "netzwerk", "kommen gehen vorschlag"],
      ["settingsTimeTrackingTab", "wifiSettingsCard"],
      { view: "settings", settingsTab: "timeTracking", focusId: "wifiSettingsCard" },
    ),
    entry(
      "settings.integration-connections",
      "Direkte Verbindungen verwalten",
      ["Einstellungen", "Import & Lohnverrechnung", "Direkte Verbindungen"],
      "Öffnet die berechtigte Verwaltung geschützter SQL-Quellen und HTTPS-Ziele.",
      ["verbindung", "sql", "api", "https ziel", "integration", "datenquelle", "credentials", "schnittstelle"],
      ["settingsIntegrationsTab", "integrationConnectionsCard"],
      { view: "settings", settingsTab: "integrations", focusId: "integrationConnectionsCard" },
    ),
    entry(
      "settings.integration-contracts",
      "Schnittstellenverträge anzeigen",
      ["Einstellungen", "Import & Lohnverrechnung", "Schnittstellenverträge"],
      "Öffnet die freigegebenen technischen Verträge und Versionen der Datenwege.",
      ["schnittstellenvertrag", "api vertrag", "datenvertrag", "contract", "version", "sql view", "integration dokumentation"],
      ["settingsIntegrationsTab", "integrationContractsCard"],
      { view: "settings", settingsTab: "integrations", focusId: "integrationContractsCard" },
    ),
    entry(
      "settings.personnel-import",
      "Personalstammdaten importieren",
      ["Einstellungen", "Import & Lohnverrechnung", "Personalimport"],
      "Navigiert zum berechtigten Importassistenten für Datei oder SQL-View, ohne einen Import zu starten.",
      ["personalimport", "mitarbeiter import", "stammdaten import", "csv", "excel", "sql view", "feldzuordnung", "importassistent"],
      ["settingsIntegrationsTab", "employeeImportCard"],
      { view: "settings", settingsTab: "integrations", focusId: "employeeImportCard" },
    ),
    entry(
      "settings.import-profiles",
      "Importprofile anzeigen",
      ["Einstellungen", "Import & Lohnverrechnung", "Importprofile"],
      "Öffnet gespeicherte Spaltenzuordnungen für wiederkehrende Personalimporte.",
      ["importprofil", "spaltenzuordnung", "mapping", "feldzuordnung", "csv profil", "wiederkehrender import"],
      ["settingsIntegrationsTab", "importProfileCard"],
      { view: "settings", settingsTab: "integrations", focusId: "importProfileCard" },
    ),
    entry(
      "settings.payroll-export",
      "Lohnverrechnung vorbereiten",
      ["Einstellungen", "Import & Lohnverrechnung", "Lohnexport"],
      "Öffnet den berechtigten Export für geprüfte Ist-Zeiten oder Planwerte.",
      ["lohnverrechnung", "lohnexport", "payroll", "tagesjournal", "lohnarten", "csv export", "excel export", "gehaltsabrechnung", "lohnverrechnung export"],
      ["settingsIntegrationsTab", "payrollExportCard"],
      { view: "settings", settingsTab: "integrations", focusId: "payrollExportCard" },
    ),
    entry(
      "settings.payroll-handoffs",
      "Monatsübergaben anzeigen",
      ["Einstellungen", "Import & Lohnverrechnung", "Monatsübergaben"],
      "Öffnet revisionssichere Monatsübergaben und externe Protokolle.",
      ["monatsübergabe", "lohnübergabe", "elda", "protokoll", "revision", "monat abschließen", "payroll handoff"],
      ["settingsIntegrationsTab", "payrollHandoffCard"],
      { view: "settings", settingsTab: "integrations", focusId: "payrollHandoffCard" },
    ),
    entry(
      "settings.export-profiles",
      "Exportprofile anzeigen",
      ["Einstellungen", "Import & Lohnverrechnung", "Exportprofile"],
      "Öffnet gespeicherte Feld- und Formatzuordnungen für Exporte.",
      ["exportprofil", "lohnprofil", "spaltenprofil", "dateiformat", "feldzuordnung", "payroll profil"],
      ["settingsIntegrationsTab", "exportProfileCard"],
      { view: "settings", settingsTab: "integrations", focusId: "exportProfileCard" },
    ),
    entry(
      "settings.integration-information",
      "Integrationshinweise anzeigen",
      ["Einstellungen", "Import & Lohnverrechnung", "Information"],
      "Öffnet die technischen Hinweise und Grenzen der Integrationsfunktionen.",
      ["integrationsinfo", "import hilfe", "schnittstellen info", "technische hinweise", "datenwege", "dokumentation"],
      ["settingsIntegrationsTab", "integrationInformationCard"],
      { view: "settings", settingsTab: "integrations", focusId: "integrationInformationCard" },
    ),
    entry(
      "settings.integration-history",
      "Import- und Exporthistorie anzeigen",
      ["Einstellungen", "Import & Lohnverrechnung", "Historie"],
      "Öffnet die freigegebenen Nachweise bisheriger Import- und Exportläufe.",
      ["historie", "importverlauf", "exportverlauf", "protokoll", "übertragung", "audit", "lieferverlauf"],
      ["settingsIntegrationsTab", "integrationHistoryCard"],
      { view: "settings", settingsTab: "integrations", focusId: "integrationHistoryCard" },
    ),
    entry(
      "settings.amu",
      "AUM-Einstellungen öffnen",
      ["Einstellungen", "Zugänge", "AUM-Dateien"],
      "Öffnet die berechtigten Regeln für AUM-Dateien, Fristen und Zuständigkeiten.",
      ["aum einstellungen", "krankenstand", "arbeitsunfähigkeitsmeldung", "attest upload", "ocr", "krankmeldung frist", "aum zugriff"],
      ["settingsAccessTab", "amuSettingsCard"],
      { view: "settings", settingsTab: "access", focusId: "amuSettingsCard" },
    ),
    entry(
      "settings.greetings",
      "Persönliche Begrüßungen einstellen",
      ["Einstellungen", "Zugänge", "Begrüßungen"],
      "Öffnet die datenschutzfreundlichen Vorlagen für persönliche Portalbegrüßungen.",
      ["begrüßung", "willkommen", "portaltext", "guten morgen", "rückkehrgruß", "genesung", "greeting"],
      ["settingsAccessTab", "greetingSettingsCard"],
      { view: "settings", settingsTab: "access", focusId: "greetingSettingsCard" },
    ),
    entry(
      "settings.birthday-presentation",
      "Geburtstagsdarstellung einstellen",
      ["Einstellungen", "Zugänge", "Persönliche Begrüßungen", "Geburtstagsdarstellung"],
      "Öffnet die berechtigte Zuordnung freigegebener Geburtstagsvarianten für das serverseitig projizierte Team.",
      ["geburtstag", "geburtstagsgruß", "geburtstagsdarstellung", "geburtstagsdesign", "gb einblendung", "portal geburtstag", "geburtstagsvariante", "geburtstagseffekt"],
      ["settingsAccessTab", "birthdayPresentationSettingsCard"],
      { view: "settings", settingsTab: "access", focusId: "birthdayPresentationSettingsCard" },
    ),
    entry(
      "settings.portal-users",
      "Portal-Zugänge verwalten",
      ["Einstellungen", "Zugänge", "Portal-Zugänge"],
      "Öffnet die berechtigte Verwaltung von Portalrollen, Freigaben und Startpasswörtern.",
      ["portal zugang", "benutzerkonto", "login", "startpasswort", "mitarbeiterportal", "portalrolle", "zugang freigeben", "passwort zurücksetzen", "passwort reset", "mitarbeiter passwort"],
      ["settingsAccessTab", "portalUserAccessCard"],
      { view: "settings", settingsTab: "access", focusId: "portalUserAccessCard" },
    ),
    entry(
      "settings.mobile-location-view",
      "Mobile Mitarbeiteransicht je Filiale einstellen",
      ["Einstellungen", "Zugänge", "Mobile Mitarbeiteransicht"],
      "Öffnet die berechtigte, rechtebeschränkte Modulauswahl je Filiale.",
      ["mobile ansicht", "handy module", "mitarbeiteransicht", "filialmodule", "portal mobil", "standort sichtbarkeit"],
      ["settingsAccessTab", "mobilePortalLocationDisplayCard"],
      { view: "settings", settingsTab: "access", focusId: "mobilePortalLocationDisplayCard" },
    ),
    entry(
      "settings.organization-accounts",
      "Filial- und Terminalkonten verwalten",
      ["Einstellungen", "Zugänge", "Filial- & Terminalkonten"],
      "Öffnet die Verwaltung allgemeiner, filialgebundener Konten ohne Mitarbeiterdatensatz.",
      ["filialkonto", "terminalkonto", "organisationskonto", "branch account", "terminal login", "standortkonto", "filialzugang", "filialkonto passwort", "terminalkonto passwort"],
      ["settingsAccessTab", "organizationAccountsCard"],
      { view: "settings", settingsTab: "access", focusId: "organizationAccountsCard" },
    ),
    entry(
      "settings.rights-management",
      "Rechtemanagement öffnen",
      ["Einstellungen", "Rechtemanagement", "Persönliche Rechte"],
      "Öffnet die berechtigte Verwaltung persönlicher Grund-, Zusatz- und Bereichsrechte.",
      ["rechte", "berechtigung", "permission", "rolle", "zusatzrecht", "recht entziehen", "rechte vergeben", "zugriff"],
      ["settingsRightsTab"],
      { view: "settings", settingsTab: "rights", focusId: "rightsUserList" },
    ),
    entry(
      "settings.mobile-leadership",
      "Mobile Leitungsansicht einstellen",
      ["Einstellungen", "Rechtemanagement", "Mobile Leitungsansicht"],
      "Öffnet die Modulauswahl für berechtigte Leitungsrollen im Mitarbeiterportal.",
      ["mobile leitung", "filialleitung handy", "leitungsportal", "mobile module", "management mobil", "leiteransicht"],
      ["settingsRightsTab"],
      { view: "settings", settingsTab: "rights", focusId: "mobileLeadershipModuleSettings" },
    ),
    entry(
      "settings.personnel-field-rights",
      "Personalakt-Feldrechte verwalten",
      ["Einstellungen", "Rechtemanagement", "Personalakt-Feldrechte"],
      "Öffnet die berechtigte Matrix für verborgene, lesbare und bearbeitbare Personalaktfelder.",
      ["feldrechte", "personalakt", "felder verbergen", "nur lesen", "filialleitung rechte", "datenminimierung"],
      ["settingsRightsTab"],
      { view: "settings", settingsTab: "rights", focusId: "personnelFieldRightsMatrix" },
    ),
    entry(
      "settings.retention-policies",
      "Aufbewahrungsregeln anzeigen",
      ["Einstellungen", "Datenschutz", "Aufbewahrungsregeln"],
      "Öffnet die freigegebene Governance für Aufbewahrung und Schutzsperren.",
      ["aufbewahrung", "löschfrist", "retention", "schutzsperre", "datenschutz", "löschregel", "dsgvo"],
      ["settingsDataProtectionTab", "retentionPolicyCard"],
      { view: "settings", settingsTab: "dataProtection", focusId: "retentionPolicyCard" },
    ),
    entry(
      "settings.retention-preview",
      "Aufbewahrungsvorschau öffnen",
      ["Einstellungen", "Datenschutz", "Vorschau"],
      "Öffnet die berechtigte, unverändernde Vorschau geplanter Aufbewahrungsmaßnahmen.",
      ["löschvorschau", "retention preview", "datenschutz vorschau", "betroffene daten", "frist simulation", "aufbewahrung prüfen"],
      ["settingsDataProtectionTab", "retentionPreviewCard"],
      { view: "settings", settingsTab: "dataProtection", focusId: "retentionPreviewCard" },
    ),
    entry(
      "settings.server-diagnostics",
      "Serverdiagnose anzeigen",
      ["Einstellungen", "System & Backups", "Serverdiagnose"],
      "Öffnet die berechtigte technische Diagnose des Servers und seiner Dienste.",
      ["serverdiagnose", "systemstatus", "dienste", "healthcheck", "fehler", "systemprüfung", "diagnostics"],
      ["settingsBackupTab", "serverDiagnosticsCard"],
      { view: "settings", settingsTab: "backup", focusId: "serverDiagnosticsCard" },
    ),
    entry(
      "settings.database-backups",
      "Datenbanksicherungen verwalten",
      ["Einstellungen", "System & Backups", "Datenbanksicherungen"],
      "Öffnet die berechtigte Sicherungsübersicht, ohne ein Backup zu erstellen oder herunterzuladen.",
      ["backup", "datenbanksicherung", "sqlite sicherung", "db backup", "sicherung", "datenbank herunterladen", "wiederherstellungspunkt", "backup erstellen", "sicherung erstellen"],
      ["settingsBackupTab", "databaseBackupSettingsCard"],
      { view: "settings", settingsTab: "backup", focusId: "databaseBackupSettingsCard" },
    ),
    entry(
      "settings.offsite-folders",
      "Offsite-Backup-Ordner verwalten",
      ["Einstellungen", "System & Backups", "Offsite-Ziel"],
      "Öffnet die ausschließlich dafür berechtigte Verwaltung des externen Backup-Ordners.",
      ["offsite", "google drive backup", "externe sicherung", "backup ordner", "cloud sicherung", "zielordner", "remote backup"],
      ["settingsBackupTab", "serverGoogleDriveManagementCard"],
      { view: "settings", settingsTab: "backup", focusId: "serverGoogleDriveManagementCard" },
    ),
    entry(
      "settings.restore-guidance",
      "Wiederherstellungsleitfaden anzeigen",
      ["Einstellungen", "System & Backups", "Wiederherstellung"],
      "Öffnet die technische Restore-Anleitung, ohne eine Wiederherstellung auszuführen.",
      ["restore", "wiederherstellung", "backup einspielen", "recovery", "notfall", "datenbank wiederherstellen", "rollback"],
      ["settingsBackupTab", "backupRestoreGuidanceCard"],
      { view: "settings", settingsTab: "backup", focusId: "backupRestoreGuidanceCard" },
    ),
    entry(
      "settings.backup-import",
      "Backup-Import anzeigen",
      ["Einstellungen", "System & Backups", "Backup importieren"],
      "Navigiert zur berechtigten Backup-Importkarte, ohne eine Datei zu übernehmen.",
      ["backup import", "datenbank import", "sicherung einspielen", "restore datei", "db import", "wiederherstellen"],
      ["settingsBackupTab", "backupImportCard"],
      { view: "settings", settingsTab: "backup", focusId: "backupImportCard" },
    ),
    entry(
      "settings.usb-provisioning",
      "USB-Bereitstellung öffnen",
      ["Einstellungen", "System & Backups", "USB-Bereitstellung"],
      "Navigiert zum berechtigten USB-Assistenten, ohne ein Laufwerk zu formatieren oder zu beschreiben.",
      ["usb stick", "usb bereitstellung", "offline stick", "provisioning", "filialstick", "stick erstellen", "usb assistent"],
      ["settingsBackupTab", "legacyUsbProvisioning"],
      { view: "settings", settingsTab: "backup", revealIds: ["legacyUsbProvisioning"], focusId: "usbProvisioningAvailabilityCard" },
    ),
  ];

  function normalizeComparable(value) {
    return String(value || "").trim().toLocaleLowerCase("de-AT");
  }

  function validateStringList(value, field, entryId, errors, minimum = 1) {
    if (!Array.isArray(value) || value.length < minimum) {
      errors.push(`${entryId}: ${field} muss mindestens ${minimum} Einträge enthalten.`);
      return;
    }
    const seen = new Set();
    value.forEach((item, index) => {
      if (typeof item !== "string" || item.trim() !== item || !item) {
        errors.push(`${entryId}: ${field}[${index}] muss eine nichtleere, getrimmte Zeichenfolge sein.`);
        return;
      }
      const normalized = normalizeComparable(item);
      if (seen.has(normalized)) errors.push(`${entryId}: ${field} enthält den doppelten Eintrag „${item}“.`);
      seen.add(normalized);
    });
  }

  function validateTarget(target, entryId, errors) {
    if (!target || typeof target !== "object" || Array.isArray(target)) {
      errors.push(`${entryId}: target fehlt.`);
      return;
    }
    Object.keys(target).forEach((key) => {
      if (!ALLOWED_TARGET_KEYS.has(key)) errors.push(`${entryId}: target.${key} ist kein erlaubtes Navigationsfeld.`);
    });
    if (target.kind !== "navigation") errors.push(`${entryId}: target.kind muss „navigation“ sein.`);
    if (!SUPPORTED_VIEWS.has(target.view)) errors.push(`${entryId}: target.view „${target.view}“ ist unbekannt.`);
    if (target.personnelAdministrationTab && (
      target.view !== "personnelAdministration" || !SUPPORTED_PERSONNEL_ADMINISTRATION_TABS.has(target.personnelAdministrationTab)
    )) errors.push(`${entryId}: personnelAdministrationTab passt nicht zum Ziel.`);
    if (target.personnelTab && (
      target.view !== "personnel" || !SUPPORTED_PERSONNEL_TABS.has(target.personnelTab)
    )) errors.push(`${entryId}: personnelTab passt nicht zum Ziel.`);
    if (target.settingsTab && (
      target.view !== "settings" || !SUPPORTED_SETTINGS_TABS.has(target.settingsTab)
    )) errors.push(`${entryId}: settingsTab passt nicht zum Ziel.`);
    if (target.dashboardMode && (
      target.view !== "rightsDashboard" || !SUPPORTED_DASHBOARD_MODES.has(target.dashboardMode)
    )) errors.push(`${entryId}: dashboardMode passt nicht zum Ziel.`);
    if (target.requestKind && (
      target.view !== "requests" || !SUPPORTED_REQUEST_KINDS.has(target.requestKind)
    )) errors.push(`${entryId}: requestKind passt nicht zum Ziel.`);
    if (target.revealIds !== undefined) validateStringList(target.revealIds, "target.revealIds", entryId, errors);
    if (typeof target.focusId !== "string" || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(target.focusId)) {
      errors.push(`${entryId}: target.focusId muss eine stabile DOM-ID sein.`);
    }
  }

  function validateFunctionSearchCatalog(catalog = FUNCTION_SEARCH_CATALOG) {
    const errors = [];
    if (!Array.isArray(catalog)) return { valid: false, errors: ["Der Funktionskatalog muss ein Array sein."] };
    const ids = new Set();
    catalog.forEach((item, index) => {
      const entryId = typeof item?.id === "string" ? item.id : `Eintrag ${index}`;
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        errors.push(`Eintrag ${index}: ungültiges Katalogobjekt.`);
        return;
      }
      Object.keys(item).forEach((key) => {
        if (!ALLOWED_ENTRY_KEYS.has(key)) errors.push(`${entryId}: Feld ${key} ist nicht erlaubt.`);
      });
      if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(String(item.id || ""))) {
        errors.push(`${entryId}: id besitzt kein stabiles Katalogformat.`);
      } else if (ids.has(item.id)) {
        errors.push(`${entryId}: id ist doppelt.`);
      } else {
        ids.add(item.id);
      }
      if (typeof item.label !== "string" || item.label.trim() !== item.label || item.label.length < 3) {
        errors.push(`${entryId}: label ist ungültig.`);
      }
      if (typeof item.description !== "string" || item.description.trim() !== item.description || item.description.length < 20) {
        errors.push(`${entryId}: description ist zu kurz oder ungültig.`);
      }
      validateStringList(item.path, "path", entryId, errors, 2);
      validateStringList(item.synonyms, "synonyms", entryId, errors, 3);
      if (!item.access || typeof item.access !== "object" || Array.isArray(item.access)) {
        errors.push(`${entryId}: access fehlt.`);
      } else {
        const accessKeys = Object.keys(item.access);
        if (accessKeys.length !== 1 || accessKeys[0] !== "gateIds") {
          errors.push(`${entryId}: access darf ausschließlich gateIds enthalten.`);
        }
        validateStringList(item.access.gateIds, "access.gateIds", entryId, errors);
        (Array.isArray(item.access.gateIds) ? item.access.gateIds : []).forEach((gateId) => {
          if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(gateId)) errors.push(`${entryId}: ungültige Gate-ID „${gateId}“.`);
        });
      }
      validateTarget(item.target, entryId, errors);
    });
    return { valid: errors.length === 0, errors };
  }

  function deepFreeze(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    Object.getOwnPropertyNames(value).forEach((key) => deepFreeze(value[key]));
    return Object.freeze(value);
  }

  function gateSet(value) {
    if (value instanceof Set) return value;
    if (Array.isArray(value)) return new Set(value);
    return new Set();
  }

  function functionSearchEntryIsAvailable(item, options = {}) {
    if (options.authenticated !== true || !item?.access?.gateIds?.length) return false;
    if (typeof options.isGateAvailable === "function") {
      try {
        return item.access.gateIds.every((gateId) => options.isGateAvailable(gateId) === true);
      } catch (_error) {
        return false;
      }
    }
    const availableGateIds = gateSet(options.availableGateIds);
    return item.access.gateIds.every((gateId) => availableGateIds.has(gateId));
  }

  function availableFunctionSearchEntries(options = {}) {
    return FUNCTION_SEARCH_CATALOG.filter((item) => functionSearchEntryIsAvailable(item, options));
  }

  function availableFunctionSearchEntry(entryId, options = {}) {
    if (typeof entryId !== "string" || !entryId) return null;
    const item = FUNCTION_SEARCH_CATALOG.find((candidate) => candidate.id === entryId);
    return item && functionSearchEntryIsAvailable(item, options) ? item : null;
  }

  const catalogValidation = validateFunctionSearchCatalog(FUNCTION_SEARCH_CATALOG);
  if (!catalogValidation.valid) {
    throw new Error(`Ungültiger Funktionskatalog:\n${catalogValidation.errors.join("\n")}`);
  }

  deepFreeze(FUNCTION_SEARCH_CATALOG);

  return Object.freeze({
    FUNCTION_SEARCH_CATALOG_VERSION,
    FUNCTION_SEARCH_CATALOG,
    validateFunctionSearchCatalog,
    functionSearchEntryIsAvailable,
    availableFunctionSearchEntries,
    availableFunctionSearchEntry,
  });
}));
