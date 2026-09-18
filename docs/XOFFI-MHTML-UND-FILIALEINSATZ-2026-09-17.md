# Xoffi-MHTML und Filialeinsatz-Anfragen

Stand: 18.09.2026. Implementiert und lokal geprüft. Die folgenden Nachweise
beschreiben den lokalen Arbeitsstand. Spätere Fehlerkorrekturen und der
VPS-Veröffentlichungsstand stehen in
[CI-Fehlerkorrektur](CI-FEHLERKORREKTUR-2026-09-18.md) und
[Release v0.92.60](DEPLOY-RELEASE-v09260.md).
Frühere Änderungen an Geschwindigkeit,
Urlaubsplanung und PDF-Auswahl bleiben erhalten.

## Bedienung

1. Die vollständige, abgeschlossene Xoffi-Woche im Browser als einzelne
   `.mhtml`-Datei speichern; `.mht` wird ebenfalls erkannt.
2. In der GP-Dienstplanung die passende Filiale und gegebenenfalls Abteilung
   auswählen und **xoffi importieren** öffnen. Die aktuell angezeigte GP-Woche
   muss nicht vorher angepasst werden.
3. Datei auslesen. Vollständige Namen werden mit den berechtigten Teammitgliedern
   dieses Bereichs abgeglichen. Eindeutige Treffer werden automatisch zugeordnet;
   bei fehlenden oder mehrdeutigen Treffern ist eine Auswahl erforderlich.
4. Zuordnung und Stunden prüfen und übernehmen. GP wechselt in die erkannte
   Woche. Bei sieben importierten Tagen und aktivierter Ist-Zeit erscheint
   beim Mitarbeiter ein weißes Häkchen im grünen Kreis.

Aktuelle und zukünftige Wochen werden serverseitig abgewiesen. Das gilt auch
bei manipulierten Formularangaben. Screenshots bleiben als bisheriger
zusätzlicher Importweg verfügbar.

Ein erneuter vollständiger Import desselben Bereichs und derselben Woche
ersetzt den aktiven Stand revisionssicher. Fehlen zuvor importierte Mitarbeiter
in der Ersatzdatei, wird diese abgewiesen; der vorhandene Stand bleibt aktiv.

## Fachliche Auswertung

- KW und Sonntag-Stichtag bestimmen gemeinsam Jahr und Montag bis Sonntag.
  Alle Mitarbeiterzeilen müssen dieselbe Woche beschreiben.
- Sieben `Gesamt`-Werte werden als gewertete Tagesstunden übernommen.
  Anwesenheitsintervalle ergeben die tatsächliche Anwesenheit; Nachtragsnotizen
  werden nicht nochmals als Arbeitsintervalle gezählt.
- Xoffi-Zuschläge und bewertete Abwesenheiten sind bereits in den gewerteten
  Stunden enthalten. GP addiert sie bei dieser Quelle nicht erneut.
- Zeitkonto und Resturlaub aus `Vorgaben/Stand` sind eigenständige Quellenwerte
  zum Sonntag vor der Woche. Der Resturlaub enthält keine künftig fixierten
  Urlaube und verändert weder GP-Urlaubsansprüche noch geplante Urlaube.
- `Wo.Tage/Std` bleibt ein Quellenhinweis auf die theoretische Wochenarbeitszeit;
  die GP-Vertragsdaten werden nicht überschrieben. Die unteren Mehrstunden
  bleiben als Änderung der importierten Woche getrennt vom oberen Zeitkonto.
- Der letzte bekannte Stichtagswert darf in späteren Wochen angezeigt werden,
  bleibt ausdrücklich datiert und erzeugt dort kein aktuelles Importhäkchen.

Die vorhandene Beispieldatei wurde lokal gelesen: sechs Mitarbeiterzeilen,
42 Tageswerte, KW 37 vom 07. bis 13.09.2026, Stichtag 06.09.2026. Ihre Daten
wurden nicht in eine produktive GP-Datenbank geladen.

## Dateiverarbeitung

Die MHTML-Verarbeitung liest eingebettetes HTML ohne Skriptausführung und ohne
externe Ressourcen nachzuladen. Quoted-Printable, Base64 und unkodierte
MIME-Teile sowie verschachtelte Archive werden unterstützt. Grenzen:
18 MiB Datei, 8 MiB decodiertes HTML, 256 MIME-Teile, 250 Mitarbeiterzeilen,
begrenzte MIME- und DOM-Verschachtelung. Tagesintervalle und Wochen-/Tagessummen
werden auch nach manuellen Änderungen geprüft.

Die Quelldatei wird nicht gespeichert. Die kurzlebige Vorschau enthält nur
extrahierte Fachwerte, Dateiname und Prüfsumme; gespeicherte Daten umfassen die
bestätigten Werte und den Importbeleg. Archivinterne URLs gelangen nicht in
die persistierten Daten. Neu hinzugekommen ist der fest versionierte
HTML-Parser `htmlparser2` 12.0.0; es wird kein Browser auf dem VPS benötigt.

## Filialeinsatz

