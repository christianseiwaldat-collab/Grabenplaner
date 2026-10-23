# Release- und Patchpolitik für die Serverversion

Diese Richtlinie gilt für die gepflegte Grabenplaner-Serverversion. Sie legt
Pflichten fest; sie behauptet keine bereits erfolgte personelle Besetzung,
Aktivierung von Repositorykontrollen oder erfolgreiche Installation.
USB-, Einzelplatz- und LAN-Pakete sind nicht Gegenstand dieser Richtlinie.

## Zuständigkeiten

Für jedes Release und jeden betriebenen Server ist eine eindeutig benannte Person
(Name oder internes Personalkonto) mit Vertretung im privaten Freigabenachweis
festzuhalten:

| Rolle | Pflicht |
| --- | --- |
| Sicherheitsverantwortung | Meldungen aufnehmen, Ausnutzbarkeit und Geschäftsauswirkung bewerten, Frist und Besitzer zuweisen, Risiken und befristete Ausnahmen freigeben. |
| Entwicklung | Abhängigkeiten und lokale Patches pflegen, Korrekturen reproduzierbar testen, Inventar und Belege bereitstellen. |
| Releaseverantwortung | Exakten Commit, Lockfile, Inventare, Scannerstände und Testergebnisse prüfen; den freigegebenen Kandidaten und dessen Hashes festhalten. |
| Systemadministration | Zielhostinventar, Wartungsfenster, Wiederherstellung und tatsächliche Installation nachweisen; Betrieb und Nachtests beobachten. |
| Unabhängige Prüfung | Kritische Änderungen und Risikoakzeptanzen gegenprüfen. Eine Person darf ihre eigene Ausnahme nicht allein freigeben. |

Fehlt eine Besetzung oder ein notwendiger Nachweis, ist die Freigabe offen.
Ein Repository-Merge ist keine Betriebsfreigabe.

## Bezugsquellen und Pflegezustand

Die folgenden Quellen bilden die freigegebene Ausgangsbasis. Eine neue Registry,
ein Mirror, Fork oder Herstellerwechsel benötigt vor Verwendung eine dokumentierte
Prüfung durch Entwicklung und Sicherheitsverantwortung: Projektidentität,
Herkunft, Lizenz, Pflegezustand, Sicherheitskontakt, exakte Version beziehungsweise
Commit und überprüfte Inhalts-Hashes; bei Paketquellen zusätzlich die
Signatur-/Schlüsselbindung. Eine neue URL allein ist keine Freigabe.

| Komponenten | Bezugsquelle und Bindung |
| --- | --- |
| npm einschließlich Browser-Vendor- und nativer Pakete | Öffentliche npm-Registry `https://registry.npmjs.org/`; App-/pnpm-Vorgaben in `package.json`, konkrete Versionen und Integritätswerte in `pnpm-lock.yaml`, Overrides und lokale Patchpfade in `pnpm-workspace.yaml`. Der Serverinstaller verwendet die konfigurierte Registry; eine abweichende Hostkonfiguration muss vor Installation geprüft und dokumentiert werden. |
| Sicherheitswerkzeuge und CI-Actions | Offizielle GitHub-Projekte `google/osv-scanner`, `gitleaks/gitleaks`, `anchore/syft`; Download-URL, Version, Größe und SHA256 in `scripts/security/tools.json`. Actions sind an volle Commit-SHAs gebunden. Semgrep-Regeln stammen vom dort gebundenen Commit von `semgrep/semgrep-rules`. Dies behauptet keine zusätzliche Artefaktsignatur. |
| Python-Werkzeuge und optionaler Optimierungsdienst | Semgrep und seine Transitiven aus PyPI mit der hashgebundenen `scripts/security/requirements.txt`; CI verlangt Binärpakete und `--require-hashes`. Für den optionalen Optimierungsdienst bindet `services/planning-optimizer/requirements.txt` die Anforderung, ersetzt aber kein separat geprüftes Installationsinventar. |
| Betriebssystem und vorinstallierte Betriebswerkzeuge | Signaturgeprüfte offizielle Ubuntu-Paketquellen für die unterstützte LTS-Version; zusätzliche Herstellerquellen nur nach dokumentierter Prüfung ihrer Herkunft und Schlüssel. Node.js darf alternativ aus dem offiziellen Node.js-Releasekanal mit geprüftem Release-/Hashnachweis stammen. Der App-Installer setzt vorhandene Werkzeuge voraus und richtet diese Quellen nicht ein. Tatsächlich verwendete Quellen, Schlüssel und Supportlaufzeiten sind daher am Zielhost separat nachzuweisen. |
| Mitgelieferte Schriften | Die in `public/fonts/price-labels/assets.json` und `SOURCE.md` dokumentierten Upstreamquellen, Lizenzen und Datei-Hashes; fehlende unveränderliche Upstreamversionen bleiben kenntlich. |

