# Versionsgebundenes Sicherheitsinventar

Format `grabenplaner-security-release-inventory`. Standardmäßig bleiben
Quellinventar und striktes Installationsinventar bei `schemaVersion: 1`.
Ein Installationsinventar mit der ausdrücklich gewählten Hostpolicy
`--host-policy debian-nodejs-v1` verwendet `schemaVersion: 2`.
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

## Ausdrückliche Debian-Hostpolicy

`GP-SEC-OPS-INV-001` betrifft deklarierte Abhängigkeiten, die Node auf Debian aus
einem separat verwalteten Betriebssystempaket auflöst. Der strikte Standardmodus
weist eine solche Auflösung weiterhin mit `INVENTORY_DEPENDENCY_ESCAPE` zurück.
Die Hostpolicy erweitert deshalb nicht stillschweigend die Vertrauensgrenze des
Quellinventars oder des App-Paketbaums. Sie trennt im Schema 2 das strikte
physische App-Inventar von `hostResolution`, dem rekursiv beobachteten deklarierten
Abhängigkeitsgraphen. Physisch vorhandene App-Pakete werden weiterhin vollständig
gehasht; ihre Markierung `physical_only` behauptet keine Erreichbarkeit. Die
Erreichbarkeit und fehlende optionale Abhängigkeiten stehen im getrennten Graphen.

`hostPolicy` muss exakt `{ "id": "debian-nodejs-v1", "version": 1 }` entsprechen.
Die drei festen Betriebssystemwurzeln sind `/usr/share/nodejs`, `/usr/lib/nodejs`
und `/usr/lib/x86_64-linux-gnu/nodejs`. Sie sind nicht per Parameter erweiterbar.
Externe Dateien und ihre Verzeichnispfade müssen root gehören und dürfen weder
gruppen- noch sonstschreibbar sein. Paketdateien und Symlinkziele werden gehasht;
ihre Zuordnung zu installierten dpkg-Paketen wird geprüft. Je Paket werden Name,
Version, Architektur, Quellpaket und Quellpaketversion erfasst. `dpkg --verify`
muss erfolgreich und ohne Ausgabe enden. Vorhandene lokale dpkg-Prüfsummenlisten
werden ebenfalls mit ihrem Hash erfasst; nicht vorhandene Listen bleiben als
unbekannte Prüfsummenabdeckung kenntlich.

Die einzige gesondert zugelassene Node-Lookup-Verknüpfung ist
`/usr/share/node_modules` mit dem exakten Linktext `nodejs` und kanonischem Ziel
`/usr/share/nodejs`. Der Link muss root gehören, von dpkg dem Paket `nodejs`
zugeordnet sein und vor sowie nach der Beobachtung unverändert bleiben. Für
Unterpfade werden die kanonischen Eigentumsnachweise geprüft. Ein ähnlicher
Pfadname, ein anderes Linkziel, ein zusätzlicher Alias, ein anderer Eigentümer
oder unsichere Rechte werden abgewiesen. Die bestehenden Schranken für den
App-Paketbaum bleiben auch mit Hostpolicy wirksam.

Schema 2 bindet Policy, Prozesskontext, Graph, App-Bytes, Hostdateien und
dpkg-Metadaten in seine Inhalts-Hashes ein. `inventoryImplementation` bindet
zusätzlich die tatsächlich ausgeführten Inventar- und Hostpolicy-Bibliotheken
mit ihren Dateihashes. Auch ein separat bereitgestellter Kandidatenprüfer gegen
einen unveränderten installierten App-Pfad bleibt damit als solcher erkennbar;
seine Codebytes werden nicht mit dem ausgelieferten App-Stand verwechselt.
`verify` liest die Policy aus dem
Dokument, beobachtet sie erneut und vergleicht die Ergebnisse; sie wird nicht
durch Weglassen des CLI-Parameters abgeschaltet. Ein explizit widersprechender
Parameter, eine unbekannte Policy oder ein Schema-Downgrade wird abgewiesen.
`--mode source --host-policy ...` ist ungültig. Das Quellinventar bleibt Schema 1
und wird samt vorhandener äußerer Paketmanifestbindung unverändert verifiziert.
Die extern verwalteten Hostpakete werden dadurch kein Bestandteil eines
signierten oder manifestgebundenen Releasepakets.

