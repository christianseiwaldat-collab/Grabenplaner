# Einstellungen und zentrale Datenbankimporte

Stand: 13.09.2026. Lokal umgesetzt, noch nicht veröffentlicht. Basis ist
`9ced7472dbf202849999eced042d9b0d4d4e39e5`, Version `0.92.42-beta`.
Die vorhandenen lokalen Anzahlungsänderungen bleiben erhalten. Der Benutzer
hat die Veröffentlichung ausdrücklich zurückgestellt.

## Bedienung

- Unter **Einstellungen → Personal** befinden sich jetzt die aufklappbaren
  Gruppen **Urlaub**, **Zeiterfassung** und **Import & Lohnverrechnung**.
  Vorhandene Felder, Speichern, Rechte und alte Direktlinks bleiben nutzbar.
- Unter **Einstellungen → System & Backups → Datenbankimporte** befinden sich
  sämtliche ACCDB-Einstiege. Der frühere Import im Artikelstamm und der
  Gesamtimport in der Verkaufsverwaltung wurden dorthin verschoben.
- **Lokale Altinstallation auf USB-Stick** entfällt aus der Oberfläche und
  aus der Funktionssuche. Die Suche nach **ACCDB** öffnet die neue Gruppe.
- Die technische Fußzeile liest Anbieter und Version aus dem laufenden
  Datenbankserver. Produktiv wurde PostgreSQL **18.6** lesend bestätigt.
  Lokale SQLite-Installationen zeigen weiterhin ihren tatsächlichen Anbieter.

Die zentrale Gruppe bietet zwei bestehende, unterschiedliche Datenwege:

| Bedienung | Zweck |
| --- | --- |
| TradeFoto-Artikelstamm aktualisieren | Artikel und Preise aus `Trade_Daten.accdb` mit dem sichtbaren GP-Artikelstamm vergleichen und bestätigt übernehmen. Manuelle Konflikte und eigene Artikelbilder bleiben geschützt. |
| Quelldaten importieren | Die vollständige freigegebene Quellprojektion der ausgewählten Datei bereitstellen, prüfen und übernehmen. |

Im zweiten Datenweg stehen `Trade_Daten.accdb`, `Kassen_Umsätze.accdb` und
`Trade_DatenBestell.accdb` zur Auswahl. Der allgemeine Trade-Quellimport ersetzt
nicht automatisch den gesonderten Artikelabgleich. Quelldaten-Zuordnungen zu
GP-Mitarbeitenden und CRM-Karten behalten ihre bestehende Freigabesperre;
ein Datei-Upload verändert keine solchen manuellen Bindungen.

## Übernahme und Schutz

Der vorhandene Importvertrag wird erweitert, nicht durch eine neue API oder
unabhängige Datenbank ersetzt. Anmeldung mit persönlichem Gesamtimportrecht,
CSRF-Prüfung, verschlüsselte Bereitstellung und Prüfprotokoll gelten für alle
drei Dateiquellen. Nicht freigegebene Tabellen und Felder werden nicht gelesen;
verknüpfte Access-Dateien werden nicht geöffnet.

Der Server prüft Dateiformat, bekannte Tabellen, Spalten, Typen und Zeilenzähler.
Erst eine vollständig bereitgestellte Datei kann übernommen werden.
Ungeklärte Struktur- oder Zählerabweichungen sperren die Übernahme. Die
Artikelvorschau hat weiterhin ihre eigenen Konflikt- und Revisionsprüfungen.

Der Upload wird mit HTTP 202 quittiert; Fortschritt kann danach abgefragt
werden. Ein isolierter Reader verarbeitet begrenzte Seiten mit Rückstaukontrolle.
Er erhält bei HTTP-Uploads die ursprüngliche Dateiallokation per Übergabe des
Speicherbesitzes. Damit entfällt eine zusätzliche vollständige ACCDB-Kopie im
Webprozess. Ausschnitte aus gemeinsamem Speicher werden nicht abgetrennt;
Originaldateien und Kennwörter werden nicht auf dem Server abgelegt.

Der generische Trade-/Bestell-Import übernimmt Datensätze in fortsetzbaren
Transaktionsblöcken. Er ist kein atomarer Austausch aller Tabellen auf einmal.
Wiederholung derselben Datei erzeugt keine doppelten Geschäftsdaten. Änderungen
bleiben versioniert und können innerhalb der bestehenden Rücknahmefrist
zurückgenommen werden, sofern keine nachfolgenden Abhängigkeiten widersprechen.
Kassenstände verwenden weiterhin den eigenen kompakten Speicher mit bewusster
Veröffentlichung für neue Berichte und Rückkehr zum vorherigen Stand.

