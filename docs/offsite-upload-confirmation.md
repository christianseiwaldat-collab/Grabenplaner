# Begrenzte Offsite-Bestaetigung und privater Fehlernachweis

## Anlass und Verhalten

Beim untersuchten Nachtlauf war der hochgeladene Snapshot spaeter vorhanden und
wiederherstellbar. Der urspruengliche Fehler bei seiner unmittelbaren Bestaetigung
war nach dem Aufraeumen nicht mehr rekonstruierbar. Eine voruebergehende
Provider-/Verbindungsstoerung ist deshalb eine moegliche, keine bewiesene Ursache.

Der Upload fuehrt weiterhin **genau ein Backup** aus. Anschliessend darf nur die
Bestaetigung **derselben vollstaendigen 64-stelligen Snapshot-ID** bis zu dreimal
laufen. Jeder Versuch hat ein externes Zeitlimit von 120 Sekunden; nach einem
voruebergehenden Fehler wird 5 beziehungsweise 15 Sekunden gewartet. Es gibt kein
erneutes Backup, keinen Ersatz durch den letzten Snapshot und keine Erfolgsmeldung
vor den bisherigen Repository-, Aufbewahrungs- und Abschlusspruefungen.

Wiederholt werden nur begrenzte Transport-/Providerstoerungen oder eine vorerst
leere Snapshot-Antwort. Falsche ID, Host, Pfad oder Tags, mehrdeutige/ungueltige
Antworten, Berechtigungs-/Passwortprobleme und Integritaetsfehler bleiben Fehler.
Unbekannte Fehler werden nicht pauschal als voruebergehend eingestuft.

## Private Diagnose und Aufbewahrung

Bei Fehlern bleibt ein strukturierter Nachweis unter
`/var/lib/grabenplaner-offsite/upload-failures/` erhalten. Verzeichnis: root:root
0700; Dateien: root:root 0600. Es werden ausschliesslich fest freigegebene
Diagnosedateien des aktuellen Uploadvorgangs aufgenommen. Konfigurationen,
Passwortdateien und andere Dateien werden nicht kopiert. Zeilen mit
Zugangsdatenkennzeichen sowie URL-Benutzerdaten werden vor dem Schreiben entfernt.
Die Oberflaeche und das normale Journal behalten feste, bereinigte Fehlermeldungen.

Erfasst werden die fehlgeschlagene Phase, Fehlerkennung, Exitstatus, erwartete
Snapshot-ID und Versuchszahl. Fuer Bestaetigungsversuche werden zusaetzlich Dauer,
Subprozess-Exitstatus und begrenzte bereinigte Antworten gespeichert. Ein
Fehlernachweis nimmt hoechstens 2 MiB Quelldiagnose auf, je Datei hoechstens
256 KiB. Uebergrosse Inhalte werden gekennzeichnet; ihre Hashwerte dienen dem
Abgleich. Die temporaeren Upload-/Credentialdateien werden weiterhin entfernt.

Es bleiben hoechstens 20 eigene gueltige Nachweise fuer hoechstens 30 Tage; die
Bereinigung laeuft bei fehlgeschlagenen **und erfolgreichen** Uploads. Der neue
Fehlernachweis wird erhalten. Fremde, verlinkte oder ungueltige Dateien werden
nicht durch einen breiten Loeschbefehl entfernt. Kann die Diagnose nicht sicher
geschrieben werden, bleibt der urspruengliche Uploadfehler bestehen.

## Bewusster Modul13-zu-Modul13-Uebergang

Das verwaltete Offsite-Artefaktset, Schema, Providerbindung, signierte
Assurancehistorie und Statusformat bleiben unveraendert. Nur
`grabenplaner-offsite-upload.sh` aendert sich. Deshalb bleibt die Modulversion 13;
der Fingerprint aendert sich trotzdem. Der allgemeine Updater lehnt diese
Aenderung unveraendert mit `migration-required:13->13` ab.

Der eigene Einstieg `server-tools/linux/refresh-grabenplaner-offsite-upload.sh`
ist fuer genau diesen einmaligen Uebergang zustaendig. Er akzeptiert nur den
geprueften Modul13-Vorgaenger mit Fingerprint
`7e7b9c89ec334c00b247db7325e5c32df487ee6af9ede21b1f8587e0416660bf`,
Schema-SHA256
`a4c7c29593ec2751139761bce2cb644377c07714c968e460d98f2b41a99274f9`
und altem Upload-SHA256
`82a631ad95b83b339bb4139b3730258ed1227fd977a51bb56966a5785089a8e8`.
Jede weitere Artefakt-/Schemaaenderung wird abgelehnt. Aeltere Installationen mit
Modul12 muessen zuerst den unveraendert geprueften historischen Schritt auf den
urspruenglichen Modul13-Stand (.100) durchlaufen. Erst danach folgt dieser eigene
13-zu-13-Refresh. Der eingefrorene 12-zu-13-Helper akzeptiert das neue Uploadskript
bewusst nicht als zusaetzliche ungepruefte Aenderung. Es gibt keine allgemeine
Ausnahme fuer gleiche Modulversionen und keine direkte Bearbeitung von
Status-/Historienbindungen.

Die Reihenfolge fuer eine spaeter ausdruecklich freigegebene Auslieferung ist:

