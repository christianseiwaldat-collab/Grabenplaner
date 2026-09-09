# Verkaufsanalysen: Bereiche und spätere Berichtserstellung

Stand: 08.09.2026. Die Oberfläche ist lokal umgesetzt, noch nicht veröffentlicht.
Die Verarbeitung neuer Datenbankberichte ist ein Zielbild für einen späteren
Entwicklungsauftrag und in diesem Stand nicht aktiviert.

## Lokal umgesetzt

Die Verkaufsanalysen öffnen mit einem kompakten Menü in dieser Reihenfolge:

1. **Bericht erstellen**: einfache Suchmaske als vorbereiteter Einstieg.
2. **PDF-Analysen**: bisheriger PDF-Import, Kennzahlen, Grafiken,
   Warengruppentabelle, Export und PDF-Berichtsarchiv.
3. **Berichte**: vorbereitete Ablage für künftig ausdrücklich beauftragte
   Berichte und ihren Bearbeitungsstand.

„Einzelverkäufe & Kassenhistorie“ ist aus den Verkaufsanalysen nach
„Kassenberichte & Belegsuche“ verschoben. Der bestehende aufklappbare Bereich
behält seine Quellenprüfung, Filter und Berechtigungen. Die Belegsuche bleibt
auf derselben Seite verfügbar; Datenquellen und Summen werden nicht vermischt.

Die Suchmaske und Berichtsablage sind als „In Vorbereitung“ gekennzeichnet.
Der Auftragsknopf ist deaktiviert; auch Enter sendet keinen Auftrag. Es werden
keine Suchbegriffe oder fingierten Berichtsaufträge auf dem Server gespeichert.
Eine Eingabe bleibt bei Bereichswechseln im geöffneten Browser erhalten und
wird beim Kontowechsel verworfen.

PDF-Daten werden beim ersten Öffnen von „PDF-Analysen“ geladen. Wechsel zu
„Berichte“ oder „Bericht erstellen“ erhalten die bestehende PDF-Auswahl.
Die Tastaturbedienung unterstützt Tab sowie Links/Rechts und Home/End im Menü.
Die Funktionssuche öffnet die jeweils richtige Unterseite, auch beim direkten
Sprung zum PDF-Import, PDF-Archiv oder zur verschobenen Kassenhistorie.
Die vorhandenen Rechteprüfungen gelten weiterhin.

## Zielbild für längere Serveraufträge

```mermaid
flowchart LR
  A[Auswahl und ausdrücklicher Auftrag] --> B[Auftrag dauerhaft speichern]
  B --> C[Begrenzte Warteschlange]
  C --> D[Separater Berichtsprozess]
  D --> E[Geprüftes Ergebnis veröffentlichen]
  B --> F[Berichte: Bearbeitungsstand]
  E --> F
```

**Auftrag:** Erst „Bericht beauftragen“ startet die Verarbeitung. Der Server
prüft Berichtsart, Parameter und alle benötigten Datenrechte, speichert den
Auftrag mit einer eindeutigen Kennung und bestätigt ihn sofort. Doppelklick
oder Netzwerkwiederholung dürfen keinen zweiten identischen Auftrag erzeugen.
Die Suchmaske führt keine freien SQL-Abfragen aus. Fachliche Suchbegriffe
werden später auf zugelassene Berichtsarten und begrenzte Parameter abgebildet.

**Bearbeitung:** Ein separater Prozess erledigt die aufwendigen Abfragen und
Dateiexporte. Zunächst ist ein gleichzeitig laufender Bericht sinnvoll;
Arbeitsspeicher, Rechenzeit, temporärer Speicher und Warteschlangenlänge werden
begrenzt. Die normale App bleibt für Dienstplanung und Belegsuche bedienbar.
Es gibt keinen Hintergrundlauf allein durch Öffnen, Tippen oder Suchen.

**Nachvollziehbarer Datenstand:** Jeder Auftrag erhält Quelle, freigegebenen
Import-/Veröffentlichungsstand, Datenabdeckung und Version der verwendeten
Auswertungsregeln. Maßgeblich bleiben die zuletzt hochgeladenen Daten.
TradeFoto, TradeKassa, PDF-Statistiken und Kassenbewegungen werden fachlich
getrennt; fehlende Tage sind kein nachgewiesener Nullumsatz.

