# Lokale Abnahme der GP-Assistenten – 12. Oktober 2026

## Umgesetzter Umfang

| Bereich | Geprüfter Stand |
| --- | --- |
| Developer-Verwaltung | `voice.assistants` als Hauptpunkt, eigene Unterseite `portal.assistant`, Grundeinstellungen, Administrator-Pilot, bestehende Rechte und serverseitiger Schlüssel |
| Mitarbeiterportal | Eigene Salden, eigener Dienstplan, Antragsverlauf, Bedienhilfe, Sprache und Text, beendbare Gespräche |
| Urlaub und ZA | Entwurf aus Sprache, GP-Datums-/Tages-/Stundenbewertung, sichtbare und gesprochene Vorschau, ausdrückliche Bestätigung, bestehender Freigabeprozess |
| Lokale Planprüfung | Überschneidungen, Abwesenheiten, Arbeitszeitprofile, Sollstunden, Besetzung, Schlüsselpersonen, Pausen und bestehende Lernanforderungen |
| Lokale Optimierung | Echter OR-Tools-CP-SAT-Python-Prozess, Wochenplanvorschläge einschließlich leerer Wochen, Ersatzpersonal, Wünsche, Samstagsverteilung, Änderungskosten, bis zu drei Szenarien |
| Planübernahme | Aktuelle Rechte, serverseitig gespeicherter Vorschlag, erneute GP-Prüfung, unveränderte Planungsgrundlage, ausdrückliche Bestätigung, atomare Speicherung und Audit |
| Betrieb | Windows-/Linux-Paketlisten ergänzt, eigene Python-Umgebung dokumentiert, Laufzeit-/Abbruchgrenzen, verständlicher Fehlerzustand ohne Beeinträchtigung der normalen Dienstplanung |

## Automatisierte Regression

**501 bestanden, 0 fehlgeschlagen, 4 umgebungsbedingt übersprungen** im abschließenden Lauf. Node.js 24.19.0, Python 3.10, OR-Tools 9.15.6755, echtes Headless-Chrome für die aktivierten Browserprüfungen. Alle personenbezogenen Testdaten waren synthetisch; API-Tests verwendeten isolierte temporäre SQLite-Datenbanken.

Geprüft wurden die neuen Assistenten sowie die betroffenen bestehenden Lern-, Kompetenz-, Arbeitszeit-, Planungs-, Aufsichts-, Antrags-, Rechte- und Paketfunktionen. Die vier übersprungenen Prüfungen betreffen einen isolierten nativen PostgreSQL-Lernlauf und drei Linux-Installationsprüfungen; diese Umgebungen standen auf diesem Windows-Host nicht bereit. Damit wird kein vollständiger PostgreSQL-/Linux-Produktionsnachweis behauptet.

Die Tests erfassen unter anderem Fremdzugriff, CSRF, Rechteentzug, abgelaufene/falsche Qualifikationen, tatsächliche Dienstabteilung, übernommene Abteilungsvorgaben im Gesamtplan, beschädigte Konfiguration, unmögliche Modelle, Wünsche, Fairness, leere Wochen, Ersatzsuche, Abbruch, Zeitlimit, veraltete Vorschläge, fehlende Bestätigung, doppelte Bestätigung und vollständigen Transaktionsrollback bei einem absichtlich ausgelösten Speicherfehler. Browserprüfungen umfassen Desktop, Smartphone und dunkle Darstellung. Syntaxprüfung der geänderten JavaScript-Dateien, Python-Kompilierung und `git diff --check` waren erfolgreich.

## Echte OpenAI-Verbindung

Vier erfolgreiche Läufe mit dem echten Mitarbeiterportal, synthetisch gesprochenem Deutsch, tatsächlichem WebRTC, `gpt-live-1` und `gpt-6-luna`:

| Äußerung | Geprüftes Ergebnis |
| --- | --- |
| „Wie viele Urlaubstage habe ich noch?“ | 25 Tage aus dem synthetischen GP-Urlaubskonto, auch gesprochen ausgegeben |
| „Wie arbeite ich nächste Woche?“ | Eigener Dienst am 11. April 2031, mit der normalen Portalabfrage verglichen |
| „Ich möchte vom vierzehnten bis achtzehnten April Urlaub nehmen.“ | Entwurfsdatum vorgelesen; vor Bestätigung kein Antrag, danach genau einer mit `pending_local` |
| „Beantrage bitte nächsten Freitag einen Zeitausgleichstag.“ | 4. April 2031 anhand des synthetischen GP-Testdatums; Entwurfsdatum vorgelesen; vor Bestätigung kein Antrag, danach genau einer mit `pending_local` |

Jeder Lauf bestätigte Audio in beide Richtungen, Client Delegation, GP-Rückantwort und gestopptes Mikrofon beim Beenden. Der freigegebene Schlüssel wurde ausschließlich im Testprozess verwendet. Es wurden keine Schlüssel, Personaldaten oder Gesprächsaufnahmen eingecheckt. Reproduzierbare Einrichtung und Testaufrufe stehen in [Sprachassistent](gpt-live-sprachassistent.md) und [Planungsassistent](planungsassistent.md).

## Geltungsbereich

Dies ist ein lokal implementierter und geprüfter Entwicklungsstand. Eine Produktionsinstallation, produktive Aktivierung und Prüfung mit physischen Mobilgeräten wurden nicht durchgeführt. Die Optimierung sucht in einer begrenzten Menge GP-geprüfter Dienstvarianten; ihre Ergebniszustände und verbleibenden fachlichen Prüfhinweise sind dokumentiert. Sprachsteuerung der Dienstplanoptimierung bleibt der ausdrücklich getrennten späteren Ausbaustufe vorbehalten.
