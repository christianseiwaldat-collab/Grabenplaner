# Vollständigkeit des SAST-Scans und gebundener Quellbau

Semgrep 1.181.0 kann trotz leerem oberstem Fehlerfeld interne Abbrüche seiner
Taint-Fixpunktanalyse melden. Sie stehen unter `time.fixpoint_timeouts`. Die
vollständige Zieldateiliste allein ist deshalb kein Vollständigkeitsnachweis.
Fehlendes Profiling, fehlende oder nicht leere Fixpunktlisten, übersprungene
Dateien/Regeln, Analysefehler und widersprüchliche Prozesscodes bleiben Fehler.
Die Profilaufrufe verlangen `--time`; Einzelbewertungen können solche Fehler
nicht in einen erfolgreichen Scan umwandeln.

Die untersuchte Originalversion begrenzt diese innere Berechnung fest auf
0,2 Sekunden. Ein höheres äußeres `--timeout` verändert diese Grenze nicht.
Einzelregel-/Ganzdateiproben bestätigten den Abbruch. Der zusätzlich untersuchte
alternative Scanner ist nicht freigegeben: Seine andere Fixpunktbegrenzung
liefert keinen ausreichenden Nachweis tatsächlich abgeschlossener Konvergenz.

## Eng begrenzter Quellbau

Der verpflichtende Linux-SAST-Job verwendet den unveränderten, über sämtliche
Paket-Hashes gebundenen Python-Wrapper 1.181.0 und denselben unveränderlichen
Upstream-Regelsatz. Nur der native Kern wird im privaten Job aus dem offiziellen
Upstream-Quellstand neu gebaut:

| Bindung | Wert |
| --- | --- |
| Upstream | `https://github.com/semgrep/semgrep.git` |
| Tagobjekt `v1.181.0` | `77a9477dbb1d7e8780d6113adc7c8204dac83150` |
| Commit | `72d3525fe7e02f486428386078f192f8c4756804` |
| Einzige semantische Änderung | `src/configuring/Limits_semgrep.ml`: `taint_FIXPOINT_TIMEOUT` von `0.2` auf `30.0` Sekunden |
| Originaldatei SHA-256 | `3ed5f57cd546ab78208a944bd35b6e974116d6aa1d59f1fe318d5a087f5fdeb1` |
| Geänderte Datei SHA-256 | `92b07fd747b597a3e5eb59b3325c61812bb29e2aef1ee848251498feabf3f526` |

Der Builder prüft das Tagobjekt, den Commit, die vollständige Submodulemenge,
den ursprünglich sauberen Quellbaum, die exakten Original-/Änderungsbytes und
die vollständige Git-Differenz. Variablen-, Mengen- und Graphgrenzen werden
nicht geändert. Der offizielle Docker-Buildtarget `semgrep-core-container`
verwendet den dokumentierten, unveränderlichen Alpine-Manifestdigest. Compiler-
und opam-Repository-Commits bleiben gebunden. Paketinventar, SBOM, Lizenz,
Quellinventar, Patch und natives Binary werden im privaten Nachweis aufbewahrt.
Eine verifizierte Upstream-Tagsignatur oder ein bitidentischer Neubau wird
damit nicht behauptet. Der Kern ist ausdrücklich ein veränderter Quellbau und
kein offizielles Releasebinary.

## Qualifikation und vollständiger Projektscan

Vor jedem vollständigen Scan baut und qualifiziert derselbe Job den Kern neu.
Vier synthetische Positiv-/Negativpaare prüfen dynamisches Laden, SQL-Injektion,
mehrfache Schleifendurchläufe und asynchrone Datenflüsse. Hinzu kommen alle fünf
unveränderten Profile auf der ganzen `server.js` und das Common-Profil auf einer
weiteren vollständigen Produktdatei. Alle zehn Rohresultate müssen vollständig
und hashgebunden sein; die vier sicheren Kontrollen dürfen keine Funde liefern.

