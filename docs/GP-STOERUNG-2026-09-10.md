# GP-Antwortaussetzer am 10. September 2026

## Produktiver Zustand

v0.92.34-beta ist installiert. Während Berichtsläufen bestätigten die Monitor-
Protokolle wiederholte Antwortaussetzer; zwischen den Läufen antwortete die
Anwendung wieder normal. Drei PDF-Aufträge brachen jeweils nach 5.800 verarbeiteten
Positionen ab. Die fehlgeschlagenen Aufträge und vorhandenen Ergebnisse wurden
erhalten. Keine Wiederholungsaufträge wurden automatisch erzeugt.

## Messung und unmittelbare Entlastung

Ein vorhandener Auftrag wurde ausschließlich lesend in einem separaten Prozess
untersucht. Ein Schritt über 200 Positionen benötigte zunächst 31,620 Sekunden,
im instrumentierten Wiederholungslauf 29,525 Sekunden. Davon entfielen 28,490
Sekunden auf 147 Abfragen der zu einem Beleg gehörenden Positionen.

`cash_snapshot_6_parent` war vorhanden. SQLite wählte ohne Statistiken dennoch
einen Scan des Datensatzbereichs über den Primärschlüssel. Mit dem Elternindex
benötigten dieselben 147 Abfragen 17 Millisekunden, der gesamte Schritt 0,880
Sekunden. Das veränderte keine fachliche Berechnung oder Integritätsprüfung.

Um 07:09:14 UTC wurde unter der vorhandenen Wartungssperre ausschließlich die
Planungsstatistik für `cash_snapshot_6` aktualisiert. Die Analyse war auf 1.000
Indexeinträge begrenzt und lief in einer Transaktion mit kurzem Zeitlimit. Vor
dem Commit wurden Indexwahl, identische Vergleichsdatensätze sowie unveränderte
Zeilenzähler und Änderungsgenerationen geprüft. Ein anfänglicher belegter
Wartungslock wurde respektiert. Die unveränderte Anwendungsabfrage verwendete
anschließend den Elternindex; der komplette Schritt dauerte 0,883 Sekunden.
Kein Anwendungs- oder Ubuntu-Neustart war erforderlich.

## Vorbereitete dauerhafte Korrektur v0.92.35-beta

- Die Positionsabfrage verlangt den vorhandenen Elternindex auch nach einem neuen
  Import oder einer Wiederherstellung ohne Planungsstatistik.
- Die PDF-Warteschlange erhält einen eigenen Worker mit einer nur lesenden
  SQLite-Verbindung. Berechnung, Entschlüsselung und PDF-Ausgabe laufen außerhalb
  der Ereignisschleife des Webservers. Worker-Laufzeit und Speicher sind begrenzt.
- Größere Zwischenstände werden in begrenzten, verschlüsselten Speicherblöcken
  gehalten. Der Cursor bleibt klein, persönlich gebunden, zeitlich begrenzt und
  nur einmal verwendbar. Die allgemeinen Verschlüsselungsgrenzen bleiben bestehen.
- Vor Übernahme des Worker-Ergebnisses werden die aktuellen Rechte erneut geprüft.
  Abbruch und Versionskonflikte gewinnen gegen verspätete Ergebnisse. Beim
  Herunterfahren bleibt ein laufender Auftrag für einen kontrollierten Wiederanlauf
  erhalten. Isolierte Recovery-Smokes starten keine Berichtswarteschlange.

Die Ausgangsgrenze von 1,5 MiB pro verschlüsseltem Objekt ließ sich mit synthetischen
Belegen schon bei 5.600 Positionen überschreiten. Das erklärt den reproduzierbaren
Abbruch wachsender Zwischenstände; der alte Jobstatus enthielt nur einen allgemeinen
Fehlercode. Eine direkte nachträgliche Entschlüsselung des verlorenen Zwischenstands
ist nicht möglich, da dieser nur im Arbeitsspeicher existierte.

## Prüfungen und offene Bereitstellung

Gezielte Tests prüfen PDF-Summen mit dem tatsächlichen Worker, HTTP-Antworten bei
CPU-Last, Worker-Zeitlimit und Austausch, Rechteentzug während der Berechnung,
Abbruchkonflikte sowie 10.000 verschiedene Belege über mehrere verschlüsselte
Blöcke. Bestehende Kassen-, Import-, Rechte- und Wiederherstellungsverträge werden
zusätzlich geprüft. Die Codekorrektur ist noch nicht produktiv bereitgestellt.
Die erste kombinierte Funktionsprüfung bestand mit 67/67 Tests, die nachfolgende
erweiterte Prüfung mit 85/85 ausführbaren Tests. Drei unveränderte Linux-
Installationsfixtures waren unter Windows plattformbedingt übersprungen.
Weitere 30 Provider- und Versionsvertragsprüfungen bestanden ohne Fehler oder
übersprungene Prüfungen. Der Persistenz-Audit enthält keine unklassifizierten
Kopplungen oder Phasengrenzverletzungen.

