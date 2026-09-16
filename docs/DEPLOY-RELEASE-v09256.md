# v0.92.56 Beta · Datenbankimporte und integrierter Einkaufsbereich

## Änderung

Der Datenbankimport erhält kompakte Uploadfelder und eine Tabelle mit
Originaldateiname und fachlichem Datenstand. Der normale Trade-Import übernimmt
auch den Artikelkatalog in wiederaufnehmbaren Paketen. Die neue Löschaktion
entfernt ausschließlich gespeicherte Access-Dateikopien; GP-Daten, Importstände
und Protokolle bleiben erhalten.

Einkauf & Bestand ist als reguläre GP-Ansicht mit Hauptmenü, Verkaufsübersicht,
Funktionssuche, gemeinsamem Darkmode und Browsernavigation eingebunden. Die
bisherigen Direktlinks führen zur passenden integrierten Auswertung.

Es gibt keine neue Migration und keine zusätzliche Abhängigkeit.
Details und bisherige Prüfnachweise:

- [Importumbau](IMPORT-NEUAUFBAU-2026-09-16.md)
- [GP-Integration](EINKAUF-GP-INTEGRATION-2026-09-16.md)

Die vollständige Importdauer auf dem VPS ist weiterhin nicht nachgewiesen. Der
auf Nutzerwunsch abgebrochene Laufzeittest wird für diesen Deploy nicht erneut
gestartet.

## Freigabe und Veröffentlichung

Commit, Push und VPS-Deploy sind am 16.09.2026 ausdrücklich beauftragt.
Die Veröffentlichung ist abgeschlossen. Der unten dokumentierte Paketstand
ist auf dem VPS installiert; die aufgeführten Releaseprüfungen sind bestanden.

## Lokale Releaseprüfung

- Abschließende Prüfung von Version, Paketierung, Navigation, Rechten,
  Einkaufsansicht und Importlaufzeitcode: 107 bestanden, kein Fehler.
  Drei unveränderte Linux-Installer-Tests sind unter Windows übersprungen.
- Die zusätzlichen Import-, PostgreSQL- und Browsernachweise sind in den
  oben verlinkten Fachberichten dokumentiert.
- Die Persistenzprüfung enthält ausschließlich die beiden bereits für
  v0.92.55 dokumentierten Altbefunde; keine neue Grenzverletzung und keine
  unbekannte Produktions- oder Testdatei.
- Der Live-Vorcheck bestätigt v0.92.55, vier erfolgreiche interne/öffentliche
  Bereitschaftsprüfungen und den abgeschlossenen Zustand der Bestell- und
  Kassenimporte. Diese Importstände bleiben erhalten.
## Veröffentlichter Stand

- Laufzeit-Commit: `b9d551e3e755cc7688d692dad7b6fef3d6696997`; auf dem zugehörigen Branch veröffentlicht.
- Erfolgreicher Updatebeleg: `2026-09-16T22:07:10.072Z`.
- Paket SHA-256: `c92fff5e601be8700b7f6ecf05bc8e3f17bc7e7d8061d5982aad892b19eecead`.
- Manifest SHA-256: `d63e771acc1718632c3ae3a1e904d73fc660fe05fad8236bc6f8141b598e54d2`.
- Alle 729 installierten Laufzeitdateien wurden unabhängig anhand ihrer
  Prüfsummen geprüft. Der Updater verwendete
  `full / RECOVERY_CONTRACT_CHANGED`.
- Die Zeilenzahlen der 22 kontrollierten Tabellen, Schema-Fingerprints und
  Prüfsummen der Importquellen, Importzustände, Kassenstände und Freigaben
  sind vor und nach dem Update identisch. Die abgeschlossenen Bestell- und
  Kassenarbeiter und ihre geschützten Kontextdateien blieben erhalten.
- Anwendung, Proxy, Datenbankdienste und Timer sind aktiv. Vier interne und
  öffentliche Live-/Ready-Prüfungen bestanden. Es gibt keine zusätzlichen
  fehlgeschlagenen Dienste gegenüber der protokollierten Ausgangslage.
- Die öffentliche Seite zeigt v0.92.56. Die geänderten JS-/CSS-Dateien werden
  bytegenau aus dem geprüften Paket ausgeliefert. Das Hauptmenü und die native
  Einkaufsansicht sind enthalten; der frühere Einkaufslink antwortet mit 302
  auf `/?view=tradeInsights&section=purchasing`.
- Die überflüssigen Kassa-Vorbereitungsbuttons, der zusätzliche
  TradeFoto-Artikelstamm-Button und die manuelle Stammdaten-Zuordnung sind
  im ausgelieferten Hauptdokument entfernt.

## Sicherung und Wiederherstellung

Der Updater führte seine Serverprüfungen für dieses Paket erfolgreich aus.
Darauf folgten der separate Offsite-Selbsttest und der vollständige geschützte
Recovery-Lauf einschließlich aller abschließenden Serverbetriebsprüfungen.
Die vorübergehende Koordination der automatischen Auslösung wurde beendet;
beide temporären Dienstsperren sind entfernt und der Monitor-Timer ist aktiv.

- Signierter Lauf: `c00f5cae-2a31-4399-8ee3-71440f2c3c2c`.
- Erfolgreicher Abschluss: `2026-09-16T22:43:23.608Z`.
- Externer Snapshot: `f4a46ac547d5`.
- Restore-Beleg SHA-256: `359037d8789813d48f9ad567c3e787d29ec68da9f2988fc0d6c6b0ce333641aa`.
- Core: 210 Tabellen, 210.179 Zeilen,
  22 Sequenzen.
- Sales: 63 Tabellen, 11.530.780 Zeilen,
  2 Sequenzen.
- Bestätigt sind außerdem 55 geschützte
  Dokumente, 114 geschützte Datensätze,
  beide Datenbankstrukturen und der isolierte Start der wiederhergestellten App.
- Zwei vollständige lokale Sicherungspaare bleiben erhalten. Der neue gebundene
  Wiederherstellungsnachweis erlaubt kompatible Folgeupdates wieder im kurzen
  Modus. Der aktuelle Monitor meldet keine aufeinanderfolgenden Live-Fehler.

Die genau geprüften Deploy- und Uploadverzeichnisse dieser Veröffentlichung
wurden entfernt. 28 archivierte Nachweisdateien wurden lokal
anhand von Größe und SHA-256 geprüft. Serverarchiv:
`/var/lib/grabenplaner-assurance/maintenance-evidence/release-v09256-b9d551e-20260916`.
Lokale Nachweise: `tmp/v09256-evidence/vps`.

Der Updater benötigte rund 22 Minuten, die vollständige anschließende
Assurance rund 35 Minuten. Das sind Release-Prüfzeiten und
keine Messungen der Importdauer. Der abgebrochene Import-Laufzeittest wurde
nicht wiederholt.