Der dokumentierte Graph entsteht aus der tatsächlichen Metadatenauflösung des
Inventarprozesses und den deklarierten Abhängigkeiten. Der Beobachter führt deren
gewöhnliche Paket-Einstiege nicht aus. Die bestehenden nativen Probes für Sharp
und Canvas bleiben davon getrennt. Dynamische, bedingte, nicht deklarierte oder
von der Anwendung selbst erzeugte Auflösungen werden nicht vollständig erfasst;
dies ist kein Laufzeittrace. Stabile Dateilesungen und abschließende Prüfungen
sind keine atomare Momentaufnahme des gesamten Dateisystems.

Der Nachweis bindet die Identität des ausführenden Prozesses, seine Node-Binary,
Arbeitsverzeichnis, Home und relevante Auflösungsumgebung. Das ist nicht
automatisch der Kontext eines laufenden Dienstes. Für einen Produktivnachweis ist
der normale Dienstbenutzer mit dem tatsächlichen Node, Arbeitsverzeichnis,
Home, relevanter Umgebung und derselben Mountsicht zu verwenden; deren
Übereinstimmung mit dem Dienst ist gesondert zu belegen. Ein Root- oder
CI-Prozess darf nicht als Dienstbeobachtung ausgegeben werden. `NODE_OPTIONS`,
`NODE_PATH` oder die globalen Suchpfade dürfen für diesen Nachweis nicht als
Workaround so geändert werden, dass die tatsächliche Hostauflösung verschwindet.

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

Bei tatsächlich benötigter Debian-Hostauflösung, im zuvor belegten Dienstkontext:

```sh
node /opt/grabenplaner/app/server-tools/linux/security-release-inventory.js generate --root /opt/grabenplaner/app --host-policy debian-nodejs-v1 --output /private/evidence/installed-host-inventory.json
node /opt/grabenplaner/app/server-tools/linux/security-release-inventory.js verify --root /opt/grabenplaner/app --host-policy debian-nodejs-v1 --input /private/evidence/installed-host-inventory.json
```

Der verifizierende Parameter ist eine zusätzliche ausdrückliche Policyprüfung;
auch ohne ihn bleibt für dieses Schema-2-Dokument dieselbe Policy zwingend.

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
archivieren. Der Linux-SBOM-Job führt die Positiv-/Negativtests des bisherigen
Inventars, der Hostpolicy und der echten CLI getrennt als verpflichtenden Schritt
aus. Danach erzeugt und verifiziert das bestehende fehlerschließende SBOM-Gate
das Runnerinventar mit `--host-policy debian-nodejs-v1`. Ein Fehler einer dieser
Prüfungen blockiert den Job und damit das unveränderte aggregierte Security-Gate.
Ein Workfloweintrag allein ist kein Nachweis eines bestandenen CI-Laufs.

Ohne durchlaufenen Paket- und Installationspfad sind dies keine
Nachweise ausgelieferter oder produktiv laufender Releases. Der Generator führt
keinen Netzabruf, keine Aktualisierung, keine Installation und keinen Paketbau
aus. Die reine Inventarisierung ersetzt weder den bestehenden Paketverifier noch
Update-/Recovery-Prüfungen, signierte Assurance-Belege oder Betriebsfreigaben.
Auch ein erfolgreicher Hostpolicy-Nachweis ist weder Upstream-Authentifizierung
noch CVE-Freigabe noch vollständige System-SBOM. Die lokalen dpkg-Prüfungen haben
die vom Paketmanager bereitgestellte Datei- und Prüfsummenabdeckung; sie ersetzen
keine unabhängige Authentizitätsprüfung. Der neu implementierte CLI-Stand ist bis
zu einem gesonderten Release- und Produktivnachweis ein geprüfter oder noch zu
prüfender Kandidat. Ein vorhandener Produktivnachweis der älteren Version belegt
nicht die Auslieferung dieser Änderung.