Der tatsächliche Monitorlauf vom 10. September um 07:12:27 UTC bestand vollständig
mit 24/24 Prüfungen, ohne automatische Wiederanlaufaktion. Die öffentliche
Bereitschaftsprüfung antwortete danach mehrfach mit HTTP 200 in rund 0,75 Sekunden.

Der gescheiterte isolierte App-Smoke des vorherigen Deployments bleibt offen.
Die Datenwiederherstellung und die Bereitschaft der daraus gestarteten Anwendung
sind getrennte Nachweise. Ein wieder grüner Betriebsmonitor ersetzt den fehlenden
App-Smoke-Nachweis nicht.

## Erneute Störung und sichere Pause am Vormittag

Ein neuer Auftrag vom 10. September um 10:16:42 UTC scheiterte um 10:17:35 UTC
wieder bei 5.800 Positionen. Die produktive Version war weiterhin v0.92.34-beta;
der vorbereitete Worker war noch nicht installiert.

Um 10:24:47 UTC wurde unter der vorhandenen Wartungssperre die Berichtverarbeitung
pausiert. Ein temporärer SQLite-Trigger verhindert ausschließlich den Übergang
eines Auftrags zu `running`. Die bestehende Warteschlange prüft die tatsächliche
Änderungszahl und beginnt deshalb keine weitere Berechnung. Neue Aufträge bleiben
wartend, fertige Ergebnisse und Abbruch bleiben verfügbar. Alle Auftragszeilen
und der Quellenbestand wurden vor und nach der kurzen Transaktion verglichen.
Eine anschließende Probe mit Rollback bestätigte den unveränderten Job und null
geänderte Zeilen. Kein App- oder Host-Neustart wurde ausgelöst.

Der Trigger `gp_incident_20260910_pause_sales_reports` bleibt bis zur verifizierten
Bereitstellung der Korrektur aktiv. Er muss danach unter der Wartungssperre anhand
seiner exakten Definition entfernt werden. Eine Installation allein hebt diese
Pause nicht auf. Fehlgeschlagene Aufträge wurden weder gelöscht noch automatisch
neu beauftragt.

Ein separater, ausschließlich lesender Test mit dem tatsächlichen Auftrag und
identischer Berechtigungsprojektion überwand die Zwischenstandsgrenze, zeigte
jedoch einen weiteren Abbruch: 939 Kombinationen aus MA und Warengruppe mit sechs
Kennzahlen überschritten die Grenze von 250 PDF-Seiten. Die Seitenzahlgrenze
funktionierte; die ursprüngliche Tabellendarstellung benötigte zu viel Platz.

Die Korrektur verringert den Zellinnenabstand und verbreitert die Gruppenspalte
der Detailtabellen. Schriftgröße, sämtliche Gruppen und Kennzahlen sowie die
Seiten- und Dateigrößengrenzen bleiben erhalten. Ein synthetischer Bericht mit
939 Gruppen und denselben sechs Kennzahlen umfasst jetzt 195 Seiten. Die Prüfung
liest jede Seite, verifiziert alle Gruppen in sämtlichen Kennzahlen, Werte,
Schriftgröße, Seitenränder und Fußzeilen. Repräsentative Tabellen und Umbrüche
wurden zusätzlich gerendert und visuell kontrolliert.

Die aktuelle kombinierte Prüfung bestand mit 56/56 Tests, einschließlich des
echten Workers, Rechteentzug, Abbruch, Pausen-/Wiederaufnahmevertrag und des großen
PDFs.

Der abschließende Test des tatsächlichen Auftrags startete um 10:47:41 UTC mit
dem unabhängig geprüften Paketstand `2177276519400674cee7efc30ff35746f1849ae2`.
Der echte Worker verarbeitete 18.954 Positionen in 96 Schritten und insgesamt
97,929 Sekunden. Das PDF hatte 195 Seiten und 539.230 Bytes; der verschlüsselte
Auftrag blieb mit 653.594 Bytes innerhalb der vorhandenen Grenze. Alle 19
Bereitschaftsprüfungen während des Laufs antworteten mit HTTP 200, maximal nach
626 Millisekunden. Quellbestand und ursprünglicher Auftrag blieben identisch.
Das Test-PDF wurde ausschließlich im Arbeitsspeicher erzeugt und nicht gespeichert.
Beide privaten Diagnosestände wurden anschließend anhand ihrer exakten Pakete
und Dateihashes geprüft und vom Server entfernt.

Das Paket `Grabenplaner-Server-v0.92.35-beta-linux-x64.zip` im Verzeichnis
`release/server-linux-2177276` hat den SHA-256-Wert
`53dbee5b99b6c1b3fe43b417218e3800cbcfc1472b72115c6cd7da748307a521`.
Es enthält 551 geprüfte Laufzeitdateien und keine Änderungen an den Serverwerkzeugen.
Der Hotfix ist damit vorbereitet und mit dem tatsächlichen Auftrag geprüft,
aber noch nicht installiert. Die produktive Berichtspause bleibt aktiv.
