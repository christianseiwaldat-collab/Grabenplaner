# Versionsgebundenes Sicherheitsinventar

Format `grabenplaner-security-release-inventory`, `schemaVersion: 1`.
Das Inventar ergänzt eine standardisierte SBOM und Advisoryprüfungen. Es ist
keine vollständige System-SBOM, keine Schwachstellenbewertung und keine Signatur.
`contentSha256` dient der Inhaltsintegrität, nicht der Authentifizierung.

## Quellpaket und tatsächliche Installation

Der Modus `source` bindet Appversion, vom Paketbauer gelieferten Commit und
Zeitpunkt, alle ausgewählten Runtimequellen, Lockfile, Workspacepolicy, lokale
Patches, Python-Anforderungen, Browser-Vendor-Routen sowie die öffentlichen
Schriften samt vorhandener Provenienz und Dateihashes. Unbekannte Upstreamversionen
werden nicht aus Dateinamen erfunden. Native Bibliotheksversionen und
Betriebswerkzeuge werden erst auf dem tatsächlich untersuchten Host ermittelt.

Der Linux-Paketbauer erzeugt `lib/security-release-inventory.source.json` vor
seiner bestehenden Manifest-Dateiliste. Damit bindet der unveränderte äußere
Manifestvertrag auch das Inventar. Das Inventar selbst und
`grabenplaner-server-manifest.json` sind explizit von seinen Quellhashes
ausgeschlossen, damit kein zyklischer Hash entsteht. Die Quellauswahl ist im
Dokument vollständig aufgeführt; nicht ausgewählte Repositorydateien sind kein
behaupteter Teil des ausgelieferten Runtimebaums. Der Commit ist eine Herkunftsangabe;
maßgeblich für die tatsächlich untersuchten Bytes bleiben die Inhalts-Hashes.

Der Standardmodus `installed` fordert eine vorhandene Installation und prüft
alle verpflichtenden Laufzeitabhängigkeiten. Er erfasst physisch vorhandene
transitive npm-Pakete, Paketpfade, Versionen, Abhängigkeitsauflösung und Hashes
aller regulären Paketdateien. Noch vorhandene, nicht über den Laufzeitgraphen
erreichbare Storepakete stehen ausdrücklich als `present_not_reachable` im
Inventar. Optionale, auf dieser Plattform nicht installierte Abhängigkeiten
stehen als solche im Graphen. Ein pnpm-Paketstore ist kein Lockfile-SBOM-Ersatz.

Ein vorhandenes Quellinventar wird zuerst verifiziert. Bei einem Serverpaket
werden zusätzlich die äußeren Manifest-Dateihashes und die Bindung des
Quellinventars geprüft; beide Dokumenthashes stehen im Runtimeinventar.
Ein Checkout ohne Paketmanifest bleibt ausdrücklich ein Checkoutnachweis.
Fehlende Installation, Pflichtabhängigkeit, Patchdatei oder geänderte bekannte
Bytes führen zu Exitcode ungleich null.

Das Runtimeinventar ermittelt den laufenden Node samt ausführbarem Dateihash und
Komponentenversionen, pnpm, Hostbetriebssystem und verfügbare Betriebswerkzeuge.
Sharp liefert seine tatsächlichen libvips-/Codec-Versionen; Canvas wird geladen
und seine nativen Bindings werden gehasht. Nicht vom Modul veröffentlichte
interne Bibliotheksversionen bleiben unbekannt. SQLite stammt aus der laufenden
Node-Version. Der Probeprozess öffnet keine Datenbank und startet keinen Server.
Fehlende Werkzeuge werden als `unavailable`, Ausführungsfehler als `error`
ausgegeben. Das ist kein Nachweis erfüllter Betriebsvoraussetzungen.

Aktivierte Python-Dienste benötigen zusätzlich ein Inventar ihrer tatsächlichen
isolierten Python-Installation. PostgreSQL-Serverversion, Betriebssystempakete,
Dienstkonfiguration und separat verwaltete Module sind im Betriebsnachweis zu
ergänzen: `psql --version` zeigt die Clientversion, nicht die Serverversion.
Ein Windows-Runtimeinventar belegt keine Linux-Binaries oder Zielhostinstallation.

## Befehle

Nach der regulären eingefrorenen Installation in CI oder im Arbeitsbaum:

```sh
node scripts/security-release-inventory.js generate --root . --output /private/evidence/release-inventory.json
node scripts/security-release-inventory.js verify --root . --input /private/evidence/release-inventory.json
```

Nach der regulären Installation des verifizierten Serverpakets auf dem Zielhost:

```sh
node /opt/grabenplaner/app/server-tools/linux/security-release-inventory.js generate --root /opt/grabenplaner/app --output /private/evidence/installed-inventory.json
node /opt/grabenplaner/app/server-tools/linux/security-release-inventory.js verify --root /opt/grabenplaner/app --input /private/evidence/installed-inventory.json
```

Der tatsächliche Installationspfad ist zu verwenden. Das Ausgabeverzeichnis muss
existieren, privat sein und außerhalb der ausgewählten Quellen liegen. Vorhandene
Ergebnisse werden nicht überschrieben. Für jede Installation und Änderung wird
ein neuer Beleg angelegt. Mit `--pnpm-cli /absolute/path/to/pnpm.cjs` kann der
tatsächlich verwendete pnpm-Einstieg explizit beobachtet werden; ohne diese Option
wird `pnpm` aus dem Prozesspfad abgefragt. Nicht auffindbares pnpm bleibt unbekannt.

Eine spätere Verifikation vergleicht die damalige Beobachtung mit dem aktuellen
Zustand. Updates an Betriebssystem, Node oder Werkzeugen können deshalb ebenso
eine Abweichung erzeugen wie veränderte Anwendungsdateien. Dann sind Ursache und
Freigabe zu prüfen und ein neues Inventar zu erstellen. Ein neu berechneter
Dokumenthash allein legitimiert keine Änderung.

## Beleggrenzen

CI kann standardisierte CycloneDX-SBOM, Inventar und Scanresultate gemeinsam
archivieren. Ohne durchlaufenen Paket- und Installationspfad sind dies keine
Nachweise ausgelieferter oder produktiv laufender Releases. Der Generator führt
keinen Netzabruf, keine Aktualisierung, keine Installation und keinen Paketbau
aus. Die reine Inventarisierung ersetzt weder den bestehenden Paketverifier noch
Update-/Recovery-Prüfungen, signierte Assurance-Belege oder Betriebsfreigaben.
