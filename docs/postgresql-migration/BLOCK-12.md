# Block 12: Umstellungsvorbereitung und Wartungsablauf

Stand 13.09.2026. Die Blöcke 9–11 sind abgeschlossen. Der Benutzer hat mit „Bitte Block 12 loslegen“ die Veröffentlichung und das beschriebene Wartungsfenster freigegeben. **Der produktive Wechsel und seine Nachkontrolle stehen beim Erstellen des Releasepakets noch aus.** Der laufende GP verwendet zu diesem Zeitpunkt weiterhin SQLite. Ein VPS-Neustart gehört nicht zum Auftrag.

Der erneute Produktivcheck um 09:21 UTC bestätigte v0.92.37-beta, alle 558 installierten Manifestdateien und vier erfolgreiche interne/öffentliche Live-/Ready-Antworten. Der abgeschlossene nächtliche Restore war erfolgreich, sein anschließender Caddy-Check scheiterte an einer erhaltenen temporären Prüfdatei. Das Release verwendet pro Prüfung eigene Dateien; zwei native Wiederholungen mit absichtlich vorhandenem Vorgängerartefakt bestanden. Die beiden Offsite-Schreibdienste erhalten außerdem die optionalen PostgreSQL-Arbeits-/Sicherungspfade; die Clusterdateien bleiben innerhalb dieser Dienste nur lesbar. Diese Änderungen ergänzen die bisherigen Qualifikationsbelege und werden gesondert geprüft.

## Geprüfter Stand

Die zusätzliche Instanz `activation-12` bildet die endgültigen Namen `grabenplaner_core` und `grabenplaner_sales` ab. Sie läuft ausschließlich im privaten Netzwerk ihrer jeweiligen Probe. Der vorhandene Lebensatlas-Cluster auf Port 5432 gehört nicht zu dieser Migration.

| Nachweis | Ergebnis |
| --- | --- |
| Frische Instanz und Rollen | PostgreSQL 18, acht getrennte Konten, zwei Datenbanken; Anlage 6,3 Sekunden |
| Vollständige erneute Übernahme | 248 Quelltabellen, 2.887.715 Zeilen; 821,3 Sekunden |
| Inhaltsprüfung und endgültige Datenbanknamen | Derselbe vollständige Inhalt wie Block 9; 124,0 Sekunden |
| Geschützte Daten nach der Übernahme | 55 verschlüsselte Dateien, 55 Verweise, 113 geschützte Datensätze und der separate Importarchivschlüssel; 27,8 Sekunden |
| Tatsächlicher Anwendungsbenutzer | Vollständiger Serverstart als `grabenplaner` mit Produktionskonfiguration in einem privaten Dateisystem-/Netzwerkraum bestanden |
| Fachliche HTTP-Prüfung | Anmeldung, Dienstplan/PDF, historische Sony-Suche, acht parallele Abfragen, Importkonflikt, Import/Rücknahme, Rechteentzug und 544 Regelwerksbelege bestanden |
| Berichterstellung | Januarbericht mit 2.239 Positionen als PDF über die automatische Warteschlange fertiggestellt |
| Datenbankdownload über HTTP | 995.840.000 Byte vollständig übertragen; Download 134,7 Sekunden; acht gleichzeitige Abfragen erfolgreich |
| Finale Quellenaufnahme | Tatsächliches Root-Werkzeug mit angehaltenem Test-GP und Wartungssperre; SQLite-Kopie bytegenau identisch, alle 65 mitgenommenen Dateien und die Schlüsselkonfiguration geprüft |
| Dienstdefinitionen | Alle fünf neuen Vorlagen durch `systemd-analyze verify` geprüft; keine Installation dabei |
| Tatsächlicher Root-Wartungsweg | Angenommener Auftrag, sauberer GP-Stopp, gemeinsame Sicherung, Prüfung und neuer bereiter GP-Prozess; 204,1 Sekunden |
| Nachtlauf mit endgültigen Datenbanknamen | Wiederherstellung genau dieses Sicherungspakets über den Root-Recovery-Einstieg samt vollständiger HTTP-/PDF-Anwendung erfolgreich; 169,3 Sekunden |

Die historischen Prüfdaten entsprechen dem unveränderlichen Block-9-Stand, nicht dem inzwischen möglicherweise weitergeschriebenen Produktivbestand. Vor der tatsächlichen Umstellung wird deshalb eine **neue finale Quelle** aufgenommen und vollständig geprüft. Die historische SQLite-SHA-256 lautet `aa37fbd4ce0b9d1c914cda7df6ac8c56b6437dd3ca6e091b8e040d6e270a84c3`; der geprüfte übernommene Dateninhalt hat SHA-256 `b37ad81733768b2e0c90f728e7d5c4a33dca7b6f33c7cb4f98599db254ece379`.

