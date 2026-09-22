# v0.92.64 Beta

Die Freigabe umfasst das System-Center, die Bewertung des vorhandenen
Filialbestands und das dauerhafte Löschen nicht übernommener Importquellen.

- Getrennte Datenbankdiagramme mit genauen Werten und gespeichertem Zeitraum;
  behobene veraltete 49/100-Begrenzung nach erfolgreicher Recovery-Prüfung.
- Überarbeitete Wartungszeiten, konfigurierbarer Sicherungsrhythmus und
  PDF-/Markdown-Prüfberichte je signiertem Assurance-Lauf.
- Filialbestand und Nettowert nach Sortimentsgruppen aus dem letzten übernommenen
  Datenstand. Bestätigte Dienstleistungen zählen nicht als Warenbestand;
  ein fehlender Einkaufspreis allein klassifiziert keine Dienstleistung.
- Geschützte Löschfunktion mit ausdrücklicher Auswahl/Bestätigung, Prüfung
  historischer Übernahmen, begrenzten Löschschritten und Wiederaufnahme.
- PostgreSQL-Verbindungsverluste brechen ein Sicherungspaar kontrolliert ab.
  Neue Sicherungen enthalten beide physischen Datenbankgrößen. Vor einem Restore
  werden mindestens 10 GiB sowie 150 % der gemessenen Datenbankgrößen zuzüglich
  privater Dateien und 2 GiB Reserve verlangt. Bei alten Sicherungen ohne Messung
  gilt eine gekennzeichnete Schätzung aus achtfacher Dumpgröße. Diese Reserven
  sind eine Vorprüfung, keine Garantie gegen späteres fremdes Plattenwachstum.

## Auslieferung

Der freigegebene APT-Wartungsschutz wird über den geprüften Installer aktiviert.
Er koordiniert Paketwartung mit der bestehenden GP-Wartungssperre, damit diese
PostgreSQL nicht während einer Sicherung neu startet. Der Server wird nicht
neu gestartet. Quellen werden erst durch eine Benutzeraktion gelöscht.

Vor dem App-Update erfolgt der reguläre Offsite-Modulabgleich mit bestehenden
geschützten Schlüsseln und unverändertem Repository. Seine vollständige Assurance
muss abschließen. Der geprüfte Kandidaten-Updater ist wegen der neuen additiven
Sales-Migration erforderlich: Er sichert zuerst, migriert nach dem Paketwechsel
unter der vorhandenen Sperre und startet erst dann die neue App. SQLite überspringt
diese PostgreSQL-Migration. Normale Paket-, Virenscan-, Health- und Recovery-Gates
bleiben verbindlich; Timer werden auf ihren vorherigen Zustand zurückgesetzt.

Nach dem Update folgen vollständige Assurance und die sequenziellen regulären
Server-/Offsite-Prüfungen. Der tatsächliche Produktionsabschluss wird im
separaten Releasebeleg festgehalten.

Details: [System-Center](SYSTEM-CENTER-GP719.md),
[Importlöschung und Bestand](IMPORT-DELETE-STOCK-GP720.md).
