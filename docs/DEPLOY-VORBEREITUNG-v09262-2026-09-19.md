# Deploy-Vorbereitung v0.92.61 / v0.92.62

Stand: 19.09.2026. Die Änderungen sind vorbereitet, nicht produktiv ausgerollt.
Produktiv läuft weiterhin v0.92.58-beta. Dieses Dokument ist keine Deploy-Freigabe.

## Integrationsstand

- `release/gp680-v09261-repair`: Reparaturstufe A mit Offsite-Modul 10.
- `release/gp681-v09262-maintenance`: separat gesicherter Matrixstand B.
- `release/gp684-main-readiness`: B mit `main` (`e73d58a`) zusammengeführt.
  Bestehende Betriebsnachweise, Startregressionen und Architekturprüfungen bleiben
  erhalten. Der Autovacuum-Schutz betrifft ausschließlich den kurzlebigen
  isolierten Restorecluster; produktive Datenbankwartung bleibt unverändert.
- Die Bootstrap-Adminverbindung wird vor der Anwendungsprüfung freigegeben.
  Fortschrittsüberwachung und Fehlerbereinigung bleiben erhalten; frühere starre
  30-/45-Minuten-Grenzen werden durch den Merge nicht wieder eingeführt.

Die Reparaturstufe A ist einschließlich Autovacuum-Schutz und Preflight-
Architekturklassifikation als `98cc1621fe2cf82c4094708bb307d12f0c76a1de`
gesichert. Die vier im Server-Vorabcheck verwendeten Helferdateien sind gegenüber
dem geprüften A-Vorgänger `4d9fa376` unverändert.

## Lokale Prüfungen der Integration

- 18 ausgewählte Produkt-/UI-Testdateien: zunächst 159 erfolgreiche Tests, eine
  übersprungene datenbankabhängige Prüfung und ein Architekturfehler. Ursache war
  die fehlende Klassifikation des neuen Preflightskripts. Diese wurde ausschließlich
  für den benannten Pfad ergänzt; unbekannte Skripte bleiben negativ geprüft.
- Anschließend 130 Deploy-, Recovery-, Preflight- und Architekturtests erfolgreich,
  ohne Fehler oder übersprungene Tests. Die neue Autovacuum-Verhaltensprüfung und
  die korrigierte vollständige Architekturprüfung sind darin enthalten.
- Reparaturstufe A: 21 fokussierte Recovery-/Bridgeprüfungen und sechs
  Architekturprüfungen erfolgreich. Die übrigen 534 Bibliotheksdateien blieben bei
  Übernahme des Autovacuum-Fixes byteidentisch.
- Syntaxprüfung aller 42 Linux-Shellskripte, des PowerShell-Paketbuilders, von
  `server.js` und `public/app.js` erfolgreich; Whitespaceprüfung sauber.
- Unabhängiger Merge-Review: Main-Korrekturen/Altnachweise erhalten; B-Produkt-UI
  unverändert; Bridge-Zielhash stimmt. Keine vollständige CI- oder Deploy-Freigabe
  aus diesen gezielten lokalen Prüfungen ableiten.

## Frische Server-Vorprüfung

Am 19.09.2026 um 08:54 CEST wurde der separate Vorabcheck mit den aktuellen
Reparaturhelfern ausgeführt. Er dauerte 59,616 Sekunden. Kein Paket wurde gebaut,
hochgeladen oder installiert; die kleine Hilfskopie wurde anschließend entfernt.

| Prüfung | Ergebnis |
| --- | --- |
| App/Caddy und intern/öffentlich Live/Ready | erfolgreich |
| Node, pnpm, Buildbenutzer/-cache, kleiner ClamAV-Funktionstest | erfolgreich |
| Installierter Runtimevertrag und Dateibaum | erfolgreich |
| PostgreSQL-Rückkehrdateien und deren Pfadvertrag | erfolgreich |
| Laufende Wartungen und Wartungssperre | zum Prüfzeitpunkt frei |
| Freier Speicher, separat erfasst | 72.743.333.888 Bytes, rund 72,74 GB |
| Vollständiger aktueller Wiederherstellungsnachweis | **fehlt; Deploy blockiert** |