Ein neuer Vollabzug der großen SQLite-Datenbank für jeden Bericht ist nicht
vorgesehen. Bevorzugt wird auf einem festgehaltenen, unveränderlichen
Veröffentlichungsstand in begrenzten Schritten gelesen. Dessen Daten müssen
bis zum Auftragsabschluss verfügbar bleiben. Für veränderliche Zuordnungen
ist vor Umsetzung ein konsistenter Stand festzulegen. Eine lange offene
SQLite-Lesetransaktion darf nicht unkontrolliert das Journal anwachsen lassen.

**Berichtsablage:** Eigene Aufträge zeigen etwa „Wartet“, „In Bearbeitung“,
„Fertig“, „Fehlgeschlagen“, „Unterbrochen“ oder „Abgebrochen“. Echte
Arbeitsschritte und verarbeitete Mengen sind besser als geschätzte Prozentwerte.
Fertige Ergebnisse enthalten Auswahl und Datenstand. Downloads prüfen die
aktuellen Rechte erneut; ein früher erteiltes Recht genügt bei späterem Entzug
nicht. Ergebnisse liegen außerhalb des öffentlich abrufbaren Webverzeichnisses.
Verkäufer-, Kunden-, Finanz- und Margendaten behalten ihre getrennten Rechte.

**Unterbrechungen und Wartung:** Aufträge überstehen das Schließen des Browsers.
Der Server speichert Bearbeitungszustand und gegebenenfalls belastbare
Fortsetzungspunkte. Nach Absturz oder Neustart werden zurückgelassene Aufträge
erkannt, begrenzt wiederholt oder ausdrücklich als unterbrochen angezeigt.
Ein Ergebnis wird erst nach erfolgreicher Fertigstellung atomar freigegeben;
teilweise Dateien erscheinen nicht als fertige Berichte.

Vor Updates, Sicherungen mit Stillstand oder einem Host-Neustart werden keine
neuen Berichte begonnen. Aktive Arbeit endet an einem sicheren Punkt oder
wird nachvollziehbar unterbrochen. Die bestehenden Sicherungs- und
Wiederherstellungsprüfungen bleiben erforderlich. Die Datenbank wird nicht
durch lang laufende Berichte während der Wartung blockiert.

**Vor der späteren Umsetzung festzulegen:** erster konkreter Bericht samt
Kennzahlen und Regeln, Filter, Ausgabeformate, Sichtbarkeit/Weitergabe,
Aufbewahrung, Speichergrenzen und Wiederholungsverhalten. Dieser Entwurf führt
keine zusätzlichen Rechte, automatischen E-Mails oder Löschregeln ein.

## Nachweis und Grenze

57 vorhandene gezielte Prüfungen für Verkaufsanalysen, Verkaufsnavigation,
Belegsuche, Historienzugriff und Funktionssuche bestanden nach dem Umbau.
Protokoll: `tmp/sales-workspace-tests-2026-09-08.tap`.
Weitere sieben Prüfungen der rollenbezogenen Funktionssuche bestanden;
Protokoll: `tmp/sales-function-search-readiness-2026-09-08.tap`.

Zusätzlich wurde die vollständige App mit einer eigenen synthetischen
Datenbank in Chrome geprüft: Menü und aktive Panels, Tastaturbedienung,
Eingabeerhalt, PDF-Auswahlerhalt, Import- und Historiensprung über die
Funktionssuche, Hell-/Dunkeldarstellung und Kontowechsel ohne Übernahme des
Suchentwurfs. Die Historie liegt nachweislich unter `receiptSearchView`.
Die neue Suchmaske verursacht keinen horizontalen Seitenüberlauf.
Direkteinstiege mit `?view=salesAnalytics&section=reports` und `section=pdf`
wurden einschließlich aktivem Zielbereich geprüft.
Keine Konsolenwarnungen oder -fehler wurden dabei erfasst.

Die synthetische Datenbank enthält keine produktiven Kassenimporte; die
Umplatzierung wurde mit dem korrekten Zustand ohne freigegebene Quelle geprüft.
Die vorhandenen gezielten Prüfungen ergänzen diese Sichtprüfung. Weder neue
Berichtsjobs noch eine große Datenbankauswertung oder eine VPS-Veröffentlichung
wurden damit getestet oder als umgesetzt behauptet.