Vor jeder neuen Komponente, jedem Release und mindestens monatlich prüft die
Entwicklung zusammen mit der Systemadministration den Pflegezustand: Support-
und EOL-Termine, Archivierung oder Aufgabe des Projekts, letzte Sicherheits-
und Wartungsaktivität sowie erkennbare Maintainer-/Eigentümerwechsel.
Fehlende neue Releases allein beweisen weder Aufgabe noch Sicherheit. EOL oder
fehlender Sicherheitswartung folgt ein terminierter Ersatz-/Upgradeplan oder
eine befristete Risikoakzeptanz nach dieser Richtlinie. Neue ungepflegte
Komponenten dürfen ohne diese Prüfung nicht übernommen werden.

Die Prüfung hält Komponente, Version, Quelle, Prüftag, Ergebnis, Beleg und Besitzer
fest. Automatisierte Inventare und Advisoryprüfungen unterstützen sie; eine
vollständige individuelle Validierung der laufenden Wartung sämtlicher transitiver
Upstreamprojekte ist damit nicht behauptet. Ungeprüfte oder unklare Zustände
bleiben ausdrücklich offen und werden nach Risiko priorisiert.

## Beobachtung und Triage

Abhängigkeiten werden bei jeder Änderung, vor einer Freigabe und planmäßig
mindestens täglich gegen verfügbare Advisorydaten geprüft. Verantwortliche
beobachten zusätzlich die Herstellerhinweise für Node.js, pnpm, PostgreSQL,
Caddy, ClamAV, rclone, OpenSSL, das Betriebssystem und aktivierte Python-Dienste.
Npm- und native Komponenten wie Sharp/libvips/Canvas/PDF.js/OCR-Bibliotheken
sind anhand der tatsächlich verwendeten Versionen und Plattformen zu bewerten.
Lockfile-, Quelltext-, Secret- und SBOM-Prüfungen ergänzen einander.

