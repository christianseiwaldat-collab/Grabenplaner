# Grabenplaner Versions-Log

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
- Update-/Release-Ablauf angepasst: Der USB-Stick wird nicht mehr direkt aktualisiert; Updates sollen über die App getestet werden.

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
- USB-Dauerregel ergänzt: Nach dem regulären USB-Update wird zusätzlich eine zweite Kopie mit leerer Datenbank im jeweiligen Versionsordner gepflegt.

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
