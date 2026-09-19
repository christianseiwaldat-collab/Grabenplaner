# Dienstplan: Optimierung des Wochenwechsels

Stand: 18.09.2026. Implementiert und lokal geprüft auf Basis von
`f1a40c2f98eea64122c9606c88c36ab22e9ed359`, Branch
`feature/schedule-pdf-day-separators`. Die folgenden Messungen und Prüfungen
beschreiben diesen lokalen Arbeitsstand. Spätere Fehlerkorrekturen und der
VPS-Veröffentlichungsstand stehen in
[CI-Fehlerkorrektur](CI-FEHLERKORREKTUR-2026-09-18.md) und
[Release v0.92.60](DEPLOY-RELEASE-v09260.md).

## Ergebnis und Messgrenze

Ziel ist ein vollständig angezeigter Wochenwechsel innerhalb etwa einer Sekunde.
Ein lokaler Chrome-Test mit nativer PostgreSQL-Datenbank, 21 Personen und
108 Schichten pro regulärer Testwoche ergab:

| Wechsel | Zeit bis zur vollständigen Darstellung |
|---|---:|
| KW 38 → KW 39 | 918 ms |
| KW 39 → KW 38 | 853 ms |
| KW 38 → KW 37 | 782 ms |

Die Messung umfasst den frischen API-Abruf, die komplette Plan-Darstellung und
zwei Animation-Frames. Überschriften, Datumsbereiche und Planraster wurden im
Browser geprüft; die Browserkonsole enthielt keine Fehler. KW 37 enthält eine
zusätzliche vorhandene Fixture-Schicht. Alle Testdaten waren synthetisch.

Dies ist keine VPS-Messung oder Garantie für jede Lastsituation. Nach einem
Deploy sind normale Wochenwechsel über die reale Verbindung erneut zu messen.
Der Browser hält dafür jeweils nur die letzte anonyme User-Timing-Messung
`gp.schedule-week` und `#timeline.dataset.weekLoadMilliseconds` bereit.
Es werden keine Messdaten versendet und keine Personendaten aufgezeichnet.

## Änderungen

- Der Dienstplan und drei häufige Hintergrundlisten lesen zusammengehörige Daten
  innerhalb einer gemeinsamen schreibgeschützten PostgreSQL-Transaktion.
- Identische Abfragen werden ausschließlich innerhalb desselben Abrufs
  zusammengefasst. Ein neuer Wochenabruf liest wieder aktuelle Daten.
- Eine abschließende aktuelle Berechtigungsprüfung bleibt erhalten. Die Antwort
  wird erst danach gesendet. Schreibzugriffe und eigenständige Transaktionen
  können diesen Lesevorgang nicht verlassen; explizit schreibgeschützte
  Repository-Transaktionen verwenden dieselbe Transaktion.
- Samstagszuordnungen werden bei normalen Wochentagen nicht mehr unnötig
  geladen. Regelprofilversionen werden je Planungsauswertung einmal aufgelöst.
- Parallele automatische Listenaktualisierungen werden zusammengeführt. Bei
  verborgenem Browserfenster oder laufendem Wochenabruf starten keine neuen
  Hintergrundaktualisierungen; manuelles Öffnen lädt weiterhin sofort.
- Ein Wochenwechsel zeichnet den vollständigen Planbereich neu. Fachfremde
  Verwaltungsansichten werden dabei nicht nochmals aufgebaut.
- Die RAM-Anzeige berücksichtigt unter Linux `MemAvailable`, einschließlich
  zurückgewinnbarem Dateicache. Bei fehlenden Werten bleibt der OS-Fallback.

Keine Datenbankmigration, zusätzliche Abhängigkeit oder Vergrößerung der
Verbindungspools ist erforderlich.

## Native PostgreSQL-Gegenprobe

Die isolierte HTTP-Gegenprobe aktiviert bzw. deaktiviert die gemeinsame
Lesetransaktion im selben Testprozess. Andere Optimierungen sind in beiden
Varianten bereits enthalten; dies ist deshalb keine vollständige Messung
gegen den unveränderten früheren Programmstand.

| Kontrollierter Abruf | Ohne gemeinsame Lesetransaktion | Mit gemeinsamer Lesetransaktion |
|---|---:|---:|
| Vollständige Wochenantwort | 1.653 ms | 642 ms |
| Gezählt: Katalog-/Operationszugriffe | 214 | 82 |
| Aufrufe der Berechtigungsprüfung | 215 | 4 |

