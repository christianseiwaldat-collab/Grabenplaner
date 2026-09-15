# v0.92.53 Beta · PostgreSQL-Wiederherstellung der Schulungsdaten

Dieses Folgeupdate schließt den beauftragten Deploy von Schulung & Wissen
ab. Bei dessen vollständiger Assurance waren Daten und Sequenzen identisch,
der Schema-Abgleich der isolierten Kopie schlug jedoch fehl.

Die Wiederherstellung hatte implizite Standardrechte der 18 neuen
Triggerfunktionen in ausdrückliche Standardrechte umgewandelt. Beide Formen
haben dieselbe Wirkung, unterscheiden sich aber im gespeicherten Schema.
Die ursprüngliche Core-Migration verwendete ausdrückliche Standardrechte;
die additive Lernmigration bewahrte die implizite Form.

Die Korrektur erhält die implizite Form ausschließlich für Funktionen des
an Version und SHA-256 gebundenen Lernmigrationsplans. Unbekannte oder
veränderte Migrationsjournale brechen vor einer Rechteänderung ab. Der
vollständige Vergleich von Schema-Fingerprint, Zeilenzahlen und Sequenzen
bleibt unverändert verpflichtend. Produktive Daten, Rechte und Journale
werden nicht verändert; eine erneute Lernmigration ist nicht erforderlich.

Hintergrund zu den beiden Darstellungen:
[PostgreSQL-Standardrechte](https://www.postgresql.org/docs/18/ddl-priv.html).

## Prüfungen

- Sieben neue Regressionstests: alte Sicherungen, exakte Auswahl der 18
  Funktionen, beschädigte oder unbekannte Journale und getrennte Schemas.
- Zielgerichtete Versions- und Lernvertragsprüfungen.
- Vor Installation: erneute native Wiederherstellung des betroffenen Paars
  einschließlich beider Datenbanken und vollständigem Anwendungsstart in
  einer vom produktiven Netz und den Live-Daten getrennten Prüfumgebung.
- Nach Installation: vollständige Assurance über das verschlüsselte Archiv,
  Live-/Ready-Prüfungen, Dienste, Importfortsetzung und Speicherbereinigung.

## Erster Installationsversuch und Wiederaufnahme

Die native Vorprüfung des betroffenen Paars bestand vollständig. Der erste
Installationsversuch mit Commit `dba47ef` wurde am 15.09.2026 um 16:27 UTC
vom Updater zurückgerollt: Die Betriebsprüfung lehnte den noch offenen alten
Restore-Fehler ab, bevor der korrigierte Code ihn regulär nachprüfen konnte.
Der Rückweg auf v0.92.52 war um 16:28 UTC bestätigt. PostgreSQL-Daten blieben
unverändert erhalten; die Fehlerbelege werden nicht überschrieben.

Der Deploy-Modus führt deshalb bei einem isolierten offenen Restore-Fehler
vor seiner Abschlussentscheidung den installierten vollständigen Offsite-
Wiederherstellungstest aus. Voraussetzung sind aktuelle erfolgreiche externe
Sicherungs-/Repositoryprüfungen, alle übrigen erfolgreichen Betriebsprüfungen,
aktive Timer und die vom Updater gehaltene Wartungssperre. Monitor- und
Nachtmodus erhalten dadurch keine neue automatische Aktion. Andere Fehler
werden nicht übergangen. Ein erneuter Fehler lässt den Deploy weiterhin
scheitern; erst der echte erfolgreiche Restore löst den offenen Status auf.

Der zweite Versuch mit Commit `3d50b03` wurde um 16:54 UTC ebenfalls
vollständig auf v0.92.52 zurückgerollt. Der Prüfschritt hatte einen nicht
installierten Befehlsalias verwendet. Die Korrektur verwendet den vorhandenen
Systemdienst `grabenplaner-offsite-restore-test.service`: dessen tatsächlicher
ExecStart wird geprüft, seine LoadCredential-Konfiguration liefert die
geschützten Zugangsdaten, und seine Isolation bleibt erhalten. Eine bereits
laufende Prüfung wird nicht als neuer erfolgreicher Test gewertet.

Status: 30 gezielte Restore-/Deploytests bestanden, Bash-Syntax geprüft.
Wiederaufnahme des transaktionalen Deploys folgt mit aktualisiertem Paket.
