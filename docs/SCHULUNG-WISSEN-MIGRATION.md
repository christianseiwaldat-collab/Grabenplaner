# Schulung und Wissen: additive PostgreSQL-Erweiterung

Stand: 15.09.2026. Im ausdrücklich beauftragten VPS-Deploy ausgeführt;
vollständiger Abschlussnachweis unter [v0.92.53](DEPLOY-RELEASE-v09253.md).
Diese Datei erteilt keine eigenständige Freigabe für eine erneute Ausführung.

## Umfang

Die Erweiterung legt ausschließlich in der Core-Datenbank sechs Tabellen an:
`personnel_learning_runs`, `personnel_learning_run_revisions`,
`personnel_learning_run_progress_revisions` und
`personnel_learning_schedule_revisions`, `personnel_learning_assessment_records`
und `personnel_learning_requirement_revisions`, außerdem das Migrationsjournal.
Bestehende Lernzuweisungen bleiben einschließlich ihrer bisherigen Eindeutigkeit
und Belege unverändert. Wiederholungen liegen in eigenen Identitäten;
Repository-Lesezugriffe führen beide Bestände zusammen. Sales bleibt unverändert.

Die DDL und Berechtigungen sind in
`lib/persistence/postgresql/core/personnel-learning-runs.js` definiert. Sie laufen
in einer einzigen serialisierbaren Transaktion unter `gp_core_owner`, mit
Umgebungsprüfung, Advisory-Lock, Vorher-/Nachher-Fingerabdruck und Planbeleg.
Wiederholte Ausführung prüft den vorhandenen Vertrag und ändert nichts mehr.
App und Leser dürfen die Historie nicht ändern oder löschen.

## Einbindung in den Release

Die etablierte geschützte Release-Kette bleibt erforderlich: Paket/Manifest,
frischer verifizierter Rückkehrpunkt beider Datenbanken und Wartungssperre.
Der mit v0.92.52 veröffentlichte Helfer
`server-tools/linux/lib/personnel-learning-runs-migrate.js` folgt dem bereits
vorhandenen `trade-annotations-migrate.js`-Ablauf. Der gebundene Release-Wrapper
muss ihn nach dem bestätigten atomaren App-Tausch und vor der abschließenden
Freigabe der Lernfunktionen aufrufen, solange Dateideskriptor 9 die bestehende
Wartungssperre hält. Nicht aus Staging und nicht aus der Webanwendung starten.

Argumente: der zuvor überprüfte SHA-256 des installierten Servermanifests und
`--maintenance-lock-held`. Der Helfer akzeptiert ausschließlich Linux/root im
installierten `/opt/grabenplaner/app`, überprüft alle kritischen Paketdateien,
die Sperre und einen höchstens eine Stunde alten geprüften gekoppelten
Sicherungspunkt. Er verwendet die vorhandene geschützte PostgreSQL-Konfiguration,
fünf Sekunden Lock-Timeout und 30 Sekunden Statement-Timeout.

Nachweis vor Release-Abschluss: Helferergebnis `verified: true`, Sales unverändert,
gültiger Core-Fingerabdruck, normale Erreichbarkeit sowie lesende Prüfung von
Wissensbibliothek, Schulungsübersicht und bisherigen Lernbelegen. Die neuen
Repository-Abfragen setzen diese Migration voraus; ein erfolgreicher allgemeiner
Readinesscheck allein ist noch keine Freigabe dieser Funktionen.

Bei Fehler vor Commit bleibt die Datenbanktransaktion unverändert. Bei Fehler
nach Commit die Ursache unter der Wartungssperre prüfen und den idempotenten
Helfer gegebenenfalls erneut ausführen. Alte App-Pakete kennen den neuen
Schema-Fingerabdruck nicht: deshalb niemals einen bloßen Code-Rollback als
vollständige Wiederherstellung ausgeben. Die bestehende gekoppelte, beaufsichtigte
Wiederherstellung ist der Rückweg, falls eine gezielte Korrektur nicht genügt.

## Bereits verifiziert

Der tatsächliche Migrationscode und die App-Rollen wurden auf PostgreSQL 18.6 in
einem separaten Cluster mit privaten Unix-Sockets und synthetischen Daten geprüft.
Nachgewiesen: Erstinstallation, idempotente Wiederholung, zwei unabhängige
Lerndurchgänge, Abschlusskorrektur, Revisionsschutz und Rücknahme einer fehlerhaften
Planungstransaktion. Zusätzlich geprüft: geschützte Prüfungsdatensätze, unveränderliche
Anforderungen, gebündelte Versions-/Ereignisabfragen und gefilterte Teamabfragen mit
Seitenbegrenzung. Der produktive Helfer wurde nicht ausgeführt.

## Prüfungen und Nachweise (Block 5)

Prüfungsdefinitionen sind optionaler Bestandteil einer unveränderlichen
Prozessfassung. Bestehende Fassungen ohne Prüfungsdefinition bleiben unverändert.
Versuche, begründete neue Freigaben, Dateinachweise und Rücknahmen stehen als
unveränderliche Belegkette in `personnel_learning_assessment_records`.

Antworten und Originaldateien liegen verschlüsselt in `protected_payload` in Core.
Verwendet werden die vorhandenen geschützten AMU-Schlüssel, mit eigenem Namespace
und Bindung an Datensatz und Personalnummer. Die eigentliche Dateikopie ist auf
2 MiB begrenzt; höchstens zehn gleichzeitig aktuelle Dateien je Durchgang. Vor
Übernahme müssen Scanner und Dateitypprüfung erfolgreich sein. Listen lesen nur
Metadaten, keine verschlüsselten Dateiinhalte. Rücknahme bewahrt die Historie.
Die bestehende gekoppelte Sicherung muss weiterhin Core **und Schlüsselbestand**
enthalten; es gibt keinen neuen ungesicherten Uploadordner.

Bestätigungs-PDFs werden aus dem aktuell gültigen erfolgreichen Abschluss erzeugt.
Nach negativer Korrektur ist kein neuer Bestätigungsdownload zulässig. Bereits
heruntergeladene PDFs dokumentieren ausdrücklich den Stand ihres Ausstellungsdatums.
Gemeinsame Filialkonten dürfen weder persönliche Prüfungen abgeben noch Nachweise
oder Bestätigungen abrufen. Bestehende Fortschrittsrechte bleiben separat geregelt.

## Team-Anforderungen (Block 6)

Anforderungen haben eine unveränderliche Revisionskette und binden eine konkrete
veröffentlichte Fähigkeits-/Prozessfassung. Änderungen und Audit werden gemeinsam
zurückgerollt. Es gibt keine automatische Kompetenz- oder Trainerfreigabe und keine
automatische Massenanlage von Durchgängen. Neue Regeln müssen bewusst konfiguriert
werden. Maximal 50 aktive Regeln; archivierte Regeln bleiben nachprüfbar.

Die Matrix und ihr CSV-Export sind auf höchstens 100 Personen pro Anfrage begrenzt
(UI: 10/25/50). Quote und Export beziehen sich ausdrücklich auf die aktuelle Seite.
Der Datenbankfilter begrenzt Personen nach aktuellen Leitungsrechten, Filiale,
Position, Rolle und Suchtext, bevor deren Lernhistorien gelesen werden. Vollständige
Historien der sichtbaren Personen bleiben für die Belegprüfung erhalten. Der
Versionskatalog wird in drei gebündelten Abfragen statt einzeln je Modul gelesen.
