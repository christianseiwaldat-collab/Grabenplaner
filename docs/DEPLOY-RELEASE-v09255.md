# v0.92.55 Beta · Importübersicht und Bestellkonfiguration

## Änderung

Die Importübersicht zeigt Originaldateiname, Status und den letzten
Bearbeitungsstand im GP. Der Kassenstand erhält eine gemeinsame Filialzuordnung
mit vorhandenen Standorten, geprüften bisherigen Bindungen und eindeutigen
Vorschlägen. Die [Bedienung](IMPORT-BEDIENUNG-2026-09-16.md) beschreibt die
Datumsbedeutung und die gemeinsame Prüfung und Aktivierung.

Beim Speichern der Filialbestellkonfiguration wartete der PostgreSQL-Zweig
nicht auf drei asynchrone ID-Abfragen. Der produktiv bestätigte Fehler
`existingIds.has is not a function` wird durch die fehlenden `await`-Aufrufe
behoben. Neue Einheiten, Positionen und Gruppen lassen sich dadurch gemeinsam
speichern. Historische Bestellungen und die Transaktion bleiben erhalten.

Die beiden zusätzlichen Kassa-Vorbereitungsbuttons in Prozessvorlagen und
Fähigkeitskatalog entfallen. Vorhandene Inhalte bleiben erhalten. Es gibt
keine neue Migration und keine zusätzliche Abhängigkeit.

## Freigabeprüfung

Der abschließende gemeinsame Lauf mit Node 22.22.1 bestand mit 185 erfolgreichen
Prüfungen, keinem Fehler und drei unter Windows übersprungenen Linux-Prüfungen.
Er umfasst Importe, gemeinsame Kassenfreigabe, Filialbestellung, Schulungs-UI,
Import-Lebenszyklus, Versionskonsistenz und Paketverträge. Der neue
Bestellkonfigurationstest lief auch nativ gegen PostgreSQL 18.6; geprüft wurden
wiederholtes Speichern, erhaltene historische Bestellungen und vollständige
Rücknahme bei einem Schreibfehler. Die Testdatenbank wurde anschließend beendet.

Die Oberfläche wurde zuvor mit synthetischen Daten im Browser geprüft. Der neue
Test ist im Persistenzinventar eingeordnet; die zwei bekannten historischen
Katalogfehler bleiben gesondert dokumentiert.

Der breite Teststand von v54 enthält dokumentierte Altfehler; ein vollständig
grüner Gesamtlauf wird nicht behauptet. Die etwa 30 Minuten pro vollständiger
Quelldatenbank auf dem VPS bleiben gesondert zu messen.

## Veröffentlichung

Commit `652d98c1ad59b2f0a7af048a104dd17126da96cb` wurde am 16.09.2026
installiert. Der erfolgreiche Updatebeleg stammt von 12:56:10 UTC; der
koordinierte Aufruf einschließlich Datenabgleich endete um 12:56:22 UTC
mit Exit 0.

- Paket SHA-256: `556f3a44ffacd729567180deaee213362dd72ad40579f7cd76ec32f4815f3ede`.
- Manifest SHA-256: `9819050a799eb9c6b9eb8f0897cbe83806239c4ee065b36a56002598107025b2`.
  Alle 727 installierten Laufzeitdateien wurden unabhängig nachgeprüft.
- Der installierte Updater wählte `full / RECOVERY_CONTRACT_CHANGED`, da
  Persistenzcode geändert wurde. Lokaler und externer Rückkehrpunkt sowie
  die abschließende lokale Sicherung wurden regulär verifiziert.
- 22 Tabellen hatten vor und nach dem Update dieselben Zeilenzahlen.
  Schema-Fingerprints und Prüfsummen der Importquellen, Importzustände,
  Kassenstände und Freigaben blieben identisch. Die zuvor abgeschlossenen
  Bestell- und Kassenarbeiter sowie ihre Kontextdateien blieben erhalten.
- Anwendung, Proxy, Datenbankdienste und Timer sind aktiv. Vier interne und
  öffentliche Live-/Ready-Prüfungen bestanden. Gegenüber der dokumentierten
  Ausgangslage gibt es keine zusätzlich fehlgeschlagenen Systemdienste.
- Die öffentlich ausgelieferte Versionsanzeige lautet v0.92.55. Beide
  Kassa-Vorbereitungsbuttons und ihre Script-Einbindung sind entfernt.
  Die vier geänderten öffentlichen JS-/CSS-Dateien stimmen bytegenau mit
  den geprüften Paketdateien überein.

Die automatische Recovery-Auslösung war während des koordinierten Updates
vorübergehend gesperrt. Der entsprechende Hinweis im Updaterprotokoll ist
erwartet. Beide temporären Sperren wurden beim Abschluss entfernt. Nach dem
erfolgreichen separaten Offsite-Selbsttest wurde der vollständige Lauf über
den bestehenden geschützten Dienst gestartet.

## Vollständiger Wiederherstellungsnachweis

Der signierte Lauf `92826dab-980c-4d1c-8a5f-1ec8f4954652` bestand am
16.09.2026 um 13:37:48 UTC; der Dienst endete mit Exit 0. Er bestätigt die
externe Sicherung, das vollständige Lesen des Repositorys, die Wiederherstellung
beider Datenbanken und den isolierten Anwendungsstart. Alle 24 abschließenden
Betriebsprüfungen bestanden.

- Snapshot: `5f3291bbbd07`.
- Restore-Beleg SHA-256:
  `8e86077d83ef293b94f34fdb4e9251fb8e64ab420186855ff8f77e2c1a07cf25`.
- Core: 210 Tabellen, 210.150 Zeilen und 22 Sequenzen.
- Sales: 63 Tabellen, 11.530.780 Zeilen und 2 Sequenzen.
- Zusätzlich bestätigt: Schema-Fingerprints, 55 geschützte Dokumente und
  114 geschützte Datensätze.
- Abschließende Prüfung um 13:38 UTC: vier erfolgreiche HTTP-Prüfungen,
  unveränderte Datenbankstrukturen und übrige Dienste, zwei vollständige
  lokale Sicherungspaare. Der gebundene Nachweis erlaubt kompatible
  Folgeupdates wieder im kurzen Modus.

Die temporären Deploy- und Uploadverzeichnisse dieser Veröffentlichung sind
entfernt. 28 archivierte Nachweisdateien wurden lokal anhand von Größe und
SHA-256 geprüft; rund 68 GiB sind auf dem VPS frei.

Serverarchiv:
`/var/lib/grabenplaner-assurance/maintenance-evidence/release-v09255-652d98c-20260916`.
Lokale Nachweise: `tmp/v09255-evidence/vps`.

Der Updater benötigte rund 26 Minuten, die anschließende vollständige
Assurance rund 40 Minuten. Das sind Release-Prüfzeiten, keine Messungen
der Importdauer. Der periodische Monitor bestand um 12:56:48 UTC; der
aktuellere vollständige Betriebsnachweis stammt aus der erfolgreichen
Assurance. Ein zusätzlicher periodischer Lauf danach wird nicht behauptet.
