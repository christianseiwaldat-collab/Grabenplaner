# Großdaten-Backup – Strategie und isolierter Nachweis

Stand: 06.09.2026, nach der ausdrücklichen Klarstellung: **tägliche Sicherungen mit 20 Kalendertagen Rückblick je lokalem Bereich**, ohne Speicherzukauf. Produktivsystem, vorhandene Sicherungen, Schlüssel und Zugänge sind unverändert. Kein Commit, Push, Deploy oder produktiver Datenimport in diesem Arbeitsschritt.

Die lokale Startprüfung besteht nach Speicherfreigabe durch den Nutzer. Neue Kompression, transaktionale Fortschrittszähler und Tagesaufbewahrung sind lokal umgesetzt. Der [Abschlussstand](ABSCHLUSS-VORBEREITUNG-2026-09-06.md) trennt die neuen Messungen von früheren Belegen. Die frühere Überlegung „älteste plus neueste 19 Punkte“ ist durch die klare 20-Tage-Vorgabe ersetzt. Die getrennte Langzeitaufbewahrung auf Google Drive bleibt bestehen.

Aktualisierung vom 07.09.2026: Die [Vollbestandsmessung mit lokalen Restores](VOLLBESTAND-BETRIEB-RESTORE-2026-09-07.md) ist inzwischen bestanden. Der neue [Arbeitskopien-Nachweis](ARBEITSKOPIEN-UND-QUELLSTAENDE-2026-09-07.md) beschreibt die folgende lokale Optimierung und die verbindliche Quellenregel. Ältere Messabschnitte unten bleiben historische Befunde. Drei lokale Sicherungen sind eine spätere noch nicht ausgeführte Variante; die Betriebskapazität ist weiterhin nicht freigegeben.

## Ergebnis und klare Grenzen

| Bestandteil | Stand |
| --- | --- |
| RAM-begrenzte Datei-Prüfsummen | Lokal implementiert, SHA-256 und bisherige Sicherungsmarker unverändert |
| Dokumentprüfung und Wiederherstellung | Metadatenprüfung ohne gleichzeitiges Halten aller Blob-Inhalte; Wiederherstellung prüft die tatsächlich kopierten Bytes |
| Offsite-Neustartprüfung | Lokal von 120 auf die vereinbarten 1.500 Sekunden korrigiert; installierter Helfer unverändert |
| Deduplizierte Ablage | Mit echten Restic-Sicherungen und vollständigen synthetischen Rücksicherungen erprobt |
| Aufbewahrung | Letzter vollständiger Stand je Wiener Kalendertag, 20 Tage einschließlich heute; mehrere Starts verbrauchen keinen zusätzlichen Tag. Der jüngste verfügbare Punkt bleibt immer erhalten. |
| Automatischer Archivbetrieb in GP und Linux-Helfern | Lokal hinter explizitem Opt-in eingebunden; **nicht produktiv aktiviert** |
| Archiv-Recovery und Export | Lokale Verwaltungs-CLI mit unabhängiger Rücksicherung und vorhandenen Schlüsselprüfungen; keine neue historische Download-Oberfläche |
| Nicht blockierende App-Sicherung | Gekoppelte Sicherung im begrenzten Kindprozess, seriell und mit gemeinsamer Deadline; Produktionslasttest offen |
| Dienst-Zeitvertrag | Lokale Templates Start/Stop 1.500 Sekunden; verwaltete Runtime-Migration vor Deploy noch erforderlich |
| Vollständiger TradeFoto-Bestand | Isoliert gemessen, einschließlich kompaktierter Datenbank, Archiv und unabhängiger Restores; Nachweis vom 07.09.2026 |
| Dauerhafte Betriebskapazität | **Noch nicht qualifiziert**; keine Hochrechnung synthetischer Einsparquoten als Freigabe |

Die vorangegangene [Betriebsvorprüfung](PRODUKTIV-BLOCK-4-BETRIEBSVORPRUEFUNG.md) bleibt als historischer Messstand erhalten. Die hier behobenen RAM-Stellen sind lokale Änderungen, keine Aussage über den bereits installierten VPS-Code.

## Zielaufbau: vollständige Punkte, gemeinsam gespeicherte Blöcke

