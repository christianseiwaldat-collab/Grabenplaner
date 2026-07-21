# Grabenplaner Versions-Log

## v0.75.5 Beta · Offsite-Serviceupdate

- Der optionale Offsite-Installer erkennt den unter Ubuntu 24.04 und 26.04 üblichen, sicheren Verweis `/etc/os-release` auf `/usr/lib/os-release` korrekt.
- Vor dem Einlesen werden der kanonische Zielpfad, Dateityp, Besitzrechte, Hardlink-Anzahl und Schreibrechte der Systemkennung weiterhin streng geprüft.
- Bereits konfigurierte Offsite-Installationen auf v0.75.3 müssen zuerst die Kompatibilitätsbrücke v0.75.4 installieren; noch nicht konfigurierte Server können direkt aktualisiert werden.
- Das Update enthält keine Datenbankmigration und verändert weder Planungsdaten noch vorhandene Sicherungsstände.

## v0.75.4 Beta · Server-Kompatibilitätsupdate

- Der Linux-Updater erhält eine eng begrenzte Kompatibilitätsbrücke für reine Änderungen am noch nicht aktivierten Offsite-Installationswerkzeug.
- Bereits eingerichtete Offsite-Laufzeitdateien und ihr Installationsbeleg bleiben unverändert; andere Moduländerungen verlangen weiterhin ausdrücklich eine Migration.
- Die einmalige Runtime-v2-Migration erkennt sowohl eine reguläre `/etc/os-release` als auch den unter Ubuntu üblichen, sicheren Verweis auf `/usr/lib/os-release` und prüft den aufgelösten Systempfad weiterhin streng.

## v0.75.3 Beta · Serviceupdate

- Der Linux-Wartungslock verwendet einen eigenen Keep-Alive-Timer und bleibt dadurch auch bei nicht interaktiven Hintergrundprozessen bis zur kontrollierten Freigabe aktiv.
- Serverupdates können den gekoppelten Datenbank-/Dokumentsicherungspunkt nun zuverlässig halten, statt wegen eines vorzeitig beendeten Lock-Helfers automatisch zurückzurollen.
- Die SQLite-Schnellprüfung unterdrückt ausschließlich den experimentellen Node-Hinweis; echte Prüffehler bleiben sichtbar und führen weiterhin zu einer fehlgeschlagenen Serverdiagnose.
- Ein eigener Regressionstest startet den Wartungslock mit geschlossenem Standardeingang und prüft, dass er erst auf das vorgesehene Beendigungssignal reagiert.

## v0.75.2 Beta · Funktionspatch

- Verwaltungs- und Personal-Pop-ups passen ihre Spaltenzahl nun an 4K-, Full-HD- und mobile Ansichten an und vermeiden horizontale Scrollbalken.
- Die Standortübersicht verwendet auf breiten Ansichten ein kompaktes Zweispaltenraster; neutrale Leerzustände und Dialog-Scrollbalken folgen auch im Darkmode dem gewählten Erscheinungsbild.
- Team- und zentrale Mitarbeitendenliste teilen eine benutzerbezogen gespeicherte Spaltenauswahl. Angezeigte Personalaktfelder bleiben auf die jeweiligen Leserechte begrenzt.
- Ein Klick auf eine Spaltenüberschrift sortiert natürlich aufsteigend, der nächste Klick absteigend; Personalnummern werden numerisch beziehungsweise alphanumerisch eingeordnet.
- Die Seitenleiste bündelt Mitarbeitende, Anträge, Zeiterfassung, Kostenstellen und die unternehmensweite Urlaubsansicht unter einer aufklappbaren Personalverwaltung. Jeder Unterpunkt wird nur mit dem dafür erforderlichen Recht angezeigt.
- Das bisherige Feld „Aktive Teammitglieder“ entfällt. Einstellungen bleiben an seiner Stelle dauerhaft außerhalb des scrollbaren Hauptmenüs erreichbar.
- Im HTTPS-Serverbetrieb meldet der untere Seitenleisten-Button den aktuellen Benutzer ab, ohne den Serverdienst zu beenden.

## v0.75.1 Beta · Sicherheitsupdate

- Die über `/usr/local/sbin` veröffentlichten Linux-Wartungsbefehle lösen ihr tatsächliches App-Skript nun vor relativen Bibliothekszugriffen kanonisch auf; fremde oder nicht reguläre Symlinkziele werden vor der Ausführung abgelehnt.
- Sechs betroffene Installations-, Deinstallations- und Controllerfunktionen der Ubuntu-Host-Härtung initialisieren voneinander abhängige lokale Bash-Variablen nun in getrennten Schritten; gezielte Regressionstests sichern diese `set -u`-Pfade ab.
- Die Bestätigung einer angewendeten Ubuntu-Host-Härtung ist nur noch über eine eigenständige neue SSH-Verbindung möglich.
- Eine lediglich per OpenSSH-Multiplexing über dieselbe bestehende TCP-Verbindung geöffnete Sitzung wird nicht mehr als unabhängige Kontrollverbindung akzeptiert.
- Die Ubuntu-Erstinstallation installiert Produktionsabhängigkeiten nun ausdrücklich im geprüften Paket-Staging statt im aufrufenden Arbeitsordner.
- Sämtliche Schritte des isolierten Build-Benutzers wechseln vor dem Rechteabstieg in den zugänglichen Staging-Quellordner; ein gesperrtes Administrator-Heimatverzeichnis kann die Installation daher nicht mehr blockieren.
- Der Ubuntu-Installer setzt Ausführungsrechte nach einer plattformneutralen ZIP-Extraktion ausschließlich für verifizierte Bash-Werkzeuge unter `server-tools/linux`; andere Archivdateien erhalten dadurch kein pauschales Ausführungsrecht.
- Schlägt die Erstinstallation nach dem Caddyfile-Tausch fehl, stellt der Rollback neben der Datei auch den zuvor erfassten Aktivierungs- und Laufzustand von Caddy wieder her; ein zuvor inaktiver Dienst wird nicht mehr unbeabsichtigt gestartet.
- Erstinstallation und Serverupdate verwenden nun je Transaktion einen eigenen, anschließend gelöschten pnpm-Store sowie echten Kopierimport. Spätere Besitz- und Modusänderungen am App-Baum können dadurch keine wiederverwendeten Cache-Inodes mehr beschädigen.
- Die Installationsbaumprüfung lehnt reguläre Dateien mit zusätzlichen Hardlinks ab und verhindert so auch unabhängig von pnpm eine Metadatenkopplung zwischen Staging und fremden Dateibäumen.
- Der Linux-Paketbau berechnet Datei- und Archivprüfsummen editionsunabhängig über die .NET-Kryptobibliothek.
- Betriebsanleitung und automatisierte Prüfungen wurden an diese zusätzliche Schutzgrenze angepasst.
- Der einmalige Ubuntu-Admin-Bootstrap startet im Serverbetrieb nur mit einem ausschließlich in der Bootstrap-Unit gesetzten Modussignal, exakter Loopback-Bindung und starkem Einmal-Token; der normale Dienst kann durch einen verbliebenen Token nicht freigeschaltet werden.
- Schreibende Browseraufrufe des Bootstrap akzeptieren ausschließlich die exakte lokale SSH-Tunnel-Adresse; die Bootstrap-Unit schließt einen gleichzeitig gestarteten normalen App- oder Caddy-Dienst aus.

## v0.75 Beta

- Ein separates Ubuntu-Host-Sicherheitsmodul prüft SSH, UFW, automatische Sicherheitsaktualisierungen, Kernel-Schutzwerte, systemd-Journal und besonders geschützte Konfigurationsdateien.
- Die normale Serverinstallation aktiviert keine Firewall- oder SSH-Änderung. Der Sicherheitsplan bleibt zunächst vollständig lesend und muss von der verantwortlichen IT ausdrücklich als Root-Vorgang angewendet werden.
- Vor einer SSH-/UFW-Änderung werden verwaltete Einstellungen gesichert und ein automatischer Rücksetz-Timer gestartet. Erst eine zweite, weiterhin funktionierende Schlüssel-SSH-Sitzung darf die Transaktion bestätigen.
- SSH bleibt auf den bereits verwendeten Port beschränkt; der Bootstrap-Port 3000 wird niemals öffentlich freigegeben. UFW-Regeln werden ohne Firewall-Reset ergänzt. Das Modul löscht fremde Regeln nicht gezielt und verweigert einen Rollback bei nachträglichem UFW-Drift, statt fremde Änderungen zu überschreiben.
- Unattended Upgrades installiert freigegebene Ubuntu-Sicherheitsaktualisierungen ohne automatischen Neustart. Ein notwendiger Neustart wird als Wartungshinweis gemeldet.
- Das systemd-Journal erhält begrenzte Aufbewahrungs- und Größenwerte. Der an Grabenplaner übergebene Sicherheitsstatus enthält keine IP-Adressen, Benutzernamen, internen Pfade, Diagnosefreitexte oder Geheimnisse; technische Transaktionsprotokolle bleiben davon getrennt und root-only.
- Geheime Linux-Umgebungsdateien werden nicht mehr als Shellcode geladen, sondern als striktes, literales `KEY=VALUE`-Format geparst. Fehlerprotokolle geben keine URL-Abfragewerte aus.
- Der Linux-Laufzeitvertrag bleibt bei Deployment-Schema 2. Das optionale Sicherheitsmodul besitzt einen eigenen, paketgebundenen Vertrag und erfordert keine Laufzeitmigration.

## v0.74 Beta

