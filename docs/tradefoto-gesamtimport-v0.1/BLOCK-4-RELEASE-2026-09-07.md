# Block 4: Auslieferung und kontrollierte Kassenuebernahme

Am 07.09.2026 wurde Block 4 nach Abschluss der lokalen Kassenanbindung
ausdruecklich gestartet. Der Releasekandidat ist v0.92.28-beta auf
`feature/schedule-pdf-day-separators`. Der bestehende TradeFoto-Katalog bleibt
erhalten. Ein erneuter vollstaendiger Trade-Aufbau gehoert nicht zu diesem Lauf.

## Vor dem Paketbau bestaetigt

- Installiert: v0.92.27-beta, Commit `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`,
  Linux-Runtime 4 und separat gebundenes Offsite-Modul 6.
- Die internen und oeffentlichen Live-/Ready-Pruefungen antworten jeweils 200.
  SQLite-Integritaet ist `ok`, Fremdschluesselfehler: 0. Der Personalbestand
  umfasst 18 Personal-Datensaetze (16 aktive und 2 inaktive).
  Freier VPS-Datentraeger: rund 72,43 GB.
- Der neue Runtime-5-Uebergang wurde gegen die vorhandenen Artefakte des
  installierten Quellcommits geprueft. Alle verwalteten Runtime-Dateien bleiben
  bis auf die beiden bestaetigten Start-/Stoppfenster bytegleich. Das
  Host-Hardening behaelt seinen bisherigen Fingerprint.
- Die vorhandenen funktionalen Kassen-, Dienstplan- und Samstagsnachweise
  wurden um gezielte Release-/Migrationspruefungen ergaenzt. Alte
  Versionsannahmen in den Vertragstests wurden an Runtime 5/Offsite 7 angepasst.

## Reihenfolge

1. Geprueften Commit und neutrales Serverpaket erzeugen; nur den zugehoerigen
   Branch veroeffentlichen. Absichtlich unversionierte Ausgabeordner erhalten.
2. App, Runtime 4 -> 5 und Offsite 6 -> 7 mit dem expliziten Migrationswerkzeug
   unter gemeinsamer Wartungssperre ausliefern. Vor dem App-Tausch sichern
   die vollstaendig geprueften Kandidatenwerkzeuge den gekoppelten Bestand
   lokal; der vorhandene Offsite-Hook sichert ihn auf Drive. Die unveraenderte
   Alt-Historie wird beim Uebergang weder bereinigt noch erneut voll gelesen.
3. Beide lokalen Sicherungsarchive mit vorhandenem Vault initialisieren und
   aktivieren. Ein Stand je Kalendertag, 20 Tage pro Bereich; kein pauschales
   Loeschen alter Rohsicherungen zur Finanzierung des Imports.
4. Die freigegebene Samstagsumstellung fuer vorhandene Verkaufsmitarbeitende
   aktivieren und den einmaligen Beleg gegen den Personalbestand pruefen.
5. Die zuletzt bereitgestellte Kassen-ACCDB persoenlich angemeldet importieren,
   ausdrueckliche GP-Zuordnungen bestaetigen und den vollstaendig geprueften
   Stand aktivieren. Ein alter Export darf bis zum naechsten Upload gelten.
6. Installierten App-/Offsite-Betrieb, gekoppelten Restore und den vollstaendigen
   signierten Assurance-Abschluss pruefen. Erst danach den produktiven
   Abschluss vermerken.

## Zweck und Datenstand

Der Grabenplaner verwendet die vorhandenen Kassen- und Warenwirtschaftsdaten
fuer Kundenkartei/CRM, historische Statistiken und darauf aufbauende
Management-Funktionen. Die Entwicklung eines eigenen Kassensystems ist nicht
Teil dieses Auftrags. Artikelbestaende und Artikelbuchungen sind ebenfalls
relevante Daten; sie beschreiben den jeweils zuletzt gelieferten Quellstand.
Wochen ohne neuen Export sind ein zulaessiger Betriebsfall. Uploadzeitpunkt und
fachlicher Datenstand muessen unterscheidbar bleiben. Ein alter Bestandsstand
ist keine Aussage ueber den aktuellen Lagerbestand.

Die allgemeine Oberflaechenangabe "Ruecknahmefrist: 30 Tage" beschreibt die
Ruecknahme klassischer Importaenderungen. Sie loescht keine Kassenhistorie.
Die kompakte Kassenanbindung schaltet zwischen erhaltenen Datenstaenden um;
dieser Wechsel hat keine entsprechende 30-Tage-Frist. Die lokale
Backupaufbewahrung von 20 Kalendertagen ist davon unabhaengig.

