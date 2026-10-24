# PostgreSQL-only: Installation und historische Sicherungen

Der aktuelle GP-Server verwendet ausschließlich PostgreSQL. Die beiden Datenbanken
`grabenplaner_core` und `grabenplaner_sales` bilden ein gemeinsam gesichertes und
wiederhergestelltes Paar. Ein fehlendes oder falsches Paar aktiviert niemals SQLite.
Eine historische SQLite-Sicherung wird nicht in einen laufenden PostgreSQL-GP
eingespielt und nicht direkt in PostgreSQL umgewandelt.

## Installation auf einem neuen Anwendungsserver

Der Serverinstaller akzeptiert ein **bereits provisioniertes und geprüftes
PostgreSQL-Paar**. Er erzeugt selbst weder ein neues Datenbankcluster noch ein
SQLite-Zwischenprodukt und ersetzt keine Migrationsfreigabe. Vor seinem Aufruf
müssen das Paar, die zugehörigen Verschlüsselungsschlüssel und die geschützten
Dateien vorbereitet sein:

- `/etc/grabenplaner/grabenplaner.env` (`root:root`, Modus `0600`), mit
  `DB_PROVIDER=postgresql`, dem PostgreSQL-Datenanker als `DB_PATH` und der
  verwalteten PostgreSQL-Anwendungskonfiguration;
- `/etc/grabenplaner/postgresql-application.json` und
  `/var/lib/grabenplaner/data/postgresql-pair.json` mit identischer geprüfter Bindung,
  Eigentümer `root`, bereits vorbereiteter Gruppe `grabenplaner` und Modus `0640`;
- `/etc/grabenplaner/postgresql-operations.json` mit passendem Aktivierungsnachweis
  (`root:root`, `0600`) und bereits vorbereiteten privaten, root-eigenen
  Sicherungs-/Prüfverzeichnissen;
- ein Paar mit vollständigem Schema, überprüften Anwendungs-/Lesekonten und
  richtigem Umgebungsvertrag; die gesonderten Verwaltungszugänge bleiben getrennt.

Der Installer prüft die Dokumente vor Änderungen an Installationsverzeichnissen,
Benutzern oder Diensten. Nach der Paketprüfung und Abhängigkeitsinstallation prüft
er alle vier Anwendungs-/Lesekonten mit schreibgeschützten Transaktionen, bevor
er die Anwendung austauscht oder Dienste beendet. Das getrennte, nicht
privilegierte Monitorkonto prüft zusätzlich die tatsächliche Clusterkennung.
Überprivilegierte Konten oder
abweichende Datenbank-/Umgebungsbindungen verhindern die Installation. Fehlt ein
Administratorkonto, ist ein unverbrauchter Bootstrap-Token erforderlich. Der
Bootstrap prüft Konten ebenfalls über PostgreSQL.

Eine automatische Erstprovisionierung eines leeren PostgreSQL-Paars ist damit
nicht zugesagt. Die vorhandene historische Übertragungsstrecke bleibt an echte
Übertragungs- und Inhaltsnachweise gebunden; sie darf nicht durch fingierte
SQLite-Sicherungen oder erfundene Transfernachweise aktiviert werden.

## Historische SQLite-Sicherungen erhalten

Aufbewahrte Datenbanken, zugehörige verschlüsselte Dateien, Abschlussmarker,
Staging-Manifeste, Schlüsselringe und Versionsinformationen bleiben unverändert
erhalten. Ein Datenbankfile ohne zugehörige Dokumente und Schlüssel ist kein
vollständiger Wiederherstellungspunkt. Diese Änderung löscht keine Sicherungen
und verkürzt keine Aufbewahrungsfristen.

