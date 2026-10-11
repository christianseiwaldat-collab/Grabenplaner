(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpDefinitionsRegistry=api;
})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const VERSION=5,UPDATED='2026-10-11';
  const topics=[
    {id:'sidebar',title:'GP-sidebar',symbol:'☷',summary:'Die gemeinsame Seitennavigation hält den aktuellen Bereich sichtbar und trennt Navigation von persönlichen Menüeinstellungen.',
      rules:[
        {title:'Unterpunkte öffnen ihren Bereich',text:'Der Wechsel zu einem Unterpunkt hält alle übergeordneten Menüs offen. Das gilt auch für tiefe Unterbereiche, Direktaufrufe sowie Zurück und Vorwärts im Browser.'},
        {title:'Ein eindeutiges aktuelles Ziel',text:'Genau der aktuelle Menüpunkt trägt die aktive Markierung und aria-current. Übergeordnete Bereiche sind als aktiver Pfad erkennbar; ihre Offen- oder Geschlossenstellung wird mit aria-expanded angezeigt.'},
        {title:'Persönliche Menüstellung behalten',text:'Manuell geöffnete oder geschlossene Bereiche werden je angemeldetem Konto gespeichert. Ein Seitenwechsel öffnet die benötigten Vorfahren; die persönlichen Einstellungen anderer Bereiche bleiben erhalten. Eine Hintergrundaktualisierung klappt kein Menü um.'},
        {title:'Freigaben vor Darstellung prüfen',text:'Die Navigation bietet nur erlaubte Ziele an. Konto-, Rollen- und Rechtewechsel entfernen nicht mehr freigegebene Einträge und fremde Zustände. Eine gespeicherte Menüstellung erteilt keine zusätzlichen Rechte.'},
        {title:'Klare Hierarchie und ruhige Markierung',text:'Hauptpunkte, Unterpunkte und weitere Ebenen verwenden einheitliche Einzüge, Abstände und aktive Markierungen. Beschriftungen bleiben lesbar und umbrechbar; Status wird nicht ausschließlich durch Farbe vermittelt.'},
        {title:'Mobile Navigation gezielt schließen',text:'Nach der Auswahl eines Ziels darf sich die mobile Navigation schließen. Dabei schließt nur die mobile Menüfläche; die persönliche Stellung der darin enthaltenen Bereiche bleibt erhalten.'},
        {title:'Tastatur und Touch unterstützen',text:'Alle Menüpunkte sind über Tastatur erreichbar. Enter oder Leertaste aktiviert Buttons; ein sichtbarer Fokus zeigt das Ziel. Mobile Touchflächen sind mindestens 44 Pixel hoch, Menütexte mindestens 13 Pixel groß.'},
        {title:'Standards als gemeinsamer Bereich',text:'Alle GP-Standarddefinitionen liegen unter dem Hauptpunkt GP-Standards. Andere freigegebene Developer-Werkzeuge stehen auf derselben Ebene; zugehörige Unterseiten bleiben bei ihrem Werkzeug. Beim Zurückkehren zu GP-Standards bleibt das zuletzt gewählte Thema erhalten.'},
      ],references:['public/sidebar-layout.js','public/navigation-history.js','public/app.js','public/gp-definitions.js'],example:'Artikel-Auswertung und BWL-Tools bleiben im geöffneten Verkauf-Menü; Personal-Unterpunkte behalten ihren Bereich'},
    {id:'windows',title:'Fenster',symbol:'▣',summary:'Interne Arbeitsfenster im GP, mit einem gemeinsamen Verhalten und einer kompakten Titelleiste.',
      rules:[
        {title:'Im gesamten GP verschieben',text:'Die Titelleiste bewegt das Fenster über den gesamten sichtbaren GP, auch über die Sidebar. Ein GP-Fenster öffnet kein zusätzliches Browserfenster.'},
        {title:'An Rändern und Ecken vergrößern',text:'Alle acht Ränder und Ecken dienen zur Größenänderung. Der Mauszeiger zeigt die Richtung. An einer Kante ändert sich nur die entsprechende Breite oder Höhe.'},
        {title:'Minimieren und wiederherstellen',text:'Arbeitsfenster bleiben beim Minimieren geöffnet: Entwürfe, Eingaben und ausgewählte Dateien bleiben erhalten, der übrige GP bleibt bedienbar. Wiederherstellen bringt die volle Größe zurück. Der Standard verwendet 260 × 44 Pixel im minimierten Zustand.'},
        {title:'Zum passenden Öffner schließen',text:'Schließen führt das Fenster mit dezenter Bewegung zu seinem Button oder Seitensymbol zurück. Artikelsuche und letzte Artikel haben ihren Dock links unten innerhalb der Artikelstamm-Seite.'},
        {title:'Gemeinsame Titelleiste',text:'Griff, einzeiliger Titel, 38-Pixel-Steuerungen und 12-Pixel-Ecken folgen der Artikelsuche. Die Titelleiste bleibt sichtbar; Erklärungen, Eingaben und Aktionen liegen im scrollbaren Inhalt.'},
        {title:'Geschützte Bestätigungen bleiben modal',text:'Sicherheitsbestätigungen, Pflicht- und Passwortdialoge behalten ihre native Modalität und fachlichen Abbruchregeln. Sie verwenden dieselbe Titelleiste, lassen sich aber nicht minimieren. Escape schließt nur das fokussierte Arbeitsfenster und respektiert offene Bestätigungen und Verwerfenschutz.'},
        {title:'Geometrie je Konto behalten',text:'Position, volle Größe und Minimierungszustand werden je angemeldetem Konto und Fenster gespeichert. Tastatur und Touch sind bedienbar; reduzierte Bewegung wird berücksichtigt.'},
      ],references:['public/gp-window.js','public/gp-window.css','public/gp-window-preferences.js'],example:'Artikelsuche auf der Artikelstamm-Seite'},
    {id:'print',title:'Druck & PDF',symbol:'▤',summary:'Ein gemeinsames Druckfenster verbindet die Ausgabeoptionen mit der tatsächlichen PDF-Datei.',
      rules:[
        {title:'PDF-Export als GP-Fenster',text:'Der Export verwendet den GP-Fensterstandard mit Verschieben, Größenänderung, Minimieren und Schließen. Ausgabeoptionen und Vorschau stehen gemeinsam im Fenster.'},
        {title:'Titel und Dateiname getrennt',text:'PDF-Titel, frei wählbarer Dateiname und Hoch- oder Querformat sind direkt einstellbar. Fachliche Ausgabeoptionen ergänzen die gemeinsamen Einstellungen.'},
        {title:'Tatsächliches Drucklayout zeigen',text:'Die Vorschau rendert die erzeugte PDF-Datei und zeigt ihre echte Seitenzahl. Seitenwechsel und Zoom machen auch mehrseitige Ausgaben prüfbar.'},
        {title:'Dieselbe Datei herunterladen',text:'Vorschau und Download verwenden dieselben PDF-Bytes. Ändern sich Optionen oder der Ergebnisstand, muss die Vorschau neu berechnet werden, bevor der passende Download bereitsteht.'},
        {title:'Vollständigkeit und Datenstand',text:'Ein Export benennt den verwendeten Datenstand und enthält die vollständige gewählte Ergebnisliste innerhalb der fachlichen Schutzgrenzen. Begrenzte Ausgaben werden ausdrücklich ausgewiesen.'},
        {title:'Aufträge sicher trennen',text:'Ein veralteter Auftrag darf keinen neueren Entwurf ersetzen. Konto- oder Rechtewechsel verwirft fremde Ausgaben; Schließen räumt die Vorschau und temporäre Download-Adressen auf.'},
      ],references:['public/gp-print-window.js','public/gp-print-window.css','public/sales-article-report-pdf-preview.js'],example:'Artikel-Auswertung, Artikelstammblatt, ABC-Analyse, Abverkaufs-Simulation und Maßnahmenliste als PDF'},
    {id:'tables',title:'Tabellen',symbol:'≡',summary:'Kompakte, anpassbare Listen machen Daten vergleichbar und behalten die persönliche Spaltenansicht.',
      rules:[
        {title:'Spaltenansicht',text:'Die kompakte Option heißt im GP „Spaltenansicht“. Sie wählt sichtbare Spalten und, wo vorgesehen, deren Reihenfolge. Mindestens eine Datenspalte bleibt sichtbar.'},
        {title:'Direkt in der Kopfzeile sortieren',text:'Sortierbare Spaltentitel wechseln zwischen auf- und absteigender Reihenfolge. Richtung und aktuelle Sortierung sind sichtbar und für Tastaturbedienung zugänglich.'},
        {title:'Spaltenbreite direkt verändern',text:'Die Grenze am Spaltenkopf lässt sich mit Maus oder Touch ziehen. Pfeiltasten passen die Breite ebenfalls an; der Zeiger macht die Funktion sichtbar.'},
        {title:'Je Konto und Tabelle speichern',text:'Spaltenbreiten, Sichtbarkeit sowie unterstützte Reihenfolge und Sortierung werden pro angemeldetem Konto und Tabelle wiederhergestellt. Eine frühe Eingabe darf gespeicherte Einstellungen nicht überschreiben.'},
        {title:'Freigaben bleiben maßgebend',text:'Die Spaltenansicht bietet ausschließlich erlaubte Daten an. Bei einem Rechtewechsel verschwinden unzulässige Spalten und fremde Ergebnisstände.'},
        {title:'Fehlende Werte verständlich anzeigen',text:'Nicht verfügbare oder ungeklärte Werte bleiben ausdrücklich erkennbar. Ein fehlender Wert wird nicht als Null ausgegeben. Breite Tabellen scrollen innerhalb ihrer Ergebnisfläche.'},
      ],references:['public/table-layout.js','public/table-layout.css','public/rights-settings-table.js'],example:'Artikelstamm und kompakte Rechteübersicht'},
    {id:'views',title:'Gespeicherte Ansichten',symbol:'↺',summary:'Der Wechsel auf eine andere GP-Seite erhält den Arbeitsstand und trennt ihn sicher zwischen Konten.',
      rules:[
        {title:'Beim Seitenwechsel erhalten',text:'Eingaben, Auswahl, Filter und noch nicht abgeschlossene Entwürfe sollen beim Wechsel auf eine andere GP-Seite bestehen bleiben. Laufende Uploads gehören zum zugehörigen Arbeitsentwurf.'},
        {title:'Ansicht und aktuelle Daten trennen',text:'Eine erhaltene Ansicht darf aktuelle Preise, Rechte oder veränderliche Details gezielt neu prüfen. Die Aktualisierung ersetzt nicht ungefragt den Entwurf oder die Auswahl.'},
        {title:'Dauerhaftes Speichern kenntlich machen',text:'Arbeitsentwurf, benannte Projektdatei und persönliche Anzeigeeinstellungen haben unterschiedliche Zwecke. Nur ausdrücklich dauerhaft gespeicherte Zustände werden für einen späteren Einstieg zugesichert.'},
        {title:'Späte Antworten nicht übernehmen',text:'Antworten auf ältere Lese- oder Speicheraufträge dürfen neuere Eingaben nicht überschreiben. Ladezustände und Konflikte bleiben sichtbar, bis der aktuelle Stand feststeht.'},
        {title:'Konto- und Rechtewechsel abgrenzen',text:'Zustände gehören zum angemeldeten Konto und dessen Freigaben. Beim Wechsel oder Rechteverlust werden fremde Daten verworfen und veraltete Aufträge beendet.'},
        {title:'Navigation ohne Formulardaten',text:'Zurück und Vorwärts stellen die GP-Seite beziehungsweise den Unterbereich wieder her. Persönliche Formulare, Berichte und Ergebnisdaten gehören nicht in die Browser-Adresse oder den Verlauf.'},
      ],references:['public/sales-price-label-working-draft.js','public/navigation-history.js','public/gp-window.js'],example:'Preisschild-Arbeitsentwurf und BWL-Eingaben beim Seitenwechsel; benannte Simulationsvarianten werden ausdrücklich dauerhaft gespeichert'},
    {id:'design',title:'Design',symbol:'◇',summary:'Ruhige, kompakte Oberflächen geben den fachlichen Inhalt und die wichtigsten Aktionen klar vor.',
      rules:[
        {title:'Kompakte klare Hierarchie',text:'Titel, kurze Einordnung, Eingaben und Ergebnis bilden eine verständliche Reihenfolge. Titelleisten und Formulare vermeiden große ungenutzte Flächen.'},
        {title:'Kontextmenüs direkt am Inhalt',text:'Kleine Menüs mit kurzen Aktionen öffnen am betreffenden Feld oder Element. Fokus, Escape und Tastaturbedienung sind Teil des Menüs; die Hauptaktion bleibt erkennbar.'},
        {title:'Dashboard-Felder individuell gestalten',text:'Felder im Startdashboard und Personaldashboard lassen sich über die Titelleiste verschieben und an Rändern oder Ecken verändern. Beschriftung, Position, Größe, Sichtbarkeit und leichte Feldfarben bleiben je Konto gespeichert. Unterstützte Inhalte lassen sich je Feld auswählen.'},
        {title:'Fenster und fachliche Felder unterscheiden',text:'Ein GP-Fenster besitzt die gemeinsamen Fenstersteuerungen. Normale fachliche Felder auf anderen Seiten werden durch den Fensterstandard nicht automatisch zu frei verschiebbaren Flächen.'},
        {title:'Hell, Dunkel und schmale Ansichten',text:'Gemeinsame Farbvariablen, lesbare Kontraste und sichtbare Fokusmarkierungen tragen beide Darstellungen. Inhalte passen sich schmalen Ansichten und einer vergrößerten GP-Schrift an.'},
        {title:'Rückmeldungen im Arbeitsfluss',text:'Laden, Speichern, Warnungen und Fehler erscheinen nahe am zugehörigen Inhalt. Ein Status benennt den tatsächlich belegten Stand und bleibt auch ohne Farbe verständlich.'},
      ],references:['public/styles.css','public/start-dashboard-workspace.js','public/start-dashboard-workspace.css','public/personnel-dashboard-workspace-preferences.js'],example:'Startdashboard, Personaldashboard und kompakte Verkaufsoberflächen'},
    {id:'galleries',title:'Galerien',symbol:'▦',summary:'Eine gemeinsame Galerie verbindet kompakte Vorschaubilder, Suche, Auswahl und geschützte Bildfenster.',
      rules:[
        {title:'Gemeinsame Galerie-Komponente',text:'Galerien verwenden dieselbe technische Komponente. Fachliche Adapter liefern freigegebene Bilder, Filter und Speicheraktionen; Downloads verwenden ausschließlich freigegebene Bildadressen und enthalten keine Zugangsschlüssel.'},
        {title:'Suchen, filtern und sortieren',text:'Suche berücksichtigt alle eingegebenen Wörter. Sortierung und Filter lassen sich kompakt aufklappen; Bildgröße und Sortierung bleiben je Konto und Galerie gespeichert. Fehlende Sortierwerte stehen am Ende.'},
        {title:'Auswahl bleibt nachvollziehbar',text:'Einzelne Bilder, Bereiche mit Umschalttaste und alle sichtbaren Bilder lassen sich auswählen. Änderungen der Ansicht entfernen unsichtbare Bilder aus der Auswahl. Sammelaktionen zeigen die aktuelle Auswahl an.'},
        {title:'Ordner und Papierkorb',text:'Virtuelle Ordner ordnen Bilder ohne die Originaldateien umzubenennen. Entfernen legt Bilder zunächst in den Papierkorb; Wiederherstellen erhält Metadaten und Statistik. Endgültiges Entfernen benötigt eine ausdrückliche Bestätigung.'},
        {title:'Bildfenster und Vollbild',text:'Bildfenster lassen sich verschieben, vergrößern, minimieren und wiederherstellen. Vollbild unterstützt Einpassen, Originalgröße, Mausrad-Zoom, Verschieben, Pfeiltasten und Escape; bei fehlender Browserfreigabe bleibt eine Ansicht innerhalb des Browsers verfügbar.'},
        {title:'Freigaben und Originale schützen',text:'Bilder und Metadaten werden serverseitig nur für freigegebene Konten ausgeliefert. Abmeldung verwirft private Ansichten und Entwürfe. Galerieaktionen geben keine verbrauchten API-Kontingente zurück und ändern keine Originalbytes.'},
        {title:'ZIP-Download gehört dazu',text:'Jede Galerie bietet einen ZIP-Download für die aktuelle Auswahl, Ansicht, gesamte Galerie und ganze Ordner einschließlich wählbarer Unterordner. Bilder, Beschreibungen oder Prompts, technische JSON-Daten und Ordnerstruktur sind wählbar. Ganze Ordner werden unabhängig von Suchfiltern geladen; Größenlimits werden vor einem unvollständigen Download erklärt. Original und Ergebnis bleiben gemeinsam nachvollziehbar.'},
      ],references:['public/gp-gallery.mjs','public/gp-gallery.css','public/gp-gallery-window.mjs','public/gp-gallery-fullscreen.mjs','public/gp-gallery-download.mjs','public/gp-gallery-zip.mjs'],example:'Geschützte Bildgalerien mit gemeinsamen Bedienelementen und fachlichen Adaptern'},
  ];
  function freeze(value){Object.values(value).forEach(item=>{if(item&&typeof item==='object')freeze(item);});return Object.freeze(value);}
  freeze(topics);
  const normalized=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLocaleLowerCase('de-AT').replace(/ß/g,'ss').trim();
  function select({topic='all',query=''}={}){
    const words=normalized(query).split(/\s+/).filter(Boolean);
    return topics.filter(item=>(topic==='all'||item.id===topic)&&words.every(word=>normalized([item.title,item.summary,item.example,...item.rules.flatMap(rule=>[rule.title,rule.text]),...item.references].join(' ')).includes(word)));
  }
  function canAccess(session){const user=session?.user;return session?.authenticated===true&&user?.role==='developer'&&user.isEmployee!==false&&user.active!==false&&user.mustChangePassword!==true;}
  return Object.freeze({VERSION,UPDATED,topics,select,canAccess});
});
