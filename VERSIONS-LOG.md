# Grabenplaner Versions-Log

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