Die JSON-Antworten beider Varianten wurden vollständig verglichen. Weitere
Wochen benötigten 515, 699 und 634 ms. Beim parallelen Abruf von Dienstplan,
Anträgen, AUM und Krankmeldungen lagen die Zeiten bei 687, 76, 159 und 85 ms.
Diese Listen waren mit synthetischen Datensätzen befüllt.

Der native Test prüft zusätzlich Änderungen zwischen zwei Abrufen und den
Zugriffsentzug unmittelbar vor der abschließenden Berechtigungsprüfung: Es
werden keine Plandaten ausgegeben; der nächste Abruf wird als nicht angemeldet
abgewiesen. Der absichtlich ausgelöste Fehler erscheint im Testprotokoll.

## Prüfungen

- 40 gezielte Tests zu Lesevorgängen, Navigation, Hintergrundaktualisierung,
  RAM-Anzeige und Wiederherstellungsbudget bestanden.
- 124 bestehende API-/Regeltests zu Dienstplanung, Standortrechten,
  Samstagsgutschrift, Krankmeldungen, Anträgen, manuellen Plansperren und
  Systemanzeige bestanden.
- Ein nativer PostgreSQL-Integrationstest bestanden, einschließlich kompletter
  Antwortgleichheit, frischer Änderungen und Zugriffsentzug während des Abrufs.
- Chrome-Gegenprobe mit vollständiger Darstellung bestanden.
- JavaScript-Syntaxprüfung und `git diff --check` bestanden.
- Persistenzaudit: keine unklassifizierten Dateien, keine Grenzverletzungen.
  Das Gesamtaudit bleibt wegen derselben zwei älteren Befunde wie beim Release
  v0.92.56 auf Fehler: Phase-4-Statement-/Dialektbindungen und historischer
  PostgreSQL-Provider-Slice. Diese Befunde wurden nicht unterdrückt oder als
  behoben ausgegeben. Die neue interne Datei ist ausdrücklich inventarisiert.

Der Browser-Login widerruft bestimmungsgemäß die vorherige Sitzung. Im optionalen
Browser-Testzweig wird deshalb nach der Sichtprüfung eine neue synthetische
Sitzung für den anschließenden Zugriffsentzugstest angelegt. Dieser Zweig wurde
nach der Korrektur ebenfalls erfolgreich ausgeführt.

## Damaliger Wiederherstellungstest: Zeitlimit und Speicherbedarf

Das gemeinsame Zeitbudget für native Wiederherstellung und anschließenden
Anwendungsfunktionstest wurde von 15 auf 30 Minuten erhöht. Speichergrenze,
CPU-Grenze, Prozessgruppenbeendigung und Abschottung bleiben erhalten.
Es wurde kein vollständiger neuer Wiederherstellungs- oder Access-Importtest
gestartet. Der tatsächliche Abschluss innerhalb von 30 Minuten ist noch offen.

Die vorangegangene VPS-Diagnose ergab etwa 4,014 GB für die Kopie des
Sicherungspakets und 11,230 GB für die wiederhergestellte Testdatenbank samt
Arbeitsdateien, zusammen 15,243 GB. Eine lauffähige Wiederherstellung benötigt
mehr Platz als das komprimierte Sicherungspaket.

Der bereits fehlgeschlagene Testordner wurde in diesem Arbeitsblock nicht
gelöscht. Die vorhandene Bereinigung erfolgt weiterhin nur nach erfolgreichem
Test; eine begrenzte Aufbewahrung mit sicherer Fehlerbereinigung ist weiterhin
offen. Das längere Zeitlimit allein beseitigt diesen bestehenden Rest nicht.

## Lokale Belege

- `tmp/speed-unit-final-20260917.log`: 40 gezielte Tests.
- `tmp/speed-api-20260917.log`: 124 Regressionstests.
- `tmp/schedule-native-final-20260917.log`: native Gegenprobe und obige API-Zeiten.
- `tmp/speed-native-qa-final-20260917.log`: erfolgreicher optionaler Browser-Zweig
  und anschließender Zugriffsentzugstest; native Gegenprobe erneut bestätigt.
- `tmp/speed-browser-20260917/measurements.json`: im Browser abgelesene Zeiten.
- `tmp/speed-audit-final-20260917.log` verglichen mit
  `tmp/v09256-audit.json`: unveränderte zwei Audit-Altbefunde.
- `output/DIAGNOSE-VPS-2026-09-17.md`: vorausgehende Live-Diagnose mit
  Server-, Platten- und Antwortzeitnachweisen.
