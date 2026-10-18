# Security-Gates

Der Workflow `.github/workflows/security.yml` führt SCA, SAST, Secrets-Prüfung
und SBOM-Erzeugung für Pull Requests, `main`, manuell und täglich aus. Der stabile
Abschlussjob `security-gates` akzeptiert ausschließlich `success` aller vier
Jobs. Fehlende Werkzeuge, ungültige Ergebnisse, Parser-/Zeitlimitfehler,
ausgelassene Ziele und abgebrochene Jobs gelten nicht als bestandene Prüfung.
Die verpflichtende GitHub-Branchregel und die externe Aktivierung müssen separat
eingerichtet und an einem tatsächlichen Actions-Lauf nachgewiesen werden.

## Werkzeuge und Umfang

- SCA: OSV-Scanner 2.7.0 und `pnpm audit` 11.7.0. OSV muss sämtliche
  Paket-/Versionspaare des Lockfiles melden, einschließlich optionaler Pakete
  anderer Plattformen. Übertragen werden Paketmetadaten, keine Kennwörter.
- SAST: Semgrep 1.181.0 mit vollständig hashgebundenen Python-Abhängigkeiten.
  Der unveränderliche Upstream-Regelcommit steht in `tools.json`. Ausgewählt
  werden alle Security-YAMLs unter `javascript/` und `typescript/lang/security/`.
  Der gebundene Upstream-Satz enthält 169 Regeln; Lizenz: Semgrep Rules License
  des gebundenen Commits. Profilversion 3 verwendet 107 unveränderte Sprach-,
  Browser- und Bibliotheksregeln auf allen Zielen sowie 51 unveränderte
  Express-Regeln auf sämtlichen Nicht-public-Zielen einschließlich server.js.
  Die 11 AWS-Lambda-Regeln setzen Lambda-Handler/Eventquellen voraus, die GP
  nicht besitzt. Sie werden ausdrücklich als nicht anwendbar inventarisiert.
  Neue Lambda-Abhängigkeiten, erkennbare Handler/Deployments oder Express-Imports
  unter public blockieren und verlangen eine neue Profilprüfung. Diese
  konservativen Kontrollen ersetzen kein Review neuer Ausführungsumgebungen.
  Ziel sind alle eigenen JS/CJS/MJS/TS/JSX/TSX-Dateien aus dem
  Git-Dateiinventar einschließlich nicht ignorierter neuer Dateien. Tests und
  `public/vendor/` sind vom deklarierten SAST-Zielumfang ausgenommen; fremde
  Abhängigkeiten werden zusätzlich über SCA/Inventar erfasst. Das vollständige
  `server.js` ist obligatorisch, ohne Größenlimit; jede erwartete Zieldatei muss
  im Ergebnis stehen. 106 allgemeine und 49 Express-Regeln erhalten 120 Sekunden
  pro Regel/Datei. Diese Frist berücksichtigt die unter Linux beobachteten
  Zeitüberschreitungen bei `detect-non-literal-fs-filename` und `express-ssrf`
  mit der früheren 60-Sekunden-Frist. Historische Profilversionen behalten ihre
  ursprünglichen Regeln, Ziele und Fristen für die Nachweisprüfung. Die drei
  unter Linux nachweislich langsameren Regeln
  `unknown-value-with-script-tag`, `remote-property-injection` und
  `direct-response-write` laufen jeweils als unveränderte Einzeldatei in einem
  eigenen Profil mit 300 Sekunden. Dabei bleiben alle jeweiligen allgemeinen
  bzw. Backend-Ziele erhalten; kein Monolith wird ausgespart. Die Vereinigung
  aller fünf Profile entspricht exakt dem bisherigen Regelsatz. Für den Scanner
  gelten gemeinsam weiterhin 40 Minuten (ein Worker, 4096 MB-Limit); der
  Actions-Job bleibt auf 45 Minuten begrenzt. Jeder Timeout/Parserfehler und
  jeder Datei-/Regelskip blockiert; alle Profilberichte bleiben getrennt
  nachvollziehbar. Upstream-Regeldateien werden bytegleich kopiert, Auswahl,
  ausgeschlossene Dateien und Targethashes in sast-profile-manifest.json
  festgehalten. Metriken und SaaS sind aus.
