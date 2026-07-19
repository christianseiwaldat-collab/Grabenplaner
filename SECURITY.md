# Sicherheitsrichtlinie

## Unterstützte Versionen

Sicherheitskorrekturen werden grundsätzlich für die jeweils aktuelle veröffentlichte Beta-Version bereitgestellt. Ältere Versionen gelten nach Veröffentlichung einer Nachfolgeversion als nicht mehr unterstützt.

## Sicherheitsproblem vertraulich melden

Bitte Sicherheitslücken nicht als öffentliches GitHub-Issue veröffentlichen. Meldungen können vertraulich per E-Mail an `christian.seiwald.at@gmail.com` gesendet werden.

Empfohlener Betreff: `Grabenplaner Security Report`

Eine hilfreiche Meldung enthält möglichst:

- betroffene Grabenplaner-Version und Betriebsmodus;
- eine klare Beschreibung der Schwachstelle und ihrer möglichen Auswirkungen;
- nachvollziehbare Schritte zur Reproduktion;
- bereinigte Screenshots oder Protokollauszüge ohne Passwörter, Datenbanken oder personenbezogene Daten.

Es sollen keine echten Personal-, Planungs-, AUM- oder Zugangsdaten übermittelt werden.

## Reaktion und verantwortungsvolle Offenlegung

Eine Eingangsbestätigung erfolgt nach Möglichkeit innerhalb von fünf Werktagen, eine erste fachliche Einschätzung innerhalb von zehn Werktagen. Diese Zeiträume sind Zielwerte und keine Garantie.

Bitte räume dem Projekt eine angemessene Frist zur Prüfung und Behebung ein, bevor technische Einzelheiten veröffentlicht werden. Eine namentliche Danksagung erfolgt nur nach vorheriger Zustimmung.

Für dieses Projekt besteht derzeit kein Bug-Bounty-Programm.

## Hinweise für einen sicheren Betrieb