`prepare_source_core.py` prüft diese Resultate, die tatsächlich installierten
Kernbytes und die aktuellen Ganzdatei-Hashes erneut. Nur die ausdrücklich
vorbereitete private virtuelle Umgebung darf geändert werden. Die normale
SAST-Ausführung und die Payroll-Response-Kontrolle prüfen diese Bindung nochmals
und verwenden den absoluten geprüften CLI-Pfad. Ein gleichnamiger Eintrag in
`PATH` oder ein fremdes `--semgrep` ersetzt ihn nicht.

Erst danach laufen die unveränderten fünf vollständigen Projektprofile mit allen
vorgesehenen Dateien, der bisherigen Einzelregel-/Gesamtzeitbegrenzung und den
unveränderten Einzelbewertungsregeln. Neue oder veränderte Hinweise, fehlende
Kontexte und abgelaufene Fristen blockieren weiterhin. Zehn erfolgreiche
Toolqualifikationen sind kein Ersatz für diesen Vollscan. Ebenso ersetzt ein
vollständiger Scan keine Laufzeit-, Berechtigungs-, Betriebs- oder ASVS-Prüfung.

Der kalte Compilerbau benötigt erheblich mehr Zeit als ein Scan mit fertigem
Binary. Der Job hat dafür ein eigenes konservatives Gesamtbudget. Die
Scannerbudgets selbst werden nicht verlängert; Timeout oder unvollständiger
Quellbau bleiben ein fehlgeschlagener Security-Job. Es gibt keinen Rückfall auf
den ursprünglich unvollständigen Kern oder den nicht qualifizierten alternativen
Scanner.

## Vertraulichkeit und geprüfte Wiederverwendung

GP-Funde, Prüfkontexte, Prozessprotokolle und der private native Qualifikations-
nachweis verlassen den Runner nur verschlüsselt. Der Entschlüsselungsschlüssel
bleibt offline. Öffentliche CI-Metadaten enthalten ausschließlich die bisherigen
schemaausgewählten Zusammenfassungen. Ein erfolgloser Quellbau hinterlässt einen
ausdrücklich unvollständigen Prüfbeleg.

Die getrennten Tool-Publisher-/Consumer-Werkzeuge sind in den Quellbauablauf
eingebunden. Ein unabhängig geprüfter, versionierter Pin unter
`.github/security-semgrep-core-pin.json` aktiviert die Wiederverwendung für
genau die gebundenen Compiler-Eingaben. Der Publisher verlangt ein vollständiges,
an das tatsächlich qualifizierte Binary gebundenes Dritt-Lizenz-/Quelleninventar.
Originale Quellen und Lizenztexte bleiben erhalten; deklarierte Lizenznamen und
separat gekennzeichnete Referenztexte ersetzen keine Originalnachweise.

Vor der Nutzung prüft der Consumer äußere und innere Archiv- und Binary-Hashes,
das vollständige Quelleninventar sowie feste Repository-, Workflow-, Run-,
Commit- und Artefaktidentitäten. Ein fehlender Pin, ein abgelaufenes oder nicht
verfügbares Artefakt oder ein gültiger Pin für andere Compiler-Eingaben führt
zum kalten Quellbau.
Widersprüchliche oder beschädigte Nachweise für den ausgewählten Pin blockieren.
Bei jeder Wiederverwendung folgen erneut die zehn Qualifizierungsfälle mit den
aktuellen vollständigen Dateien und alle fünf regulären Vollscanprofile.
Scan-Ergebnisse werden nicht wiederverwendet. Der jeweilige CI-Beleg weist den
tatsächlich benutzten Weg als `reviewed_reuse` oder `cold_build` aus.

Reine Upstream-Quellen-/Lizenzdiagnosen enthalten keine GP-Funde und werden als
begrenztes, ausdrücklich aufgelistetes Set mit Hashmanifest aufbewahrt. Sie sind
als Diagnose gekennzeichnet und erteilen keine Tool- oder Security-Freigabe.
Diese Compiler-Prüfung bestätigt keine Produktivinstallation.