## Tatsaechlich ausgelieferter Stand

- App: `v0.92.28-beta`, Quellcommit
  `66c0210d90258d2d708b1177394d399c3c23ffb0`.
- Paket: `Grabenplaner-Server-v0.92.28-beta-linux-x64.zip`, 505 gepruefte Dateien,
  SHA-256 `0e16909701fb7b94e9f57acae83a606adc05f706772a6bd46c249cf5c6000711`.
- Runtime 4 -> 5 und Offsite-Modul 6 -> 7 wurden am 07.09.2026 um 14:49 UTC
  erfolgreich abgeschlossen. Migrationsbeleg:
  `/var/lib/grabenplaner/maintenance/history/runtime-v5-2026-09-07T14-49-14-660769816.json`.
- Die Samstagsumstellung ist ab 07.09.2026 belegt: 18 vorhandene
  Personal-Datensaetze haben die freigegebene Verkaufszuordnung. Der installierte
  Rechner liefert fuer 60 Arbeitsminuten samstags ab 13 Uhr 30 Bonusminuten,
  davor 0. Die Pruefung hat keine Zeitbuchungen angelegt.
- SQLite-Integritaet nach Migration: `ok`; Fremdschluesselfehler: 0.
- Beide lokalen Archive wurden mit dem bestehenden Vault initialisiert und
  aktiviert. Intervall: 24 Stunden; Aufbewahrung: 20 Kalendertage. Der erste
  interne Archivpunkt umfasst 604.448.013 gekoppelte Bytes bei 86.127.092 Bytes
  Archivgroesse. Noch nicht registrierte Alt-Rohsicherungen werden durch die
  Archivaktivierung nicht pauschal geloescht.
- Gemessener freier VPS-Speicher nach Archivaktivierung: 79.274.680.320 Bytes.
  Drive-Quota vor dem Abschlusslauf: 109.513.217.642 Bytes frei. Drive behaelt
  den bestehenden separaten Aufbewahrungsvertrag 14 taeglich / 8 woechentlich /
  12 monatlich; dies ist keine Umstellung auf 20 Tage auf Drive.
- Der vollstaendige signierte Wiederherstellungsnachweis des ausgelieferten
  Basisbestands bestand am 07.09.2026 um 15:19:06 UTC (Snapshot `b0164c7c8067`,
  Belegpraefix `2de03f0bdee0`). Dieser Nachweis liegt vor der Kassenaktivierung
  und ersetzt deren abschliessende Sicherungspruefung nicht.
- Die installierten Betriebspruefungen `grabenplaner-test` und
  `grabenplaner-offsite-test` liefen nacheinander erfolgreich durch
  (15:23:01 bzw. 15:23:24 UTC). Die eigenen temporaeren Paket- und
  Migrationsverzeichnisse wurden nach Identitaetspruefung entfernt.

## Fachliche Integrationsgrenze

Der vorhandene TradeFoto-Import versorgt Artikelkatalog, Preise und Kennungen.
Er ist kein vollstaendiger Import aller TradeFoto-Tabellen. Der GP-Kundenstamm
war bei dieser Abnahme noch leer. Kundenstammdaten, Artikelbestaende und
Artikelbewegungen muessen zusaetzlich angebunden werden; der Kassenimport
allein stellt diese Bereiche nicht vollstaendig bereit. Kaufhistorie und
Verkaufsstatistik verwenden den geprueften Kassenstand und ausdrueckliche
Zuordnungen. Nicht zugeordnete historische Quellnummern bleiben erhalten.

Der Nutzer hat 77 (Foto Straub) und 99 (USW United Camera Wien) ausdruecklich
als bestehende Verkaufsfilialen bestaetigt. Beide bleiben auf seinen Wunsch
in Navigation und Dienstplanung ausgeblendet. Das GP-Standortfeld `active`
steuert dort die Planung; es ist kein Beleg einer Betriebsschliessung. Die
Importoption fuer ein historisches / inaktives GP-Ziel erlaubt die regulaere
Verkaufszuordnung zu diesen vorhandenen Zielen. Ihre technische Kennzeichnung
`historical` bedeutet in diesem Fall nur diese ausdrueckliche Freigabe und
keine Beschraenkung auf vergangene Umsaetze. Die Oberflaechenkurzform
"historisch" ist dafuer missverstaendlich und darf fachlich nicht als
Schliessungsstatus verwendet werden.