Anfragen sind bis einschließlich desselben Kalendertages sechs Monate nach dem
heutigen Wiener Datum möglich. Monatsenden werden auf den letzten gültigen Tag
begrenzt. Beispiel: 17.09.2026 bis 17.03.2027. Für heute endet die Anfragefrist
drei Stunden vor Ladenschluss der eigenen Zielfiliale; danach beginnt die
Datumsauswahl mit morgen. Bei Ladenschluss um 18:00 Uhr ist eine Anfrage bis
einschließlich 15:00:00 Uhr möglich. An geschlossenen Tagen beginnt das Fenster
ebenfalls mit morgen. Die Sechsmonatsgrenze verschiebt sich dadurch nicht.

Der Kalender erhält seine Grenzen vom Server. Mehrtägige Anfragen können
mehrere Wochen umfassen. Stundenweise Anfragen bleiben auf einen Tag begrenzt.
Das Anfragefenster ist unabhängig von der ein- oder zweiwöchigen Fremdplanansicht;
bestehende Leserechte, Datenschutzfilter und Bestätigungsabläufe bleiben wirksam.

## PostgreSQL-Erweiterung für den ersten Deploy

`lib/persistence/postgresql/core/xoffi-snapshots.js` ergänzt in Core die Tabelle
`xoffi_time_snapshots` und ein Migrationsjournal. Snapshots sind unveränderlich,
mit dem bestehenden Mitarbeiter-Importdatensatz verknüpft und nur für App und
Leser entsprechend berechtigt. Sales wird nicht verändert.

Außerdem wird ausschließlich der vorhandene Fremdschlüssel
`fk_xoffi_time_imports_0` auf `DEFERRABLE INITIALLY DEFERRED` gestellt.
Dies stellt die bereits im SQLite-Quellschema definierte Semantik wieder her:
der alte Import darf innerhalb derselben Transaktion auf den unmittelbar
anschließend angelegten Nachfolger verweisen. Beim Commit muss der Nachfolger
existieren. Eindeutigkeit des aktiven Imports und Unveränderlichkeit bleiben
erhalten. Ein Test mit fehlendem Nachfolger weist den vollständigen Rollback nach.

Die Erweiterung läuft mit Umgebungsprüfung, Advisory-Lock, einer serialisierbaren
Transaktion sowie verifizierten Vorher-/Nachher-Fingerabdrücken. Wiederholung
prüft den vorhandenen Vertrag und verändert nichts.

Der Helfer `server-tools/linux/lib/xoffi-snapshots-migrate.js` wird im geschützten
Release-Wrapper über die ausdrücklich gesetzte Updater-Option
`--xoffi-snapshots-migration` ausgeführt: **nach dem atomaren App-Tausch, vor dem
Start der neuen App**, unter der weiterhin gehaltenen Wartungssperre auf
Dateideskriptor 9. Diese Option erzwingt die vollständige Prüfung und akzeptiert
nur PostgreSQL mit übernommener Wartungssperre. Der Updatebeleg enthält das
Migrationsergebnis. Weil v0.92.56 diese Option noch nicht kennt, wird für diesen
Übergang der unabhängig geprüfte Updater aus dem vollständigen Kandidatenpaket
verwendet; Paketprüfung und Runtimeprüfung erfolgen durch die installierten
Verifikationswerkzeuge. Es gibt keinen Vertrauenswechsel des Paketprüfers.
Argumente: geprüfter SHA-256 des installierten Servermanifests und
`--maintenance-lock-held`. Er akzeptiert nur Linux/root im installierten
`/opt/grabenplaner/app`, prüft Manifest und Quelldateien sowie einen höchstens
eine Stunde alten verifizierten gekoppelten Sicherungspunkt und nutzt die
vorhandene geschützte PostgreSQL-Konfiguration. Nicht aus Staging starten.

Die neuen Dienstplanabfragen benötigen diese Erweiterung. Ein bloßer App-Tausch
ohne Migration reicht deshalb nicht. Live-Abschlussprüfung: Helfer `verified`,
gültiger Core-Fingerabdruck, unveränderte Sales-Datenbank, normaler Dienstplan
und Xoffi-Import. Der Linux-Helfer wurde in diesem Block nicht auf dem VPS
ausgeführt. Ein Rückweg benötigt die bestehende gekoppelte Wiederherstellung;
ein bloßer Code-Rollback kennt den neuen Schema-Fingerabdruck nicht.

Beim isolierten Restore eines älteren Sicherungspunktes werden zunächst dessen
ursprüngliche Struktur, Daten, Sequenzen und geschützte Inhalte vollständig
geprüft. Anschließend ergänzt der Recovery-Worker die Xoffi-Struktur nur in der
privaten Testkopie für die Prüfung der neuen Anwendung. Das Ergebnis ist als
`application.schemaUpgrades.xoffi` ausgewiesen. Quellarchiv und Produktivdatenbank
werden dadurch nicht verändert; bei bereits aktuellem Schema erfolgt keine
erneute Änderung.

## Verifikation und Grenzen