Das Schließen der Importgruppe oder der Wechsel der Einstellungen beendet
unsichtbare Abfragen und entfernt die private Vorschau. Eine schon angenommene
Bereitstellung am Server kann weiterlaufen. Die Oberfläche zeigt Dateinamen
vollständig umgebrochen und funktioniert bei 390 Pixel Bildschirmbreite.

## Bestelldaten und PostgreSQL

Übernommen werden die geprüften Profile aus der lokalen Bestell-Vorbereitung:
21 Geschäftstabellen mit 728 Feldern. Sechs technische beziehungsweise fremde
Tabellen, darunter `Kasse_Zeiterfassung`, bleiben ausgeschlossen.

Die Speicherung nutzt die bereits qualifizierte Importhistorie der gemeinsamen
Sales-Datenbank. Die Quellenfamilie heißt `trade`; das genaue Quellsystem heißt
`tradefoto.bestell`, die Quellinstanz `tradefoto-bestell`. Die neuen Profile
behalten ihre `trade-bestell.*`-Kennungen und Fingerabdrücke. Es gibt keine
Tabellennamenskollision mit den bestehenden Trade-Profilen. Die ursprünglichen
43 Historienprofile sind unverändert, zusammen sind es 64 Profile/1.161 Felder.

Diese Integration benötigt keine neue PostgreSQL-Tabelle oder Schemamigration.
Der geprüfte Sales-SQL-Katalog enthält unverändert 219 Anweisungen. Die vier
separaten Tabellen und der eigenständige Demo-Server der Vorbereitung werden
nicht kopiert. Die bestehenden GP-Repositorys übernehmen Schreiben, Lesen,
Verschlüsselung und Rücknahme. Bestellrechnungen werden dadurch nicht zusätzlich
als Kassenumsatz gezählt. Reparatursuche, Filialkonto-Paket und neue
Bestandskennzahlen sind nicht Bestandteil dieses Einstellungsumbaus.

## Prüfung dieses Arbeitsstands

- 56 gezielte Tests für Importlaufzeit, HTTP-/Rechteschutz, Speicherübergabe,
  Layout und Navigation bestanden (`tmp/settings-import-final-tests.txt`).
- 44 Tests zur Funktionssuche, ihrem Katalog und den Rechte-/Navigationsgrenzen
  bestanden (`tmp/settings-function-search-final.txt`); teilweise identisch mit
  den Navigationstests des vorherigen Aufrufs, daher nicht zu 100 addieren.
- Drei Historien-Vertragstests bestanden, einschließlich vollständigem
  synthetischem Schreiben/Rücklesen aller 64 Profile und Erhalt der ursprünglichen
  Profile (`tmp/settings-history-contract-final.txt`).
- Der gezielt ausgewählte statische Einstellungsdesign-Test bestand
  (`tmp/settings-appearance-static-final.txt`). Ein zusätzlich angestoßener,
  nicht betroffener Legacy-Startmigrationstest überschritt zuvor sein
  12-Sekunden-Startlimit. Deshalb wird keine vollständig bestandene Gesamtsuite
  behauptet. Sein ausschließlich eigener Testprozess wurde beendet.
- Realer Reader gegen die lokale 136.056.832-Byte-Bestelldatei: Tabellenstruktur
  und Profilfingerabdrücke geprüft; 21 Tabellen mit 414.434 deklarierten Zeilen,
  sechs ausgeschlossene Tabellen. Nach dem Manifest kontrolliert beendet,
  keine Echtwerte importiert. Original-SHA-256 unverändert
  (`tmp/settings-accdb-worker-readonly-result.json`).
- Echte lokale Chrome-Prüfung mit synthetischem GP-Konto: Personalgruppen,
  zentraler Artikelimportdialog, alle drei Quelldateien, globale Suche,
  alte Direktlinks, Abfrageabbruch beim Bereichswechsel, 390-Pixel-Mobilansicht
  und Dark Mode. Keine JavaScript-Seitenfehler. Die Anzeige PostgreSQL 18.6
  ist in diesem lokalen Browserlauf eine ausdrücklich synthetische Anzeigeprobe;
  die produktive Version wurde separat lesend am VPS bestätigt.
- Browsernachweis: `tmp/settings-import-qa-1789323710713/result.json` und
  die vier Screenshots im selben Verzeichnis. Bilder visuell geprüft.

Kein Import in produktive PostgreSQL-Datenbanken, kein Dienst- oder Hostneustart,
kein Commit, Push oder Deploy. Eine produktive Ausführung der neuen vollständigen
Bestellübernahme wurde hier nicht behauptet. Beim später freigegebenen Deploy
gelten die regulären PostgreSQL- und Wiederherstellungsprüfungen.

