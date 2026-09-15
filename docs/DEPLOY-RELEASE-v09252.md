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

Status: Release vorbereitet; Live-Nachweise werden nach Abschluss ergänzt.