- Die SQLite-Datenbank und Sicherungen können Personal- und Planungsdaten enthalten und müssen durch Betriebssystem- und Dateiberechtigungen geschützt werden.
- Sensible Personalakt-Inhalte sowie AUM-Dokumente und ihre geschützten Metadaten werden zusätzlich mit AES-256-GCM verschlüsselt. Betriebliche Indizes und nicht sensible Verwaltungsdaten bleiben für den Anwendungsbetrieb in SQLite lesbar.
- Filial- und Abteilungsleitungen erhalten bei Krankenständen nur Zeitraum, AUM-Status und Planungswirkung. AUM-Dokumente, Dateinamen, Vorschauen, geschützte Metadaten und interne Bemerkungen bleiben auf Personalleitung und höhere geschützte Rollen mit ausdrücklichem Zusatzrecht begrenzt; Dokumentzugriffe und abgewiesene Zugriffsversuche werden protokolliert.
- Die AUM-Datenerkennung läuft lokal im Browser. Digitale PDFs werden mit der lokal bereitgestellten PDF.js-Version ausgewertet; Scan-PDFs, hochgeladene Fotos und Kamerabilder werden lokal mit Tesseract.js verarbeitet. Ausgelesener Dokumenttext und OCR-Rohtext werden weder zur Erkennung an den Server übertragen noch in der Datenbank gespeichert. Vorgeschlagene Datumswerte müssen vor dem Upload bestätigt oder korrigiert werden.
- Externe Besetzungswarnungen enthalten keine Gesundheits- oder Personaldaten. Zugangsdaten externer Provider dürfen nur in der geschützten Serverkonfiguration liegen.
- Krankmeldungen und AUM-Warnungen werden in SQLite nur über geheime HMAC-Suchwerte zugeordnet; Personen-, Standort- und Statusdetails liegen im AES-256-GCM-geschützten Payload. Neutrale Portalhinweise enthalten keine Personalnummer oder Gesundheitsangabe.
- Neue oder geänderte externe Warnziele bleiben deaktiviert, bis ein sechsstelliger, zeitlich begrenzter Einmalcode bestätigt wurde. Gespeichert werden nur ein gesalzener Code-Hash, Ablaufzeit und Fehlversuchszähler.
- Krankmeldungen, Warnzustände und externe Versandaufträge werden nach den festgelegten Aufbewahrungsfristen automatisch gelöscht.
- Eine vollständige Sicherung besteht aus der Datenbank und der zugehörigen verschlüsselten Dokumentablage. Beide Bestandteile müssen gemeinsam aufbewahrt und wiederhergestellt werden.
- Der separate Backup-Befehl verwendet dieselbe exklusive Datenbanksperre wie Grabenplaner. Falls Grabenplaner noch läuft, muss die Sicherung dort erstellt oder Grabenplaner zuerst beendet werden.
- Das optionale Ubuntu-Offsite-Modul liest niemals die laufende SQLite-Datenbank direkt. Es übernimmt ausschließlich einen zuvor vollständig veröffentlichten und erneut geprüften lokalen Sicherungspunkt aus Datenbank, verschlüsselter Dokumentablage und Abschlussmanifest.
- Restic verschlüsselt die Offsite-Kopie vor der Übertragung. Restic-Passwort, rclone-Konfiguration, Google-Zugang und die Grabenplaner-Recovery-Schlüssel dürfen weder im Repository noch in SQLite, Release-Paketen, Statusdateien oder Protokollen gespeichert werden. Ein getrenntes, offline aufbewahrtes Recovery-Set ist erforderlich.
- Für Google Drive ist ein separates Konto beziehungsweise ein eigener freigegebener Zielbereich zu verwenden. Das Offsite-Modul akzeptiert ausschließlich ein rclone-Drive-Remote mit dem engen OAuth-Umfang `drive.file`.
- Gepinnte Restic-/rclone-Binaries werden nur nach Prüfung ihrer vorab festgelegten SHA-256-Prüfsummen installiert. Automatisches Herunterladen oder Ausführen ungeprüfter Fremdbinaries ist nicht Teil des Serverbetriebs.
- Google Drive ist trotz Restic-Verschlüsselung kein WORM- oder Object-Lock-Speicher. Wer den Server und dessen schreibberechtigten Drive-Zugang vollständig kompromittiert, kann Offsite-Daten löschen. Für echte Unveränderlichkeit ist ein getrennt administriertes oder technisch unveränderliches Backupziel notwendig.
- Automatische Restic-Entsperrung und automatische Reparatur eines beschädigten Repositorys sind nicht zulässig. Sperr- oder Prüffehler müssen vor einem manuellen Eingriff administrativ untersucht werden.
- Offsite-Wiederherstellungen werden zunächst in einem getrennten Staging-Bereich geprüft. Erst nach erfolgreicher Kopplungs-, Hash-, SQLite- und Dokumentprüfung dürfen Daten in den produktiven Pfad übernommen werden.
- Der lokale Verschlüsselungsschlüssel muss durch die Geräte-, Konto- und Dateiberechtigungen des Betriebssystems geschützt werden. Geht er verloren, können verschlüsselte Dokumente nicht wiederhergestellt werden.
- Personen mit Schreibzugriff auf den Grabenplaner- oder Datenbankordner gelten als vertrauenswürdige Systembetreiber.
- Der LAN-Host-Modus ist nur für ein vertrauenswürdiges internes Netzwerk vorgesehen.
- Ein öffentlich erreichbarer Betrieb darf nur über den vorgesehenen Servermodus mit HTTPS und korrekt konfiguriertem Reverse Proxy erfolgen. Die Anwendung muss dabei ausschließlich an eine Loopback-Adresse gebunden sein; unsichere Host-, Proxy-, Demo- oder Scanner-Ausnahmen werden im Produktionsprofil abgelehnt.
- Grabenplaner-Anwendung und HTTPS-Reverse-Proxy müssen mit getrennten Dienstidentitäten und eingeschränkten Dateirechten betrieben werden. Der Proxy benötigt keinen Zugriff auf Datenbank, AUM-Ablage oder Anwendungsgeheimnisse.
- Im produktiven HTTPS-Betrieb ist ein erreichbarer Virenscanner Voraussetzung für die Annahme von AUM-Dokumenten. Eine Test- oder Umgehungskonfiguration darf dort nicht verwendet werden.
- Öffentliche Live- und Ready-Prüfungen geben keine internen Pfade oder Geheimnisse aus. Ausführliche Serverdiagnosen sind ausschließlich nach Anmeldung mit einem entsprechend berechtigten Konto verfügbar.
- Serverupdates müssen in einem Wartungsfenster mit geprüfter Paket-Prüfsumme, vollständigem Vorab-Backup, anschließendem Ready-Check und vorbereitetem Rollback erfolgen.
- Reale Datenbanken, Branding-Kits mit internen Daten und AUM-Dokumente dürfen nicht in öffentliche Repositories oder Fehlerberichte hochgeladen werden.

## Umfang

Meldungen zu Fehlern in Grabenplaner selbst sind willkommen. Probleme, die ausschließlich aus einem unsicheren Betriebssystem, einer fehlerhaften Netzwerk- oder Proxykonfiguration, veränderten Abhängigkeiten oder einer eigenständig modifizierten Installation entstehen, können außerhalb des Projektumfangs liegen.