Beim Download waren die zusätzlichen Anfragen nach 121–1.827 ms beantwortet, überwiegend nach 121–757 ms. Die Lastmessung aus Block 11 bleibt maßgeblich für die Berichtslast: 48 erfolgreiche parallele Fachabfragen, p95 2.557 ms. Daraus wird keine produktive Antwortzeitgarantie abgeleitet.

## Betriebswege

Die Anwendung erhält ausschließlich vier Geschäftszugänge für Core/Sales und ihre Leser. Die acht vollständigen Betriebs-/Wiederherstellungszugänge bleiben in einer Root-Datei. Anwendung, Betriebskonfiguration, Quellstand, Paketmanifest und PostgreSQL-Instanz sind ausdrücklich miteinander verbunden. Ein einzelnes `DB_PROVIDER=postgresql` öffnet keinen unkontrollierten Zugriff und bewirkt keinen automatischen Rückfall auf SQLite.

Die eigene Datenbank-Unit verwendet `127.0.0.1:55486`, 32 Verbindungen, 128 MiB gemeinsame Puffer und begrenzte Arbeitsspeicherwerte. Core-App darf zehn, Sales-App acht gleichzeitige Verbindungen öffnen; dadurch bleibt der administrative Download auch mit laufenden Such-/Berichtsworkern möglich. PostgreSQL und GP erhalten jeweils ein eigenes Limit von 1.536 MiB. In der isolierten gemeinsamen Probe benötigten beide Prozesse einschließlich zugerechnetem Dateicache mehr als ein zusammengefasstes Limit von 1.536 MiB; diese Probe lief deshalb mit 2.048 MiB. Das gemeinsame Probelimit ist nicht der produktive Dienstvertrag.

Sicherung, GP-Neustart, Herunterfahren und ein später separat angeforderter VPS-Neustart verwenden eine Root-Steuerung mit vier fest vorgegebenen Aktionen. Sie übernimmt die bestehende Wartungssperre, beendet die GP-Schreiber, erstellt und prüft das gekoppelte Paket und führt erst danach die angeforderte Schlussaktion aus. Ein abgebrochener Browser darf die bereits angenommene Sicherung nicht abbrechen. Bei einem Fehler wird der GP wieder gestartet; ein eigener systemd-Fehlerdienst deckt auch den Abbruch des Wartungsprozesses ab. Ein ungeprüfter Sicherungspunkt darf keinen VPS-Neustart auslösen.

Der spätere Updater prüft zusätzlich den installierten Vertrag der fünf PostgreSQL-Dienstdateien. Ein Paket mit abweichenden Dienstdateien erfordert eine kontrollierte Moduländerung. Die Zeilenenden dieser Dateien sind in Git festgelegt. Der bestehende kurze Deployablauf bleibt erhalten: frischer gemeinsamer Rückkehrpunkt, Paketprüfung und kurze Funktionsprüfungen. Umfangreiche Restore- und Archivprüfungen bleiben im Nachtablauf.

Der native Wartungsnachweis umfasst 73 Komponenten mit 1.006.057.630 Byte und Paarmanifest-SHA-256 `151678826ef35b1ef845bcf11129f7e12dfd94aef40884bdf2962c67f3501b42`. Für Anwendung und Datenbank wurden echte Prozesse verwendet; ausschließlich der systemd-Steuerbefehl wurde innerhalb des privaten Dateisystemraums auf die eigene Test-GP-Instanz begrenzt. Kein anderer Dienst war darüber ansprechbar. Anschließend wurde genau dieses Paket über den tatsächlichen Root-Recovery-Einstieg wiederhergestellt und mit der vollständigen Anwendung geprüft. Die produktiven Prozesskennungen blieben während dieses abschließenden Restorelaufs unverändert.

## Ablauf des noch ausstehenden Produktivwechsels

Für das Wartungsfenster sind anhand der Übernahme-, Start- und Berichtsmessungen **30–45 Minuten GP-Unterbrechung einzuplanen**. Dies ist eine Planung mit Reserve, keine garantierte Laufzeit. Die Bereitstellung des Releasepakets und das Vorbereiten der leeren Instanz erfolgen vorher. Ein Ubuntu-Neustart gehört nicht dazu.