- Eine gehärtete systemd-Prüfung kontrolliert den Ubuntu-Server alle fünf Minuten und schreibt ausschließlich einen redigierten, manipulationsgeschützten Status für die Anwendung.
- Nur drei aufeinanderfolgende Fehler der internen Live-Prüfung dürfen einen begrenzten automatischen Neustart auslösen; Ready-, Backup-, Offsite- oder Speicherwarnungen führen niemals selbstständig zu einem Neustart.
- Neue getrennte Rechte steuern die redigierte Betriebsübersicht und technische Diagnosedetails. Warnungen erscheinen für berechtigte Personen direkt im Grabenplaner, ohne interne Pfade oder Geheimnisse offenzulegen.
- Sicherungszeitpunkte in der Zukunft gelten nicht mehr als aktuell; bei mehreren Sicherungszielen wird tatsächlich der neueste verifizierbare Stand ermittelt.
- Der quartalsweise Offsite-Test stellt einen exakt gebundenen Snapshot in einen isolierten, schreibgeschützten Prüfbereich wieder her und dokumentiert das Ergebnis nachvollziehbar.
- Eine produktive Ubuntu-Wiederherstellung erfolgt ausschließlich als Root-Vorgang in den Phasen Auflisten, Vorbereiten, Prüfen und Anwenden. Snapshot und Vorgangskennung müssen ausdrücklich bestätigt werden; vor dem Austausch bleibt der bisherige Datenstand als Sicherheitskopie erhalten.
- Nach einer Wiederherstellung bleiben Grabenplaner und Caddy absichtlich beendet, bis die verantwortliche Administration Daten und Dienste geprüft und bewusst wieder freigegeben hat.
- Der Linux-Runtimevertrag wurde für die neuen Monitor-Dienste auf Deployment-Schema 2 angehoben. Der Wechsel von einer bestehenden v0.73-Serverinstallation benötigt daher die dokumentierte Wartungsmigration statt eines stillen In-place-Updates.

## v0.73 Beta

- Optionales Ubuntu-Offsite-Modul überträgt ausschließlich vollständig verifizierte lokale Datenbank-/Dokument-Sicherungspunkte verschlüsselt mit Restic über rclone zu Google Drive; die Live-Datenbank bleibt auf dem lokalen Linux-Dateisystem.
- Die Einrichtung verwendet separat bereitgestellte, gepinnte Restic-/rclone-Binaries und akzeptiert sie nur zusammen mit der jeweils erwarteten SHA-256-Prüfsumme.
- Zugangsdaten und Wiederherstellungsgeheimnisse liegen außerhalb von App, SQLite, Release-Paket und Offsite-Repository; ein getrenntes Offline-Recovery-Set bleibt Voraussetzung.
- Tägliche Uploads, monatliche vollständige Repository-Prüfungen und quartalsweise Wiederherstellungstests werden über getrennte systemd-Dienste und -Timer ausgeführt.
- Die feste Aufbewahrung umfasst 14 tägliche, 8 wöchentliche und 12 monatliche Sicherungsstände. Vor Updates wird ein kurzer lokaler Snapshot extern gesichert, während die bisherige App für die Netzübertragung wieder erreichbar ist; unmittelbar vor dem App-Tausch entsteht ein zweiter aktueller lokaler Rollback-Snapshot.
- Eine datensparsame Statusdiagnose zeigt Einrichtung, letzten Upload, Prüfung und Restore-Test, ohne Repository-Adresse, Zugangsdaten oder interne Dateipfade offenzulegen.
- Google Drive ist ein räumlich getrenntes, verschlüsseltes Backupziel, aber kein unveränderlicher WORM-Speicher. Ein kompromittierter Server mit gültigem Drive-Schreibzugang kann das Ziel weiterhin gefährden.

## v0.72 Beta

- Ubuntu 24.04 und 26.04 LTS auf x86-64 werden als offizielle Plattformen für den zentralen HTTPS-Serverbetrieb unterstützt; für neue Beta-Server wird Ubuntu 26.04 LTS empfohlen.
- systemd, Caddy und ClamAV ersetzen unter Linux die Windows-spezifischen Dienst-, Proxy- und Virenscannerbausteine.
- Ein eigener, nicht interaktiver Grabenplaner-Dienstbenutzer sowie getrennte Programm-, Daten-, Protokoll-, Sicherungs- und Geheimnisverzeichnisse begrenzen die Zugriffsrechte.
- Linux-Wartungswerkzeuge unterstützen kontrollierte Installation, Dienststopp, Betriebsprüfung, konsistente Sicherung und Updates mit automatischem Rollback.
- Die einmalige Admin-Ersteinrichtung bleibt auf Loopback beschränkt und schaltet HTTPS erst nach erster Sicherung sowie interner und öffentlicher Ready-Prüfung frei.
- Block 1 verwendet lokale, gekoppelte Sicherungspunkte; eine verschlüsselte Off-Host-Sicherung mit Restore-Test ist für den nächsten Serverblock vorgesehen.
- Ein neutrales Linux-Serverpaket enthält weder Arbeitsdaten noch kundenspezifische Brandings oder Geheimnisse und wird über Dateimanifest und SHA-256-Prüfsumme abgesichert.
- Die automatisierten Prüfungen laufen sowohl unter Windows als auch unter Linux; Linux-Shellskripte werden zusätzlich auf Syntaxfehler geprüft.
- Der Dark Mode verwendet in Planung und Verwaltungsbereichen durchgängig kontrastreiche dunkle Oberflächen, Statusfarben und Scrollleisten.

## v0.71 Beta

- Jede Hauptseite kann ihre eigene gespeicherte helle oder dunkle Darstellung verwenden; die technische Fußzeile folgt dem gewählten Erscheinungsbild.
- Die neue Dashboard-Zentrale bündelt Rechte, Standardprozesse, eigene Prozesse und eine anordenbare Filialübersicht mit datensparsamen Abwesenheitsinformationen.
- Der Personalakt wurde um verschlüsselte persönliche, vertragliche, Kontakt- und Beschäftigungsdaten sowie verschlüsselte Dokumente erweitert.
- Feldgenaue Rollenmatrizen steuern für Filial- und Abteilungsleitungen getrennt, welche Personalakt-Daten verborgen, lesbar oder bearbeitbar sind.
- Eine zentrale Personalverwaltung mit frei verwaltbaren Kostenstellen bildet auch Beschäftigte außerhalb von Filialteams ab.
- Filialverwaltung, Einsatzfilialen und die zentrale Urlaubsübersicht berücksichtigen Standort, Abteilung, Mindestbesetzung, Sperren und bestätigte Ersatzdienste.
- Personalleitung und Administration können eigene grafische Prozesse mit Bedingungen, Zuständigkeiten, Aufgaben und datensparsamen Benachrichtigungen definieren.
- AUM-Dokumentzugriff und Fallzuständigkeit werden serverseitig nach Rolle, Bereich und ausdrücklicher Freigabe durchgesetzt.

## v0.70 Beta

- AUM-Dokumente und erkannte Gesundheitsdaten sind serverseitig besonders geschützt; Zugriffe werden nachvollziehbar protokolliert.
- Der Personalakt unterstützt verschlüsselte sensible Stammdaten wie Sozialversicherungsnummer, Bankverbindung, Adresse und geregelte Telefonrechte.
- Krankmeldungen können im Mitarbeiterportal direkt mit einer AUM verbunden werden; lokale OCR-Vorschläge werden vor der Übermittlung bestätigt und serverseitig geprüft.
- Für Vertrauensstufe A stehen konfigurierbare Krankenstände ohne AUM sowie nachvollziehbare Bewertungs-Snapshots für Krankenstunden bereit.
- Eindeutig erkannte und zugeordnete AUM-Fälle können nach freigegebenen Regeln automatisch abgeschlossen werden; unsichere Fälle bleiben in der manuellen Prüfung.

## v0.69.1 Beta · Serviceupdate

- Der Portable-Updater schützt nur noch die vorgesehenen Datenordner an der Paketwurzel. Gleichnamige Laufzeitordner innerhalb von `node_modules` werden vollständig aktualisiert.
- Das entpackte Paket und die installierte Laufzeit werden vor dem Neustart auf benötigte Module und eine gültige Serverdatei geprüft.
- Ein Update gilt erst dann als erfolgreich, wenn der neu gestartete Grabenplaner seinen Bereitschaftsendpunkt bestätigt.
- Scheitert der Neustart, bleibt die Datenbank unberührt und ein klarer Hinweis verweist auf das lokale Updateprotokoll.
- Automatische Update-Neustarts hinterlassen nach einem Startfehler kein irreführend wartendes Startfenster.

## v0.69 Beta

- Wiederverwendbare SQL-Importprofile speichern Quellenart und konkrete geprüfte Verbindung zusätzlich zur Feldzuordnung; sie können direkt aus der Profilübersicht erneut geöffnet werden.
- Ein Profil darf serverseitig nur mit seiner hinterlegten Quellenart und SQL-Verbindung verwendet werden. Vorschau und ausdrückliche atomare Bestätigung bleiben verpflichtend.
- SQL-Personalquellen und HTTPS-Lohnziele sind fest an ihren jeweils freigegebenen, versionierten Schnittstellenvertrag gebunden; unpassende Verträge werden abgewiesen.
- Die neue Vertragsübersicht dokumentiert Richtung, Transport, Version und SHA-256-Prüfsumme. Berechtigte Stellen können die maschinenlesbaren JSON-Verträge für die Firmen-IT herunterladen.
- Der Vertrag `grabenplaner.personnel-view.v1` erlaubt ausschließlich schreibgeschützte Personalstammdaten aus einer freigegebenen View und schließt sensible Personalakt-Daten aus.
- Der Vertrag `grabenplaner.payroll.v1` beschreibt die minimierte, idempotente HTTPS-JSON-Übergabe ausschließlich final geprüfter Ist-Werte.

## v0.68.1 Beta · Serviceupdate

- Portable Aktualisierungen laden das veröffentlichte Windows-ZIP direkt über GitHub HTTPS; eine installierte oder angemeldete GitHub CLI ist nicht mehr erforderlich.
- Dateiname, erlaubter GitHub-Host, gemeldete Dateigröße und die von GitHub veröffentlichte SHA-256-Prüfsumme werden vor der Installation kontrolliert.
- Unter Windows berücksichtigt der HTTPS-Abruf auch den Systemzertifikatsspeicher, damit freigegebene Firmen- und Sicherheitssoftware-Zertifikate ohne unsichere TLS-Abschaltung funktionieren.
- Unvollständige, manipulierte oder von einem fremden Host gelieferte Downloads werden verworfen, bevor der laufende Grabenplaner beendet wird.
- Der Installationshelfer prüft Größe und SHA-256 unmittelbar vor dem Entpacken erneut; Datenbanken, Backups, AUM-Dateien und lokale Laufzeitkonfiguration bleiben weiterhin geschützt.

## v0.68 Beta

