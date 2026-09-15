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

## Erfolgreiche Installation

Commit `f458a0f2f8e70eb7e0a1ca2d51fd97f2c0bebef9` wurde am 15.09.2026
um 17:36:41 UTC transaktional installiert; Wrapperabschluss um 17:36:51 UTC
mit Exit 0. 30 gezielte Restore-/Deploytests und die Bash-Syntaxprüfung bestanden.

- Paket SHA-256: `a2ab8d50c06633531514b5a59bee48914559b1b2c1cfa2768fe5abc2b8ec3122`.
- Manifest SHA-256: `5555dd4ddafb4bd504e6f292054d3b084a99dadef9bd4fa1c8ad3b103daf0970`;
  alle 718 installierten Laufzeitdateien nachgeprüft.
- Der geschützte Restore-Dienst bestand einschließlich vollständigem
  Anwendungsstart um 17:36:41 UTC. Seine native Quittung hat SHA-256
  `e019c4cf89cb9c642683884aba2de18c6fd1d4088f7504771e3f5a10d321cd8e`.
- Produktiv: vier HTTP-200-Checks, zwölf reine Leseabfragen des Lernrepositorys,
  geschützte Lernrouten ohne Sitzung HTTP 401, Login-Fehlerbibliothek erreichbar.
  PostgreSQL 18.6, Core-/Sales-Fingerprints unverändert gegenüber der bestätigten
  Lernmigration. Importquellen und Checkpoints erhalten, Dienste fortgesetzt.
- Die Chrome-Sitzung ist abgemeldet; eine authentifizierte Live-Bedienprüfung
  wird deshalb nicht behauptet. Synthetische Browser-/PDF-Prüfungen und der
  authentifizierte isolierte Anwendungs-Restore sind separat dokumentiert.

## Abschlussnachweis

Der vollständige signierte Lauf `94f6e741-17d5-4f71-b6f6-6e8ed36b72ac`
bestand am 15.09.2026 um 18:05:32 UTC. Er enthält erfolgreiche externe Sicherung,
vollständige Archivprüfung, native Wiederherstellung beider Datenbanken und
authentifizierte Anwendungs-/PDF-Prüfung im isolierten Netz. Alle 24 abschließenden
Betriebsprüfungen bestanden. Die Wiederherstellung bezieht sich auf den neuen
Snapshot `dc38fb2eaaa2`; der alte Fehlerbeleg bleibt separat erhalten.

Der nachfolgende periodische Monitor setzte wegen der vom fortgesetzten
Bestellimport gehaltenen Wartungssperre korrekt aus. Sein letzter vollständiger
24-Punkte-Status stammt bereits aus der installierten v53; die aktuellere vollständige
Betriebsprüfung ist durch die signierte Assurance belegt. Es wurde kein frischer
periodischer Status erfunden oder manuell gesetzt. Monitor-Timer aktiv, kein
automatischer App-Neustart ausgelöst.

Die Abschlussprüfung bestätigt den Modus `short` für gewöhnliche weitere Deploys,
genau zwei vollständige lokale PostgreSQL-Sicherungspaare und rund 75 GiB freien
Speicher. Alle vier Deploy-/Upload-Verzeichnisse dieser Veröffentlichung und die
temporären Wiederherstellungskopien sind entfernt. Die ursprünglichen Fehler,
Rückwege und erfolgreichen Nachweise bleiben archiviert; 155 Nachweisdateien wurden
lokal heruntergeladen und einzeln anhand von Größe und SHA-256 geprüft.

Serverarchiv: `/var/lib/grabenplaner-assurance/maintenance-evidence/`, Verzeichnisse
`release-v09252-2ac82cb-20260915`, `release-v09253-dba47ef-20260915`,
`release-v09253b-3d50b03-20260915` und `release-v09253c-f458a0f-20260915`.
Lokale Nachweise: `tmp/v09252-evidence/vps`, `tmp/v09253-evidence/vps`,
`tmp/v09253b-evidence/vps` und `tmp/v09253c-evidence/vps`.

Die beiden zurückgerollten v53-Versuche sind keine erfolgreichen Deploys. Der
erfolgreiche v53-Updaterlauf dauerte etwa 29 Minuten einschließlich zwölf Minuten
gezielter Wiederherstellungs-Nachprüfung; die anschließende vollständige Assurance
benötigte weitere 27 Minuten. Die gesamte Fehlerbehebung dauerte entsprechend länger.