1. Den geprüften Arbeitsstand als eigenes Release mit sauberem Git-Stand, offizieller Paketprüfung und eindeutigem Paketmanifest bereitstellen. Das laufende SQLite-System vorerst beibehalten. Offsite-Modul 9 über seinen bestehenden Migrationsweg einspielen und dessen Bindung prüfen; der installierte Vorgänger ist noch Modul 8.
2. Freien Speicher, unverändertes Quellschema, Schlüssel, aktuellen GP-Zustand, Paketdateien und alle Dienst-/Repositorybindungen kontrollieren. Der vorbereitende Befehl fordert mindestens 16 GiB frei, der finale Einstieg mindestens 12 GiB. Zusätzlich ist der erwartete Gesamtbedarf aus neuer Quelle, Zielbestand und erster Sicherung zu berücksichtigen. Nur eindeutig eigene, anderweitig belegte Prüfduplikate dürfen Platz freigeben.
3. `server-tools/linux/postgresql/migrate-grabenplaner-postgresql.sh prepare` mit dem exakten SHA-256 des **installierten** Paketmanifests ausführen. Der Befehl legt ausschließlich die dedizierte neue Instanz an. Vorhandene Zielkonten, Verzeichnisse, Units oder ein belegter Port werden abgewiesen. Eine unterbrochene Anlage wird zuerst untersucht und nicht blind erneut ausgeführt.
4. Im freigegebenen Wartungsfenster `execute` mit demselben Manifestfingerprint als betreuten Root-Auftrag ausführen. Die Wartungssperre bleibt über Anhalten, finale SQLite-/Dateikopie, vollständigen Transfer, Inhalts-/Schlüsselprüfung, Konfigurationsanlage und erste gekoppelte Sicherung bestehen. Der Auftrag muss unabhängig von einer abbrechenden SSH-Sitzung laufen.
5. Erst nach diesem Sicherungspunkt veröffentlicht der Ablauf PostgreSQL als maßgeblichen Bestand und startet den GP. Der fertige Dienst muss seine Bereitschaft melden; beide Datenbanken, Identitäten und Strukturen werden anschließend geprüft. Das Ergebnis kennzeichnet die vollständige fachliche Produktivabnahme ausdrücklich weiterhin als ausstehend.
6. Produktiv anmelden, Dienstplan/Zeiten/Rechte und CRM prüfen, Kassenbeleg und Trade-Artikel abfragen, einen begrenzten Bericht erstellen und dessen PDF/Rohertrag prüfen. Die erste gemeinsame Sicherung und die nachfolgende Offsite-/Assurance-Ausführung kontrollieren. Erst mit diesen Nachweisen ist Block 12 abgeschlossen. Keine synthetischen Mitarbeitenden oder Importartikel in den Produktivbestand einfügen.

Der genaue freigegebene Release-/Paketstand und das Wartungsfenster gehören gemäß [Migrationsplan](../POSTGRESQL-BESTANDSAUFNAHME-2026-09-12.md) zum letzten Schritt. Die lokalen Vorbereitungen sind keine Meldung, dass die produktive Datenquelle schon gewechselt wurde.

## Rückkehr und Wiederherstellung

Ein normal gemeldeter Fehler **vor Veröffentlichung** der PostgreSQL-Verantwortung stellt die ursprüngliche SQLite-Konfiguration wieder her und startet den unveränderten GP-Ausgangsstand. Die finale Quellkopie, die ursprüngliche SQLite-Datei und Fehlernachweise bleiben erhalten. Die Abbruchfälle jeder einzelnen Ablaufstufe sind gezielt geprüft. Bei hart beendetem Root-Auftrag ist der dauerhafte Zustand zuerst zu prüfen; ein fehlender Erfolgsbeleg ist keine Freigabe zum Löschen oder Wiederholen.

Ab Veröffentlichung kann die neue Anwendung schreiben. Von da an bleibt PostgreSQL maßgeblich, auch wenn eine nachfolgende Bereitschaftsprüfung fehlschlägt. Ein automatisches Zurückschalten auf SQLite ist gesperrt. Auch das ältere SQLite-Recovery-Werkzeug verweigert PostgreSQL-Sicherungen beziehungsweise einen aktiven PostgreSQL-Paarbezug, bevor es Dateien ersetzt.

