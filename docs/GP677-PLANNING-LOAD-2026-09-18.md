# Dienstplan: erste Anzeige und Mitarbeiterabruf

Die produktiven Zugriffsprotokolle am 18.09.2026 zeigten Dienstplanantworten
mit HTTP 200 nach zunächst rund 1–3 Sekunden; spätere Chrome-Aufrufe lagen
zwischen 2,7 und 7,9 Sekunden. Zeitgleich dauerte `/api/employees`
teilweise 6–8 Sekunden; ein Abruf scheiterte mit HTTP 500 und
`PERSISTENCE_TIMEOUT`. Die Oberfläche wartete auf alle Antworten gemeinsam
und verwarf dadurch auch einen bereits erfolgreich geladenen Dienstplan.

Der Dienstplan wird jetzt nach seiner eigenen Antwort dargestellt. Fehler
bei Zusatzdaten bleiben sichtbar, verhindern diese erste Anzeige aber nicht.
Beim Einstieg wird die angeforderte Ansicht mit ihrem Standort vor dem
Datenabruf ausgewählt, ohne einen zweiten Initialabruf auszulösen.
Antworten einer abgelösten Anmeldung dürfen die Ansicht nicht aktualisieren.

Der Mitarbeiterabruf verwendet denselben geschützten, an eine Anfrage
gebundenen PostgreSQL-Lesebereich wie die Dienstplanung. Er bündelt die
Einzelabfragen in einer lesenden Transaktion mit erneuter Rechteprüfung vor
der Antwort. Standortfilter und personenbezogene Feldfreigaben bleiben bestehen.

Gezielte Lade-, Rechte- und Architekturprüfungen: 21 bestanden. Der vorhandene
native PostgreSQL-Paritätstest wurde um die Mitarbeiterliste erweitert.
Die erste lokale Ausführung konnte die abgeschaltete Entwicklungsdatenbank
nicht erreichen; dies ist kein fachlicher Testerfolg. Veröffentlichung und
produktive Antwortzeiten sind gesondert zu verifizieren. Der separate Fehler
unter Firefox 115 ist im folgenden Abschnitt beschrieben.

## Prüfung des Releasekandidaten

Commit `c6fbf51c64e3a64a8097a6ce4720ae5716f83f61`, Paket
`Grabenplaner-Server-v0.92.60-beta-linux-x64.zip`, SHA-256
`49d1558b14650f6d012a0615c4301820a2816236e42f5427cbf7b3d4ff2eaae4`.
Alle vier Jobs des CI-Laufs 35332519833 bestanden, einschließlich Windows,
Linux, PostgreSQL-Providervertrag und minimaler Node-Version. Die vorhandene
API-Prüfung der Personalprofilfelder bestand ebenfalls.

Im internen Chromium-Browser erschien der synthetische lokale Dienstplan
nach 1.102 ms, obwohl der Mitarbeiterabruf absichtlich acht Sekunden verzögert
und anschließend mit HTTP 503 abgewiesen wurde. Auch danach blieb das Raster
sichtbar und der Fehler wurde angezeigt. Ein normaler Wochenwechsel benötigte
44 ms; dabei gab es keine JavaScript-Fehler. Diese Werte stammen aus der
lokalen SQLite-Testumgebung und sind keine Messung der Produktionsleistung.

Firefox 156.0 wurde zusätzlich automatisiert mit einem frischen, isolierten
Profil und synthetischen Schichten geprüft. Dienstplan und sichtbare Dienstbalken
erschienen nach 672 ms. Auch mit dem nach acht Sekunden fehlschlagenden
Mitarbeiterabruf blieben sie sichtbar. Der Wechsel von KW 38 auf KW 39 inklusive
Dienstbalken bestand ebenfalls (68 ms). Beide Ansichten wurden als Screenshot
visuell geprüft. Browser, Testserver und Treiber wurden danach beendet.

Das exakte Paket bestand am 18.09.2026 um 10:14:46 UTC den vollständigen
Anwendungstest auf einer bereits vorhandenen, isolierten PostgreSQL-Kopie.
Geprüft wurden reguläre Anmeldung, Dienstplan, PDF, parallele Lesezugriffe,
Artikelimport mit Konfliktabwehr und Rücknahme, historische Arbeitsregeln,
Umsatzbericht und Sperrung einer widerrufenen Sitzung. Der Dienstplanabruf
benötigte dort 1.445 ms. Es wurde für diese Prüfung keine neue vollständige
Wiederherstellung gestartet und kein Produktionskonto angelegt.