1. Das offizielle ZIP und seinen unabhaengig freigegebenen SHA256 bereitstellen.
   Das ZIP isoliert als Build-Benutzer entpacken und mit der bestehenden
   Sicherheitsbasis in einen frischen root-eigenen Baum versiegeln. Kein
   Extrahieren als root, keine nutzerbeschreibbaren Elternverzeichnisse.
2. Den root-geschuetzten Einstieg mit `--package`, `--sha256`,
   `--candidate-root` und gegebenenfalls `--node`/`--pnpm` aufrufen. Er prueft
   bytegleiche ZIP-/Quellbaumbindung, eigene Einstiegs-/Helperbytes,
   ClamAV, Paketmanifest, Core6/Modul13 und den gruenen read-only Vorabcheck.
3. Unter Wartungssperre FD9 werden die urspruenglichen vier Offsite-Timerzustaende
   privat festgehalten und die Timer pausiert. Die tatsaechlichen Assurance- und
   Repository-Sperren werden ohne Warten erworben. Ein laufender Vorgang ist ein
   Abbruchgrund.
4. Der Helper prueft alle alten Artefakte vor Ausfuehrung des alten Verifiers.
   Nur Uploadskript und providergebundener Installationsbeleg werden mit
   Write-ahead-Journal, privaten Rueckkehrkopien, atomaren Einzel-Renames und
   fsync uebernommen. Die gemeinsame Sperre schuetzt den kurzen Zwischenzustand.
5. Nach exakt passender externer Modulbindung laeuft der **unveraenderte
   installierte Core6-App-Updater** mit `--verification auto` und uebernommener
   FD9. Er bestimmt und prueft den normalen kurzen oder vollstaendigen Pfad.
6. Erfolg verlangt den exakten neuen Appmanifest-Hash, passende Modulbindung,
   erfolgreichen Updaterabschluss und gueltigen Laufzeitvertrag. Erst dann werden
   die urspruenglichen Timerzustaende wiederhergestellt. Der normale
   nachgelagerte Assuranceabschluss bleibt ein eigener Nachweis.

## Fehler, Unterbrechung und Rueckkehr

Die private Transaktion liegt neben dem externen Modul in
`/opt/grabenplaner-offsite/.offsite-upload-refresh-UUID` (0700, Dateien 0600).
Sie enthaelt Skript-/Belegkopien, Hashwerte und die Timerzustaende, keine
Providerzugangsdaten oder Datenbanken. Sie bleibt als kleiner Rueckkehrnachweis
erhalten; ihre Entfernung gehoert erst zum abgeschlossenen Release-Cleanup.

Bei einem normalen Fehler wird nur dann exakt zum alten Skript und alten
Installationsbeleg zurueckgekehrt, wenn das Appmanifest nachweislich noch exakt
das alte ist. Ein bereits neuer oder unbekannter Appstand erhaelt keinen
vermuteten Teilrollback. Unbekannte Dateibytes oder beschaedigte Rueckkehrkopien
fuehren ebenfalls zum Abbruch mit erhaltenen Nachweisen und pausierten Timern.

Nach TERM/INT/SIGKILL bleibt die Transaktion zur ausdruecklichen Wiederaufnahme
erhalten. Derselbe root-geschuetzte Einstieg kann mit
`--recover /opt/grabenplaner-offsite/.offsite-upload-refresh-UUID` den genauen
Stand abgleichen: alter Appstand = exakte Rueckkehr; neuer Appstand = exakte
Bestaetigung. Auch ein schon bestaetigter Commit ist erneut pruefbar, falls erst
das Wiederherstellen eines Timers scheiterte. Vor der Timerfreigabe werden
Laufzeitvertrag sowie interne und oeffentliche Bereitschaft geprueft.

## Qualifikation und Grenze der Aussage

`test/offsite-upload-confirmation.test.js` simuliert unter anderem
Transportfehler, voruebergehende Abwesenheit, permanente Identitaetsabweichung,
Diagnosebereinigung und Aufbewahrungsgrenzen. Die echten Linux-root-Faelle nutzen
GNU timeout/Bash/Node mit synthetischem Transport, keine Cloudzugangsdaten.

`test/offsite-upload-hardening-transition.test.js` prueft den unveraenderten
allgemeinen Fingerprint-Gate, privaten exakten Modul-/Belegtausch,
Provider-/Statuskontinuitaet, echte SIGKILL-Unterbrechung nach dem ersten Rename,
I/O-Fehler, Wiederaufnahme, bereits uebernommene/unbekannte Appstaende,
Dateimanipulation, Pfad-/Rechte-/Linkschutz sowie die CLI-Aktionsgrenzen.
Die originale installierte .100-Gate-/Verifierversion wird zusaetzlich im
isolierten Linux-Abbild vor/nach Refresh und Rueckkehr ausgefuehrt.

Diese Quell- und Helperpruefungen ersetzen nicht die Qualifikation des spaeteren
offiziellen ZIPs samt altem/neuem App-Updater und Rueckkehr. Vor einer produktiven
Mutation muss auch das exakte freigegebene Paket in der isolierten Umgebung
qualifiziert sein. Ein gebautes/veroeffentlichtes Paket, ein VPS-Eingriff oder
eine erfolgreiche produktive Nachtpruefung wird durch diese lokalen Tests nicht
behauptet.