## Unterbrechungen und Abschlussgrenze

Ein erster Runtime-Uebergang wurde vor dem App-Tausch durch das Zeitlimit des
aufrufenden Prozesses unterbrochen. Der vorherige Runtime-4-Stand wurde anhand
der installierten Manifest-Hashes wiederhergestellt. Der anschliessend
ausgelieferte Uebergang vermeidet die wiederholte Vollpruefung unveraenderter
Alt-Sicherungen und erhaelt seine Wiederanlaufunterlagen auch bei SIGTERM.
Diese Unterbrechung ist mit einem echten Linux-Signal regressiongeprueft.

Die automatisch gestartete Nachpruefung `app-updated` wurde vor der noch
ausstehenden Archivkonfiguration kontrolliert beendet. Ihr signierter
Fehlernachweis bleibt erhalten. Eine vollstaendige Pruefung der neuen
Archivkonfiguration wurde danach mit `manual-cli` gestartet.

Der persoenliche Kassen-Upload wurde auf Wunsch des Nutzers von ihm selbst in
der normalen Oberflaeche durchgefuehrt. Ein Uploadversuch wurde durch die
Wartungsphase der Wiederherstellungspruefung unterbrochen. Nach bestaetigter
internen und oeffentlichen Bereitschaft wurde dieselbe freigegebene Datei
erneut uebertragen. Alle 1.082.167 Zeilen sind produktiv gespeichert. Waehrend
dieses erfolgreichen Imports trat einmal HTTP 502 beim Statusabruf auf; die
Uebernahme lief weiter und die Anzeige wurde anschliessend aktualisiert.
Bis zum Importabschluss wird keine weitere Wartung mit App-Unterbrechung
gestartet.

Die Uebernahme wurde persoenlich unter GP-Personalnummer 252 begonnen. Die
Gleichheit von GP-Personalnummer 426 und TradeFoto-Verkaeufer 426 wurde durch
den Nutzer ausdruecklich bestaetigt. Weitere Zuordnungen werden anhand der
Quellnamen und vorhandenen GP-Ziele geprueft, nicht aus Nummerngleichheit
allein abgeleitet.

Systemweit bleiben 21 historische fehlgeschlagene Einheiten sichtbar:
18 bestanden bereits, drei weitere Kontrollanfragen liefen waehrend der
Wartung in ihr Zeitlimit. Diese Historie wurde nicht pauschal zurueckgesetzt;
die abschliessenden installierten Kontrollprotokollpruefungen bestanden.

## Produktive Kassenabnahme

Die zuletzt bereitgestellte Datei `Kassen_Umsätze.accdb` umfasst
330.928.128 Bytes. Ihr SHA-256 ist
`6a7e9f3cb8404299da54aef8c5ab661d7d66e1791003ebcd62c10d60a6a4e395`.
Der Exportstand bleibt 04.09.2026; der Bereitstellungsbeginn
07.09.2026 um 15:22:55 UTC ist davon getrennt dokumentiert.

Alle 1.082.167 Quellzeilen wurden auf dem VPS gespeichert und vollstaendig
zurueckgelesen. Der Vergleich bestaetigt die Quellpruefsummen aller sieben
Tabellen. Es gab keine Beschraenkung auf 24 Monate und keinen erneuten Upload
fuer die Pruefung oder Aktivierung.

Der persoenlich angemeldete Nutzerkontext aktivierte den Stand unter der
Bezeichnung **Kasse · Exportstand 04.09.2026**. Bestaetigt wurden sechs
Filialzuordnungen, 17 Verkaeuferzuordnungen (16 aktive Personalziele und eine
ausdrueckliche Zuordnung zu einem inaktiven Ziel) und 11.036 bereits
vorhandene Artikelbindungen. Es wurden keine neuen Artikel oder Kundenkarten
aus vermeintlicher Nummerngleichheit angelegt.

Die normale Oberflaeche lieferte fuer Grabenweg folgenden Belegabgleich:

| Belegtag | Gepruefte Positionen | Offene Rechenpruefungen | Brutto EUR |
| --- | ---: | ---: | ---: |
| 03.09.2026 | 47 | 0 | 2.494,51 |
| 04.09.2026 | 37 | 0 | 1.001,71 |
| Zusammen | 84 | 0 | 3.496,22 |

