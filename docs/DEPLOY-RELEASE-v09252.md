# v0.92.52 Beta · Schulung und Wissen

Freigegeben am 15.09.2026 durch den ausdrücklichen VPS-Deployauftrag.

## Umfang

Blöcke 1–6: Wissensbibliothek, konkrete Fähigkeitsziele, eigenständige
Schulungsdurchgänge, Sammelzuweisungen und Termine, optionale Prüfungen,
verschlüsselte Dateinachweise, Bestätigungs-PDFs und gefilterte Team-Anforderungen.
Fachliche Kasseninhalte bleiben Entwürfe. Keine automatische Kompetenzfreigabe.

Die additive Migration ergänzt sechs Core-Tabellen. Bestehende Lernhistorien
und Sales bleiben erhalten. Der installierte transaktionale Updater erstellt
den frischen gekoppelten Rückkehrpunkt. Unter derselben Wartungssperre folgt
der manifestgebundene Lernmigrationshelfer; erst danach beginnt die für den
geänderten Datenbankvertrag erforderliche Wiederherstellungsqualifikation.
Temporär angehaltene Monitor-/Assurance-Auslöser werden wiederhergestellt.

## Prüfung vor Veröffentlichung

- Lernfunktionen: 124 bestandene Tests, ein optionaler nativer Test ausgelassen.
  Der native PostgreSQL-18.6-Lauf wurde zuvor separat erfolgreich ausgeführt;
  siehe Umsetzungs- und Migrationsnachweis.
- Release-/Paket-/Versionsprüfungen: 48 bestanden, drei Linux-exklusive Tests
  unter Windows ausgelassen. Der Paketprüfer läuft anschließend direkt am VPS.
- Der veraltete feste Versionsvergleich der Funktionssuche wurde durch die
  gemeinsame Prüfung von Paketversion, README und Demo-Metadaten ersetzt.
- Persistenzinventar: keine unklassifizierten Dateien, keine Grenzverletzungen.
  Zwei bereits im Ausgangsstand nachgewiesene historische Gesamtauditbefunde
  bleiben offen: ältere Statement-Zählstände und das frühere nichtproduktive
  PostgreSQL-Entwicklungsprofil. Deren historische Verträge werden für dieses
  Release nicht umgeschrieben; ein global grüner Audit wird nicht behauptet.
- Gezielte Browserprüfung am Desktop und mobil, Prüfungsabschluss nach Reload,
  PDF-Ausgabe sowie Transaktions-/Berechtigungsprüfungen sind dokumentiert in
  `SCHULUNG-WISSEN-UMSETZUNG-2026-09-15.md`.

## Betrieb

Die bereits beauftragten Datenbankimporte behalten ihre Quellen und Checkpoints.
Der wartende Kassenimport wird beim Wechsel ausschließlich auf die verifizierte
neue Anwendungsversion gebunden; keine doppelte Quellenanlage oder Freigabe.
Zwei vollständige lokale Sicherungspaare bleiben die Aufbewahrungsregel.
Host-Neustart und Änderungen an Netzwerk-/Zugangsregeln gehören nicht dazu.

Status am 15.09.2026: Anwendung 0.92.52 und additive Lernmigration installiert.
Die erste vollständige Abschluss-Assurance scheiterte bei der isolierten
Wiederherstellung. Die Behebung und der erfolgreiche Gesamtnachweis erfolgten mit
dem Folgeupdate v0.92.53; siehe [Abschlussnachweis](DEPLOY-RELEASE-v09253.md).

## Zwischenstand des Live-Deploys

- Runtime-Commit `2ac82cb517f98190baf8acc71d0eda8ee8041922`, 718 Paketdateien.
- App-Update am 15.09.2026 um 15:19:16 UTC bestätigt; Lernmigration um
  15:19:26 UTC abgeschlossen. Core-Fingerprint danach
  `55a02942056314c6297e207cd0c7e0247a75fbb23304223a3c8ad02374e1fbb1`;
  Sales-Fingerprint unverändert.
- Vier Live-/Ready-Prüfungen HTTP 200; Lernrepository mit produktivem
  Lesezugang geprüft; neue Routen ohne Sitzung gesperrt. Host-Boot-ID,
  Caddy und andere Anwendungen unverändert.
- Der wartende Kassenimport musste nach dem Versionswechsel mit identischen
  Ressourcenlimits neu als kurzlebiger Dienst angelegt werden. Der erste
  Wrapper-Exit 1 bleibt dokumentiert; `release-completion.json` bestätigt
  die erfolgreiche Fortsetzung. Kein Importcheckpoint wurde zurückgesetzt.
- Assurance-Lauf `71f85de1-a607-4c3d-afc2-8419c7f4a0a1`: Sicherung und
  Repository-Prüfung bestanden, Restore am 15:46:33 UTC fehlgeschlagen.
  Tabellen und Sequenzwerte der Prüfkopie stimmen exakt; ausschließlich
  18 Funktions-ACLs weichen in der Darstellung NULL/ausdrücklicher Standard ab.
  Diagnose und unveränderter Fehlernachweis bleiben beim Release archiviert.