- Eine lesbare Konfigurationsprüfung ergänzt das Rechte-Dashboard und unterscheidet erfolgreiche Prüfungen, bewusste Hinweise, Warnungen und echte Blocker.
- Alternative Urlaubs-, ZA-, AUM-, Tagesprüfungs- und Lohnübergabewege können folgenlos simuliert werden. Die Simulation verändert keine gespeicherten Einstellungen oder Fachdaten.
- Prüfhinweise führen mit einem Klick direkt zum betroffenen Prozessschritt; von dort kann zur passenden Einstellung oder zur Rechteübersicht gewechselt werden.
- Standortabhängige Prüfungen erkennen unter anderem deaktivierte Zeiterfassung sowie fehlende Netzwerkfreigaben, ohne vertrauliche Netzadressen offenzulegen.
- Der gewählte Prozessweg kann einschließlich Simulation, Standortbezug, Regeln, Schritten und Prüfergebnis als geschützte PDF-Dokumentation ausgegeben werden.
- Zugriff auf Dashboard, Prüfdaten und PDF-Export bleibt auf Personalleitung, Admin, IT-Admin und Developer beziehungsweise ausdrücklich berechtigte Rollen beschränkt.

## v0.67 Beta

- Das grafische Rechte-Dashboard erhält eine zweite Ansicht für die aktuellen Standardprozesse von Urlaubsantrag, Zeitausgleich, Krankmeldung/AUM, Tagesprüfung und Lohnübergabe.
- Jeder Prozess zeigt Antrag beziehungsweise Buchung, automatische Prüfungen, Entscheidungen, Freigaben und Abschluss als leicht lesbaren vertikalen Ablauf.
- Ein Klick auf einen Schritt erklärt die zuständige Rolle, die aktuell wirksame Einstellung, den Status und die benötigten Rechte.
- Aktive, bedingte, übersprungene und deaktivierte Schritte sind optisch getrennt; Urlaubssperren, Freigabestufen, AUM-Regeln und vorhandene Lohnschnittstellen fließen direkt ein.
- Für Zeiterfassung und Lohnübergabe kann der betrachtete Standort gewechselt werden. Standortbezogene Aktivierung, Buchungsort und Abweichungstoleranz werden ohne vertrauliche Netzwerkdaten dargestellt.
- Die helle oder dunkle Darstellung bleibt ausschließlich auf dieses Dashboard beschränkt.

## v0.66 Beta

- Neues grafisches Rechte-Dashboard für Personalleitung, Admin, IT-Admin und Developer mit dem nachvollziehbaren Pfad Person → Rolle → Standort/Abteilung → wirksame Rechte.
- Grundrechte einer Rolle, individuelle Zusatzrechte und auf Person, Filiale oder Abteilung begrenzte Geltungsbereiche werden klar unterschieden.
- Suche nach Personalnummer, Name oder Recht sowie Filter nach App-Rolle, Standort, Abteilung und Rechteart erleichtern die Kontrolle größerer Teams.
- Jedes wirksame Recht erklärt Herkunft, Geltungsbereich, Status und technischen Schlüssel, ohne Passwort- oder andere sensible Zugangsdaten auszugeben.
- Das Dashboard besitzt eine eigene helle oder dunkle Darstellung. Sie gilt ausschließlich dort und wird pro angemeldetem Benutzer gespeichert.

## v0.65 Beta

- Einstellungen sind fachlich neu gegliedert: Urlaubsfreigaben liegen unter „Urlaub“, Pausen-, Samstags- und WLAN-Regeln unter „Zeiterfassung“, Vertrauensstufen unter „Personal“.
- „Ansicht & Startverhalten“ kann den zuletzt angesehenen Dienstplan- und Urlaubs-Gesamtplan benutzer- und browserbezogen wieder öffnen; der Sonntag wird im selben Bereich gesteuert.
- Personalleitung und höhere Rollen können das Vertrauensstufensystem ohne Datenverlust deaktivieren und die Sichtbarkeit für Filialleitung, Abteilungsleitung sowie Teammitglieder getrennt festlegen.
- Bei deaktivierten Vertrauensstufen bleiben A/B/C-Zuordnungen bearbeitbar gespeichert; für Bestätigungsfristen gilt währenddessen vorsichtshalber Stufe C.
- Zugänge und Rechtemanagement nutzen eine kompaktere echte Zweispaltenansicht. WLAN-Status, Controller-Zuordnung und Anwesenheitsregeln sind in einem gemeinsamen Bereich gebündelt.

## v0.64 Beta

- Direkte, manuell ausgelöste Verbindungen ergänzen den bestehenden Datei-Import und -Export, ohne automatische Hintergrundsynchronisation.
- Microsoft SQL Server wird über einen reinen Lesezugriff auf eine ausdrücklich freigegebene View angebunden; zusätzlich werden nur die konfigurierten Spalten gelesen. Freie SQL-Befehle, Tabellenzugriffe, Prozeduren und Schreiboperationen sind ausgeschlossen.
- SQL-Daten durchlaufen weiterhin die befristete Vorschau, Feldzuordnung, Dublettenprüfung und atomare Bestätigung des Personalimport-Assistenten. Vorschauen sind auf 5 MiB begrenzt, an Verbindung und Bereich gebunden und werden vor der Übernahme erneut geprüft.
- Final geprüfte Lohnwerte können als minimiertes, versioniertes JSON an ein vorkonfiguriertes HTTPS-Ziel übergeben werden. Entwürfe und Läufe mit Blockern sind von der direkten Zustellung ausgeschlossen.
- DNS-/SSRF-Prüfung, IP-Pinning, TLS 1.2+, feste Größen- und Zeitlimits, Redirect-Sperre sowie an die Zielrevision gebundene Idempotenz schützen die API-Übertragung. Der Verbindungstest bleibt auf DNS und TLS beschränkt und sendet keine Fachdaten.
- Nach einem Prozessabbruch bleiben Zustellungen nicht hängen, sondern werden nachvollziehbar als unklar markiert und nur ausdrücklich erneut versucht.
- Zugangsdaten liegen getrennt von öffentlicher Konfiguration und Laufprotokollen kontextgebunden mit AES-256-GCM verschlüsselt; Antworten zeigen ausschließlich, ob Zugangsdaten eingerichtet sind.
- Eigene Rechte trennen Lesen, technische Konfiguration, Ersetzen von Zugangsdaten und fachliche Lohnübergabe. Verlauf und Audit enthalten nur neutrale Metadaten, Status und Hashes.

## v0.63 Beta

- Neuer neutraler Personalimport-Assistent für CSV- und XLSX-Dateien mit automatischen Zuordnungsvorschlägen, frei prüfbarer Feldzuordnung, Vorschau und atomarer Übernahme.
- Personalnummern bleiben Textwerte einschließlich führender Nullen; Dubletten werden standardmäßig übersprungen und Groß-/Kleinschreibung erzeugt keine zweite Person.
- Wiederverwendbare Import- und Lohnverrechnungsprofile speichern ausschließlich Zuordnungen und Einstellungen, niemals die hochgeladenen Personalzeilen.
- Konfigurierbarer Lohnverrechnungs-Export als Tagesjournal oder Lohnarten-Datei in CSV/XLSX mit Planwerten oder aktuell geprüften Ist-Zeiten.
- Vorprüfung sperrt finale Ist-Exporte bei fehlender beziehungsweise veralteter Tagesprüfung, offenen Korrekturen, unvollständigen Buchungen oder Arbeits-/Abwesenheitsüberschneidungen; ein ausdrücklich gekennzeichneter Entwurf bleibt möglich.
- Standort- und Abteilungswerte werden getrennt geprüft; nicht eindeutig zuordenbare Mehrabteilungstage sowie standortübergreifende Ist-Zeiten bleiben bis zur passenden Tagesprüfung auf klar markierte Entwürfe beschränkt. Ein Lauf umfasst höchstens 93 Tage.
- Eigene delegierbare Rechte, Bereichsprüfung und datensparsame Laufprotokolle schützen Import und Export; sensible Personalakt-, Bank-, Adress-, SV- und AUM-Daten sind ausgeschlossen.

## v0.62 Beta

- Sichere native Geräteanmeldung für Grabenplaner Mobile im konfigurierten HTTPS-Serverbetrieb mit kurzlebigen Zugriffstokens, rotierenden Refresh-Tokens und serverseitig widerrufbaren Gerätesitzungen.
- Android-Alpha-Vertrag für Standortbranding, persönlichen Dienstplan, Zeiterfassungsstatus und idempotente Zeitbuchungen mit vertrauenswürdiger Serverzeit.
- Gerätewechsel, erneute Anmeldung, Passwort- und Rechteänderungen beenden betroffene Sitzungen nachvollziehbar; Refresh, Wiederverwendung bereits konsumierter Tokens und App-Mindestversion werden serverseitig geprüft.
- Der Browserzugang behält seine bestehende Cookie-, CSRF- und Origin-Sicherheit. Native App-Routen akzeptieren ausschließlich Bearer-Tokens und öffnen keine Cross-Origin-Browserfreigabe.

## v0.61.2 Beta · Funktionspatch

- Der USB-Stick-Assistent steht berechtigten Developer-, IT-Admin- und Admin-Konten nun auch im LAN-Host- und HTTPS-Serverbetrieb zur Verfügung.
- Formatierung und Installation bleiben aus Sicherheitsgründen ausschließlich direkt am physischen Windows-Host möglich; entfernte Browser, Tablets und Smartphones erhalten nur einen erklärenden Sperrhinweis.
- Im HTTPS-Betrieb wird zusätzlich die wirksame Clientadresse hinter dem vertrauenswürdigen Reverse-Proxy geprüft. Mutationen verlangen weiterhin Session, USB-Berechtigung, CSRF-Schutz, Aktionsheader und eine gleichursprüngliche Browseranfrage.
- Im Netzwerk- und Serverbetrieb ist das Erstellerkonto an das angemeldete Administratorkonto gebunden. Der erzeugte Stick startet unabhängig vom Quellmodus stets mit eigener SQLite-Datenbank im Lokalbetrieb.

## v0.61.1 Beta · Serviceupdate