Die beiden bisherigen lokalen Sicherungsbereiche bleiben fachlich getrennt. Jeder bekommt ein eigenes verschlüsseltes, dedupliziertes Repository. Die bis zu 20 Tagesstände werden nicht zu 20 täglichen Vollkopien derselben großen Datenbank. Jeder Punkt enthält dennoch einen vollständigen Dateibaum und kann anhand seiner festen Snapshot-ID direkt wiederhergestellt werden; es gibt keine selbst entwickelte Kette aus Basissicherung und nacheinander anzuwendenden SQL-Deltas.

Als Speicherschicht ist Restic vorgesehen, das im bestehenden Offsite-Konzept bereits eingesetzt wird. Es speichert wiederverwendbare Inhaltsblöcke in verschlüsselten Paketen. Snapshot-Identität, vollständige Dateireferenzen und die GP-Prüfungen bleiben zusätzlich maßgeblich. [Restic-Format](https://restic.readthedocs.io/en/stable/100_references.html), [Wiederherstellung](https://restic.readthedocs.io/en/stable/050_restore.html).

Die Offsite-Sicherung bleibt ein zusätzlicher, getrennter Schutz. Zwei lokale Repositorys auf derselben VPS-Platte schützen nicht vor deren vollständigem Ausfall. Es wird weder ein neuer Provider eingebunden noch ein bestehendes Offsite-Ziel geändert.

### Freigegebene tägliche Aufbewahrung

- Je Bereich **20 Kalendertage einschließlich heute**, höchstens ein vollständiger Stand je Tag. Fehlende Tage verlängern den Rückblick nicht. Gibt es nur ältere Sicherungen, bleibt der jüngste vollständige Stand erhalten.
- Maßgeblich ist das authentifizierte ursprüngliche Sicherungsdatum im GP-Commitmarker, nicht der spätere Zeitpunkt der Archivierung. Kalendertage werden in Europe/Vienna einschließlich Sommerzeitwechsel bestimmt.
- Die tägliche Routine wird auf 24 Stunden gesetzt; Start-, Stopp- und notwendige Wartungssicherungen dürfen zusätzliche Punkte erzeugen. Ältere vollständige Punkte desselben Tages werden erst nach erfolgreicher Verifikation ersetzt.
- Auswahl nur für die feste Installationskennung und den festen Bereich `app` beziehungsweise `external`.
- Gruppierung nach `host,tags`, nicht nach wechselnden datierten Dateipfaden. Andernfalls würde jeder Dateiname eine eigene Gruppe bilden.
- Die Vorschau muss exakt alle zuvor gelesenen Snapshot-IDs in behalten/entfernbar partitionieren. Doppelte, fremde, fehlende oder falsch gruppierte Punkte werden abgewiesen; der neueste Punkt muss erhalten bleiben.
- Die reine Planungsfunktion liefert nur eine Vorschau. Der ausdrücklich aktivierte Archiv-Core darf nach unabhängiger Rücksicherung genau die als redundant oder abgelaufen ausgewählten IDs entfernen. Authentifizierte Journale halten Regelversion und Planungsdatum fest; Wiederanlauf prüft dieselbe Auswahl. Alte 30-Punkte-Journale können weiterhin ohne zusätzliche Löschung abgeglichen werden. Nach `prune` müssen Datenprüfung und unabhängige Rücksicherung bestehen. Ohne diese Nachweise werden keine registrierten Rohkopien entfernt. Das wurde nur mit synthetischen Archiven ausgeführt.

### Inhalt eines freigegebenen Sicherungspunkts

Ein konsistenter, kompaktierter Datenbank-Snapshot, alle referenzierten geschützten Dokumente, das bestehende Dokumentmanifest und der Commitmarker gehören zusammen. Dazu kommt der zu dieser Datenbank passende, geschützte Wiederherstellungsnachweis der vorhandenen Vault-Schlüsselverwaltung. Die verschlüsselten Import-Key-Umschläge befinden sich in der Datenbank; sie sind ohne den passenden Vault-Schlüssel nicht ausreichend.

Fehlende oder falsche Schlüssel dürfen niemals durch neue Ersatzschlüssel kaschiert werden. Archive werden weder als alleinige Kopie ihrer eigenen Entschlüsselungsgrundlage geplant noch durch unkontrollierte Schlüsselableitung eingerichtet. Die produktive Einrichtung muss die vorhandene geschützte Recovery-Set-Verwaltung verwenden; dieser Arbeitsschritt änderte keine produktiven Schlüsseldateien.

### Sichere Veröffentlichung und Umstellung

1. Konsistenten DB-/Dokumentpunkt isoliert erzeugen und seine GP-Integrität prüfen.
2. In das ausdrücklich gebundene lokale Repository schreiben; jeder Fehler einschließlich teilweise gelesener Quelldateien verhindert eine Erfolgsmeldung.
3. Feste Snapshot-ID und Repository-Identität bestätigen, Datenprüfung durchführen und einen separaten Rücksicherungstest bestehen lassen.
4. Erst danach einen Archivbeleg veröffentlichen. Eine Dateinamenliste oder ein alleiniger Restic-Exitcode ersetzt nicht die Kopplungs- und Schlüsselprüfung.
5. Vorhandene Vollsicherungen bleiben während der Einführung unverändert. Es gibt in diesem Auftrag keine automatische Konvertierung oder Löschung. Die spätere kontrollierte Umstellung muss jeden vorhandenen Punkt erhalten und nachweisen, bevor redundante physische Kopien überhaupt zur Freigabe stehen.

Lokal vorhanden sind signierte Archivbelege, begrenzte authentifizierte Health-Metadaten, eine Verwaltungs-CLI für Liste/Prüfung/Export/Recovery und die Einbindung in App-, Offline- und Linux-Sicherung. Der jeweils jüngste gekoppelte Rohpunkt bleibt für die bisherigen Updater-/Offsite-Verträge vorhanden. Vor einer Schema-Migration erzeugte Sicherheitskopien bleiben absichtlich unregistriert und werden niemals durch die Archiv-Retention entfernt.

Noch offen sind die produktive Runtime-/Offsite-Migration, End-to-End-Updater-/Wiederherstellungsabnahme mit dem vollständigen Bestand, belastbare Kapazitäts- und Laufzeitmessungen sowie die systemweite Abstimmung mit externen Linux-/Offsite-Prozessen. Der aktuelle Datenbank-Download ist weiterhin eine separat erzeugte Rohkopie, kein historischer Archivexport; seine Großdatenlast muss ebenfalls vor Aktivierung bewertet werden. Im installierten System bleiben bisherige Erzeuger und Aufbewahrung unverändert aktiv.

### Lokale Betriebs- und Wiederanlaufverträge

- `GRABENPLANER_LOCAL_BACKUP_ARCHIVE=1` allein initialisiert nichts. Jeder Bereich benötigt vorher eine ausdrückliche Initialisierung mit festem Host/Stream, unabhängig gepinnter ausführbarer Datei und bestehendem Integration-Vault. Bei fehlender/fehlerhafter Konfiguration wird verweigert; ein vorhandenes Archiv darf nicht still in den bisherigen Löschpfad zurückfallen.
- Die App lässt Rohkopie, Dokumentinventur und Restic im eigenen Kindprozess laufen: 512-MiB-Heap, begrenzte Ausgaben, maximal vier eingereihte/aktive Aufträge und keine Geheimnisse in Kommandozeilen. Beide Zielbereiche teilen 1.400 Sekunden einschließlich Queuezeit; ein Dienststopp verkürzt auch bereits laufende/eingereihte Fristen. Die lokalen Service-Templates lassen 1.500 Sekunden für Start/Stop zu. Ein nicht bestätigtes Prozessbaum-Ende verhindert sauberen Abschluss und Freigabe der Instanzsperre.
- Ein fehlgeschlagener Archivauftrag blockiert weitere Aufträge dieses Bereichs im App-Prozess bis zu bewusster Wiederherstellung und Neustart. Ein Fehler wird nicht als erfolgreicher Sicherungspunkt oder als erfolgreicher Neustart quittiert.
- Die Verwaltungs-CLI `scripts/manage-local-backup-archive.js` bietet ausdrückliche Aktionen für `initialize`, `inspect`, `list`, `export`, `reconcile`, `release-stale-lock`, `archive-existing` und `finish-retention`. Recovery-Aktionen nur bei nachweislich gestoppten Produzenten ausführen. `archive-existing` akzeptiert ausschließlich den jüngsten Rohpunkt; keine beliebige Übernahme fremder oder älterer Dateien.
- Ein Export schreibt in ein neues privates Unterverzeichnis eines ausdrücklich benannten vorhandenen Ziels und prüft den tatsächlichen Ergebnisbestand. Auf demselben Laufwerk werden die verifizierten temporären Dateien dorthin verschoben; eine zweite Vollkopie entfällt. Bei verschiedenen Laufwerken bleibt die geprüfte Kopie mit Platzprüfung je Laufwerk nötig. Benötigt werden Datenbank, Dokumente, Manifest/Marker, Archivzustand samt Recovery-Umschlag und die passenden bereits vorhandenen Vault-/Dokumentenschlüssel. Die verschlüsselten Import-Key-Umschläge werden ebenfalls authentifiziert. Fehlende oder falsche Schlüssel verhindern Erfolg.
- Die Aktionen `export`, `archive-existing`, `finish-retention` und `reconcile` benötigen nun zusätzlich den absoluten `DB_PATH` der zugehörigen vorhandenen Installation. Sie nehmen dieselbe Arbeitsbereichssperre wie App-Backup und Download; ein belegter Arbeitsbereich führt zu einem Fehler vor der Kopie. Ein fehlender Live-Datenbankpfad wird nicht automatisch ersetzt oder angelegt. Die gesonderte Wiederherstellung einer ausgefallenen Installation bleibt ein betreuter Recovery-Vorgang.
- Alte Integration-Key-IDs dürfen nicht aus dem vorhandenen Schlüsselring entfernt werden, solange ein Archiv-Recovery-Umschlag damit versiegelt ist. Automatisches Neuversiegeln bei Schlüsselrotation ist nicht implementiert; davor sind ausdrückliches Recovery-Konzept und Rücksicherungsnachweis nötig.
- Die bestehende Offsite-Sicherung schützt den jüngsten Rohpunkt gemäß ihrem eigenen Vertrag. Sie kopiert **nicht automatisch die vollständige lokale Archivhistorie samt Recovery-Umschlag**.
- Die beiden lokalen Unit-Änderungen verändern den verwalteten Runtime-Fingerprint. Der Updater verweigert eine abweichende Runtime bei unverändertem Deployment-Schema. Dieses Gate bleibt aktiv; bloßes Aktualisieren eines Test-Hashes ist keine Runtime-Migration und keine Deploy-Freigabe.

## Kapazitätsplanung und Freigabegrenzen

`lib/local-backup-policy.js` enthält einen konservativen, nebenwirkungsfreien Kapazitätsrechner. Eingaben müssen tatsächliche Messwerte oder ausdrücklich als solche erkennbare Lastannahmen sein:

- zusätzlicher Platz für die produktive Datenbank nach dem Import;
- Größe eines kompaktierten **gekoppelten** Sicherungspunkts einschließlich Dokumenten;
- tatsächliche erste Repository-Größe und zusätzlicher Speicher pro Änderungspunkt;
- zwei getrennte lokale Repositorys mit jeweils bis zu 20 Tagesständen;
- alle tatsächlich gleichzeitig vorhandenen Roh-, Offsite-, Erstellungs- und Restore-Kopien, WAL, zusätzliche Archivkandidaten, Zwischenreste, Speicher für Archivbereinigung und mindestens 10 GiB freie Reserve.

Selbst bei nachgewiesener systemweiter Serialisierung und nur einem Offsite-Stagingpunkt sind mindestens fünf gekoppelte Kopien anzusetzen: jüngster App-Rohpunkt, jüngster externer Rohpunkt, Offsite-Staging, neue Rohkopie und unabhängige Rücksicherung. Ohne bereichsübergreifende Koordination können sieben nötig sein; bleibt altes Offsite-Staging während des Neuaufbaus erhalten, kommt eine weitere hinzu. Die App-interne Queue alleine serialisiert keine extern gestarteten Linux-/Offsite-Prozesse. Live-Datenbank, bereits belegter Plattenplatz und künftig zusätzlicher Platz dürfen nicht doppelt gerechnet oder weggelassen werden. Vorhandene Legacy-, Migrations- und unregistrierte Rohkopien erhalten keine Löschgutschrift.

Die Abschätzung `Archiv = gemessene Basis + 19 × zusätzliche Änderungsbytes` ist nur ein Bestandteil. Hinzu kommen der vor der Retention zeitweise vorhandene 21. Archivpunkt, DB-/WAL-Spitzen, alle gleichzeitig vorhandenen Arbeitskopien sowie begrenzte Zwischenreste und Archivbereinigung. Aktuell begrenzt `prune --max-repack-size 0` das zusätzliche Repacking, kann aber ungenutzte Blöcke in gemischten Paketen belassen. Ohne gemessene Änderungsfenster und begrenzte langfristige Bereinigungsschuld ist damit keine dauerhafte Kapazitätszusage möglich.

Ein rechnerisches Passen ist keine Produktivfreigabe: Ohne Vollbestands- und Änderungsfenster-Messung bleibt `qualified=false`. Die maximale Testbelegung von 21,3 GB aus Block 3 enthält WAL/SHM und ist kein kompaktierter Sicherungspunkt. Stark geänderte oder neu verschlüsselte Daten können Deduplizierung weitgehend aufheben. Deshalb ist kein Einsparfaktor garantiert.

### Zusätzlicher Freigabepunkt: Folgeimport einer geänderten Quelldatei

Die abschließende reine Codeprüfung hat drei unterschiedliche Speicherfälle bestätigt:

1. Bei stabilen fachlichen Schlüsseln bleiben unveränderte Ziele `unchanged`; sie werden nicht als neue Verkäufe oder unnötige Zielversionen angewandt. Die erfolgreiche Wiederholung **derselben Datei** bleibt davon getrennt.
2. Ein **neuer Datei-SHA** erzeugt neue Source-/Run-IDs. Die Prüfablage speichert jede eingelesene Zeile erneut verschlüsselt, danach den vollständigen Reviewplan einschließlich vorheriger Bindung und Zielzustand. Die Staging-Dublettenprüfung ist run-begrenzt; unveränderte Prüfunterlagen werden nicht zwischen Läufen gemeinsam referenziert. Der Speicherbedarf wächst deshalb zunächst mit dem gesamten Quelldatenumfang, nicht nur mit fachlich geänderten Zeilen. Neue zufällige Verschlüsselungs-IVs verhindern eine verlässliche Wiederverwendung derselben Ciphertextblöcke durch das Backup.
3. Tabellen ohne stabilen Quellschlüssel behalten bewusst vollständige dateigebundene Historienstände, etwa `ARTIKEL_FILIALEN`, `Tagesbericht` und `KassenJournal_Details`. Diese fachlich vorgesehenen Snapshots sind keine pauschal zu löschenden Dubletten.

Codeanker: `lib/persistence/repositories/data-import-runtime.js` (Source-ID und Runtime-Rechte), `lib/data-import-engine.js` (Run, Stage, Review, Apply, Purge), `lib/data-import-protection.js` (zufällige IV), `lib/tradefoto-history-profiles.js` (Snapshot-Identität). Der vorhandene Test `test/tradefoto-history.test.js` unterscheidet ausdrücklich unveränderte Verkäufe von vollständigen neuen Tagesbericht-Snapshots.

Ein `expiresAt` nach 30 Tagen startet keine automatische Bereinigung. Der bisher vorhandene interne Engine-`purge()`-Pfad ist im neuen lokalen Stand zusätzlich gesperrt: Auch ein ausdrücklich aufgerufener interner Löschversuch erhält `IMPORT_PURGE_DISABLED`, statt Row-/Change-Payloads zu leeren. Die Runtime bietet weiterhin keine entsprechende Bedienaktion oder Berechtigung an. Weder Rücknahmebelege noch Historie werden entfernt; die bestehenden Zugriffs- und Rücknahmefristen werden nicht verkürzt.

Damit belegt eine kleine Archivänderung bei Wiederholung derselben Sicherungsdatei **nicht** den Speicherbedarf des nächsten tatsächlichen ACCDB-Imports. Die zusätzliche datenbewahrende Optimierung des Importkerns wurde am 06.09.2026 ausdrücklich freigegeben und wird lokal umgesetzt. Originalwerte, bewusst vollständige Historienstände, Herkunft, Rechte und Rücknahme bleiben bindende Abnahmekriterien; keine stillschweigende Purge- oder Aufbewahrungsverkürzung.

Die additive Ablage verwendet unveränderliche verschlüsselte Teilobjekte und individuell authentifizierte Row-/Change-Hüllen. Bis zu sechs feste große Felder können innerhalb desselben Scope-, Owner-, Profil- und Quellsystems gemeinsam gespeichert werden. Run-ID, Datei-SHA, Snapshotzeitpunkt, Zeilennummer, fachliche Identität und Content-Hash bleiben individuell erhalten. Technische Snapshotfelder werden nur bei den dafür definierten Profilen getrennt erhalten, niemals fachliche Snapshotdatensätze zusammengelegt. Referenztabellen und authentifizierte Hüllen müssen exakt übereinstimmen; fehlende, fremde oder manipulierte Teile werden verweigert.

Die vollständige Herkunftsbindung wird als separat zweckgebundener HMAC-Digest innerhalb der authentifizierten Hülle gespeichert und beim Lesen aus den erwarteten vollständigen Metadaten erneut berechnet. Objekte unter 1.024 Bytes und bereits verschlüsselte Alt-Link-Werte unter 4.096 Bytes bleiben inline. Gibt es keine auszulagernden Teile, wird der unveränderte Originalwert im bisherigen Envelope-Format gespeichert; dies ist eine bewusste Schreibentscheidung, kein Ausweichpfad nach einem Entschlüsselungsfehler.

Ein zweckgebundener Verschlüsselungsschlüssel für Teilobjekte wird aus dem bereits verwalteten Import-Key abgeleitet; es wird kein neuer produktiver Schlüssel bereitgestellt. Legacy-Hüllen bleiben lesbar, eine Schema-Installation schreibt keine Altdaten um. Neue gemeinsame Schreibvorgänge sind nur über den internen Kompositionsparameter `sharedPayloads:true` möglich. Der HTTP-/Server-Produktivpfad lässt diesen Schalter aus; ein Upload kann ihn nicht setzen.

Die Einführung erfolgt deshalb gestuft: zunächst additive Tabellen und beide Leser mit bisherigem Writer; erst nach separater Vollbestands-/Rücksicherungsabnahme darf das neue Schreibformat produktiv aktiviert werden. Vor Aktivierung muss die Mindestleserversion im Release-/Recovery-Vertrag festgehalten und praktisch geprüft werden. Ein älteres Binary ohne neuen Leser darf nicht mit einer bereits umgestellten Datenbank gestartet werden; ein Rückgang davor erfordert den dazu passenden vor der Umstellung erzeugten vollständigen Wiederherstellungspunkt. Ein bloßer Code-Downgrade ist kein zulässiger Rollback.

Der isolierte Vollimport-Prüfer akzeptiert optional `--shared-payloads` und kennzeichnet das benutzte Format im Bericht. Der inzwischen beendete Vollbestandslauf hatte noch den alten Code geladen und qualifiziert diese Optimierung nicht. Neue synthetische Vergleichstests zählen alle behaltenen Hüllen, Teilobjekte und Referenzen einschließlich der unveränderten Live-Links; Löschungen dürfen keine Einsparung vortäuschen. Bis zu diesen Nachweisen bleibt die Änderung ein zusätzliches Produktivfreigabe-Gate.

Der abschließende lokale Fokuslauf bestand mit 84 Tests ohne Fehler oder Skips. In zwei synthetischen Dateien mit jeweils 128 Kunden (127 unverändert, eine Änderung) sowie jeweils acht vollständigen schlüssellosen Snapshots wurden die Import-Spaltenbytes von 10.014.779 auf 6.414.420 und die gesamten SQLite-Seiten von 11.636.736 auf 8.126.464 Bytes reduziert. Alle 403 behaltenen Teilobjekte und 1.092 Referenzen sind darin enthalten; kein Purge und keine Löschgutschrift. Ganze Datenbank-Rücksicherung, falscher Schlüssel, Rechte, Manipulationen, Transaktionsabbruch, Snapshotidentität und Rücknahme sind geprüft.

Zusätzliche Zwei-Datei-Tests mit 100-, 300- und 600-Byte-Notizen bleiben einschließlich Datenbankseiten exakt gleich groß wie Legacy und erzeugen keine Teilobjekte oder Referenzen. Es gibt dennoch keine allgemeine Nichtwachstumszusage: In einer gesonderten In-Memory-Grenzmessung mit 96 Zeilen je Datei und Source-/Data-Teilen von 1.024/997 Bytes bleiben die Spaltenbytes nahezu gleich (1.766.632 gegenüber 1.765.942), während die gesamten SQLite-Seiten von 2.273.280 auf 2.408.448 Bytes wachsen, rund 5,95 %. Die Erstablage eines Teilobjekts kostet zusätzliche Hüllen, Metadaten und Indizes; Wiederverwendung muss diese Kosten zunächst ausgleichen. Neue echte Änderungen, individuelle Laufmetadaten und bewusst vollständige historische Snapshots wachsen weiterhin. Vollbestand, Folgeimport, Arbeitskopien und Platzreserve müssen deshalb vor jeder daraus abgeleiteten Produktivfreigabe tatsächlich geprüft werden.

Die erste neue Vollsuite wurde für diese belegte Kleindatenkorrektur bewusst beendet und gilt nicht als Abnahme. Die Wiederholung unter `tmp/import-shared-payload-final-full-20260906.tap` ist beendet: 2.975 Tests, 2.933 bestanden, 40 bewusst übersprungen, zwei Fehler, 1.215,7 Sekunden. Spätere gezielte Nachprüfungen ersetzen keine vollständig grüne Gesamtsuite des aktuellen Arbeitsstands.

## Nachweisverfahren

Aufruf: `node scripts/verify-large-data-backups.mjs ABSOLUTER_RESTIC_PFAD SHA256_DER_BINARY`.

Der Test nutzt ausschließlich ein neu erzeugtes Verzeichnis unter dem Repository-Ordner `tmp`; keine vorhandene App-Datenbank, kein produktives Environment und kein vorhandenes Backup-Repository werden geöffnet. SQL-Fixtures liegen ausdrücklich in `test-support/large-data-backup-qualification.mjs` und sind im Architektur-Audit als Tests klassifiziert.

1. Eine synthetische Datei mit 2.147.483.665 Bytes wird in einem separaten Node-Prozess mit 64-MiB-Heap-Grenze gehasht. Der erwartete SHA-256-Wert stammt aus einer unabhängigen blockweisen Null-Daten-Berechnung.
2. 64 MiB zufällige Ausgangsdaten mit jeweils 1 MiB Änderung, verwalteter Import-Key-Umschlag und verschlüsseltes Testdokument erzeugen 32 echte Restic-Punkte.
3. Jeder Punkt wird in ein neues leeres Ziel zurückgesichert. Datenbankhash, GP-Commitmarker, Dokumentkopplung, Dokumententschlüsselung und Import-Key-Wiederherstellung werden geprüft; falsche Vault-Schlüssel müssen scheitern.
4. Die Aufbewahrungsvorschau behält 30 Punkte. Alle 32 Testpunkte bleiben bis zum Ende des Tests im Repository erhalten.
5. Ein anschließend absichtlich beschädigtes, ausschließlich synthetisches Archivpaket muss die Datenprüfung scheitern lassen.
6. Erzeugte Testdaten und Testschlüssel werden anschließend entfernt; der Bericht enthält nur Aggregate und Hashes. Es werden keine Geschäftsdaten für diesen synthetischen Test verwendet.

Werkzeug für den lokalen Windows-Nachweis: Restic 0.18.1, offizielles Release-Archiv gegen dessen `SHA256SUMS` geprüft. ZIP-SHA-256 `0c1a713440578cb400d2e76208feb24f1b339426b075a21f73b6b2132692515d`; Binary-SHA-256 `034b7bf67a23049d30d58ddf4fb318239726cc74728b80bff876de824f2fc786`. Das ist keine Änderung der gepinnten produktiven Linux-Binary. [Offizielles Release](https://github.com/restic/restic/releases/tag/v0.18.1).

Der abschließende synthetische Durchlauf bestand nach 98,3 Sekunden: 32 Rücksicherungen einschließlich Schlüsselprüfung, 30 Punkte in der Vorschau und eine erfolgreich erkannte Archivbeschädigung. Der Großdatei-Hash benötigte maximal 49.680.384 Bytes Prozessspeicher. Synthetische Archivgröße: 166.773.044 Bytes gegenüber 2.158.755.840 Bytes reiner Datenbank-Vollkopien. Diese Zahlen sind **kein Nachweis der produktiven TradeFoto-Größe**. Lokaler Bericht: `tmp/large-backup-qualification-XJlef6/report.json`; der [Abnahmebeleg](GROSSDATEN-BACKUP-NACHWEIS.json) hält die vollständigen Aggregate fest.

Die frühere Gesamtsuite vor der Archiv-/Kindprozess-Einbindung bestand mit 2.890 Tests: 2.850 bestanden, 40 bewusst übersprungen, keine Fehler oder Abbrüche; Laufzeit 667,2 Sekunden. Das ist ein historischer Nachweis und **keine Gesamtabnahme der anschließend ergänzten Implementierung**. Aktuelle Teil- und Gesamtläufe werden getrennt im Abnahmebeleg geführt.

Die wiederholte Archiv-Integrationssuite bestand anschließend mit 2.949 Tests: 2.909 bestanden, 40 bewusst übersprungen, keine Fehler oder Abbrüche; Laufzeit 1.192,6 Sekunden. Die danach begonnenen Änderungen an der gemeinsamen Import-Prüfablage benötigen eine neue Abnahme und werden von dieser Baseline nicht abgedeckt.

### Vollbestandsmessung vom 06.09.2026

Der erneut isolierte Lauf startete um 13:32 Uhr Wiener Zeit mit den damals geprüften Desktop-Quellen. Bericht: `tmp/tradefoto-block3-5S1S2a/report.json`. Er endete nach 18.213.148 ms mit `BACKUP_MEASUREMENT_DISK_RESERVE` in der Backup-Messphase. Alle 1.082.167 Kassenzeilen waren verarbeitet; es entstanden jedoch null Sicherungspunkte und kein Restore-Nachweis. Die PIDs 14168 und 20200 sind beim Folgecheck nicht mehr vorhanden. Der Job bereinigte selbst seine isolierten Messdateien; beim Task-Wechsel und bei der Startprüfung wurde nichts gelöscht. Produktive Zuordnungen, Schreibzugriffe und Schlüsselverwendung blieben aus. Der Report bindet den damaligen Quellenstand über SHA-256; die Quellen wurden bei der Startprüfung nicht erneut geöffnet.

Der beendete Prozess hatte die ältere Messimplementierung mit `VACUUM` geladen. Der zugehörige Reservewächter war auf PID, Startzeit und Test-Kommandozeile begrenzt und durfte keine Dateien löschen. Maßgeblich für den Abschluss ist der fehlgeschlagene Messreport, nicht die frühere Meldung über den laufenden Prozess. Die Quell-ACCDBs werden niemals geändert.

Für künftig gestartete Messungen liegt zusätzlich `measurementImplementation: vacuum-into-v2` vor: Platzvorprüfung, Kompaktierung in eine neue Datei, unabhängige Integritätsprüfung und abgesicherter Dateitausch; ein gezielter Renamefehler muss die Originaldatei erhalten. Drei synthetische Tests bestanden. Die gesamte temporäre Messablage einschließlich WAL, Archiv und Restore wird stichprobenartig erfasst (`sampledPeakOnly: true`); das ersetzt keine unterbrechungsfreie Spitzenmessung oder ein repräsentatives betriebliches Änderungsfenster. Der fehlgeschlagene ältere Lauf ist kein v2-Nachweis. Die [Startprüfung](BLOCK-4-STARTPRUEFUNG-2026-09-06.md) zeigt, weshalb ein unveränderter Neustart nicht sinnvoll ist.

## Fortsetzung von Block 4

Der jüngste vollständige Messlauf ist bestanden und hat seine isolierten Messdateien anschließend entfernt. Ein erneuter fünfstündiger Vollimport derselben Dateien wird für gewöhnliche Backups nicht benötigt. Maßgeblich sind die zuletzt vom Nutzer bereitgestellten Exporte, auch wenn sie wochenlang unverändert bleiben. Synthetische Folgeimportfälle mit den echten Import-Writern bleiben von Messungen eines tatsächlich neu bereitgestellten Geschäftsdatenstands getrennt. Vor dessen späterer Übernahme sind Änderungen und zusätzlicher Platz neu zu prüfen.

Die gemeinsame Arbeitsbereichssperre und der Export ohne zweite Vollkopie auf demselben Laufwerk sind lokal eingebunden. Als Nächstes sind die innerhalb von Recovery/App-Smoke erzeugten Kopien, betreute Wiederherstellungen, Fehlerreste und langfristige Archivbereinigung gemeinsam zu begrenzen und mit dem großen Kandidatenbestand zu qualifizieren. Der bestehende Kapazitätsrechner bleibt bis dahin konservativ und `qualified=false`; ein getestetes Sperrprimitive alleine ist keine Gesamt-Spitzenmessung.

Danach die lokal implementierten GP-/Linux-Verträge mit dem vollständigen Bestand und vorhandenen produktiven Recovery-Set abnehmen. Die Änderungen am verwalteten Runtime- und eigenständig gepinnten Offsite-Modul erfordern nachvollziehbare, koordinierte Migrationen; keine Datei wird außerhalb des Installationsvertrags auf dem VPS ausgetauscht. Erst nach grünen Kapazitäts-, Laufzeit-, Wiederherstellungs- und Betriebsnachweisen folgt der bereits freigegebene Release-/Importablauf von Block 4. Bis dahin bleiben `productionQualified=false` und der produktive Gesamtimport gesperrt.