Die Nettosumme dieser Auswahl ist 2.913,62 EUR. Innerhalb genau dieser
Auswahl sind Artikel-, Filial-, Positionsverkaeufer- und
Belegverkaeuferreferenzen vollstaendig zugeordnet. Das ist keine Aussage,
dass saemtliche historischen Quellnummern aller Zeitraeume schon GP-Ziele
besitzen.

Die anschliessende Vollpruefung der produktiven SQLite-Datenbank ergab
`integrity_check: ok` und null Fremdschluesselfehler. Alle sieben
Quelltabellenzahlen und alle 11.059 Bindungen wurden gegen den gespeicherten
Aktivierungsstand geprueft. App und Caddy sind aktiv und beim Systemstart
aktiviert; interne und oeffentliche Live-/Ready-Endpunkte liefern jeweils
HTTP 200. Die App lauscht nur auf `127.0.0.1:3000`.

Messung am 07.09.2026 um 16:07 UTC: 1.491.234.816 Bytes produktive Datenbank,
42.860.392 Bytes Schreibjournal und 75.046.424.576 Bytes freier VPS-Speicher.
Die kompakt geschriebene Sicherungsdatenbank umfasst 1.420.673.024 Bytes;
dieser Wert beschreibt die Sicherung und darf nicht mit der laufenden
Datenbank einschliesslich Schreibjournal gleichgesetzt werden.

## Erfolgreicher Wiederherstellungsabschluss

Der aktivierte Stand wurde mit dem installierten Hintergrundsicherungsprozess
bei laufender App gesichert. Das Offsite-Modul uebernahm genau diesen
geprueften gekoppelten Stand ueber seinen vorhandenen `--backup-result`-Weg.
Der komplette Ablauf bis zum Wiederherstellungsnachweis verlief mit
unveraenderter App-Prozess-ID und ohne weitere App-Unterbrechung.

- Lokaler gekoppelter Sicherungspunkt:
  `dienstplan-2026-09-07T16-03-33-775Z-58f365640cd9`.
- Sicherungsdatenbank SHA-256:
  `f7c7f29cc461a23f1882f1feaf0bbe1793be34073c102e58d0f5723815f0a6b9`.
- Drive-Snapshotpraefix: `352768b06806`.
- Vollstaendige Repositorypruefung bestanden: 16:11:21 UTC.
- Isolierte Wiederherstellung bestanden: 16:15:21 UTC.
- Isolierter App-Start bestanden: 16:15:22 UTC.
- Signierter Gesamtabschluss `full-assurance-passed`: 16:15:23 UTC
  (18:15 Uhr Wien), Wiederherstellungsbelegpraefix `db77ec73bf89`.
- Der verifizierte Assurance-Status ist `ok`. Das vorhandene Ubuntu-Hinweisfeld
  fuer einen spaeteren kontrollierten Hostneustart bleibt davon getrennt.

Nach Entfernen der temporaeren Wiederherstellungsumgebung sind
76.474.699.776 Bytes am VPS frei. Die anschliessende Live-Abfrage auf Drive
ergab 108.999.376.999 Bytes frei. Das lokale externe Sicherungsarchiv belegt
539.916.472 Bytes; es enthaelt den aktivierten Kassenstand. Das interne Archiv
belegt 86.674.728 Bytes und enthaelt noch den davor automatisch erzeugten
GP-Stand. Beide Archive sind auf 24 Stunden / 20 Kalendertage eingestellt und
enthalten am ersten Tag jeweils einen Archivpunkt. Die naechste regulaere
interne Sicherung uebernimmt ebenfalls den inzwischen aktivierten Bestand.

Fuenf interne und 36 externe Rohsicherungen aus der bestehenden Historie
bleiben erhalten; die Archivaktivierung ist kein pauschales Loeschen dieser
Altbestaende. Die eigenen temporaeren Paket-, Migrations- und
Abschlussverzeichnisse wurden nach gepruefter Identitaet entfernt.

**Der kontrollierte Kassenimport und die Betriebs-/Wiederherstellungsabnahme
von Block 4 sind abgeschlossen.** Die oben beschriebene fachliche
Integrationsgrenze fuer CRM-Stammdaten, Bestaende und Artikelbewegungen bleibt
bestehen. Maschinenlesbarer Abschlussbeleg:
[`BLOCK-4-ABNAHME-2026-09-07.json`](BLOCK-4-ABNAHME-2026-09-07.json).