- Neuer lokaler Windows-Assistent zum Erstellen vorkonfigurierter Grabenplaner-USB-Sticks ohne UAC-Anforderung oder Rechteumgehung.
- Der Assistent übernimmt ausgewählte Standorte, Teammitglieder, Rollen und Zusatzrechte in eine frische Datenbank; Dienste, Urlaube, Zeitbuchungen, AUMs, Sitzungen und Auditverlauf werden nicht kopiert.
- Der Ersteller wird verpflichtend als Admin mit seinem bestehenden Passwort-Hash angelegt. Ein Developer-Zugang wird niemals auf den Zielstick übertragen.
- Funktionsprofile blenden nicht freigeschaltete Bereiche aus und sperren die zugehörigen APIs zusätzlich serverseitig.
- Haupt-Branding, mehrere zusätzliche Branding-Kits und eine anpassbare, automatisch gebrandete „Erste Schritte“-PDF können vorbereitet werden.
- Das Ziel erhält ein aufgeräumtes Hauptverzeichnis mit Startdatei, Anleitung, Backups und PDF-Exporten; Programmdateien liegen optional versteckt und gegen versehentliche Änderungen geschützt im Unterordner `app`.
- Vor der Formatierung werden Laufwerksidentität, Kapazität und exakte Bestätigung geprüft. Nach der NTFS-Formatierung wird der Datenträger erneut identifiziert und die vollständige Installation abschließend per SHA-256 verifiziert.
- Branding-ZIP-Importe sind zusätzlich gegen übergroße oder verschachtelte Archive abgesichert; die Ersteller-Freigabe besitzt eine lokale Fehlversuchsbegrenzung.

## v0.61 Beta

- Der HTTPS-Serverbetrieb ist für einen IT-verwalteten produktiven Windows-Einzelserver mit Caddy als Reverse-Proxy und WinSW-Diensten ausgearbeitet.
- Strikte Produktionsprüfungen sichern Loopback-Bindung, vertrauenswürdigen Proxy, öffentliche HTTPS-Adresse, sichere Sitzungen und die getrennte Datenablage ab.
- Der Codespaces-Testbetrieb erkennt die öffentliche Browseradresse auch dann sicher, wenn GitHubs HTTPS-Proxy intern einen Loopback-Host weiterreicht; fremde Origins bleiben gesperrt.
- Getrennte Dienstidentitäten und eingeschränkte ACLs begrenzen den Zugriff von Anwendung, Reverse-Proxy und Administration auf die jeweils erforderlichen Ordner.
- Separate Live- und Ready-Endpunkte unterscheiden einen laufenden Prozess von einer vollständig betriebsbereiten Instanz einschließlich Datenbank, Speicher, Backupziel und AUM-Scanner.
- Die Server-Betriebsprüfung ersetzt die frühere Pilot-Checkliste und zeigt berechtigten Stellen die produktionsrelevanten Prüfpunkte verständlich an.
- Ein kontrollierter Wartungsablauf prüft Release-ZIP und SHA256, erstellt vor dem Update ein verifiziertes Backup, tauscht nur Programmdateien aus und führt bei einem fehlgeschlagenen Start ein Rollback durch.
- Backup und Wiederherstellung halten SQLite-Datenbank und verschlüsselte AUM-Ablage gekoppelt; Service-Stopp, Healthchecks und Caddy-Konfiguration sind in die Betriebswerkzeuge eingebunden.
- Der aktuelle Produktivmodus bleibt bewusst eine einzelne Instanz ohne Hochverfügbarkeit. Nativer Token-Login und Gerätesitzungen für Android/iOS folgen in einem eigenen Sicherheitsblock.

## v0.60 Beta

- Persönliche Portal-Einstellungen bündeln Passwortänderung und freiwillige WLAN-Zeitvorschläge an einer festen Stelle.
- Die Zeiterfassung kann Teammitglieder persönlich begrüßen; die Funktion ist datenschutzfreundlich zunächst deaktiviert. Personalleitung, Admin, IT-Admin und Developer können neutrale Vorlagen sowie die Rückkehrzeiträume nach längerem Urlaub oder Genesung verwalten.
- Begrüßungen werden serverseitig ausgewählt und geben weder Diagnosen noch AUM-Inhalte oder andere Gesundheitsdetails an Browser beziehungsweise Mobile-Client weiter.
- Eine versionierte Mobile-API-v1-Basis liefert Status, Branding, Benutzerprofil, Navigation, Startbereich und persönliche Einstellungen mit stabilen Typen und Fehlercodes.
- Der eigenständig versionierte Android-/iOS-Client erhält dafür den Vertragsstand 0.2.0; der native Token-Login folgt in einem eigenen Sicherheitsblock.

## v0.59.2 Beta · Serviceupdate

- Mobile Leitungsansicht korrigiert: Die Unterbereiche „ZA beantragen“, „Urlaub beantragen“ und „Krankmeldung & AUM“ bleiben bei einer Layout-Neuberechnung unter „Mehr“ geöffnet.
- Das Ein- oder Ausblenden der Android-Browserleiste löst beim Scrollen zwar weiterhin den normalen Viewportwechsel aus, springt aber nicht mehr fälschlich zur Zeiterfassung.
- „Mehr“ bleibt als übergeordneter Menüpunkt sichtbar markiert, während einer seiner Unterbereiche geöffnet ist.

## v0.59.1 Beta · Serviceupdate

- Nach der Rückkehr von der Android-Kamera oder Dateiauswahl bleibt im Mitarbeiterportal der Bereich „Krankmeldung & AUM“ aktiv; ein vom Betriebssystem ausgelöster Seitenneuaufbau springt nicht mehr zur Zeiterfassung zurück.
- Der zuletzt geöffnete Portalbereich wird nur für die laufende Browsersitzung gespeichert und beim Abmelden wieder entfernt.
- Aktualisierungen unterscheiden künftig sichtbar zwischen Serviceupdate, Sicherheitsupdate und neuer Funktionsversion. Patchstände wie v0.59.1 bleiben eigenständige, aufsteigend sortierte Wartungsreleases.

## v0.59 Beta

- Krankmeldung und AUM zu einem gemeinsamen, mobil optimierten Ablauf im Mitarbeiterportal zusammengeführt; eine Krankmeldung kann im HTTPS-Serverbetrieb auch von außerhalb des Firmennetzes erfasst werden.
- Ein gemeinsamer Zeitraumskalender verlangt nur ein Beginn-Datum und erlaubt ein offenes voraussichtliches Ende. Über „Arbeitsfähigkeit melden“ wird der Fall später eindeutig abgeschlossen; eine AUM kann sofort oder nachträglich sicher zugeordnet werden.
- Zuständige Filial- und Abteilungsleitungen erhalten sofort eine interne Meldung; eine mögliche Unterschreitung der hinterlegten Mindestbesetzung wird gesondert hervorgehoben.
- E-Mail, SMS und WhatsApp können je berechtigter Leitung als optionale externe Besetzungswarnung mit einer frühesten Versandzeit eingerichtet werden; die Provider-Anbindung bleibt Aufgabe der Firmen-IT.
- Neue oder geänderte externe Warnziele werden erst nach Bestätigung eines sechsstelligen Einmalcodes aktiviert.
- Externe Warnungen enthalten ausschließlich einen neutralen Hinweis zum Anmelden im geschützten Portal, keine Personalnummer, Diagnose oder sonstige Gesundheitsdaten.
- Besetzungsrisiken berücksichtigen den tatsächlichen Einsatzort eines Dienstes, delegierte Leserechte und spätere Umplanungen; erledigte Warnungen und ausstehende Versandaufträge werden automatisch aufgelöst.
- Die lokale AUM-Datenerkennung unterstützt hochgeladene Fotos, direkte Kamerabilder und PDFs: Digitale PDFs werden mit PDF.js ausgewertet, Scan-PDFs und Bilder mit Tesseract.js. Erkannte Werte sind nur Vorschläge, müssen geprüft und bestätigt werden und überschreiben keine manuellen Eingaben.
- Gelbe lokale und rote Personalleitungs-Eskalationen für verspätete AUMs sind getrennt einstellbar; verspätete Uploads bleiben weiterhin möglich.
- Krankmeldungsdaten, Warnziele und ausstehende externe Versandaufträge werden pseudonymisiert, kontextgebunden mit AES-256-GCM geschützt, bei einem Datenbankimport auf Integrität geprüft und nach den festgelegten Aufbewahrungsfristen gelöscht.

## v0.58 Beta

- Rechteprofil direkt in die Personalstammdaten integriert: Developer und IT-Admin können App-Rolle und personenbezogene Zusatzrechte beim Anlegen oder Bearbeiten gemeinsam speichern.
- IT-Admins dürfen die Rolle Personalleitung samt Mindest- und Zusatzrechten vergeben; geschützte Developer-Konten bleiben ausschließlich offline gebunden und können weder über Oberfläche noch API zugewiesen werden.
- Rollen-, Rechte- und Bereichsänderungen werden serverseitig geprüft, transaktional gespeichert und revisionsfähig protokolliert; unzulässige Rechteprofile lassen keine Teiländerungen zurück.
- Sensible Personalakt- und AUM-Inhalte sowie Dokumentmetadaten werden kontextgebunden mit AES-256-GCM verschlüsselt; neue Dokumente binden die Verschlüsselung zusätzlich an ihren Ablagepfad.
- Bestehende Personalakt-Daten werden vor der Migration gemeinsam mit der verschlüsselten Dokumentablage gesichert, anschließend verschlüsselt und aus den bisherigen Klartextfeldern entfernt.
- Manuelle Sicherungen umfassen Datenbank und verschlüsselte Dokumentablage als zusammengehöriges Paar; App und separater Backup-Befehl sperren den Datenbestand währenddessen gegenseitig gegen parallele Änderungen.
- Reine Datenbankimporte sind im geschützten Betrieb Developer/IT-Admin vorbehalten, werden bei vorhandenen Dokumenten abgewiesen und prüfen auch ältere verschlüsselte Personalakt-Datensätze vor der Annahme mit dem lokalen Schlüsselsatz.
- Admin-Zugänge können die technische IT-Admin-Rolle weder über Personalstammdaten noch über die ältere Zugangsverwaltung vergeben; Developer bleibt ausschließlich offline bindbar.
- Rollenänderungen ohne neues Startpasswort bewahren den bestehenden Passwortstatus und lösen keine unnötige erneute Passwortänderung aus.

