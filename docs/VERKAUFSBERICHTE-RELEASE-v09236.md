# Verkaufsberichte und Kassenklärung – v0.92.36 Beta

## Umfang

Das gemeinsame Release enthält den bisher nicht installierten Hotfix aus
v0.92.35 sowie die anschließenden Berichtserweiterungen, Kassenklärungen,
Beleganordnung und Browsernavigation. Grundlage sind die
[Auswahl- und Navigationsbeschreibung](VERKAUFSANALYSEN-AUSWAHL-UND-NAVIGATION-2026-09-10.md),
die [geprüften Kassenregeln](VERKAUFSBERICHTE-GEPRUEFTE-TEILWERTE.md) und der
[Störungsnachweis](GP-STOERUNG-2026-09-10.md).

Die Berichtserstellung läuft in begrenzten Hintergrund-Workern mit separater
lesender Datenbankverbindung. Verschlüsselte Zwischenstände werden aufgeteilt;
Rechteentzug, Abbruch, Wiederanlauf und Quellenbindung bleiben geprüft.
Neue Filter, Hoch-/Querformat, Diagramme und gekennzeichnete Teilwerte ergänzen
die PDF-Berichte. Die historischen Kassenwerte werden entsprechend den
bestätigten Fachregeln ausgewertet, einschließlich signierter Roherträge,
Gutscheine, UID-Zwischenbuchungen und Gebrauchtware mit gespeichertem Steuersatz 0.

Bereits gespeicherte PDF-Dateien bleiben unverändert. Für die neuen Regeln
sind neue Berichtsaufträge erforderlich. Alte, an einen anderen Regelstand
gebundene Aufträge dürfen nicht mit geänderten Regeln fortgesetzt werden.

## Prüfung vor der Bereitstellung

Die gezielte Releaseauswahl umfasst 658 Prüfungen für Kassa, TradeFoto,
Berichts-Worker, Verschlüsselung, Rechte, PDF-Inhalte und -Grenzen, Artikelstamm,
Navigation, angrenzende Oberflächen, Providerverträge und Paket-/Versionsstand.
Nach Anpassung der veralteten Versionsvergleiche bestehen 649 Prüfungen;
neun Linux- und PostgreSQL-Prüfungen ohne passende lokale Laufzeit bleiben als
übersprungen ausgewiesen. Der Persistenzaudit weist keine unklassifizierten
Dateien oder Phasengrenzverletzungen aus.

Vor der Bereitstellung wurde außerdem ein abgebrochener nächtlicher
Archivabschluss festgestellt. Die Wiederaufnahme verwendet die vorhandene
Archivverwaltung mit Prüfung des beendeten Sperrbesitzers und signierter
Vorgangshistorie; Sicherungspunkte werden durch diese Abstimmung nicht gelöscht.
Das Update bleibt vom erfolgreichen Abschluss der Sicherungsprüfungen abhängig.

## Bereitstellungsstatus

Vorbereitet, noch nicht als produktiv bestätigt. Die produktive Berichtspause
bleibt bis zum geprüften Releaseablauf bestehen. Paket-/Hash-Nachweis,
Updatebeleg, Wiederherstellungsprüfung, Betriebstests und Abschlussabgleich
werden hier nach tatsächlichem Abschluss ergänzt.