Nächste erfasste größere Termine: apt-daily am 19.09. um 21:27:50 CEST,
Sicherheitsprüfung am 20.09. um 00:24:54, Nacht-Assurance am 20.09. um 04:10:21
und apt-daily-upgrade am 20.09. um 06:37:30. Der Monitor läuft regelmäßig.
Diese Momentaufnahme reserviert kein späteres Wartungsfenster. Direkt vor einem
Deploy erneut prüfen; unter der Wartungssperre bekannte Timer pausieren und
anschließend ihre exakten vorherigen Zustände wiederherstellen.

Geschützter Serverbeleg:
`/var/lib/grabenplaner-assurance/maintenance-evidence/gp684-deploy-preflight`.
Der Offsite-Status bleibt wegen der fehlenden Recovery-Qualifikation auf Fehler.

## Verbindungsfehler: Nachweis und Grenze

Der letzte vollständige Test erreichte den Artikelimport, scheiterte dort aber
beim Beziehen einer Datenbankverbindung. Der damalige tatsächliche Poolpeak wurde
nicht aufgezeichnet. Die kleine native PostgreSQL-18-Probe bestätigte den passenden
Mechanismus: Bei 20 maximalen Verbindungen und drei reservierten Plätzen blockiert
ein gehaltener Bootstrap-Admin die 17. normale Verbindung. Nach seiner Freigabe
funktioniert sie. Der temporäre Testcluster wurde vollständig entfernt.

Dieser mechanische Nachweis und die lokalen Regressionstests ersetzen keinen
erfolgreichen vollständigen Restore einschließlich Anwendungsprüfung. Es wurde
deshalb kein weiterer Vollversuch und kein Deploy gestartet.

## Zeitplanung

Eine vollständige A → Offsite 11 → B-Kette innerhalb von 30 Minuten ist mit dem
aktuellen Ablauf nicht belegt und anhand der vorhandenen Messung nicht realistisch.
Allein der letzte, noch fehlgeschlagene Restore dauerte **42min 20sek**,
davon **34min 18sek** im nativen Prüfprozess.

Die Übergangskette benötigt nach ihrer Vorqualifikation derzeit:

- zwei Abhängigkeitsinstallationen und zwei vollständige ClamAV-Paketscans;
- sieben frische PostgreSQL-Sicherungspaare, also 14 Datenbankdumps;
- fünf Offsite-Übertragungen mit Aufbewahrungsprüfungen;
- drei vollständige Repository-Datenchecks und drei Vollrestores mit App-Prüfung.

Installation und Paketscan erfolgen bereits vor dem App-Stopp. Die Backups
verursachen jedoch weitere Unterbrechungen, auch in der nachgelagerten Assurance.
Aktuelle PostgreSQL-Backupzeiten fehlen; eine Ausfallzeit unter 30 Minuten wird
deshalb ebenfalls nicht zugesichert. Ein alter SQLite-Release belegt für den
ClamAV-Abschnitt höchstens ungefähr 5min 45sek; das ist keine aktuelle Laufzeitprognose.

## Reihenfolge bis zur Freigabe

1. Die vollständige Recovery-Qualifikation mit dem korrigierten, exakt gepinnten
   Reparaturstand erfolgreich abschließen. Bei einem neuen Fehler Diagnose sichern
   und die Ursache gezielt prüfen, keine identischen Wiederholungsläufe starten.
2. Danach frischen Deploy-Vorabcheck ausführen. Erst bei Erfolg Pakete und Hashes
   aus den konkreten Commits erzeugen; alte eingebettete Prüfpayloads nicht übernehmen.
3. A, Modulupdate und B in getrennten geeigneten Wartungsfenstern planen. Ihre
   jeweiligen Assurance-Nachweise müssen vor dem nächsten Übergang erfolgreich sein.
4. Für den Übergang auf Offsite 11 den geprüften B-Updater und dessen aktuellen
   vertrauensgepinnten Paketprüfer verwenden. Der installierte A-Prüfer kennt v11
   nicht. Direkter Sprung von v58 auf B ist durch die bestehende Reparaturbrücke
   nicht zugelassen: B ändert weitere Bibliotheken und `common.sh`.
5. Phasendauern aus den neuen Update-Receipts auswerten. Ein dauerhafter abgesicherter
   Paketcache oder eine getrennte Prepare-/Activate-Phase sind mögliche spätere
   Optimierungen, derzeit aber nicht implementiert oder freigeprüft.

Das 30-Minuten-Ziel wird nicht durch ausgelassene Sicherungen, abgeschwächte
Prüfungen oder ein pauschales Abbruchlimit erzwungen.