## v0.57 Beta

- Geschützte, idempotente Controller-/RADIUS-Schnittstelle für pseudonymisierte WLAN-Ereignisse ergänzt; Hardware-Adressen, SSIDs und Gerätekennungen werden abgelehnt.
- Freiwilliges Mitarbeiter-Opt-in, bearbeitbare Zeitvorschläge und persönliche Bestätigung im Mitarbeiterportal umgesetzt.
- Reconnects innerhalb der einstellbaren Toleranz teilen die Anwesenheit nicht; nach Ablauf bleibt der ursprüngliche WLAN-Abbruch als Vorschlagsende maßgeblich.
- Vertrauensstufen A, B und C steuern Wochenabschluss beziehungsweise Bestätigungsfrist; bald fällige und überfällige Vorschläge werden sichtbar gewarnt.
- Automatische Endbuchungen bleiben ausgeschlossen: Erst die ausdrückliche Bestätigung erzeugt revisionsfähige Zeitbuchungen.
- Controller-Kennungen je Filiale können ab Personalleitung gepflegt werden und werden ausschließlich gehasht gespeichert.
- Angemeldete Person, App-Rolle und Firmenposition erscheinen kompakt im linken Menü; Logout liegt direkt bei diesen Angaben.
- Im Serverbetrieb dürfen ausschließlich Developer, IT-Admin und Admin den eindeutig bezeichneten Server-Stopp auslösen.
- Codespaces akzeptiert die vom vertrauenswürdigen GitHub-HTTPS-Proxy gemeldete gleichursprüngliche Weiterleitungsadresse, ohne die Origin-Prüfung für fremde Seiten zu lockern.
- Öffentliche Musterkits für einen fiktiven Foto- und Sporthandel sowie ein Sporthandels-Demoprofil mit sechs Filialen, 15 Abteilungen und 31 Verkaufsmitarbeitenden ergänzt.

## v0.56 Beta

- Ersten Teil der WLAN-Automatik als geschützte technische Grundlage ergänzt; eine echte Controller- oder RADIUS-Verbindung ist noch nicht aktiv.
- Eigenen Einstellungsbereich „WLAN-Automatik“ für Personalleitung, Admin, IT-Admin und Developer eingeführt.
- Mindestanwesenheit und Abwesenheitstoleranz sind einstellbar; bei endgültiger Abwesenheit bleibt der ursprüngliche WLAN-Abbruch als spätere Vorschlagszeit maßgeblich.
- Vertrauensstufen A, B und C unabhängig von Position, Rolle, Filiale und Abteilung im Personalstamm ergänzt; neue und bestehende Datensätze starten vorsichtshalber mit Stufe C.
- Kompakte, durchsuchbare Verwaltung aller Vertrauensstufen im WLAN-Menü ergänzt und Änderungen revisionsfähig protokolliert.
- Pseudonymisierte, idempotente Datenstruktur für spätere WLAN-Ereignisse, Anwesenheitssitzungen und bestätigungspflichtige Zeitvorschläge vorbereitet.
- Zugriffe unterhalb der Personalleitung erhalten weder die WLAN-Einstellungen noch die sensible Vertrauensstufe über Oberfläche oder API.
- Automatische Buchungen bleiben bewusst deaktiviert: Teil 2 ergänzt erst die WLAN-Schnittstelle, Mitarbeiter-Opt-ins, Vorschlagsbildung und Bestätigungswarnungen.

## v0.55 Beta

- Zentrale Tagesauswertung für beliebig viele Pausen und geteilte Dienste eingeführt; offene historische Buchungen werden nicht mehr bis zur aktuellen Uhrzeit weitergerechnet.
- Tatsächliche Arbeitszeit, Pausen, Dienstplanzeit, Abweichung und Samstagswertung werden getrennt und nachvollziehbar ausgewiesen.
- Tagesprüfung für berechtigte Leitungen mit Hinweisen zu fehlenden Buchungen, unvollständigen Tagen, Pausenunterschreitungen, Zeitabweichungen und offenen Korrekturen ergänzt.
- Geprüfte Tage speichern Regelversion und Auswertungsstand; nachträgliche Plan-, Buchungs-, Abwesenheits- oder Regeländerungen markieren die Prüfung automatisch als veraltet.
- Standortbezogene Regeln für Buchungen von überall oder nur aus einem vertrauenswürdigen Firmennetz sowie eine einstellbare Abweichungstoleranz ergänzt.
- Mehrteilige Zeitkorrekturen mit mehreren Pausen oder Arbeitsblöcken können in der Leitungsansicht vollständig bearbeitet werden.
- Zeitübersichten im Mitarbeiterportal um gewertete Zeit, Pausen und konkrete Tageshinweise erweitert.
- Rechtevergabe für Personalleitung, Admin und Developer optisch verdichtet; Checkboxen, geschützte Rechte und individuelle Zusatzrechte werden klar und responsiv dargestellt.
- Abteilungsbereiche werden bei delegierten Zusatzrechten rollenunabhängig geprüft; die Tagesprüfung bleibt auf den zugewiesenen Bereich begrenzt.
- Bereichsübergreifende Zeitkorrekturen können nur auf Filialebene entschieden werden und behalten bei der Übernahme ihre korrekte Abteilungszuordnung.

## v0.54 Beta

- Geschützte Developer-Rolle als technische Ebene oberhalb der regulären Administration ergänzt; sie kann nicht über die Weboberfläche vergeben, geändert oder entfernt werden.
- IT-Admin als eigene technische Rolle für Zugänge, Rechtemanagement, Betriebsmodus, Updates, Backups und Serverbetrieb eingeführt, ohne automatische Personal- oder AUM-Fachrechte.
- Rollenvergabe hierarchisch abgesichert: Personalleitung und IT-Admin verwalten untergeordnete Rollen, Admin und Developer die regulären Systemrollen; Developer bleibt ausschließlich offline bindbar.
- Personenbezogene Zusatzrechte von der Position entkoppelt: IT-Admin kann den vollständigen delegierbaren Katalog auch normalen Mitarbeiterkonten zuweisen, während die Personalleitung nur festgelegte fachliche Rechte verwaltet.
- Rechtemanagement mit Suche nach Personalnummer oder Name, kompakter Trefferliste und gruppiertem Bearbeitungsdialog für Grund- und Zusatzrechte ergänzt.
- Bisher zu weitreichendes delegierbares Personalrecht durch ein enges Recht zur Änderung von Teamfarben ersetzt. Name, Sollzeit und weitere Stammdaten bleiben in Oberfläche und API schreibgeschützt.
- Standort- und Abteilungsgrenzen sowie geschützte Benutzerkonten werden bei jeder relevanten Serveraktion geprüft und sicherheitsrelevant protokolliert.
- Sicherheitsrichtlinie für vertrauliche Meldungen, unterstützte Versionen und sichere Betriebsbedingungen ergänzt.

## v0.53.1 Beta

- Branding-Verhalten nach Rollen präzisiert: Admin und Personalleitung behalten das in den Einstellungen gewählte Verwaltungs-Branding; standortgebundene Rollen und Mitarbeitende sehen ausschließlich das Branding ihrer Filiale – einschließlich der Anmeldung.
- Speichern und Anwenden installierter Branding-Kits stabilisiert; nicht verwendete Kits können nun gelöscht werden.
- Standortbezogene Branding-Zuweisungen lassen sich gesammelt bearbeiten und in einem Schritt speichern, ohne andere noch nicht gespeicherte Auswahlfelder zurückzusetzen.
- Einstellungen für Branding, Personal, Zugänge, Rechtemanagement und Datenbank in ein platzsparendes zweispaltiges Layout überführt; die PDF-Ausgabe bleibt bewusst einspaltig.
- Standortverwaltung auf eine kompakte Übersicht mit eigenen Dialogen zum Anlegen und Bearbeiten von Filialen und Abteilungen umgestellt.
- PDF-Vorschau in den Ausgabeeinstellungen repariert sowie Personalakt-Dialog und leere Statusanzeigen ohne horizontales Abschneiden dargestellt.

## v0.53 Beta

- Geschütztes Rechtemanagement ergänzt: Admin und Personalleitung können ausgewählte Verwaltungsrechte gezielt an Filial- und Abteilungsleitungen delegieren; besonders sensible Funktionen bleiben der übergeordneten Ebene vorbehalten.
- Installierte Branding-Kits können durch Admin oder Personalleitung standortbezogen zugewiesen werden; Filial- und Abteilungsleitungen erhalten keinen Zugriff auf Branding-Änderungen.
- Zeiterfassung um persönliche Wochen- und Monatsübersichten sowie nachvollziehbare Korrekturanträge erweitert.
- Berechtigte Leitungen können Zeitkorrekturen prüfen, bearbeiten, genehmigen oder ablehnen; Entscheidungen und Änderungen bleiben protokolliert.
- Mobil optimiertes Leitungsportal mit wenigen, konfigurierbaren Kernfunktionen ergänzt; im Mitarbeiterportal öffnet sich die Zeiterfassung standardmäßig zuerst.
- Verwaltungsübersicht für Zeiträume und offene Zeitkorrekturen ergänzt.
- Private GitHub-Codespaces-Testumgebung für Rollen-, Portal- und Zeiterfassungsabläufe über den geschützten HTTPS-Proxy aktualisiert.

## v0.52 Beta

