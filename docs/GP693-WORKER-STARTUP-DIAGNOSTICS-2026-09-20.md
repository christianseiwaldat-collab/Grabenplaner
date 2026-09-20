# GP693: Diagnose von PostgreSQL-Worker-Startfehlern

## Anlass und Umfang

Der fehlgeschlagene Wiederherstellungstest brach beim Initialisieren der Anwendung ab, bevor der HTTP-Listener und der PDF-Test erreicht wurden. Der PostgreSQL-Worker ersetzte unterschiedliche technische Fehler durch `IMPORT_REPORT_FAILED`; die ursprüngliche Fehlerklasse war anschließend nicht mehr bestimmbar.

Diese Änderung ergänzt die Diagnose. Sie ist auf dem vorbereiteten App-Stand 0.92.62 aufgebaut und noch nicht produktiv installiert. Sie weist keine bestimmte Ursache des früheren Abbruchs nach.

## Implementierung

- Die Anwendungsinitialisierung meldet die Phasen `application-data`, `receipt-workers` und `report-worker`.
- Der PostgreSQL-Worker unterscheidet Modulladen, Core-Datenbank, Sales-Datenbank, Datenbank-Routing, Laufzeitaufbau und spätere Aufträge.
- Bekannte technische Fehlerklassen und freigegebene Originalcodes, etwa SQLSTATE `53300`, bleiben über die Thread-Grenze erhalten. Unbekannte Fehler werden als unbekannt erfasst. Eine abgebrochene Abfrage wird nicht pauschal als Zeitüberschreitung ausgegeben.
- Die Wiederherstellungsprüfung schreibt bei einem Initialisierungsfehler eine kleine private `startup-failure.json` mit Modus `0600`. Die bestehende Bereinigung übernimmt ausschließlich freigegebene Felder in ihren dauerhaft aufbewahrten Nachweis, bevor sie die Testkopie entfernt.
- Rohmeldungen, SQL, Kennwörter, Verbindungsadressen und Stacktraces werden nicht in diese Diagnose übernommen. Öffentliche Fehlercodes, Zeitlimits, Verbindungspools und Wiederholungsregeln bleiben unverändert.

Die Recovery-Helfer werden bereits aus dem Anwendungsbaum geladen und verwenden dort auch `server.js`. Die neue gemeinsame Diagnosebibliothek liegt im selben `lib`-Baum; es wird kein separat installierter Modulpfad vorausgesetzt.

## Gezielte Prüfung unter Ubuntu

31 Tests aus sechs Dateien bestanden, kein Fehler, Laufzeit rund 15,7 Sekunden. Zusätzlich bestanden die Syntaxprüfungen der geänderten Anwendungsmodule.

Der Kaltstarttest verwendet den tatsächlichen PostgreSQL-Worker einschließlich seiner Module und des echten `pg`-Treibers. Eine ausschließlich lokale, synthetische PostgreSQL-Protokollgegenstelle weist den Verbindungsaufbau mit SQLSTATE `53300` zurück. Die Prüfung bestätigt `core-database` / `connection-capacity` / `53300`, die unveränderte öffentliche Fehlermeldung und genau einen Verbindungsversuch.

Weitere Tests prüfen die Fehlerweitergabe bis zur privaten Recovery-Diagnose, erfolgreiche Initialisierung, unveränderte HTTP-Prüfungen, Verbindungs- und Schemafehler, unbekannte Fehler, Worker-Absturz, Zeitüberschreitung sowie das Verwerfen unzulässiger Diagnoseinhalte. Die vorhandenen Worker-Tests synchronisieren ihre Prüfung nun mit dem tatsächlichen Arbeitsbeginn beziehungsweise einer kontrollierten Testuhr, statt von engen Laufzeitannahmen eines gemeinsam genutzten Rechners abzuhängen.

Die Tests liefen ohne Root-Rechte in einem temporären Quellbaum. Sie verwendeten die installierten Bibliotheken lesend und ausschließlich synthetische Verbindungen und Testdaten. Der temporäre Baum wurde anschließend entfernt. Die installierte Anwendung, ihre Datenbanken und die Wartungsplanung wurden nicht verändert. Es gab keinen Deploy und keinen vollständigen Wiederherstellungslauf.

## Nachweisgrenze und Fortsetzung

Der Test belegt die zuverlässige Weitergabe eines gezielt ausgelösten Startfehlers. Er reproduziert nicht den ursprünglichen Fehler mit der inzwischen entfernten Restorekopie. Die Ursache des damaligen Abbruchs bleibt daher offen.

Vor einem weiteren Release muss der geänderte Kandidat die üblichen Freigabeprüfungen durchlaufen. Für die weitere Ursachenanalyse ist zunächst ein gezielter isolierter Start gegen eine geeignete Testdatenbank zu prüfen und dessen neue Diagnose auszuwerten. Aus diesem Ergebnis folgt die sachliche Reparatur; weder Zeitlimits noch Poolgrößen sollten ohne diesen Nachweis geändert werden. Ein fehlgeschlagener Lauf darf keine automatische neue Deploy- oder Vollrestore-Schleife auslösen.

Lokale Nachweise liegen im Aufgabenverzeichnis `output/deploy/gp693-worker-diagnostics`: `ubuntu-focused-tests.tap` und `tested-source-sha256.json`. Die früher erzeugten Releasepakete enthalten diese Ergänzung noch nicht.