Primärquellen sind die [GitHub Advisory Database](https://github.com/advisories),
[OSV](https://osv.dev/), [Node.js Security Releases](https://nodejs.org/en/blog/vulnerability)
und [Ubuntu Security Notices](https://ubuntu.com/security/notices) sowie die
jeweiligen offiziellen Herstellerhinweise. Im privaten Prüfbeleg stehen
Abrufzeitpunkt in UTC, Quelle, Scanner- und Datenbankversion beziehungsweise
Aktualisierungszeit, Eingabehash, vollständiges Ergebnis und eventuelle Fehler.
Ein nicht erreichbarer Dienst oder fehlender Datenstand ist kein grünes Ergebnis.
Ein Ergebnis ohne gemeldete Advisories ist keine Aussage über unbekannte Lücken.

## Reaktionsfristen

Die folgenden Fristen sind interne Vorgaben ab belastbarer Kenntnis, keine
gesetzlichen oder normativ vorgeschriebenen Fristen. Die Einstufung verbindet
technische Schwere mit Erreichbarkeit, Ausnutzbarkeit, betroffenen Daten,
Berechtigungen und vorhandenen Schutzmaßnahmen. Aktive Ausnutzung erhöht die
Dringlichkeit unabhängig von einem CVSS-Wert.

| Priorität | Beispiel | Triage | Schutzmaßnahme | Installierte Korrektur |
| --- | --- | --- | --- | --- |
| P0 | Aktive Ausnutzung oder unmittelbar erreichbarer kritischer Kontrollverlust | 4 Stunden | 24 Stunden | 72 Stunden |
| P1 | Hohe nachgewiesene Auswirkung mit plausibler Ausnutzung | 1 Kalendertag | 3 Kalendertage | 14 Kalendertage |
| P2 | Begrenztere Auswirkung oder erschwerte Ausnutzung | 3 Kalendertage | Nach Risiko, spätestens mit Korrektur | 30 Kalendertage |
| P3 | Geringe Auswirkung oder Härtung | 10 Kalendertage | Nach Risiko | 90 Kalendertage |

Die Frist endet erst mit dem Installations- und Nachtestbeleg. Gibt es noch
keinen Herstellerpatch, sind Begrenzung, Abschaltung der betroffenen Funktion
oder andere konkrete Schutzmaßnahmen zu bewerten. Eine Fristüberschreitung
benötigt eine begründete, befristete Risikoakzeptanz mit erneuter Prüfung.

## Ausnahmen, Fehlalarme und lokale Patches

Jede Ausnahme nennt Advisory-/Regel-ID, exakte Komponente und Version, Plattform
und betroffenen Pfad, Begründung, Belege, Schutzmaßnahmen, Besitzer, unabhängige
Freigabe, Ablaufdatum und Nachprüfung. Ein Fehlalarm benötigt einen reproduzierbaren
Nachweis. Ein lokaler Patch ist kein pauschaler Fehlalarm: Die Upstreamversion
bleibt betroffen, bis der Patch für exakt diese Bytes und den Ausnutzungspfad
belegt wurde. Ein minimierter synthetischer Regressionstest ist erforderlich.

P0/P1-Ausnahmen laufen spätestens nach 14 Tagen, P2/P3 spätestens nach 30 Tagen
ab; eine Verlängerung benötigt neue Belege und erneute Freigabe. Ausnahmen dürfen
weder alle Versionen eines Pakets noch unbeteiligte Regeln unterdrücken.
Scannerfehler, fehlende Scans und abgelaufene Ausnahmen blockieren die Freigabe.
Entsprechende GitHub-Gates müssen zusätzlich aktiviert und durch Repositoryregeln
erzwungen werden; ihre YAML-Dateien allein belegen diese Wirkung nicht.

Lokale Patches werden als prüfbare Dateien mit Herkunft, Anlass, Inhalts-SHA256,
Lockfilebindung, betroffener Upstreamversion, Funktions-/Negativtests und geplantem
Entfernungskriterium dokumentiert. Overrides und Freigaben junger Paketversionen
sind exakt zu begrenzen. Herstellerkorrekturen haben Vorrang, sobald Kompatibilität
und Sicherheitswirkung belegt sind. Releasealter und Integritätsprüfung werden
nicht allgemein abgeschaltet.

## Freigabe, Betrieb und Nachtest

1. Entwicklung bindet Commit, Quellinventar, Lockfile, Workspacepolicy und lokale
   Patches. Native Änderungen benötigen einen tatsächlichen Test auf der
   unterstützten Linuxarchitektur; Windowsbelege ersetzen diesen nicht.
2. CI liefert getrennte Scanner-, Secret-, SAST-, Dependency- und Inventarbelege
   sowie die betroffenen Funktions-, SQLite-/PostgreSQL-, Migrations- und
   Wiederherstellungstests. Relevante Fehler und Skips bleiben sichtbar.
3. Die Releaseverantwortung prüft Status und Aktualität tatsächlich aktivierter
   GitHub-Kontrollen getrennt vom Repositorycode. Checks müssen für den exakten
   Kandidaten bestanden sein; lokale grüne Ergebnisse ersetzen kein Merge-Gate.
4. Der reguläre Paketpfad bindet das Quellinventar in seine Dateihashes.
   Das nach Installation erzeugte Runtimeinventar bindet diese Paketidentität
   und die tatsächlich installierten Dateien. Die Herkunft des Pakets wird durch
   den vorhandenen vertrauenswürdigen Release-/Prüfpfad abgesichert; der
   Inventargenerator erzeugt keine eigene Signatur.
5. Die Systemadministration hält Wartungsfreigabe, Sicherung, getesteten Rückweg,
   tatsächlich installierte Version und Inventar fest. Bestehende Update-,
   Recovery- und Assurance-Prüfungen bleiben vollständig erforderlich.
6. Erst nach erfolgreichen Funktions-/Sicherheitsnachtests und beobachtetem
   regulärem Betrieb wird ein Befund als im Betrieb behoben geschlossen.
   Entwicklerprüfung, Releasebereitschaft und produktive Behebung sind getrennte
   Statuswerte mit Datum, Beleg und Besitzer.

Inventare und Freigabebelege enthalten keine Zugangsdaten oder Produktivdaten.
Zielhost- und Toolinformationen verbleiben im zugriffsbeschränkten Betriebsnachweis.
Belege werden mindestens für die Lebensdauer des unterstützten Releases und
zwölf Monate nach dessen Ablösung aufbewahrt; Zugriff und Löschung sind dem
zuständigen Betreiber zuzuordnen.

CI-Artefakte sind vorübergehend: Der Sicherheitsworkflow bewahrt sie derzeit
14 Tage auf. Die Releaseverantwortung muss die freigegebenen, auf notwendige
Informationen beschränkten Belege einschließlich Hashbindungen vor Ablauf in
das zugriffsbeschränkte Releasearchiv übernehmen und die Übernahme nachweisen.
Die längere Aufbewahrung ist weder durch GitHub-Artefakte allein erfüllt noch
durch diese Richtlinie bereits als eingerichtet oder durchgeführt belegt.