- Standortweise aktivierbare Zeiterfassung ergänzt: Mitarbeitende buchen im mobil optimierten Portal „Kommen“, „Pause“, „Weiter“ und „Gehen“ mit verbindlicher Serverzeit und geschützter Buchungsfolge.
- Live-Anwesenheit für berechtigte Leitungen und Administration ergänzt, einschließlich Tagesbuchungen sowie erster Soll-/Ist-/Differenzanzeige.
- Vergessene Gehen-Buchungen können durch berechtigte Leitungen mit tatsächlicher Abschlusszeit nachvollziehbar korrigiert werden, ohne den nächsten Arbeitstag dauerhaft zu sperren.
- AUM-Uploads um direkten Kamerazugriff, WEBP/TIFF-Unterstützung und automatische, optional graustufige A4-PDF-Aufbereitung erweitert; Upload- und Speicherlimit sind für Admin und Personalleitung einstellbar.
- Geschützten Personalakt mit vergangenen AUM-Meldungen ergänzt; der Dateizugriff für Filial- und Abteilungsleitungen bleibt separat einstellbar und bereichsbeschränkt.
- Private GitHub-Codespaces-Testumgebung mit automatisch erzeugtem Demo-Admin, Datenhaltung außerhalb des Repositorys und sichtbarer Demodaten-Warnung vorbereitet.
- Externe Schriftimporte entfernt und die Verwaltungsoberfläche zuverlässig auf lokale serifenlose Systemschriften festgelegt.
- Integrierten Windows-Updater auf einen bereinigenden Programmabgleich umgestellt; Datenbank, Backups, AUM-Dateien und lokale Laufzeitkonfiguration bleiben ausdrücklich geschützt.
- Automatisierte Tests für Dokumentaufbereitung, Verschlüsselung, Rollenbereiche, Zeiterfassungszustände sowie LAN-/HTTPS-Grundbetrieb erweitert.

## v0.51.1 Beta

- Aufklappbare Filialgruppen in der Seitennavigation verwenden nun kleine Explorer-artige Pfeile links vor dem Bereichssymbol statt großer Plus-/Minus-Zeichen am rechten Rand.
- Der Pfeil dreht sich passend zum Zustand, die untergeordneten Filialen bleiben sauber eingerückt und der Schalter ist auch per Tastatur zugänglich.

## v0.51 Beta

- Öffnungszeiten, Mittagspausen und Mindestbesetzungen in die jeweilige Standortverwaltung verschoben und bestehende Werte je Filiale sicher übernommen.
- Rollenbereiche ergänzt: Admin und Personalleitung arbeiten global, Filialleitungen sehen zugewiesene Filialen und Abteilungsleitungen nur zugewiesene Abteilungen.
- Navigation kompakter, scrollbar und mit ein-/ausklappbaren Filialunterpunkten gestaltet; „Personalverwaltung“ heißt nun „Teams & Standorte“.
- Branding-ZIP-Import im geschützten LAN-Betrieb repariert und alle Überschriften mit zuverlässiger lokaler Sans-Serif-Darstellung versehen.
- ZA-Anträge unterstützen stundenweise, ganztägige und mehrtägige Zeiträume, Bearbeitung vor der Entscheidung sowie Änderungs- und Stornoanträge für genehmigte zukünftige ZAs.
- Bereichsprüfungen schützen Dienstpläne, Antragssperren und Urlaubsplanung vor Zugriffen außerhalb zugewiesener Filialen und Abteilungen; die Mitarbeiteransicht des Archivs ist auf sechs Monate begrenzt.
- Urlaubsanträge können vor der Entscheidung geändert werden; „Meine Anträge“ trennt ZA und Urlaub übersichtlich.
- Offene ZA-Anträge erscheinen als unverbindlicher Hinweis im Dienstplan; Arbeitsunfähigkeitsmeldungen werden in der Oberfläche korrekt als AUM bezeichnet.

## v0.50 Beta

- Mitarbeiterportal für Smartphones überarbeitet: kompakte Navigation, sichere Bildschirmränder, größere Touch-Ziele und besser bedienbare Dialoge.
- Persönlichen Bereich „Meine Anträge“ ergänzt: Urlaub, ZA, Änderungen und Stornierungen bleiben mit Status, Freigaben, Bemerkungen und Entscheidungschronik dauerhaft nachvollziehbar.
- Zurückgezogene Anträge werden nicht mehr gelöscht, sondern als „Zurückgezogen“ protokolliert; überlappende Anträge werden in allen Freigabestufen zuverlässig erkannt.
- Interne Benachrichtigungen mit Ungelesen-Zähler ergänzt: neue Anträge, Weiterleitungen und Entscheidungen erscheinen bei den zuständigen Personen beziehungsweise Antragstellenden.
- Arbeitsunfähigkeitsmeldungen (AUM) können im Mitarbeiterportal als PDF, JPG oder PNG mit bis zu drei Dokumenten hochgeladen und vor der Prüfung wieder zurückgezogen werden.
- AUM-Dateien sowie Bemerkungen und Originaldateinamen liegen ausschließlich im geschützten Bereich, werden per AES-256-GCM verschlüsselt, anhand ihrer Dateisignatur geprüft und niemals über den öffentlichen Webordner ausgeliefert.
- Ein dauerhafter Schlüsselprüfwert verhindert unbemerkte Schlüsselwechsel; abgebrochene Klartext-Uploads werden beim nächsten Start aus dem privaten Temporärordner entfernt.
- Eigene AUM-Rechte für Mitarbeitende, Filial-/Abteilungsleitung, Personalleitung und Admin ergänzt; Dokumentinhalte bleiben Personalleitung und Admin vorbehalten.
- Datenbank-Backups sichern nun auch die verschlüsselten AUM-Dateien als fest gekoppelten Sicherungspunkt mit Manifest, Datenbank-Hash und Prüfsummen; HEIC bleibt bis zu einer sicheren Normalisierung bewusst deaktiviert.
- Firmenserver-Pilotpaket ergänzt: neutrale WinSW-/Caddy-Vorlagen, PowerShell-Installation, Diagnose, Backup und sichere Offline-Wiederherstellung.
- Serverbetrieb gehärtet: beschreibbare Daten liegen getrennt vom Programm, Instanzschutz greift vor Migrationen, vor Migrationen und beim Dienststopp werden verifizierte Backups erstellt, und Browser-„Beenden“ ist im Dienstbetrieb gesperrt.
- Serverdiagnose um Pilot-Checkliste, Daten-/Backupziel, freien Speicher, Backupalter, Virenscanner-Bereitschaft und geschützten AUM-Speicher erweitert.

## v0.49 Beta

- Technischen HTTPS-Serverbetrieb ergänzt, der ausschließlich über geschützte Servervariablen und nicht über das Browser-Frontend aktiviert wird.
- Betrieb hinter einem Reverse-Proxy vorbereitet: Proxy-Vertrauen, öffentliche HTTPS-Adresse, sichere Cookies, HSTS, Sicherheitsheader und Herkunftsprüfung werden im Servermodus erzwungen.
- Unterschiedliche Passwortregeln nach Betriebsmodus: Lokal und LAN bleiben bei mindestens 6 Zeichen, im Serverbetrieb gelten für neu gesetzte Passwörter mindestens 10 Zeichen.
- Zusätzliche IP-basierte Login-Drosselung sowie Admin-Funktion zum Entsperren blockierter Zugänge ergänzt.
- SQLite für den zentralen Mehrbenutzerbetrieb gehärtet: WAL, Fremdschlüssel, fünf Sekunden Schreibwartezeit und automatische Checkpoints.
- Datenbank-Integritätsprüfung und versionierte Migrationsmarkierung beim Start ergänzt.
- Schutz vor einer zweiten Grabenplaner-Instanz auf derselben SQLite-Datei ergänzt.
- Backups werden nach der Erstellung automatisch mit SQLite `quick_check` überprüft.
- Neue Server- und Datenbankdiagnose für Admins mit Betriebsbereitschaft, HTTPS, Migration, Sitzungen, Instanzschutz und Backupstatus.
- Im Serverbetrieb werden automatische App-Updates, PowerShell-Neustarts und Datenbankimporte aus dem Browser gesperrt und kontrollierten Wartungsfenstern überlassen.
- Neutrale technische Anleitung `SERVERBETRIEB.md` für die spätere Einrichtung mit Firmen-IT ergänzt.

## v0.48 Beta

- Eigener Menüpunkt „Anträge“ ergänzt: offene Urlaub- und ZA-Anträge werden getrennt dargestellt und bei Handlungsbedarf in der Navigation hervorgehoben.
- Anträge bleiben nach der Entscheidung als nachvollziehbare Historie sichtbar; Status, Entscheidungsbemerkungen und die Personalnummern der freigebenden Personen werden angezeigt.
- Zweistufiger Urlaubsworkflow ergänzt: Filial- oder vertretende Abteilungsleitung prüft zuerst, anschließend kann eine globale Freigabe durch die Personalleitung verlangt werden.
- Neue feste Rolle „Personalleitung“ sowie zeitlich begrenzte Vertretungen der Filialleitung ergänzt.
- ZA-Anträge unterscheiden zwischen filialinterner Freigabe und verbindlichem ZA mit zusätzlicher Freigabe durch die Personalleitung.
- Entscheidungsdialog für Ablehnen, vorläufiges Genehmigen, Genehmigen, nachträgliches Bearbeiten und Stornieren ergänzt.
- Uhrzeiten für ZA-Anträge werden in 15-Minuten-Schritten ausschließlich innerhalb der hinterlegten Öffnungs- und Dienstzeiten angeboten.
- Antragssperren werden kompakt angezeigt; das Eingabeformular öffnet sich erst über „Neue Antragssperre“.
- Neue „Bearbeitungssperre für Dienstpläne“: Die aktuelle Woche kann automatisch nach der letzten hinterlegten Schließzeit oder manuell zwischen Freitag 18:00 Uhr und Sonntag 23:00 Uhr gesperrt werden.
- Geräteerkennung vorbereitet: Das Mitarbeiterportal ist mobil optimiert; die Verwaltungsplanung weist auf kleinen Bildschirmen auf die empfohlene Desktop-Nutzung hin.
- Abgelaufene Sitzungen führen wieder zuverlässig zum Login, ohne dass die App in einem nicht bedienbaren Zustand bleibt.

## v0.47 Beta