- Secrets: Gitleaks 8.30.1, Standardregeln, vollständige lokal vorhandene
  Git-Historie aller Refs und aktueller Git-Dateibestand. Keine pauschalen
  Ausnahmen für Tests, Dokumentation oder Historie; Inline-Allow-Kommentare und
  vorhandene globale Ignoredateien werden nicht übernommen.
- SBOM: Syft 1.54.1 erzeugt CycloneDX aus genau `package.json`,
  `pnpm-lock.yaml` und `pnpm-workspace.yaml`. Das getrennte Releaseinventar
  prüft die tatsächlich aktive Runner-Installation einschließlich nativer
  Abhängigkeiten. Quell-SBOM, Runner-Inventar, gebautes Release und Zielhost
  sind unterschiedliche Nachweise.

GitHub-Actions sind auf überprüfte vollständige Commit-SHAs festgelegt.
Binärwerkzeuge stammen aus offiziellen GitHub-Releases; SHA256 und Dateigröße
sind gegen veröffentlichte Release-Metadaten gebunden. Eine zusätzliche
Signaturprüfung wird nicht behauptet. `requirements.txt` bindet PyPI-Wheels
einschließlich transitiver Abhängigkeiten mit Hashes; die Regeldateien werden
zusätzlich einzeln verifiziert. Änderungen erfordern erneute Prüfung gemäß
`server-tools/linux/security-release-policy.md`.

## Ausnahmen

`exceptions.json` enthält ausschließlich einzeln geprüfte Treffer mit exaktem
Fingerprint, tatsächlichem Datei-/Gitblob-SHA256, Begründung, Verantwortlichkeit,
Prüfdatum und Ablaufdatum. Keine Advisory-Ausnahmen sind genehmigt. P0/P1 sind
auf höchstens 14, P2/P3 auf höchstens 30 Kalendertage begrenzt. Die aktuellen
synthetischen/Shellsyntax-Treffer wurden zweimal unabhängig gelesen und sind
auf 14 Tage begrenzt. Zwei einzelne Dateien besitzen zusätzlich genau geprüfte
LF-Checkout-Hashes; es gibt keine allgemeine Inhaltsnormalisierung. Neue oder
verschobene Treffer, neue historische Commits und Inhaltsdrift blockieren.

SAST verwendet getrennt `sast-dispositions.json`. Eine Entscheidung gilt nur
für einen konkret geprüften Fehlalarm: kanonische Upstream-Regel-ID, relativer
Pfad, Anfangs- und Endposition einschließlich Spalten, daraus berechneter
Fingerprint und vollständiger Quelldatei-SHA256 müssen übereinstimmen. Die
genannten Kontextdateien (beispielsweise Encoder und Aufrufpfad) sind ebenfalls
mit ihren tatsächlichen Bytes gebunden. Begründung, Reviewer, Prüfdatum und
Ablaufdatum sind obligatorisch; dieselben 14-/30-Tage-Grenzen gelten.
Für plattformabhängige Git-Zeilenenden enthält jede Entscheidung zusätzlich
`sourceSha256Variants` und jeder Kontext `sha256Variants`: höchstens drei
eindeutige, ausdrücklich geprüfte SHA256-Werte der ursprünglichen Bytes sowie
deren reiner LF-/CRLF-Varianten. `newline_hash_variants(bytes)` erzeugt diese
Liste beim Review, ohne BOM, einzelne CR, Leerzeichen oder sonstige Inhalte zu
ändern. Der ursprüngliche Reviewhash bleibt erhalten und muss enthalten sein.
Das Gate normalisiert keine Laufzeitdatei: Der tatsächliche Rohhash muss in der
expliziten Liste stehen und beim Treffer exakt dem Scanner-Quellhash entsprechen.
Variantenlisten sind Teil der unabhängig zu prüfenden Entscheidung; beliebige
zusätzliche Inhaltsvarianten sind nicht zulässig.
Veraltete, doppelte, nicht zuordenbare oder unvollständige Entscheidungen
scheitern geschlossen. Nicht geprüfte und echte Befunde bleiben blockierend.
Eine Entscheidung kann niemals Parserfehler, Zeitlimits oder fehlende
Dateiabdeckung aufheben. Die am 18.10.2026 einzeln geprüften 2.983 aktuellen
Hinweise sind an 148 Kontextdateien gebunden und bis 17.11.2026 befristet.
Die vollständige Linux-Abdeckung wurde aus dem Vollscan und genau zwei
quell- und regelgebundenen Nachläufen nachgewiesen. Historische echte Fehler
bleiben als behoben dokumentiert. Neue Scannerhinweise werden nicht automatisch
als Fehlalarm übernommen; Änderungen und Ablauf erfordern eine erneute Prüfung.

