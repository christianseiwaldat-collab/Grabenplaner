# Block 12: Produktivumstellung am 13.09.2026

Die Freigabe „Bitte Block 12 loslegen“ umfasst den vorbereiteten Release und die Umstellung auf zwei PostgreSQL-Datenbanken. **v0.92.39-beta ist produktiv installiert; der GP verwendet seit 13.09.2026, 11:38:23 UTC PostgreSQL.** Alle 248 Quelltabellen mit 2.887.718 Zeilen wurden übernommen und vollständig verglichen. Geschützte Daten, gemeinsame Sicherungen, vollständige externe Wiederherstellung und Anwendungstests einschließlich PDF-Bericht sind bestätigt. **Offen bleibt ausschließlich die angemeldete produktive Bedienabnahme**, weil die vorhandene Chrome-Sitzung abgelaufen ist.

## Veröffentlichung

Für die Migration wurde zunächst Commit `daa62f9b3157cd64342224c1e8dea46451b90e40`, Version `0.92.38-beta`, mit Runtime 5 und Offsite-Modul 9 installiert. Die 646 Manifestdateien wurden nach der Installation vollständig verglichen. Interne und öffentliche Live-/Ready-Prüfungen bestanden. Der Release war um 10:47:50 UTC abgeschlossen.

- Paket-SHA-256: `7525304a08fc02cb2375815fc516fb0877a74cea6961db8c427fe3c45cfd9d02`
- Manifest-SHA-256: `8e223560bd9198d87d04357034aa2540f2a315139a48f6dfd0f7a068f65142d3`
- Separat geprüfter Paketprüfer: `6dba6a651dc91a62d5e9c2d956c8d95c66e7dda8eee1a22a16271e85c232aca5`

Dieser vorbereitende Release benötigte den vollständigen bisherigen SQLite-Sicherungspfad: Der bereits laufende interne Sicherungsvorgang musste zuerst enden, anschließend wurden die beiden vom vollständigen Updater geforderten Rückkehrpunkte und die externe Sicherung erstellt. Der gewöhnliche kurze Deployvertrag ist seit dem vollständigen neuen Wiederherstellungsnachweis wieder gebunden.

## Übertragung und kontrollierte Wiederholung

Die dedizierte neue PostgreSQL-Instanz wurde um 10:48:56 UTC angelegt. Sie verwendet ausschließlich `127.0.0.1:55486`, die Instanzkennung `7684970073632912650` und die beiden vorgesehenen Datenbanken. Der vorhandene Lebensatlas-Cluster auf Port 5432 gehört nicht zu diesem Vorgang.

Der erste Lauf `60670981-1d93-49bd-a069-d3b669fb1a03` kopierte und prüfte alle 248 Tabellen mit 2.887.718 Zeilen erfolgreich. Die anschließende Freigabeprüfung meldete `PG_STAGING_ACTIVE_CLIENTS`, weil sie auch PostgreSQL-Hintergrundwartung zählt. Automatisches Vacuum/Analyze ist für den Zeitpunkt des Abbruchs nachgewiesen. Es gab keinen gemeldeten Inhaltsunterschied. Die Veröffentlichung von PostgreSQL als maßgeblicher Bestand war noch nicht erfolgt; die vorhandene SQLite-Konfiguration wurde wiederhergestellt und der GP war um 11:08:41 UTC wieder bereit.

Für die Wiederholung wird die automatische Pflege ausschließlich in der noch nicht aktivierten neuen Instanz vorübergehend pausiert. Vor dem Zurücksetzen ihrer beiden Arbeitsdatenbanken werden die genaue Instanz, der installierte Paketstand, die vollständig erhaltene Quelle und ihr Transfernachweis, die fehlende produktive Aktivierung sowie die SQLite-Verantwortung erneut geprüft. Bestehende Hintergrundarbeiten müssen von selbst enden. Die ursprüngliche SQLite-Datei, die erste Quellkopie und alle Fehler-/Inhaltsnachweise bleiben erhalten. Danach richtet der unveränderte installierte Bootstrap die leeren Ziele ein und der reguläre Migrationsbefehl nimmt den inzwischen aktuellen GP-Bestand erneut auf.

