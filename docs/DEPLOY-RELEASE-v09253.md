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

Status: Korrektur lokal geprüft; native Vorprüfung und Live-Abschluss laufen.
