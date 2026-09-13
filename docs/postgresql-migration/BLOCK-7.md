# Block 7: Verbindungen zwischen Core und Sales

Stand 12.09.2026, isoliert abgeschlossen. Produktive Freigabe bleibt geschlossen.

## Zuständigkeiten und Transaktionen

Die unveränderten Trade-Quellarchive, Stammdatensegmente, Artikel und Kassa bleiben in Sales. Bestätigte GP-Zuordnungen (`import_master_bindings`, `import_master_events`, `import_master_holds`) gehören dagegen zum Core. Dadurch werden CRM-Karte, Zuordnung und Änderungsereignis innerhalb **einer Core-Transaktion** gespeichert. Die drei alten, leeren Sales-Tabellen sind in dieser Entwicklungsstufe gesperrt; Block 9 muss ihren historischen Inhalt ausdrücklich zum Core übertragen. Dies präzisiert die ursprüngliche Tabellenzuordnung aus Block 1.

Der zusammengesetzte Provider routet bekannte Statements ausdrücklich. Ein Schreibvorgang darf genau eine Datenbank ändern. Ein zweiter Schreib-Eigentümer führt zum vollständigen Rollback. Der andere Teilnehmer liest nur und wird vor dem Schreiber abgeschlossen. Ein begrenzter, sitzungsgebundener Koordinations-Lock bleibt bis zum Abschluss beider Teilnehmer bestehen. Ein Prozessabbruch löst diesen Lock automatisch; es gibt keine zurückgelassenen vorbereiteten Transaktionen. Unabhängige GP-Lesezugriffe benötigen diesen Lock nicht. Berechtigungen werden über den zwingend übergebenen aktuellen Autorisierungsprüfer vor Abschluss erneut geprüft. In der Berichtskomposition besitzt dieser Prüfer einen eigenen Core-Leser mit genau einer Verbindung. Er sieht einen frischen Stand und benötigt keine weitere Verbindung aus einem möglicherweise bereits durch Transaktionen belegten Anwendungspool.

Alle Import- und Zuordnungsabläufe müssen im späteren Serverbetrieb diesen Provider verwenden; ein direkter Aufruf der darunterliegenden Einzelprovider ist kein zulässiger Ersatz. Diese Anbindung wird erst in der späteren Integrationsprobe und beim Cutover freigegeben.

Die Datenbankteilnehmer werden erst beim ersten tatsächlichen Zugriff geöffnet. Der große Importtest in Block 8 zeigte, dass ein vorzeitig geöffneter, ungenutzter Core-Teilnehmer sonst nach 30 Sekunden Idle-Zeit ausläuft. Der Koordinations-Lock bleibt auf einer eigenen Verbindung erhalten. Verbindungsabbrüche zwischen zwei Statements werden als fehlgeschlagene Transaktion behandelt und lösen keinen unbehandelten Node-Fehler mehr aus. Alle vier Grenztests bestanden anschließend gemeinsam auf Schema-Stufe 8.

## Versionierte Übergaben

- Core-Zuordnungen halten eine geprüfte Quellrevision mit SHA-256. Historische Quellrevisionen bleiben nachweisbar, auch wenn ein neuer Import vorliegt.
- Leihpositionen übernehmen die exakt ausgewählte Sales-Artikelrevision in die lokale Core-Referenztabelle. Spätere Trade-Änderungen verändern eine bestehende Leihe nicht.
- Artikel-Audits entstehen atomar im Sales-Auftrag. Eine Core-Inbox verbucht jede Ereignis-ID einmal gemeinsam mit dem Audit. Erst danach folgt die Sales-Zustellbestätigung. Nach einem Abbruch dazwischen setzt die Zustellung ohne Duplikate fort; abweichende Prüfsummen werden abgewiesen.
- CRM-Abhängigkeiten und gefilterte Zuordnungslisten werden über beide Datenbanken zusammengeführt. Eine bestehende Zuordnung verhindert die Rücknahme des zugrunde liegenden Imports.

## Nachweis

184 vorbereitete Sales-Statements plus 24 zusätzliche Grenz-Statements. Der Core-Katalog aus Block 4 bleibt unverändert; Zusatzkatalog und Schema sind separat versioniert und gegen echte PostgreSQL-Definitionen geprüft.

Vier echte Integrationstests bestanden: CRM-Synchronisation samt Rücknahme; Rechteverlust und unzulässiger zweiter Schreiber; Leihe mit fester Artikelrevision samt Zustellabbruch; Kassa-Publikation mit echten Core-Filialen und Mitarbeitenden. Ein deaktivierter Mitarbeiter verhindert die Publikation. Initiale Testannahmen zum Fehlercode und zur Zahl der Quellaudits wurden korrigiert, die drei betroffenen/ergänzten Prüfungen bestanden anschließend gezielt (3 bestanden, 0 Fehler, 0 übersprungen).

Die historischen 2,6 GB wurden nicht übertragen. Wiederherstellung beider Datenbanken und der Schlüssel als zusammengehöriger Stand bleibt Voraussetzung aus Block 9–11. PostgreSQL weist auf die zusätzlichen Betriebsanforderungen verteilter vorbereiteter Transaktionen hin; deshalb verwendet dieser Entwurf eindeutige Schreibzuständigkeiten und bestätigte Ereignisübergaben: [PostgreSQL 18, PREPARE TRANSACTION](https://www.postgresql.org/docs/18/sql-prepare-transaction.html).
