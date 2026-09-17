# Urlaubsplaner, PDF-Auswahl und Dashboard-Kennzahlen

Stand: 18.09.2026. Implementiert und lokal geprüft. Der VPS-Deploy steht aus.
Ergänzt die Änderungen aus
`PERFORMANCE-WOCHENWECHSEL-2026-09-17.md`.

## Urlaubsplaner: Filialwechsel

Der Filialwechsel löste zuvor `loadAll()` aus. Dadurch musste die Oberfläche
zusätzlich den Dienstplan, die Mitarbeiterverwaltung, Branding und weitere
Grunddaten laden. Der Urlaubsplan allein war deutlich günstiger.

Der Wechsel lädt jetzt nur den gewählten Urlaubsplan. Das gilt für Filiallinks,
Navigation, Browser-Zurück/Vorwärts und den Einstieg aus dem Startdashboard.
Beim Zurückwechseln zur Dienstplanung wird deren Filialkontext geprüft, damit
kein zuvor geladener Plan einer anderen Filiale stehen bleibt. Überholte
Antworten werden abgebrochen bzw. verworfen; Abteilungsrechte bleiben erhalten.
Der Server verwendet auch hier die gemeinsame schreibgeschützte Lesetransaktion
mit abschließender aktueller Berechtigungsprüfung.

### Gemessen mit nativer lokaler PostgreSQL-Datenbank

Zwei synthetische Filialen mit 18 bzw. 21 Personen und 72 bzw. 84
Urlaubseinträgen. Vollständiger Jahreskalender 2026 in Chrome:

| Gewählte Filiale | Abruf und vollständige Darstellung |
|---|---:|
| 18 | 298 ms |
| 05 | 142 ms |
| 18 | 202 ms |

Die API-Antworten der isolierten Gegenprobe benötigten beim Filialwechsel
28–34 ms. Gleiche Ergebnisse mit und ohne gemeinsame Lesetransaktion wurden
vollständig verglichen. Im Browser wurden Eintragszahlen und jeweilige
Filialauswahl geprüft. Die Zeiten stammen vom lokalen Rechner; eine Messung
über die reale VPS-Verbindung steht bis zum Deploy aus.

## PDF-Analysen: letzte persönliche Auswahl

Die Auswahl wird im bestehenden benutzerbezogenen Präferenzspeicher gehalten:

- Statistikbericht, Filial- und Datumsfilter;
- Berichtszeitraum bzw. Jahr bis Berichtsende;
- Grafikart und Kennzahl.

`GET/PUT /api/sales-analytics/selection` verwendet den angemeldeten Account und
die bestehenden Analyse- und CSRF-Prüfungen. Die Berichtsdaten werden weiterhin
über den berechtigungsgeprüften Detailabruf geladen. Ein gespeicherter Bericht
außerhalb der ersten 200 Archivtreffer wird gezielt nachgeladen. Wenn er nicht
mehr verfügbar oder freigegeben ist, erscheint ein Hinweis und eine verfügbare
Auswahl wird verwendet. Gespeicherte Rohertragsauswahl gibt keine zusätzlichen
Rechte; nach Entzug des Margenrechts wird eine öffentliche Kennzahl verwendet.

Speichervorgänge laufen geordnet, sodass schnelle Auswahlwechsel nicht durch
ältere Antworten überschrieben werden. Explizite Auswahländerungen werden
sofort gespeichert; kleine PUT-Anfragen verwenden `keepalive` für Seitenwechsel.
Persönliche PDF-Exportoptionen behalten ihren eigenen Speicherbereich.

Browserprüfung: Trotz vorhandenem August-Bericht wurde der Juli-Bericht nach
Seitenneustart wieder angezeigt. Filialfilter, Zeitraum, Pareto-Darstellung und
die ausdrücklich gewählte Rohertragskennzahl wurden ebenfalls wiederhergestellt.

## Startdashboard

Die bestehende Filialauswahl und Auswahl des jüngsten freigegebenen Berichts
sind unverändert. Unter „Stärkste Warengruppen“ lassen sich per Pfeiltasten oder
Auswahlfeld sechs Ranglisten durchschalten:

1. Umsatz netto
2. RE absolut
3. RE %
4. Kundenanzahl
5. Ø €/Kunde
6. Menge

RE % = Rohertrag / Nettoumsatz × 100, je Warengruppe. Bei fehlenden Werten oder
Nettoumsatz ≤ 0 wird kein Prozentwert erfunden. Die fünf höchsten verfügbaren
Werte werden angezeigt. Beide RE-Ansichten benötigen das bestehende
Rohertragsrecht. Ø €/Kunde übernimmt den vorhandenen PDF-Wert. Die Bezeichnung
„€/Kunde“ folgt der letzten ausdrücklichen Korrektur des Benutzers.

Die Kennzahlenauswahl bleibt im Browser je Benutzer erhalten. Das Durchschalten
verwendet den bereits geladenen Bericht und benötigt keinen neuen Datenabruf.
Im synthetischen Browserbeispiel wurden 25 Euro RE, 25 %, zwei Kunden und
50 Euro je Kunde korrekt angezeigt. Keine Browser-Konsolenfehler.

## Verifikation und Nachweise

- 97 gezielte Tests und bestehende Regressionstests bestanden; anschließend
  ein zusätzlicher Test für alte Archivberichte und zwischenzeitlich geänderte
  Benutzerauswahl ergänzt. Alle acht Auswahl-/Kennzahlentests danach bestanden.
- Nativer PostgreSQL-Integrationstest bestanden: Dienstplan- und Urlaubsantworten,
  Filialtrennung, tatsächliche Speicherung der PDF-Auswahl, Trennung zweier
  Benutzerkonten, Ablehnung ohne CSRF und Zugriffsentzug während des Ladens.
- Syntaxprüfungen und `git diff --check` bestanden.
- Persistenzaudit: keine neuen Verstöße; dieselben zwei dokumentierten älteren
  Phase-4-/Provider-Slice-Befunde wie beim vorherigen Arbeitsblock bleiben offen.
- Ein veralteter UI-Test erwartete die bereits veröffentlichte Einkaufsansicht
  noch nicht in der Navigation. Seine erlaubte Routenliste wurde vervollständigt.
- Eigene synthetische Testdaten wurden durch die bewachten Fixtures entfernt;
  Testtab und lokale PostgreSQL-Testinstanz wurden geschlossen.

Lokale Protokolle:

- `tmp/vacation-sales-final-tests.log`
- `tmp/vacation-sales-selection-final.log`
- `tmp/vacation-sales-final-native.log`
- `tmp/vacation-sales-browser.log`
- `tmp/vacation-sales-browser-20260917/measurements.json`
- `tmp/vacation-sales-audit.log`

Keine produktiven Daten, Uploads, Zugangswege oder VPS-Dienste wurden geändert.
