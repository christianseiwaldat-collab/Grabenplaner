(function(root) {
  "use strict";
  const levels = [
    ["Orientierung", "Aufbau der Kassa, Ansprechpersonen und Schutz des persönlichen Zugangs erklären."],
    ["Artikel erfassen", "Artikel, Menge und Preise unter Anleitung erfassen und am Beleg prüfen."],
    ["Standardverkauf begleiten", "Einen einfachen Verkauf mit Begleitung vollständig durchführen."],
    ["Standardverkauf selbständig", "Standardverkäufe mit freigegebenen Zahlungsarten sicher abschließen und Unklarheiten weitergeben."],
    ["Rücknahmen und Rabatte", "Freigegebene Rücknahmen und Rabatte korrekt erfassen und ihre Belegwirkung erklären."],
    ["Gutscheine und Anzahlungen", "Ausgabe und Einlösung unterscheiden und die Auswirkungen auf Umsatz und Rohertrag erklären."],
    ["Sonderfälle erkennen", "UID-Fälle, Reparaturpauschalen und unklare Belege erkennen und fachlich klären lassen."],
    ["Abstimmen und begleiten", "Kassenabstimmungen nach dem örtlichen Ablauf durchführen und Kolleginnen und Kollegen begleiten."],
    ["Fachlich einschulen", "Kassenabläufe erklären, Praxisbeispiele prüfen und nachvollziehbare Rückmeldung geben."],
    ["Standards weiterentwickeln", "Freigegebene Kassenabläufe verbessern, Schulungsinhalte pflegen und fachliche Änderungen vermitteln."],
  ].map(([label,description],i)=>({level:i+1,label,description}));
  const steps = [
    ["zugang", "Zugang und Arbeitsplatz", "Persönlichen Zugang, Belegausgabe und die zuständige Ansprechperson gemeinsam kennenlernen. Örtliche Regeln zum Kassenbeginn ergänzen.", "Zugang sicher verwenden und zuständige Person nennen."],
    ["artikel", "Artikel und Mengen", "Artikelnummer oder EAN suchen. Bezeichnung, Menge, Einzelpreis und Gesamtpreis prüfen. Zwei Stück eines Artikels als Übungsfall erfassen.", "Die erfassten Positionen mit der Ware abgleichen."],
    ["verkauf", "Verkauf und Zahlung", "Einen Standardverkauf mit einer einschulenden Person durchgehen. Vor Abschluss Positionen und Zahlungsart prüfen. Örtliche Zahlungsabläufe gemeinsam zeigen.", "Einen freigegebenen Standardverkauf ohne Hilfestellung erklären und vorführen."],
    ["rabatte", "Rabatte und Rücknahmen", "Negative Artikelmengen als Rücknahme erkennen. Separate Rabattpositionen mindern den Umsatz; der gespeicherte Rohertrag des Warenartikels bleibt erhalten. Preisfreigaben vor Ort klären.", "Verkauf, Rücknahme und Rabatt an einem Beispiel unterscheiden."],
    ["gutscheine", "Gutscheine und Anzahlungen", "Gutscheinausgabe erzeugt keinen Warenumsatz oder Rohertrag; Einlösung dient als Zahlungsmittel. Anzahlungsartikel 98 erhöht bei positiver Menge den Umsatz ohne Rohertrag. Seine Einlösung mindert den Umsatz; der Rohertrag der Waren bleibt erhalten.", "Die unterschiedliche Wirkung von Gutschein und Anzahlung erklären."],
    ["klaerung", "Unklare Belege weitergeben", "Menge, Artikelnr., Bezeichnung und Preise prüfen. Netto im Belegkopf und brutto bei Positionen können unterschiedliche Grundlagen sein. Ungeklärte Fälle an die zuständige Person geben.", "Unklarheiten beschreiben und keinen unbekannten Betrag eigenmächtig verändern."],
    ["praxis", "Praxis gemeinsam bewerten", "Einen Standardverkauf praktisch vorführen und Rücknahme, Rabatt, Gutschein und Anzahlung erklären. Die prüfende Person hält Ergebnis und gegebenenfalls Übungsbedarf fest.", "Alle Pflichtschritte geprüft; fachliches Ergebnis dokumentiert. Eine Kompetenzstufe wird anschließend gesondert freigegeben."],
  ].map(([stepId,title,instruction,completionCriteria])=>({stepId,title,instruction,completionCriteria,required:true}));
  const presets = {
    skill: {skillCode:"kassa.bedienung",title:"Kassensystem sicher bedienen",category:"Kassa",summary:"Vorschlag für die Kassenpraxis. Stufen vor der Veröffentlichung fachlich prüfen; Trainerfreigaben werden je Person ausdrücklich erteilt.",tags:["Kassa","Einschulung"],versionNote:"Kassa-Pilot: fachlich zu prüfender Entwurf",levelDefinitions:levels},
    training: {moduleCode:"kassa.grundlagen",moduleType:"training",title:"Kassensystem Einschulung",summary:"Begleitete Einführung mit selbständiger Vorbereitung und gemeinsamer Praxisprüfung.",objective:"Standardverkäufe sicher durchführen, Sonderfälle erkennen und gezielt weitergeben. Vorgeschlagene Zielstufe: 4; Trainer mindestens Stufe 8 mit gesonderter Trainerfreigabe.",estimatedMinutes:120,verificationMode:"practical_check",tags:["Kassa","Einstieg"],versionNote:"Kassa-Pilot: örtliche Abläufe vor Veröffentlichung fachlich prüfen",steps},
  };
  if(typeof module === "object" && module.exports) module.exports=presets;
  else root.GrabenplanerLearningPresets=presets;
})(globalThis);
