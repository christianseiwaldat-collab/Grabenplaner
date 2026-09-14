# Release v0.92.46-beta

## Freigabe und Paketumfang

Am 14.09.2026 freigegeben: alle sechs Integrationsblöcke nacheinander,
anschließend Deploy bei bestandener Abnahme. Die danach gemeldeten Loginfehler
sind Teil desselben Pakets. Keine neue Veröffentlichung eines GitHub-Releases,
kein Tag und keine Änderung von Netzwerkzugängen oder anderen Anwendungen.

- [Sechs Fachblöcke](INTEGRATION-SECHS-BLOECKE-2026-09-14.md).
- [Planungsoptimierung](PLANUNG-LADEZEITEN-2026-09-14.md).
- [Login- und Importsperren](LOGIN-UND-IMPORTSPERREN-2026-09-14.md).

147 gezielte lokale Tests bestanden; zusätzlich native PostgreSQL-Fachprüfung,
native Belegsuche und tatsächlicher HTTP-Login mit zwölf parallelen Aufrufen bei
gleichzeitigem synthetischem Import bestanden. Produktive Daten wurden für
Diagnose und Vorprüfung ausschließlich gelesen. Der bisherige Betrieb ist
v0.92.45-beta / `ebeadc74a0e9cbeb54ba6f302048200a8a62901e`.

Die neue Core-Tabelle und ihr Migrationsprotokoll werden erst nach erfolgreichem
normalem Code-Update durch den installierten Root-Helfer ergänzt. Ein kontrollierter
Fehler in der DDL-Transaktion wurde nativ als vollständige Rücknahme geprüft.
Das Sales-Schema bleibt unverändert. Frischer gekoppelter Sicherungspunkt,
geprüftes Paket und kurze Betriebsprüfungen bleiben verpflichtend. Der bestehende
Updater wählt den Prüfmodus anhand seiner unveränderten Richtlinie.

## Installationsstand

Releasekandidat lokal vorbereitet; noch nicht als produktiv veröffentlicht
ausgewiesen. Paket- und Manifest-Hashes, Zeitmessungen, produktiver Schemastand,
Bedienprüfung und Abschluss werden nach dem tatsächlichen Wechsel ergänzt.
