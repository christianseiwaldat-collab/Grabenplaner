# Veröffentlichung v0.92.27 Beta

Am 05.09.2026 wurde die Veröffentlichung des vorhandenen Implementierungs- und Prüfstands ausdrücklich freigegeben: lokaler Commit, Push des zugehörigen Feature-Branches und das bestehende transaktionale VPS-Update.

Diese Freigabe ersetzt die früheren Commit-/Push-/Deploy-Stopps für den nun veröffentlichbaren Code. Sie ist **keine fachliche Abnahme oder Freigabe zur produktiven Übernahme der Gesamtimport-Daten**. Die im [Block-6-Prüfbericht](BLOCK-6-PRUEFUNG-UND-ABNAHME.md) beschriebenen offenen Punkte bleiben bestehen.

- Die neuen Verkaufs-/Kassen- und CRM-Kaufansichten sind integriert, aber ohne produktive Historienquelle. Ohne geprüfte Quellen- und Schlüsselkomposition bleibt die API gesperrt.
- Die isolierten Import-, Stammdaten- und Historientabellen werden beim normalen App-Start nicht angelegt. Bestehende Artikelimporte und operative Geschäftsdaten werden durch dieses Release nicht verändert.
- Neue fachliche Rechte werden nicht automatisch an andere Rollen ausgeweitet; die geschützte Developer-Rolle behält alle bekannten Anwendungsrechte.
- Quell-ACCDBs, importierte Geschäftsdaten, Schlüssel, persönliche PDFs, Testdatenbanken und lokale Testprotokolle sind kein Teil des Commits oder des neutralen Serverpakets. Der Quellenkatalog und die Testberichte enthalten ausschließlich datensparsame Metadaten und Prüfergebnisse.
- Runtime-, Offsite- und Host-Sicherheitsverträge bleiben unverändert. Es werden keine SSH-, Tailscale-, Firewall-, Schlüssel- oder Zugangsänderungen vorgenommen; der App-Port bleibt auf `127.0.0.1` gebunden.

## Voraussetzungen für die spätere Datenfreigabe

1. Bestätigte TradeFoto-Verkaufs-/Tagesabschlussberichte mit eindeutigem Zeitraum und Filiale; dazu nachvollziehbare Beispiele für Verkauf, Rückgabe und Storno einschließlich Positionen und Belegsumme. Nicht benötigte Kundendaten können geschwärzt werden.
2. Unabhängiger Access-Abgleich der abweichenden Zeilenzähler in `ARTIKEL_STAMM` und `ARTIKEL_FILIALEN` oder eine ausdrücklich dokumentierte fachliche Quellenentscheidung.
3. Bestätigte Zuordnungen zwischen historischen Filial-/Verkäuferkennungen und den heutigen GP-Standorten/Personalnummern sowie kontrollierte CRM-Verknüpfungen. Keine automatische Erfindung fehlender Zuordnungen.
4. Freigegebener produktiver Schlüssel-/Aufbewahrungsbetrieb, vollständiger Großdatentest und ein gesonderter Übernahmeauftrag. Externe Medien und zusätzliche Archive sind getrennt bereitzustellen.

Paketprüfsumme, Commitbindung, Sicherungspunkt, Update-Receipt und Betriebsprüfungen werden beim tatsächlichen Rollout separat erfasst. Diese Vorbereitungsnotiz behauptet noch keinen abgeschlossenen Deploy.