- 80 gezielte Parser-, API-, Rechte-, Grenzdatum- und UI-Regressionstests bestanden.
- Nativer PostgreSQL-Test bestanden: tatsächliche Migration und Wiederholung,
  Upload per HTTP, Zuordnung, Speicherung, erneuter vollständiger Import,
  Ablehnung unvollständiger Ersetzungen, unveränderliche Snapshots, getrennte
  Urlaubsstände, bereits enthaltene Zuschläge und Rollback bei fehlendem Nachfolger.
- Zusätzlicher nativer Dienstplan-/Urlaubs-Regressionslauf bestanden; Filial- und
  Rechtefilter sowie die vorherigen Optimierungen bleiben wirksam.
- In Chrome lokal geprüft: Importdialog, grünes Häkchen der importierten Woche,
  Stunden und datierter Quellenstand sowie fehlendes Häkchen in der Folgewoche.
  Die automatische Dateiauswahl in Chrome war durch die fehlende Erweiterungsoption
  „Allow access to file URLs“ blockiert. Der gesamte Browser-Upload bleibt daher
  offen; der echte HTTP-Upload ist sowohl mit SQLite als auch PostgreSQL geprüft.
- Syntaxprüfungen und `git diff --check` bestanden.
- Persistenzaudit: null unklassifizierte Dateien und null Phasengrenzverletzungen.
  Die beiden bekannten Altbefunde zu Phase-4-Bindungen und historischem
  PostgreSQL-Provider-Slice bleiben bestehen; der Gesamtaudit ist deshalb nicht grün.

Lokale Prüfprotokolle: `tmp/xoffi-final-tests.log`,
`tmp/xoffi-native-reimport.log`, `tmp/xoffi-native-final.log`
(Dienstplan-Test bestanden; darin enthaltener früherer Xoffi-Fehler durch den
erneuten erfolgreichen Lauf abgelöst), `tmp/xoffi-browser.log` und
`tmp/xoffi-audit-final.log`. Die Testdaten sind synthetisch; die Fixtures
räumen ihre eigenen Daten auf.

Der lokale Testtab ist geschlossen; die eigene PostgreSQL-Testinstanz wurde
nach bestätigter Bereinigung gestoppt. Produktive Daten und VPS-Dienste wurden
in diesem Arbeitsblock nicht verändert.

## Ergänzung: Tagesfrist und Urlaubsplan

Die Frist verwendet die aktuellen Öffnungszeiten der Zielfiliale in Wiener
Ortszeit einschließlich geschlossener Tage, Feiertage und Filialsperrtage.
Beim Öffnen des Anfragedialogs und des Kalenders wird sie erneut vom Server
abgerufen. Beim Absenden prüft der Server die Frist innerhalb der Transaktion
erneut; ein bereits offener Dialog oder manipulierte Datumsgrenzen umgehen sie
nicht. Das Hinweisfeld zeigt Ladenschluss und Frist beziehungsweise die
Auswahl ab morgen. Quellfiliale und gewünschtes Teammitglied bestimmen den
Ladenschluss nicht.

Unter **Resturlaub je Teammitglied** erscheint zusätzlich das zuletzt
importierte **Xoffi-Urlaubsguthaben** mit Stichtag und bis zu zwei Nachkommastellen.
Der Hinweis erklärt, dass künftig fixierte Urlaube darin noch nicht berücksichtigt
sind. Ohne Quelle steht ausdrücklich „Noch kein Xoffi-Stand importiert“.
Bei vergangenen Planjahren werden spätere Quellenstände ausgeschlossen.
GP-Jahresanspruch, verplante Tage und GP-Resturlaub werden dadurch nicht verändert.
Die Abfrage lädt alle sichtbaren Quellenstände gesammelt statt einzeln pro Person.

Zusätzliche Verifikation dieser Ergänzung:

- 63 gezielte Tests bestanden, einschließlich Frist vor/auf/nach der Grenze,
  frischen Öffnungszeiten, geschlossenen Tagen, Berechtigungen und Urlaubsständen.
- Zwei native PostgreSQL-Tests bestanden: Xoffi-Import samt Urlaubsansicht sowie
  Dienstplan-/Urlaubs-Regressionen. Die eigene PostgreSQL-Testinstanz ist gestoppt.
- Chrome: Xoffi-Werte 37,5 und 12,75 Tage mit Stichtag sowie fehlender Import
  sichtbar geprüft. Nach Fristablauf ist heute nicht auswählbar; morgen und
  exakt sechs Monate voraus bleiben auswählbar, der Folgetag nicht.
- Syntax und `git diff --check` bestanden. Persistenzaudit weiterhin ohne neue
  unklassifizierte Dateien oder Phasengrenzverletzungen; dieselben zwei bekannten
  Altbefunde verhindern weiterhin einen insgesamt grünen Audit.

Protokolle: `tmp/xoffi-cutoff-vacation-tests.log`,
`tmp/xoffi-cutoff-vacation-native.log`, `tmp/xoffi-cutoff-vacation-audit.log`.
Screenshots und Hinweise zur bewusst weiterlaufenden lokalen Vorschau liegen
unter `output/xoffi-vorschau-20260917/`. Diese Vorschau verwendet ausschließlich
synthetische Personen und eine eigene lokale SQLite-Datenbank. Kein Deploy.