Das Skript `scripts/legacy-recovery-capsule.js` konserviert die letzte gemeinsame
Quellbasis `b2ba03cdc0b738d44766857de052e090db557807` aus Git. Es übernimmt **nur
versionierte Quelldateien**, den eingefrorenen Lockfile und eine ausdrücklich
übergebene, nach SHA-256 und Version gebundene Node-Laufzeit. Unversionierte
Arbeitsdateien, produktive `.env`-Dateien, Sicherungen und `node_modules` werden
nicht erfasst. Die ursprünglichen SQLite-Leser, Integritätsprüfungen,
Schlüsselprüfungen, Wiederherstellungshelfer und Instanzsperren bleiben dadurch
zusammen auf demselben Stand. Die Offline-Recovery benötigt ausschließlich
Node-Bordmittel. Der vollständige historische Anwendungsstart mit allen
npm-Abhängigkeiten ist **nicht** Bestandteil dieser Kapsel.

Unter Linux werden zusätzlich der ELF-Lader und alle von `ldd` gemeldeten nativen
Bibliotheken als reguläre Dateien mit eigenen Hashwerten konserviert. Die Kapsel
erfasst Architektur, Kernelstand und Distributionskennung. Die ursprünglichen
Helfer starten Unterprozesse mit einer absichtlich begrenzten Umgebung: deshalb
setzt die Wiederherstellung dieselbe Architektur und **exakt passende
Systembibliotheken einschließlich ELF-Lader** voraus. Vor jeder Wiederherstellung
werden deren Hashwerte erneut geprüft. Bei Abweichung stoppt das Werkzeug, bevor
es das Zielverzeichnis anlegt. Es wird keine beliebige frische Linux-Installation
als kompatibel behauptet. Die konservierten Bibliotheken und ein separat
aufbewahrtes passendes Basisimage dienen der Rekonstruktion einer isolierten
Prüfumgebung.

Beispiel auf dem geprüften Linux-System, mit unabhängig bestätigtem Runtime-Hash:

```sh
node scripts/legacy-recovery-capsule.js create \
  --repository /pfad/zum/geprueften-git-repository \
  --node /pfad/zur/geprueften/node \
  --node-version v22.22.1 --node-sha256 GEPRUEFTER_RUNTIME_SHA256 \
  --output /privater-neuer-pfad/gp-legacy-recovery
```

Der ausgegebene `manifestSha256` ist **außerhalb der Kapsel** im Auditnachweis und
im Sicherungsinventar aufzubewahren. Kapsel und Digest werden an mindestens zwei
getrennten Sicherungsorten behalten. Schlüssel werden getrennt geschützt und
nicht in die Quellkapsel aufgenommen. Hashgleichheit weist Unverändertheit nach;
die Vertrauenswürdigkeit der ursprünglich gewählten Laufzeit wird durch ihre
separate Herkunftsprüfung nachgewiesen.

## Isolierte Wiederherstellung

Die Wiederherstellung erfolgt auf einer gesonderten, kompatiblen Linux-VM ohne
produktive Dienstkonfiguration, ohne produktive Datenbankverbindung und mit
unterbundenem ausgehendem Netz. Daten und Schlüssel sind vertraulich. Die
Offline-Laufzeit wird nicht als öffentlich erreichbarer GP betrieben.

```sh
node scripts/legacy-recovery-capsule.js verify \
  --capsule /privater-pfad/gp-legacy-recovery \
  --manifest-sha256 EXTERN_AUFBEWAHRTER_MANIFEST_SHA256

node scripts/legacy-recovery-capsule.js restore \
  --capsule /privater-pfad/gp-legacy-recovery \
  --manifest-sha256 EXTERN_AUFBEWAHRTER_MANIFEST_SHA256 \
  --stage /privater-pfad/zum/vollstaendigen-offsite-stage \
  --environment /privater-pfad/zur/historischen-schluesseldatei.env \
  --output /privater-neuer-pfad/offline-wiederherstellung
```

`--output` muss vollständig neu sein; ein bestehendes Ziel wird auch dann
abgelehnt, wenn es leer erscheint. Das Ziel darf auch nicht innerhalb der
aufbewahrten Kapsel oder Quell-Stage liegen. Das Werkzeug kopiert den Quellbestand in einen
eigenen eingefrorenen Eingabebaum, prüft Marker, SQLite-Integrität, Fremdschlüssel,
Versionskompatibilität und verschlüsselte Inhalte mit den ursprünglichen Helfern.
Danach stellt es ausschließlich unter `--output/restored` wieder her. Es startet
keine Dienste und überschreibt keinen bestehenden Anwendungsbestand. Eine
PostgreSQL-Paarsicherung wird von diesem Werkzeug abgewiesen.

