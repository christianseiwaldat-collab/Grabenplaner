# GP#677: isolierte PostgreSQL-Workerinitialisierung

Stand: 18.09.2026, 08:29 Uhr Europe/Vienna.

## Betriebsstand

Die ursprünglichen 26 Fehler sind behoben; Nachweise stehen in
`CI-FEHLERKORREKTUR-2026-09-18.md`. Produktiv läuft weiterhin v0.92.58-beta,
Commit `736cc4dd7b00413ca3e6cb3eafba1e84a1d80c5e`. Am 18.09.2026 um
08:27 Uhr waren App und Caddy aktiv und alle vier internen/öffentlichen
Live-/Ready-Abfragen HTTP 200. Für den Betriebsbeginn um 09:00 Uhr wird kein
neuer Releasewechsel mit Wiederherstellung gestartet.

Der CI-Lauf 35312654769 für `616a6b6` ist inzwischen vollständig erfolgreich.
Das ist kein CI- oder Recovery-Nachweis für spätere Änderungen.

## Diagnose und Korrektur

Zwei eng begrenzte Vergleichsprüfungen verwendeten dieselbe bereits
wiederhergestellte private PostgreSQL-Kopie, drei Reportworker und die
bestehende Isolation mit einer CPU und 1,5 GiB. Kein Vollrestore und keine
Produktionsänderung wurden ausgeführt. Die Initialisierung verwendete einen
synthetischen Vault-Schlüssel; keine fachlichen Berichte oder Entschlüsselungen
wurden ausgeführt. Jeder Diagnose-Service war auf 180 Sekunden begrenzt.

Vor der Korrektur gelangen alle sechs Datenbankverbindungen in weniger als
zwei Sekunden. Core- und Sales-Schema-Prüfungen bestanden. Danach kompilierte
die Datenbankzuordnung die bereits von den Providern geprüften SQL-Kataloge
erneut. Alle drei Worker überschritten die äußere Diagnosefrist von 125 Sekunden.

Die Zuordnung verwendet jetzt die identischen Statement-IDs der Quellkataloge.
Die erste vollständige Kompilierung und Qualifizierung in jedem Provider sowie
die Prüfung der tatsächlichen Datenbankschemata bleiben unverändert.

Im Vergleichslauf wurde ausschließlich diese Änderung überlagert. Alle drei
Worker meldeten `ready: true` nach rund 98,5 Sekunden. Weder die zuvor lokal
versuchte Microtask-Verzögerung des Workers noch längere Zeitlimits gehörten
zu diesem Vergleich. Die Diagnosequellen wurden anschließend zurückgesetzt.

Lokale Regressionen prüfen identische Statement-IDs für Core und Sales in
Stufe 7/8, tatsächliche Zuordnung von Leseoperationen sowie das Ausbleiben einer
zweiten Kompilierung. Acht gezielte Start-/Workerprüfungen und fünf Prüfungen
der Persistenzarchitektur bestanden. Die acht Prüfungen umfassen auch lokale,
weiterhin separat gehaltene Versuche mit Initialisierungsfristen.

## Freigabegrenze und Belege

Der erfolgreiche Vergleich belegt die Workerinitialisierung, nicht die
vollständige Anwendung, einen fertigen Release oder die gesamte Recovery.
Die fünf übernommenen lokalen Änderungen bleiben von dieser Korrektur getrennt;
insbesondere sind verlängerte Fristen dadurch nicht als erforderlich bestätigt.
Es wurde kein v0.92.60-Deploy ausgeführt.

Lokale Diagnosebelege: `tmp/gp677-worker-phases.log`,
`tmp/gp677-worker-phases-after.log`, `tmp/gp677-architecture-tests.log`.
Remote Diagnosebelege liegen weiterhin in der erhaltenen isolierten Testkopie
`/var/lib/grabenplaner-offsite/postgresql-recovery/cbedbc1a-2b81-4cb6-a6e4-8125b8d671fe`.
Vor einer späteren Veröffentlichung fehlen die Freigabe des exakten finalen
Pakets und dessen vollständiger Anwendungstest in der Recovery-Umgebung.