- Mitarbeiterportal um „Zeitausgleich beantragen“ erweitert: ZA kann für einen einzelnen Tag minutengenau mit Von-/Bis-Zeit und optionaler Bemerkung beantragt werden.
- Ampelprüfung ergänzt: Grün bestätigt die aktuelle Planbarkeit, Gelb kennzeichnet die notwendige manuelle Prüfung und Rot erklärt unmittelbar, weshalb ein Antrag derzeit nicht möglich ist.
- Bei genehmigtem stundenweisen ZA wird der bestehende Dienst automatisch geteilt und der ZA als eigener Sonderfall eingetragen.
- „Genehmigter Urlaub“ im Mitarbeiterportal ergänzt; Änderungen und Stornierungen können zur Freigabe eingereicht werden.
- Filialleitung und Admin prüfen Urlaub, ZA, Urlaubsänderungen und Stornierungen gemeinsam in einer übersichtlichen Antragsliste.
- Antragssperren je Filiale oder Abteilung ergänzt; Urlaub und ZA können getrennt oder gemeinsam für einzelne Tage oder Zeiträume gesperrt werden.
- Branding wird nun bereits auf den Loginseiten der Administration und des Mitarbeiterportals angewendet, einschließlich Logo und Webicon.
- Passwörter können in allen Login-, Einrichtungs- und Änderungsfeldern eingeblendet werden; mindestens 6 Zeichen und reine Zahlenpasswörter sind möglich, ein stärkeres Passwort wird empfohlen.
- Darstellung der leeren Antragsliste korrigiert; der Hinweistext wird nicht mehr am Kartenrand abgeschnitten.

## v0.46 Beta

- Optionaler LAN-Host-Modus: Eine zentrale Grabenplaner-Installation kann im vertrauenswürdigen internen Firmennetz von weiteren PCs per Browser verwendet werden; die SQLite-Datenbank bleibt ausschließlich am Host-PC.
- Admin-Ersteinrichtung direkt am Host-PC sowie Anmeldung mit Personalnummer und Passwort ergänzt.
- Rollen und Berechtigungen aktiviert: Mitarbeiter, Filialleitung und Admin erhalten getrennte Zugriffe; sicherheitskritische Einstellungen bleiben Admins vorbehalten.
- Portal-Zugänge je Teammitglied mit Rolle, Aktivstatus und einmaligem Startpasswort verwaltbar.
- Mitarbeiterportal mit „Mein Dienstplan“, Wochenwechsel und persönlichen Sonderfällen ergänzt.
- Urlaubsanträge können von Mitarbeitenden gestellt und offene Anträge wieder zurückgezogen werden.
- Filialleitung und Admin können Anträge genehmigen oder ablehnen; genehmigter Urlaub wird automatisch in Urlaubs- und Wochenplanung übernommen.
- Sicherheit: scrypt-Passwort-Hashes, zeitlich begrenzte Sitzungen, HttpOnly-/SameSite-Cookies, CSRF-Schutz, Kontosperre nach Fehlversuchen, Sicherheitsheader und Audit-Log aktiviert.
- Betriebsmoduswechsel führt über Backup und sicheren PowerShell-Neustart; Branding, Updates und Datenbank bleiben zentral am Host-PC.
- Nach einem Datenbankimport startet Grabenplaner vorsorglich wieder im Lokalbetrieb; der LAN-Host kann anschließend bewusst erneut aktiviert werden.
- Der bisherige lokale SQLite-/USB-Betrieb bleibt unverändert Standard und benötigt weiterhin keine Anmeldung.

## v0.45 Beta

- Server-Fundament ergänzt: Der Betriebsmodus ist in den Grundeinstellungen sichtbar und bleibt standardmäßig sicher auf „Lokalbetrieb“.
- Versionierte Portal-API v1 mit Status-, Rollen- und Session-Vertrag vorbereitet; Anmeldung, Mitarbeiterportal, Urlaubsanträge und Zeiterfassung bleiben noch inaktiv.
- Rollenmodell erweitert: Built-in-Rollen und Berechtigungen werden bei Updates sauber aktualisiert, selbst angelegte Rollen bleiben erhalten.
- Datenbank für sichere Sitzungen, fehlgeschlagene Anmeldeversuche und spätere Admin-Ersteinrichtung vorbereitet.
- Passwort-Hashing mit Node.js-scrypt und versioniertem Hashformat technisch vorbereitet.
- Der lokale Webserver bindet ausschließlich an `127.0.0.1`; externe Netzwerkbindungen bleiben bis zum abgesicherten Servermodus blockiert.
- Automatisierte Tests für frische/ältere Datenbankstände, Portal-Sperren, Rollen, lokale API und Passwort-Hashes ergänzt.

## v0.44 Beta

- Lizenz ergänzt: Grabenplaner ist source-available; kommerzielle Nutzung erfordert vorherige schriftliche Genehmigung.
- Vorbereitung für späteren Servermodus, Mitarbeiterportal und Zeiterfassung: interne Tabellen, Rollen und Einstellungen sind angelegt, bleiben im lokalen Betrieb aber inaktiv.
- Branding: Webicon/Favicon ist Teil des Branding-Systems; die neutrale Grundauslieferung nutzt ein neutrales Icon.
- Branding-Kits werden lokal gespeichert und können in den Einstellungen wie Themes mit Vorschau erneut angewendet werden.
- Backup-Import bietet eine Auswahl zwischen vollständigem Import und Import mit aktuellem Branding; „aktuelles Branding behalten“ ist vorausgewählt.
- Abteilungs-PDFs verwenden standardmäßig „Abteilungsplan …“ statt „Dienstplan …“.
- README mit Lizenzhinweis und kurzer Notiz „Servermodus in Vorbereitung“ ergänzt.

## v0.43.3 Beta

- Branding-Kits können jetzt als komplette ZIP-Datei mit JSON und Logo-Assets importiert/exportiert werden; ältere JSON-Kits bleiben importierbar.
- Release kann zusätzlich ein externes Branding-Kit als separates ZIP-Asset verwenden.
- Dienstplanung: Der variable Wochenzeitraum steht als eigene Karte in der Kennzahlenzeile; die obere Toolbar bleibt dadurch stabiler sticky.
- Datenbank-Import startet die App nach sicherem Austausch der Datenbank automatisch per PowerShell neu.
- Seitenmenü: „Aktive Teammitglieder“ steht jetzt über dem Systembereich mit Aktualisierung und Beenden.
- Urlaubs-PDF: Teamübersicht zeigt keinen vorgeschalteten Block „Resturlaub je Teammitglied“ mehr.
- Urlaubs-PDF: Feiertage werden je nach Ansicht beschriftet: Monat mit vollem Namen, Quartal mit „Feiertag“, Jahr mit „FT“.

## v0.43.2 Beta

- Branding: App-Name ist fest `Grabenplaner` und kann in den Einstellungen oder per Branding-Kit nicht mehr geändert werden.
- Branding: Hinweistext zur neutralen GitHub-Version aus dem Einstellungsbereich entfernt.
- Hotfix: Urlaubs-PDF-Erstellung repariert (`plan is not defined` im PDF-Footer).
- Update-/Start-Cleanup: Installierte App-Ordner räumen alte Versionsstarter und nicht benötigte Root-Dateien nach Updates auf; Hinweise werden in den Ordner `docs` verschoben.

## v0.43.1 Beta

- Frontend: Fester Developer-Kontakt `christian.seiwald.at@gmail.com` links unten direkt unter dem Aktualisierungsbutton ergänzt.

## v0.43 Beta

- Öffentliche GitHub-Version neutralisiert: fest eingebautes Firmenlogo und feste Admin-Mail entfernt.
- Start-Cleanup entfernt in bestehenden Installationen alte, nicht mehr verwendete Firmenlogo-Reste aus `public/assets`.
- Neues Branding-System ergänzt: App-Name, Firma, Logo-Pfad, Logo-Alternativtext und Admin-E-Mail sind in den Einstellungen pflegbar.
- Branding-Kits können als JSON exportiert und importiert werden; PDF-Titel und Dateinamen werden dabei mit übernommen.
- README gekürzt und mit neutralem Key-Features-Abschnitt für GitHub überarbeitet.
- Standarddaten für neue Installationen neutralisiert: Hauptstandort statt firmenspezifischem Standortnamen.

## v0.42.9 Beta

- Hotfix: Portable ZIP wieder mit vollständigen PDFKit-Schriftdaten gebaut. Dadurch funktioniert die Dienstplan-/Urlaubs-PDF-Erstellung wieder.
- Release-Bau korrigiert: Die echte App-Datenbank und Backups bleiben weiterhin draußen, interne Paketordner wie `node_modules/pdfkit/js/data` werden aber nicht mehr versehentlich entfernt.

## v0.42.8 Beta

- Hotfix: Automatische Aktualisierung robuster gemacht. Der Updater startet nun entkoppelt über Windows, wartet kontrolliert auf das Beenden des Servers und schreibt ein dauerhaftes Protokoll nach `data/update-last.log`.
- Hotfix: Die GitHub CLI wird für den Updateprozess bevorzugt als absoluter Pfad gespeichert, damit der versteckte PowerShell-Updater nicht an einer fehlenden PATH-Auflösung hängen bleibt.
- Hotfix: Nach dem Kopieren der neuen Version wird die App über die passende Startdatei neu geöffnet; falls diese fehlt, wird auf `Dienstplan starten.cmd` zurückgefallen.

## v0.42.7 Beta

- Bemerkungseditor auf Quill umgestellt: schlichte WYSIWYG-Leiste für fett, kursiv, unterstrichen, Schriftgröße und Formatierung löschen.
- Oberes Menü in der Dienstplanung fixiert, damit die Wochen-Navigation beim Scrollen nicht mehr springt.
- Abteilungs-PDFs zeigen nun auch eingeteilte Mitarbeitende, wenn sie nicht als bevorzugte Abteilung im Stammdatensatz hinterlegt sind.

## v0.42.6 Beta

- Besondere Bemerkung: Editor-Formatierung repariert. Markierter Text wird nun direkt sichtbar fett, kursiv, unterstrichen oder klein/normal/groß formatiert.
- Linkes Menü: Aktualisierungscheck über GitHub ergänzt. Aktuelle Version wird grün markiert; verfügbare Updates werden gelb angezeigt.
- Aktualisierung: Wenn GitHub-Zugriff lokal möglich ist, kann die App ein Update starten und danach neu öffnen; Datenbank und Backups bleiben ausgeschlossen und erhalten.
- Dienstplanung: Linkes Menü zeigt wieder den Filial-Gesamtdienstplan statt eigener Abteilungs-Unterpunkte.
- Dienstplanung: Dienste können einer Abteilung zugeordnet werden und zeigen die Abteilung direkt im Dienstbalken bzw. in der PDF.
- PDF-Ausgabe: Abteilungsdienstpläne können weiterhin separat über eine Abteilungs-PDF-Auswahl im Filial-Gesamtplan erstellt werden.

## v0.42.5 Beta