Die Nachweise `verification.json`, `application.json`, die Vorabsicherung und die
Kapselbindung verbleiben im privaten Arbeitsverzeichnis. Nach erfolgreicher
Wiederherstellung ist eine Übernahme in ein neues PostgreSQL-Paar ein eigener,
kontrollierter Migrationsvorgang mit vollständigem Inhaltsvergleich, Schlüssel-
und Dateiprüfung und eigenständiger Freigabe. Es gibt keine automatische
Umschaltung des aktuellen GP auf den alten Bestand.

## Prüfgrenzen und wiederkehrender Nachweis

`test/legacy-recovery-capsule.test.js` führt unter Linux eine synthetische
Wiederherstellung einschließlich verschlüsseltem Datensatz aus. Negativfälle
prüfen manipulierte Quelle, falschen Manifest-/Runtime-Hash, falsche Schlüssel,
Links, verschachtelte Quell-/Kapselziele und bestehende beziehungsweise PostgreSQL-Ziele. Die unveränderte
Quellsicherung wird erneut gehasht. `test/postgresql-only-recovery.test.js`
prüft die Ablehnung alter SQLite-Stages durch die aktuellen Recovery-CLIs und
das Laden der gemeinsamen PostgreSQL-Prüfungen ohne SQLite-Treiber.

Diese Tests ersetzen nicht den dokumentierten Wiederherstellungsnachweis einer
konkreten produktiven Altsicherung. Für jede weiter aufzubewahrende historische
Format-/Versionsgruppe sind ein vollständiger Sicherungspunkt, sein passender
Schlüsselring und eine tatsächliche isolierte Nachprüfung zu registrieren. Neue
Formate oder Quellversionen oberhalb der konservierten Basis werden nicht durch
Lockerung der Versions- oder Integritätsprüfung zugelassen.

## Getrennte historische Testabhängigkeiten

Historische Server- und Upgradeverträge verwenden weiterhin den unveränderten
Quellstand `b2ba03cdc0b738d44766857de052e090db557807`. Sicherheitsupdates im
aktuellen Dependencybaum dürfen diesen Nachweis nicht nachträglich verändern.
Der ausschließlich für Tests bestimmte Builder installiert deshalb die
Originaldateien `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` und den
damaligen Vendor-Patch mit exakt PNPM `11.7.0`, privatem Store/HOME,
`--frozen-lockfile`, `--ignore-scripts` und `--ignore-pnpmfile`:

```sh
node --no-global-search-paths test-support/prepare-legacy-dependencies.cjs \
  --target /privater-neuer-pfad/historische-testabhaengigkeiten \
  --pnpm /absoluter-pfad/zum/geprueften/pnpm
```

Die JSON-Ausgabe nennt `root` und `manifestSha256`. Für den nachfolgenden
Testprozess müssen diese Werte getrennt als `GP_LEGACY_DEPENDENCIES_ROOT` und
`GP_LEGACY_DEPENDENCIES_MANIFEST_SHA256` übergeben werden. Der Runner prüft den
externen Manifesthash, den unveränderten Baselinebezug und jede tatsächliche
Datei im installierten Baum. Symlinks, Hardlinks, zusätzliche oder fehlende
Dateien und geänderte Metadaten werden zurückgewiesen. Ein bereits bestehendes
Vorbereitungsziel wird niemals überschrieben.

Bei abweichendem aktuellem Lock gibt es keinen stillen Rückfall auf den
aktuellen Dependencybaum. Der historische Baum einschließlich seiner bekannten
alten Bibliotheksstände dient ausschließlich den isolierten Altverträgen und
gehört nicht zum aktuellen Serverpaket. Diese Testversorgung ersetzt weder die
Offline-Recovery-Kapsel noch die Prüfung einer konkreten produktiven Sicherung.