## VPS-Speicher und normale Deploys

Lesende Bestandsaufnahme vom 13.09.2026; Größen in dezimalen GB:

| Bereich | Umfang |
| --- | ---: |
| Freier Platz auf dem VPS | 19,37 GB |
| Laufender GP-PostgreSQL-Cluster | 3,26 GB |
| GP-Daten-/Migrationsbereich unter `/var/lib/grabenplaner-postgresql/migration` | 5,20 GB |
| Separater Migrations-/Abnahmebereich unter `/home/gpadmin/grabenplaner-pg-migration-20260912` | 14,61 GB |
| Regulärer GP-Backupbereich unter `/var/lib/grabenplaner/backups` | 17,88 GB |
| PostgreSQL-Paarsicherungen unter `/var/backups/grabenplaner-postgresql` | 2,01 GB |

Die beiden separaten Übergangsbereiche belegen zusammen rund 19,81 GB. Das ist
nicht die Größe der laufenden Datenbank und wird nicht bei jedem normalen Deploy
als neue SQLite-zu-PostgreSQL-Migration wiederholt. PostgreSQL-Sicherungen und
das Wachstum der Geschäftsdaten bleiben hingegen regulärer Speicherbedarf.

Der letzte tatsächliche Updatebeleg (`update-2026-09-13T15-58-42-459839107.json`)
misst 15:44:35 bis 15:58:42 UTC, also rund **14 Minuten 7 Sekunden**. Größere
Einzelphasen: Paketprüfung knapp 6 Minuten, Offsite-Vorbereitung rund 2 Minuten
34 Sekunden sowie frische Rückkehrpunkte und Funktionsprüfungen. Die zusätzliche
vollständige Wiederherstellungsqualifikation dauerte anschließend etwa
19 Minuten, von 16:01:59 bis 16:20:37 UTC.

Der bestehende kurze Deploypfad behält frischen Rückkehrpunkt, Paketprüfung und
kurze Funktionsprüfungen. Er setzt einen aktuellen signierten Vollprüfnachweis
(höchstens 36 Stunden), unveränderte kritische Verträge und einen aktiven
nächtlichen Prüf-Timer voraus. Der Timer ist aktiv. Kritische Änderungen, darunter
Server-/Persistenzänderungen dieses Arbeitsstands, können weiterhin den vollen
Prüfpfad erfordern. **20–30 Minuten sind ein sinnvolles Ziel für normale Deploys,
keine garantierte Obergrenze für Migrationen und kritische Änderungen.**

Keine Speicherbereinigung durchgeführt. Vor einer späteren Bereinigung müssen
Rückkehrnachweise, Quelloriginale, Abhängigkeiten und Aufbewahrung getrennt geprüft
werden. Die gelesene Operationskonfiguration enthält keine Pfadverweise auf
die beiden Übergangsbereiche; das ersetzt keine vollständige Abhängigkeitsprüfung.

## Nachtrag: fachliche Bestätigungen und vollständige Speicheraufnahme

Der Benutzer hat die oben noch offenen Reparaturbedeutungen bestätigt:
`erledigt` bedeutet für TradeRepair abholbereit, auch bei abgelehnter Reparatur.
Abholung und Abrechnung folgen davon unabhängig. Die Abholdatumsfelder werden
im Betrieb nicht verwendet. Bei Ablehnung bleibt die berechnete KVA-Pauschale
von 75 EUR bestehen. Für eine spätere GP-Übersicht sind eigene, vom Import
unabhängige Felder „abholbereit“ und „abgeholt“ vorgesehen. Bereits importierte
Reparaturen bleiben bei späteren Exporten ohne diesen Fall erhalten; dieses
Verhalten wurde zusätzlich gezielt geprüft.

Auch die vorgeschlagene Bestandsklassifikation einschließlich Artikel-Ausnahmen,
Vorrang von `Sachkonto`/`OhneBestand` und Langsamdrehern nach 90/180 Tagen ist
bestätigt. Der vollständige neue Stand steht in
`BESTELL-BESTAETIGTE-FACHREGELN-2026-09-13.md`.

Die Speicheraufstellung oben war eine Teilauswahl der Ordner. Die inzwischen
vervollständigte Bestandsaufnahme findet 44,58 GB über alle vier GP-Sicherungs-
bereiche und 24,16 GB über vier Migrations-/Qualifikationsbereiche. Laufender
GP-PG-Cluster 3,26 GB; insgesamt 19,38 GB frei. Einzelpfade, Summen und
Messbeleg: `VPS-SPEICHERBELEGUNG-2026-09-13.md`. Keine Bereinigung ausgeführt.