- Dienstplan-PDF: Emojis/Smileys werden in der besonderen Bemerkung entfernt, damit keine schweren Emoji-Schriften eingebettet werden müssen und die PDF schlank bleibt.
- Besondere Bemerkung: Die bisherige globale Schriftgrößen-Auswahl wurde durch einen einfachen Editor mit Fett, Kursiv, Unterstrichen sowie Klein/Normal/Groß für markierte Textstellen ersetzt.
- Wochenstunden je Teammitglied: Optionale Samstagsdienst-Statistik ergänzt. Gezählt wird ein Samstag, sobald ein Teammitglied samstags mindestens 2 Stunden eingeteilt ist.
- Samstagsstatistik: Anzeige für letzte 4 Wochen und letzte 3 Monate; bei unvollständiger Historie werden Werte hochgerechnet und mit `*` grau markiert.
- Einstellungen > Personal: Schalter für die Samstagsstatistik ergänzt und Layout auf zwei Spalten umgestellt.
- Dienstplanung: Vertikalen Innen-Scrollbalken in der Wochenplan-Tabelle entfernt.

## v0.42.4 Beta

- Hotfix: PDF-Erstellung repariert. Die für PDFKit benötigten Standard-Schriftdaten werden wieder vollständig in der portablen Version mit ausgeliefert.
- Hotfix: UTF-8-Textfehler in neuen Positions-/Mindestbesetzungsbereichen und zugehörigen Fehlermeldungen korrigiert.
- Hotfix: USB-Hauptordner-Startdateien korrigiert. Der Start vom Stick wechselt nun sauber in den `app`-Ordner, statt im USB-Hauptordner nach `runtime` und `node_modules` zu suchen.

## v0.42.3 Beta

- Darkmode vollständig entfernt; die Oberfläche entspricht wieder dem hellen Layout aus v0.42.1.
- System: Button heißt jetzt „Beenden“ und stoppt den lokalen Webserver sicher mit Shutdown-Backup. Das USB-Auswerfen bleibt bewusst bei Windows bzw. dem Nutzer.
- Personalverwaltung: Position je Teammitglied ergänzt.
- Einstellungen > Personal: Eigener Bereich für Positionen ergänzt. Die vier Standardpositionen Teamleitung, Abteilungsleitung, Verkaufsmitarbeiter und Lehrling sind fix; eigene Positionen können hinzugefügt, bearbeitet und gelöscht werden.
- Einstellungen > Personal: „Inaktive Teammitglieder anzeigen“ aus den Grundeinstellungen hierher verschoben.
- Standortverwaltung: Mindestbesetzung je Filiale und je Abteilung ergänzt.
- Automatische Planung: Die wirksame Mindestbesetzung berücksichtigt jetzt neben dem Tageswert auch Filial- und Abteilungs-Mindestwerte.

## v0.42.2 Beta

- Linkes Menü: Darkmode-Schalter ergänzt; Darkmode ist standardmäßig aktiv und wird gespeichert.
- System: Neuer Button „Beenden & USB auswerfen“ mit Sicherheitsabfrage, sauberem Server-Stopp, Shutdown-Backup und verzögertem Windows-Auswurfversuch nach Prozessende.
- Lokale Entwicklungsbasis für GitHub/Release vorbereitet: Quellcode ohne echte Arbeitsdatenbank, portable ZIP separat als Release-Artefakt.

## v0.42.1 Beta

- Datenbank-Einstellungen: Beim Start wird immer ein internes Backup im App-Backupordner erstellt; zusätzlich bleibt die lokale PC-Sicherung in `Dokumente\grabenplaner-backups` standardmäßig aktiv und kann deaktiviert oder umgestellt werden.
- Backup-Intervall gilt für die zusätzliche lokale PC-Sicherung; manuelle Backups erstellen interne und, falls aktiv, lokale PC-Kopien.
- Urlaubs-PDFs zeigen gesetzliche Feiertage inklusive Tirol-Ergänzung, z. B. Hl. Josef und Hoher Frauentag.
- Feiertagsstunden zählen in der Dienstplanung nur, wenn der Feiertag auf Montag bis Freitag fällt.
- Urlaubs-PDF-Resturlaub wurde optisch als Teamkarten mit ausgeschriebenen Tagen und Wochen-Umrechnung überarbeitet.
- PDF-Einstellungen für Dienstplan-Titel und Dateiname sind jetzt je Filiale und Abteilung getrennt; Urlaubs-PDF-Einstellungen je Filiale.
- Dienstplan-PDF: Besondere Wochenbemerkung als gelbliches Feld ergänzbar, mit Schriftgröße und Formatierung.
- Dienstplanung: Button „Bemerkung“ zwischen „Zurücksetzen“ und „PDF exportieren“ mit anzeigen/bearbeiten/löschen.
- Leere USB-Zweitkopie wird nicht mehr automatisch mit aktualisiert.

## v0.42 Beta

- Warn-/Fehlermeldungen werden auch bei geöffneten Dialogen lesbar rechts unten angezeigt.
- Anzeigedauer für Hinweise einstellbar: kurz 5 Sekunden, mittel 10 Sekunden, lang 15 Sekunden.
- Dienstplanung: Gesetzliche Feiertage werden automatisch mit Wochen-Soll ÷ 5 gutgeschrieben; dadurch ergeben Mo–Fr-Urlaubswochen mit Feiertag wieder 0 Differenz.
- PDF-Einstellungen: statische Layoutvorschau entfernt und durch echte PDF-Vorschau auf Klick ersetzt.
- Urlaubsplanung: Jahresurlaub je Teammitglied wird nach dem Speichern kompakt angezeigt und erst über „Jahresurlaub bearbeiten“ wieder editierbar.
- Urlaubsplanung-PDF: Jahresübersicht zeigt gleichzeitige Urlaube zuverlässiger durch dynamisch komprimierte Farblinien.
- Neuer Hauptpunkt „Personalverwaltung“ mit Team- und Standortverwaltung.
- Standortverwaltung: Filialen mit zweistelliger Filial-ID und bis zu 3 Abteilungen je Filiale.
- Personalstammdaten: Stammfiliale und bevorzugte Abteilung je Teammitglied ergänzt.
- Dienstplanung kann bei mehreren Abteilungen als Unterpunkt je Abteilung geführt werden; Urlaubsplanung bleibt pro Filiale.

## v0.41 Beta

- Dienstplanung: Vergangene Kalenderwochen sind standardmäßig schreibgeschützt; Bearbeitung kann in den Grundeinstellungen aktiviert werden.
- Planungsoptionen: Ganze Tage können für alle gesperrt werden, optional mit Feiertagswertung und Stundenanrechnung Wochen-Soll ÷ 5.
- Österreichische gesetzliche Feiertage werden bei der Urlaubsberechnung automatisch nicht als Urlaubstag gezählt.
- Urlaubs-PDFs sind einheitlich A4 Querformat; A3-Auswahl entfernt.
- Urlaubs-PDF-Kalender zeigen standardmäßig durchgezogene Urlaubslinien; Einzelpunkt-Darstellung bleibt als Option erhalten.
- PDF-Einstellungen erhalten einfache Layoutvorschauen für Dienstplan und Urlaubsplanung.
- Teamübersicht im Urlaubsplaner/PDF überarbeitet: bessere Boxen, vollständige Urlaubsliste und ausgeschriebener Resturlaub.
- Webicon/Favicon wird nochmals randlos geprüft und neu erzeugt.

## v0.40 Beta

- Urlaubs-PDFs erhalten Kalenderansichten für Jahr, Quartal und Monat.
- Urlaubs-PDF-Resturlaubsblock wird konfigurierbar: ausblendbar sowie mit optionalem Jahresurlaub, geplantem Urlaub und konsumiertem Urlaub.
- Urlaubsplanung erhält die Ansicht „Teamübersicht“ mit Urlauben je Teammitglied und eigenem PDF-Export.
- Bereits eingetragene Urlaube können bearbeitet oder gelöscht werden.
- Planungsoptionen-Dialog kann direkt zwischen Kalenderwochen wechseln; Datumsauswahl ist auf die gewählte KW begrenzt.
- Webicon/Favicon wird randlos neu erzeugt.

## v0.39 Beta

- Planungsoptionen können nachträglich bearbeitet werden.
- Urlaubsplanung erhält eine Kalenderansicht mit Kalenderwochen, Wochentagen und Datum.
- Urlaubs-PDF ohne technischen Hinweis zur Samstagszählung.
- PDF-Ausgabe für Urlaubsplanung mit eigenem Titel, Dateiname, Zeitraum-/Zeitstempel-Option und A4/A3-Zielgröße.
- Navigation: „Wochenplanung“ heißt jetzt „Dienstplanung“.
- Grundeinstellungen layouttechnisch aufgeräumt: kompakte Karten in zwei Spalten, Dienstzeiten über volle Breite.

## v0.38 Beta

- Urlaubsplanung mit Jahres-, Quartals- und Monatsübersicht ergänzt.
- Jahresurlaub per 1.1. je Teammitglied, Resturlaub und PDF-Export eingeführt.
- Samstag zählt standardmäßig nicht als Urlaubstag, kann aber optional aktiviert werden.
- USB-Struktur auf Hauptordner `Grabenplaner` mit App-Unterordner umgestellt.

## v0.37 Beta

- Schulungen, Zeitausgleich, Außer-Haus-Termine und Teamsitzungen zeitlich erfassbar.
- Backup-Einstellungen mit wählbarem Ordner, Intervall und Import alter Backups.
- Geschlechtsneutrale Formulierungen im WebUI weitergezogen.
- Bemerkungen/Sonderfälle in der Dienstplan-PDF in drei Spalten gegliedert.

## v0.35 Beta

- Appname „Grabenplaner“ eingeführt.
- Datumsauswahl zum Springen in Kalenderwochen ergänzt.
- PDF-Dateiname für Dienstplan anpassbar gemacht.
- Fixe dienstvertragliche Arbeitstage je Teammitglied ergänzt.

## v0.31 Beta

- Beta-Hinweis und Versionierung in der PDF eingeführt.
- Sonderfälle in der Dienstplan-PDF grau diagonal schraffiert dargestellt.
- Dienstplan-PDF optisch näher an das gewünschte Layout angepasst.