Die Regel-ID wird gegen die vollständige ID-Liste des hashgeprüften
Upstream-Profils aufgelöst, unabhängig von temporären Scannerpfaden. Der
zusätzliche `legacyFingerprint` dient ausschließlich dem Vergleich mit älteren
Berichten ohne Spaltenbindung und wird nicht zur Freigabe verwendet.

Die gesonderte `patch-policy.json` betrifft ausschließlich die bereits
vorhandene CJS-Kompatibilitätsanpassung von `brace-expansion@5.0.12`. Sie
ignoriert keine Schwachstelle. Patch, Workspace-/Lockfile-Eintrag und installierte
Datei werden mit Hashes geprüft; beide realen ExcelJS-Verbraucher und begrenzte
Missbrauchsfälle müssen funktionieren. Ablauf nach höchstens 30 Tagen.

## Lokale Ausführung und Ergebnisse

Nach dem eingefrorenen Produktionsinstallationsschritt des Workflows:

```text
python scripts/security/install_tools.py --tool osv-scanner --directory <tools>
python scripts/security/gates.py sca --root . --tools <tools> --output <new-output>
python -m unittest discover -s scripts/security -p "test_*.py" -v
node --test test/security-ci-patch-policy.test.js
```

Für `sast`, `secrets` und `sbom` entsprechend die im Workflow dokumentierten
Werkzeuge installieren. Ausgabeverzeichnisse müssen für Scanner-Staging und
Publikation neu sein. Exitcodes: 0 bestanden, 1 blockierende Befunde,
2 Werkzeug-/Vollständigkeitsfehler. Ein Scannerfund ist vor der individuellen
Bewertung weder automatisch ein Exploit noch automatisch ein Fehlalarm.

Roh-JSON und stdout/stderr bleiben ausschließlich im privaten lokalen bzw.
flüchtigen Runner-Ausgabeverzeichnis. Sie werden **nicht** hochgeladen.
`publish_artifacts.py` erzeugt separat ausschließlich ausgewählte Zähler,
Status und Hashes sowie ein minimiertes CycloneDX mit Bibliotheksidentitäten.
Keine Quellauszüge, beliebigen Fehlermeldungen, Befehlszeilen, Secret-Werte,
Dateipfade oder SBOM-Properties gelangen in diese öffentlichen Artefakte.
Nur diese explizit benannten Dateien werden 14 Tage als Actions-Artefakte
aufbewahrt. Das volle Runner-Inventar wird lediglich per Hash referenziert;
ein dauerhaft benötigter Detailbeleg ist lokal bzw. am Releasehost privat
zu archivieren. Ein fehlgeschlagener Scanner bleibt auch nach erfolgreicher
Bereinigung fehlgeschlagen.