Eine zusätzliche Mitarbeiter-Vergleichsmessung während des Virenscans erreichte
die Messphase nicht: Ein Reportworker scheiterte beim Anwendungsstart mit
`IMPORT_REPORT_FAILED`. Daraus liegt kein belastbarer Vorher-Nachher-Wert vor.
Der private PostgreSQL-Prozess wurde beendet und die Testkopie wieder versiegelt.

Der reguläre vollständige Updater wurde um 10:15 UTC gestartet. Um 11:03 UTC
wurden Version 0.92.60, öffentliche Live-/Ready-Antworten mit HTTP 200 und die
exakten Hashes von HTML, JavaScript und CSS bestätigt. Die anschließende
Wiederherstellungsprüfung scheiterte beim Anwendungsstart mit
`PERSISTENCE_TIMEOUT`. Der Updater stellte die vorherige Version 0.92.58
automatisch wieder her und endete um 11:51:31 UTC mit Exitcode 1.
Version 0.92.60 ist damit nicht erfolgreich veröffentlicht.
Eine angemeldete produktive Firefox-Sitzung wurde nicht verändert oder für die
Prüfung vorausgesetzt.

## Dienstbalken unter Firefox 115

Die produktiven Firefox-Aufrufe verwendeten laut User-Agent Firefox 115.
Ein zusätzlicher lokaler Test mit genau Firefox 115.0 reproduzierte den
Darstellungsfehler: Der Schichtbutton war nur zwei Pixel breit, obwohl die
Mitarbeiterspalte 34,78 Pixel breit war. Das absolut positionierte Label gab
dem Button keine eigene Inhaltsbreite; diese Firefox-Version streckte den
Button nicht zwischen den beiden seitlichen Abständen.

Eine explizite Breite `calc(100% - 6px)` berücksichtigt dieselben Abstände
und erhält die Spaltengeometrie. Der Test bestand damit in Firefox 115.0
einschließlich belegter Schichten in KW 38 und KW 39 und eines verzögert
fehlschlagenden Mitarbeiterabrufs. Erstes Raster: 766 ms; Wochenwechsel: 97 ms.
Chrome 152.0.7977.84 bestand dieselbe Prüfung (641 ms und 58 ms). Sämtliche
Werte beziehen sich auf lokale synthetische SQLite-Daten.

## Veröffentlichter Browser-Hotfix auf Version 0.92.58

Am 18.09.2026 um 12:04:14 UTC wurde der Browser-Hotfix
`46a2e7528744b0c4926dfa2a87bb813fe33692f2` erfolgreich veröffentlicht.
Er basiert auf der wiederhergestellten Version 0.92.58 und ändert ausschließlich
`public/app.js` und `public/styles.css`. Alle übrigen 744 Laufzeitdateien wurden
gegen das ursprüngliche Paket bytegenau geprüft. Backend, Datenbank und
Dienstprozesse wurden nicht verändert oder neu gestartet.

Der Dienstplan wird vor den Zusatzdaten angezeigt; Mitarbeiter-, Urlaubs- und
Brandingabfragen beginnen erst nach seiner Antwort. Dadurch konkurrieren diese
Abfragen beim ersten Laden nicht um dieselben Datenbankverbindungen. Fehler in
Zusatzdaten verwerfen den bereits angezeigten Plan nicht. Die zehn gezielten
Ladetests bestanden auf dem isolierten Hotfix-Checkout.

Das konkrete Paket bestand Browserprüfungen mit sichtbaren Schichten in zwei
Wochen, Wochenwechsel und einem nach acht Sekunden fehlschlagenden
Mitarbeiterabruf: Firefox 115.0 mit 969 ms bis zur Anzeige und 119 ms beim
Wochenwechsel, Chrome 152.0.7977.84 mit 625 ms und 67 ms. Das sind synthetische
lokale SQLite-Messungen, keine produktiven Antwortzeiten.

Paket-SHA-256:
`e2d60ecffd1950d70cae4979b923fed2751d6c66dff0569887105148691badbe`.
Nach der atomaren Dateiersetzung wurden sämtliche 746 Dateien, die öffentlich
ausgelieferten JavaScript-/CSS-Hashes und interne sowie öffentliche Live-/Ready-
Antworten mit HTTP 200 geprüft. Die separate Veröffentlichung wurde unter
`/opt/grabenplaner/.deploy-ui-v09258-46a2e75/deployment-receipt.json`
protokolliert. Der vorherige Fehlerstatus der Wiederherstellungsprüfung bleibt
unverändert dokumentiert; dieser Browser-Hotfix behauptet keinen neuen
Wiederherstellungsnachweis.