Der zweite Lauf `d8cd8dc4-74f5-4064-ba51-17f9bf78d611` begann um 11:23:31 UTC. Seine Quelle wurde um 11:23:57 UTC aufgenommen; ihr SHA-256 lautet `d3dcd416f494797884e691c07057f4e1da3a57df494211d33816ad22fd5ea4a0`. Alle 248 Tabellen mit 2.887.718 Zeilen wurden vollständig übernommen und verglichen. Der bestätigte Inhaltsfingerprint lautet `b8a7857bcac8921ea6c77f7d1388919c7ac3bad7830a591f9a05000a39069e8e`.

Der Ablauf bestätigte anschließend 55 verschlüsselte Dateien, 55 Dateiverweise, 113 geschützte Datensätze und den separaten Importarchivschlüssel. Die erste gemeinsame Sicherung war um 11:38:18 UTC fertig; der GP meldete um 11:39:17 UTC seine Bereitschaft. Beide Datenbanken wurden analysiert. Um 11:39:31 UTC endete der betreute Root-Auftrag erfolgreich, nachdem der ursprüngliche Autovacuum-Standard wiederhergestellt und die temporäre Einstellung nachweislich entfernt worden war.

PostgreSQL beschreibt automatische Analyse während großer Ladeoperationen und die anschließende Aktualisierung der Planerstatistik in seiner [Dokumentation zur Datenübernahme](https://www.postgresql.org/docs/18/populate.html). Die [Autovacuum-Konfiguration](https://www.postgresql.org/docs/18/runtime-config-vacuum.html) bleibt nach dem Transfer auf ihrem normalen Standard. WAL-, Netzwerk- und andere Anwendungseinstellungen werden nicht verändert.

## Bestätigter produktiver Betrieb

Die Nachkontrolle um 11:40 UTC bestätigte die gemeinsame Umgebung `grabenplaner-pair-00be95f8-5d61-4dd4-be03-d3fbd746c1d0`, die zwei vorgesehenen Datenbanknamen und die tatsächlichen Leserollen ohne administrative Zusatzrechte. Erhalten sind unter anderem 18 Mitarbeitende, sechs Standorte, 30.503 CRM-Kunden, 19.024 Artikel, alle sieben Kassensnapshots mit ihren vorherigen Zeilenzahlen und fünf abgeschlossene Berichte. Es wurden dafür keine Produktivdatensätze angelegt oder geändert.

Vier interne/öffentliche Live-/Ready-Abfragen antworteten mit HTTP 200. Drei geschützte Fachrouten verweigerten nicht angemeldete Zugriffe mit HTTP 401. Die tatsächliche GP-Dienstkennung kann die Anwendungskonfiguration und den Paarbezug lesen; Umgebungsdatei und administrative Betriebskonfiguration bleiben ausschließlich für Root lesbar. PostgreSQL-Dienst, Wartungssocket und bestehende Timer sind aktiviert. Bootkennung sowie Prozesse von Caddy, Lebensatlas und dessen PostgreSQL-Instanz sind unverändert.

Die erste Sicherung umfasst beide Datenbanken und 72 gebundene Komponenten. Ihr Manifest-SHA-256 lautet `1a0cf07ccc0b9cf270deeb70eef8028d4b165a677a3ed3d3509b35b69c89c9a9`. Die Erstellung dauerte 70,8 Sekunden. Die anschließende kurze GP-Betriebsprüfung und der vollständige Offsite-Selbsttest liefen nacheinander und endeten um 11:41:25 UTC erfolgreich.

## Offene Bedienabnahme

Offen ist die angemeldete produktive Prüfung von Dienstplan, Zeiten, Rechten, CRM, Artikelstamm, Kassenbelegen und einer begrenzten PDF-Auswertung. Die vorgefundene Chrome-Sitzung ist abgelaufen; die Bitte um erneute Anmeldung blieb unbeantwortet. Es wurden weder Anmeldedaten ausgelesen noch Ersatzberechtigungen oder Testkonten in der Produktion eingerichtet. Die technischen und isolierten Anwendungstests sind vollständig bestätigt; sie werden von dieser noch offenen Bedienprüfung unterschieden.

## Geprüfte Recovery-Korrektur

Der PostgreSQL-Prüfdienst läuft als `grabenplaner-offsite`, während der installierte Programmbaum ausschließlich Root und der Gruppe `grabenplaner` lesbar ist. Die zurückgeholte Sicherung und ihre Dateien wurden bereits überprüft; der neu gestartete Prüfprozess konnte danach sein vorhandenes Programm nicht öffnen und meldete `MODULE_NOT_FOUND`. Der tatsächliche Dateizugriff als Dienstkonto bestätigte die fehlende Leseberechtigung.

v0.92.39 verwendet für genau diese isolierte Unit die bereits beim SQLite-Smoke-Test eingesetzte vorübergehende Prozessgruppe. Der Programmbaum ist ausdrücklich nur lesbar. Produktive Core-/Sales-Daten, Umgebungsdatei, administrative Konfiguration, Sicherungen, Assurance-Dateien und Steuerungssockets werden in der Prüfinstanz ausgeblendet. Die persistenten Gruppen des Dienstkontos bleiben unverändert.

52 gezielte lokale Recovery-, Deploy- und Versionstests sowie die Ablehnung von vier fremden Arbeitsverzeichnissen sind bestanden. Die native Zugriffsprobe um 12:06:07 UTC bestätigte lesbaren, nicht beschreibbaren Programmcode, unzugängliche Produktivpfade und das private Netzwerk. Die vollständige native Wiederherstellung desselben zurückgeholten Pakets endete um 12:12:19 UTC erfolgreich: beide Datenbanken, 55 geschützte Dokumente, 113 geschützte Datensätze, Importarchivschlüssel und acht neu erzeugte Wiederherstellungskonten wurden bestätigt. Die isolierte Anwendung bestand Anmeldung, Dienstplan/PDF, Artikelsuche, Importkonflikt/Übernahme/Rücknahme, Kassenabfrage, Berichtserstellung mit 2.239 Verkaufspositionen, PDF-Download und Zurückweisung einer widerrufenen Sitzung. Teständerungen betrafen ausschließlich diese Kopie. Ihr Arbeitsverzeichnis wurde nach Sicherung des vollständigen Nachweises kontrolliert entfernt.

Damit die reguläre Aktualisierung einen echten erfolgreichen Restore-Status vorfindet, wurde die bestätigte Prozesskonfiguration vorübergehend ausschließlich für `grabenplaner-pg-recovery-…` über eine Root-eigene Datei unter `/run/systemd/system` ergänzt. Die [offizielle systemd-Dokumentation](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml) beschreibt die Präfixzuordnung dieser Ergänzungen. Eine weitere native Probe bestätigte ihre tatsächliche Wirkung. Die Ergänzung wurde nach Installation des permanenten Hotfixes um 12:53:18 UTC vollständig entfernt. Es wurden weder der installierte Programmbaum verändert noch Fehlerstatus oder signierte Ergebnisse manuell auf Erfolg gesetzt. Der reguläre vollständige Assurance-Lauf `84b2a0d8-3b31-43cf-bbd3-03f271e496d8` bestätigte anschließend Snapshot `7817316bd24e`, die Wiederherstellung, die Anwendung und die abschließenden Betriebsprüfungen; er endete um 12:38:21 UTC erfolgreich.

Ab der Veröffentlichung von `authority.json` bleibt PostgreSQL maßgeblich. Ein nachfolgender Fehler rechtfertigt keinen Rückfall auf den inzwischen veralteten SQLite-Stand. Die gemeinsamen Wiederherstellungsregeln aus [Block 12](BLOCK-12.md) gelten weiterhin.


## Endgültiger Release und Wiederherstellungsnachweis

v0.92.39-beta, Commit `bd79bf67ebb90932543b0512ce316c599edfe137`, wurde um 12:53:20 UTC über den regulären vollständigen Updater installiert. Das bestätigte Paket änderte gegenüber v0.92.38 ausschließlich den Recovery-Controller sowie README, Paketversion und UI-Versionsanzeige; alle übrigen Laufzeitdateien blieben bytegleich. Die Dateiprüfung bestätigte sämtliche 646 Manifestdateien. Offsite-Modul 9 und seine Providerbindung blieben erhalten.

- Paket-SHA-256: `8155f089d339daa948a7f8830d104291ec51391d94e215ce2d19cef336996850`
- Manifest-SHA-256: `97d639b57866770e0b7e3369dc0dffd040f9071cd8a98dfc18da1d36b184a67c`
- Recovery-Controller: `0fe91bf18d9baceb1e1a614d46d711ed1da835ffae72fc57b58dc12a432ed791`

Beide frischen PostgreSQL-Rückkehrpunkte dieses Releases benötigten jeweils 71 Sekunden. Nach dem Paketwechsel bestanden die vier internen/öffentlichen Live-/Ready-Prüfungen. Die zusätzliche kurze GP-Prüfung und der Offsite-Selbsttest wurden nacheinander erfolgreich abgeschlossen. Zwei Fehler in temporären Prüfaufrufen – unbekannte Option und Windows-Zeilenende im Launcher – wurden korrigiert; sie betrafen weder die installierte Anwendung noch den Datenbestand. Die ursprünglichen Fehlervorgänge und ihre erfolgreichen Folgeläufe sind im Nachweis erhalten.

Der abschließende reguläre Assurance-Lauf `1903e4fb-6332-4948-8ae7-d013b5467f82` lief vollständig ohne temporäre Recovery-Ergänzung. Er bestätigte die externe Sicherung `5d50f4a96795` um 13:04:07 UTC, die vollständige Archivprüfung um 13:08:53 UTC sowie Wiederherstellung und Anwendung um 13:16:38 UTC. Der signierte Gesamterfolg folgte um **13:17:23 UTC**. Der Wiederherstellungsbeleg ist durch SHA-256 `6f72409460da32e3c37e2c490b453b12bb3fefeb3b963ba870aa9fb2deb3eee5` an diesen Verlauf gebunden.

Die isolierte Anwendung bestand Anmeldung, acht gleichzeitige berechtigte Lesezugriffe, Artikelsuche, Importkonflikt/Übernahme/Rücknahme, Kassenabfrage, Dienstplan-PDF, einen Verkaufsbericht mit 2.239 Positionen und dessen PDF-Download mit 74.573 Bytes. Eine widerrufene Sitzung wurde zurückgewiesen. Alle Probeänderungen lagen ausschließlich in der wiederhergestellten Kopie; diese wurde danach automatisch entfernt. Die zusätzlichen PostgreSQL-Laufzeittabellen sind von den 248 vollständig verglichenen Quelltabellen getrennt dokumentiert.

Die anschließenden produktiven Leseprüfungen bestätigten erneut 18 Mitarbeitende, sechs Standorte, 30.503 CRM-Kunden, 19.024 Artikel, alle sieben Kassenbestände und fünf abgeschlossene Berichte. Die frühere Berichtssperre ist in beiden Datenbanken nicht vorhanden. Vier Bereitschaftsabfragen antworteten mit HTTP 200, geschützte Fachrouten ohne Anmeldung mit HTTP 401. Autovacuum ist eingeschaltet; Bootkennung und Prozesse des eigenen Datenbankdienstes, von Caddy, Lebensatlas und dessen PostgreSQL blieben unverändert.

Der aktuelle PostgreSQL-Deploynachweis ist an beide Datenbanken, Konfiguration, Code und den signierten Gesamterfolg gebunden. Die reguläre Entscheidung für unveränderte technische Grundlagen lautet `short / RECENT_FULL_RECOVERY`. Künftige Änderungen an kritischem Laufzeit-, Datenbank- oder Wiederherstellungscode werden weiterhin nach den vorhandenen Regeln geprüft.

## Aufbewahrung und Bereinigung

Die Nachweise und Releasepakete liegen dauerhaft geschützt unter `/var/lib/grabenplaner-assurance/maintenance-evidence/pg12-20260913`. Beide eigenen Installationsbereiche, ihre Uploadverzeichnisse, temporäre Credential-Kopien und die geprüfte Kopie des ersten fehlgeschlagenen Restores wurden nach Pfad-, Eigentums-, Stillstands- und Inhaltsprüfung entfernt. Die beiden eigenen lokalen Paketierungs-Worktrees wurden ebenfalls nach sauberem HEAD-/Statusnachweis entfernt. Originale SQLite-Daten, finale Migrationsquellen, Qualifikationsnachweise und reguläre Sicherungen bleiben erhalten; `output/` wurde nicht verändert.

Vier ausschließlich in diesem Auftrag angelegte fehlgeschlagene Hilfs-/Vorläuferjobs wurden nach dokumentiertem erfolgreichem Folgelauf gezielt quittiert. Journale und Migrationsbelege bleiben erhalten. Andere gespeicherte Host-/Systemfehler wurden nicht pauschal zurückgesetzt. SSH, Tailscale, Firewall, fremde Projekte und Ubuntu-Boot blieben unverändert.
