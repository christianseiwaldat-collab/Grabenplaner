# Paketgebundene SAST-Kontexte

Nicht ausgelieferte Tests, SQLite-/Transfer-Altmodule und Entwicklungswerkzeuge
bleiben außerhalb des Laufzeitbaums. Ein privater CI-Beleg enthält nur ihre
SHA-256-Werte, explizite LF/CRLF-Varianten, den Quellcommit, die Bewertungsdatei
und die Identität des SAST-Laufs. Er enthält keinen ausführbaren Quelltext.

## Erzeugung und Vertrauensgrenze

`security.yml` erzeugt `sast-context-evidence.json` nach dem erfolgreichen
vollständigen SAST-Gate und der zusätzlichen Response-Regelprüfung. Der Helfer
verlangt einen sauberen Commit, die erwartete Workflow-Identität, alle fünf
vollständigen Profile ohne Fehler/Timeouts, exakt passende Fundstellen und
Einzelbewertungen sowie sämtliche aktuellen Prüfdateien. Der Beleg wird mit den
anderen privaten Nachweisen verschlüsselt; die öffentliche Uploadliste bleibt
unverändert.

Der Releaseverantwortliche muss das CI-Artefakt authentifiziert beziehen und
dessen Run/Attempt/Commit, erfolgreichen Workflow, Archivdigest, Uploadmanifest
und entschlüsselten Inhalt im bestehenden Freigabeweg prüfen. Erst danach wird
der SHA-256-Wert des darin enthaltenen Kontextbelegs als **externer Pin** an den
Paketbauer übergeben:

```powershell
./server-tools/package/New-GrabenplanerLinuxServerPackage.ps1 `
  -SourceDirectory <sauberer-gepruefter-checkout> `
  -OutputDirectory <neues-ausgabeverzeichnis> `
  -SastContextEvidence <privater-verifizierter-kontextbeleg.json> `
  -SastContextEvidenceSha256 <extern-verifizierter-sha256>
```

Ein selbst berechneter Hash einer beliebigen JSON-Datei ist keine
Authentifizierung. Der Helfer behauptet weder eine unabhängige CI-Signatur noch
eine neue Scanfreigabe. Seine Vertrauensgrenze ist die bestehende authentifizierte
Releaseprüfung. Der Paketbauer prüft zusätzlich Commit, Policy, vollständige
Kontextmenge und aktuelle Quell-/Paketbytes; ein alter Beleg passt nach einer
Quell- oder Bewertungsänderung nicht mehr. Der neue Paketbauer benötigt diesen
Beleg, sofern das neue SAST-Modul vorhanden ist; ältere Quellstände bleiben
kompatibel. Der aktuelle Arbeitsbaum benötigt vor einer Auslieferung einen
eigenen vollständig erfolgreichen CI-Lauf.

## Laufzeit und Fehlerfälle

Der private Beleg liegt unter `lib/security-audits/` und ist durch das bestehende
Paketmanifest gebunden. Die Laufzeit prüft Manifest-Commit, Policy- und
Belegbytes, vollständige Kontexte sowie jede vorhandene Prüfdatei. Nur explizit
vom Paket ausgeschlossene Pfade können als `ci_evidence` gelten. Die beiden
mitgelieferten Backup-Skripte sind ausdrücklich keine solchen Ausschlüsse.

- Vorhandene Datei geändert: `changed`, auch mit altem Beleg.
- Laufzeitdatei gelöscht: `incomplete`, auch mit Beleg.
- Ausgeschlossener Kontext ohne Beleg: `incomplete`.
- Ausgeschlossener Kontext mit passendem Beleg: `evidenced` in der Bewertung.
- Beleg vorhanden, aber ungebunden/manipuliert/falscher Commit: HTTP 503.
- Frist abgelaufen: weiterhin Nachprüfbedarf; der Beleg verlängert keine Frist.

UI und Export unterscheiden direkt geprüfte Dateien von CI-belegten Kontexten.
Ein passender Beleg besagt nicht, dass alle ASVS-Anforderungen geprüft sind.

## Gezielte Regression

```sh
node --test test/security-sast-context-evidence.test.js test/security-sast-reviews.test.js
```

Die Symlink-Kontrollen laufen nativ unter Linux. Die bestehende
PowerShell-Paketprüfung läuft unter Windows. Zusätzlich prüfen die CLI-Tests
echte temporäre Git-Commits, Fremd-Commit, Dirty-Tree, Capture und Packaging.