Der verbindliche Reparaturweg beginnt mit einer Diagnose auf dem neuen Bestand; ein kompatibler Code-Rückschritt erhält beide Datenbanken und alle seit dem Wechsel geschriebenen Änderungen. Falls eine Datenwiederherstellung nötig ist, werden **beide Datenbanken, geschützte Dateien und die zugehörigen Schlüssel gemeinsam** aus demselben verifizierten Paket wiederhergestellt. Der logische Restore in einer eigenen, anschließend gestoppten Instanz samt Inhalts-, Sequenz-, Rechte-, Schlüssel- und Anwendungsprüfung wurde in Block 10/11 bestanden.

Die Freigabe einer solchen wiederhergestellten Instanz für den Produktivbetrieb ist ein betreuter Root-Vorgang: beschädigten Stand sichern/erhalten, GP und ausschließlich seine eigene Datenbank anhalten, einen frischen unveränderten Restore aus dem geprüften Paar erzeugen, neue Cluster-ID in App-/Betriebskonfiguration und Paarbezug zusammen binden, private Dateien und Schlüssel aus genau diesem Paket bereitstellen, Eigentümer/Port/Ressourcen prüfen und anschließend GP samt Funktionen abnehmen. Eine für HTTP-Importtests veränderte Prüfinstanz darf nicht direkt produktiv übernommen werden. **Der bisherige generische SQLite-`recovery apply` automatisiert diesen PostgreSQL-Tausch nicht.** Die gemessene reine Wiederherstellung ist deshalb keine zugesagte Gesamtdauer für einen betreuten Produktivrestore.

Das anfängliche Betriebsprofil bleibt die tägliche gekoppelte Offsite-Sicherung. Lokaler PITR ist geprüft; kontinuierlicher Offsite-WAL-Transport ist nicht aktiviert. Ein 15-Minuten-RPO wird nicht zugesagt.

## Prüfgrenzen und erhaltene Belege

Die ausführbaren Teile wurden isoliert geprüft; der gesamte Root-Migrationsbefehl hat noch keinen produktiven Durchlauf. Beim Aufbau der zusätzlichen Wartungsprobe wurden falsche relative Modulpfade und ein unvollständiger fester Linux-Suchpfad korrigiert. Ein späterer abgewiesener Versuch enthielt doppelte Schlüssel ausschließlich in der wiederverwendeten Testkonfiguration; der unveränderte strenge Umgebungsdateileser hat dies korrekt erkannt. Die Testkonfiguration wurde berichtigt.

Die finale Quellenaufnahme war bereits vollständig und bytegenau identisch. Ein zusätzlicher langsamer Integritätsscan derselben unveränderten SQLite-Bytes wurde beendet; anschließend wurden beide vollständigen Dateihashes und sämtliche mitgenommenen Dateien erneut bestätigt. Es wird kein bestandener zusätzlicher Integritätslauf behauptet. Die identische zusätzliche 2,59-GB-Kopie wurde erst nach ihrem Nachweis entfernt; das unveränderliche Original aus Block 9 bleibt erhalten.

Der [geprüfte Quellstand](block-12-source-review.json) beschreibt 645 zur Paketquelle gehörende Arbeitsdateien mit 19.236.814 Byte und Fingerprint `74f68739ba9a2171e6244b2893b15ab582a37e1d2cd91ffb285941f8f19c705f`. Alle 252 relativen Modulabhängigkeiten der PostgreSQL-Bibliotheken und Root-Einstiege liegen innerhalb dieses Dateisatzes. Dieser Nachweis beschreibt die Arbeitskopie; er ist ausdrücklich kein offizielles Releasepaket und ersetzt dessen Manifestprüfung nicht.

Der frühere Gesamtlauf der 3.397 Tests wird nicht erneut als vollständig grün ausgegeben: alle darin gefundenen Fehler wurden durch die dokumentierten gezielten Folgeläufe geschlossen. Die neuen Aktivierungs-, Rückkehr-, Recovery- und Paketprüfungen werden separat in den Block-12-Nachweisen festgehalten. Keine Schlüssel, Kontopasswörter oder privaten Belegdaten gehören in diese Dokumentation.

Die [nativen Nachweise](block-12-activation-verification.json) enthalten die gesamte zusätzliche Aktivierungsprobe einschließlich Wiederherstellung. Die [lokalen Prüfgruppen](block-12-local-verification.json) dokumentieren ihre einzelnen Protokolle; überlappende Fälle werden nicht als zusätzliche eindeutige Tests gezählt. Der Persistenzaudit meldet keine unklassifizierten produktiven Zugriffe und keine Grenzverletzungen.
