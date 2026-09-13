# Block 12: Umstellungsvorbereitung und Wartungsablauf

Stand 13.09.2026. Die BlÃ¶cke 9â€“11 sind abgeschlossen. Der Benutzer hat mit â€žBitte Block 12 loslegenâ€œ die VerÃ¶ffentlichung und das beschriebene Wartungsfenster freigegeben. **Der produktive Wechsel und seine Nachkontrolle stehen beim Erstellen des Releasepakets noch aus.** Der laufende GP verwendet zu diesem Zeitpunkt weiterhin SQLite. Ein VPS-Neustart gehÃ¶rt nicht zum Auftrag.

Der erneute Produktivcheck um 09:21 UTC bestÃ¤tigte v0.92.37-beta, alle 558 installierten Manifestdateien und vier erfolgreiche interne/Ã¶ffentliche Live-/Ready-Antworten. Der abgeschlossene nÃ¤chtliche Restore war erfolgreich, sein anschlieÃŸender Caddy-Check scheiterte an einer erhaltenen temporÃ¤ren PrÃ¼fdatei. Das Release verwendet pro PrÃ¼fung eigene Dateien; zwei native Wiederholungen mit absichtlich vorhandenem VorgÃ¤ngerartefakt bestanden. Die beiden Offsite-Schreibdienste erhalten auÃŸerdem die optionalen PostgreSQL-Arbeits-/Sicherungspfade; die Clusterdateien bleiben innerhalb dieser Dienste nur lesbar. Diese Ã„nderungen ergÃ¤nzen die bisherigen Qualifikationsbelege und werden gesondert geprÃ¼ft.

## GeprÃ¼fter Stand

Die zusÃ¤tzliche Instanz `activation-12` bildet die endgÃ¼ltigen Namen `grabenplaner_core` und `grabenplaner_sales` ab. Sie lÃ¤uft ausschlieÃŸlich im privaten Netzwerk ihrer jeweiligen Probe. Der vorhandene Lebensatlas-Cluster auf Port 5432 gehÃ¶rt nicht zu dieser Migration.

| Nachweis | Ergebnis |
| --- | --- |
| Frische Instanz und Rollen | PostgreSQL 18, acht getrennte Konten, zwei Datenbanken; Anlage 6,3 Sekunden |
| VollstÃ¤ndige erneute Ãœbernahme | 248 Quelltabellen, 2.887.715 Zeilen; 821,3 Sekunden |
| InhaltsprÃ¼fung und endgÃ¼ltige Datenbanknamen | Derselbe vollstÃ¤ndige Inhalt wie Block 9; 124,0 Sekunden |
| GeschÃ¼tzte Daten nach der Ãœbernahme | 55 verschlÃ¼sselte Dateien, 55 Verweise, 113 geschÃ¼tzte DatensÃ¤tze und der separate ImportarchivschlÃ¼ssel; 27,8 Sekunden |
| TatsÃ¤chlicher Anwendungsbenutzer | VollstÃ¤ndiger Serverstart als `grabenplaner` mit Produktionskonfiguration in einem privaten Dateisystem-/Netzwerkraum bestanden |
| Fachliche HTTP-PrÃ¼fung | Anmeldung, Dienstplan/PDF, historische Sony-Suche, acht parallele Abfragen, Importkonflikt, Import/RÃ¼cknahme, Rechteentzug und 544 Regelwerksbelege bestanden |
| Berichterstellung | Januarbericht mit 2.239 Positionen als PDF Ã¼ber die automatische Warteschlange fertiggestellt |
| Datenbankdownload Ã¼ber HTTP | 995.840.000 Byte vollstÃ¤ndig Ã¼bertragen; Download 134,7 Sekunden; acht gleichzeitige Abfragen erfolgreich |
| Finale Quellenaufnahme | TatsÃ¤chliches Root-Werkzeug mit angehaltenem Test-GP und Wartungssperre; SQLite-Kopie bytegenau identisch, alle 65 mitgenommenen Dateien und die SchlÃ¼sselkonfiguration geprÃ¼ft |
| Dienstdefinitionen | Alle fÃ¼nf neuen Vorlagen durch `systemd-analyze verify` geprÃ¼ft; keine Installation dabei |
| TatsÃ¤chlicher Root-Wartungsweg | Angenommener Auftrag, sauberer GP-Stopp, gemeinsame Sicherung, PrÃ¼fung und neuer bereiter GP-Prozess; 204,1 Sekunden |
| Nachtlauf mit endgÃ¼ltigen Datenbanknamen | Wiederherstellung genau dieses Sicherungspakets Ã¼ber den Root-Recovery-Einstieg samt vollstÃ¤ndiger HTTP-/PDF-Anwendung erfolgreich; 169,3 Sekunden |

Die historischen PrÃ¼fdaten entsprechen dem unverÃ¤nderlichen Block-9-Stand, nicht dem inzwischen mÃ¶glicherweise weitergeschriebenen Produktivbestand. Vor der tatsÃ¤chlichen Umstellung wird deshalb eine **neue finale Quelle** aufgenommen und vollstÃ¤ndig geprÃ¼ft. Die historische SQLite-SHA-256 lautet `aa37fbd4ce0b9d1c914cda7df6ac8c56b6437dd3ca6e091b8e040d6e270a84c3`; der geprÃ¼fte Ã¼bernommene Dateninhalt hat SHA-256 `b37ad81733768b2e0c90f728e7d5c4a33dca7b6f33c7cb4f98599db254ece379`.

Beim Download waren die zusÃ¤tzlichen Anfragen nach 121â€“1.827 ms beantwortet, Ã¼berwiegend nach 121â€“757 ms. Die Lastmessung aus Block 11 bleibt maÃŸgeblich fÃ¼r die Berichtslast: 48 erfolgreiche parallele Fachabfragen, p95 2.557 ms. Daraus wird keine produktive Antwortzeitgarantie abgeleitet.

## Betriebswege

Die Anwendung erhÃ¤lt ausschlieÃŸlich vier GeschÃ¤ftszugÃ¤nge fÃ¼r Core/Sales und ihre Leser. Die acht vollstÃ¤ndigen Betriebs-/WiederherstellungszugÃ¤nge bleiben in einer Root-Datei. Anwendung, Betriebskonfiguration, Quellstand, Paketmanifest und PostgreSQL-Instanz sind ausdrÃ¼cklich miteinander verbunden. Ein einzelnes `DB_PROVIDER=postgresql` Ã¶ffnet keinen unkontrollierten Zugriff und bewirkt keinen automatischen RÃ¼ckfall auf SQLite.

Die eigene Datenbank-Unit verwendet `127.0.0.1:55486`, 32 Verbindungen, 128 MiB gemeinsame Puffer und begrenzte Arbeitsspeicherwerte. Core-App darf zehn, Sales-App acht gleichzeitige Verbindungen Ã¶ffnen; dadurch bleibt der administrative Download auch mit laufenden Such-/Berichtsworkern mÃ¶glich. PostgreSQL und GP erhalten jeweils ein eigenes Limit von 1.536 MiB. In der isolierten gemeinsamen Probe benÃ¶tigten beide Prozesse einschlieÃŸlich zugerechnetem Dateicache mehr als ein zusammengefasstes Limit von 1.536 MiB; diese Probe lief deshalb mit 2.048 MiB. Das gemeinsame Probelimit ist nicht der produktive Dienstvertrag.

Sicherung, GP-Neustart, Herunterfahren und ein spÃ¤ter separat angeforderter VPS-Neustart verwenden eine Root-Steuerung mit vier fest vorgegebenen Aktionen. Sie Ã¼bernimmt die bestehende Wartungssperre, beendet die GP-Schreiber, erstellt und prÃ¼ft das gekoppelte Paket und fÃ¼hrt erst danach die angeforderte Schlussaktion aus. Ein abgebrochener Browser darf die bereits angenommene Sicherung nicht abbrechen. Bei einem Fehler wird der GP wieder gestartet; ein eigener systemd-Fehlerdienst deckt auch den Abbruch des Wartungsprozesses ab. Ein ungeprÃ¼fter Sicherungspunkt darf keinen VPS-Neustart auslÃ¶sen.

Der spÃ¤tere Updater prÃ¼ft zusÃ¤tzlich den installierten Vertrag der fÃ¼nf PostgreSQL-Dienstdateien. Ein Paket mit abweichenden Dienstdateien erfordert eine kontrollierte ModulÃ¤nderung. Die Zeilenenden dieser Dateien sind in Git festgelegt. Der bestehende kurze Deployablauf bleibt erhalten: frischer gemeinsamer RÃ¼ckkehrpunkt, PaketprÃ¼fung und kurze FunktionsprÃ¼fungen. Umfangreiche Restore- und ArchivprÃ¼fungen bleiben im Nachtablauf.

Der native Wartungsnachweis umfasst 73 Komponenten mit 1.006.057.630 Byte und Paarmanifest-SHA-256 `151678826ef35b1ef845bcf11129f7e12dfd94aef40884bdf2962c67f3501b42`. FÃ¼r Anwendung und Datenbank wurden echte Prozesse verwendet; ausschlieÃŸlich der systemd-Steuerbefehl wurde innerhalb des privaten Dateisystemraums auf die eigene Test-GP-Instanz begrenzt. Kein anderer Dienst war darÃ¼ber ansprechbar. AnschlieÃŸend wurde genau dieses Paket Ã¼ber den tatsÃ¤chlichen Root-Recovery-Einstieg wiederhergestellt und mit der vollstÃ¤ndigen Anwendung geprÃ¼ft. Die produktiven Prozesskennungen blieben wÃ¤hrend dieses abschlieÃŸenden Restorelaufs unverÃ¤ndert.

## Ablauf des noch ausstehenden Produktivwechsels

FÃ¼r das Wartungsfenster sind anhand der Ãœbernahme-, Start- und Berichtsmessungen **30â€“45 Minuten GP-Unterbrechung einzuplanen**. Dies ist eine Planung mit Reserve, keine garantierte Laufzeit. Die Bereitstellung des Releasepakets und das Vorbereiten der leeren Instanz erfolgen vorher. Ein Ubuntu-Neustart gehÃ¶rt nicht dazu.

1. Den geprÃ¼ften Arbeitsstand als eigenes Release mit sauberem Git-Stand, offizieller PaketprÃ¼fung und eindeutigem Paketmanifest bereitstellen. Das laufende SQLite-System vorerst beibehalten. Offsite-Modul 9 Ã¼ber seinen bestehenden Migrationsweg einspielen und dessen Bindung prÃ¼fen; der installierte VorgÃ¤nger ist noch Modul 8.
2. Freien Speicher, unverÃ¤ndertes Quellschema, SchlÃ¼ssel, aktuellen GP-Zustand, Paketdateien und alle Dienst-/Repositorybindungen kontrollieren. Der vorbereitende Befehl fordert mindestens 16 GiB frei, der finale Einstieg mindestens 12 GiB. ZusÃ¤tzlich ist der erwartete Gesamtbedarf aus neuer Quelle, Zielbestand und erster Sicherung zu berÃ¼cksichtigen. Nur eindeutig eigene, anderweitig belegte PrÃ¼fduplikate dÃ¼rfen Platz freigeben.
3. `server-tools/linux/postgresql/migrate-grabenplaner-postgresql.sh prepare` mit dem exakten SHA-256 des **installierten** Paketmanifests ausfÃ¼hren. Der Befehl legt ausschlieÃŸlich die dedizierte neue Instanz an. Vorhandene Zielkonten, Verzeichnisse, Units oder ein belegter Port werden abgewiesen. Eine unterbrochene Anlage wird zuerst untersucht und nicht blind erneut ausgefÃ¼hrt.
4. Im freigegebenen Wartungsfenster `execute` mit demselben Manifestfingerprint als betreuten Root-Auftrag ausfÃ¼hren. Die Wartungssperre bleibt Ã¼ber Anhalten, finale SQLite-/Dateikopie, vollstÃ¤ndigen Transfer, Inhalts-/SchlÃ¼sselprÃ¼fung, Konfigurationsanlage und erste gekoppelte Sicherung bestehen. Der Auftrag muss unabhÃ¤ngig von einer abbrechenden SSH-Sitzung laufen.
5. Erst nach diesem Sicherungspunkt verÃ¶ffentlicht der Ablauf PostgreSQL als maÃŸgeblichen Bestand und startet den GP. Der fertige Dienst muss seine Bereitschaft melden; beide Datenbanken, IdentitÃ¤ten und Strukturen werden anschlieÃŸend geprÃ¼ft. Das Ergebnis kennzeichnet die vollstÃ¤ndige fachliche Produktivabnahme ausdrÃ¼cklich weiterhin als ausstehend.
6. Produktiv anmelden, Dienstplan/Zeiten/Rechte und CRM prÃ¼fen, Kassenbeleg und Trade-Artikel abfragen, einen begrenzten Bericht erstellen und dessen PDF/Rohertrag prÃ¼fen. Die erste gemeinsame Sicherung und die nachfolgende Offsite-/Assurance-AusfÃ¼hrung kontrollieren. Erst mit diesen Nachweisen ist Block 12 abgeschlossen. Keine synthetischen Mitarbeitenden oder Importartikel in den Produktivbestand einfÃ¼gen.

Der genaue freigegebene Release-/Paketstand und das Wartungsfenster gehÃ¶ren gemÃ¤ÃŸ [Migrationsplan](../POSTGRESQL-BESTANDSAUFNAHME-2026-09-12.md) zum letzten Schritt. Die lokalen Vorbereitungen sind keine Meldung, dass die produktive Datenquelle schon gewechselt wurde.

## RÃ¼ckkehr und Wiederherstellung

Ein normal gemeldeter Fehler **vor VerÃ¶ffentlichung** der PostgreSQL-Verantwortung stellt die ursprÃ¼ngliche SQLite-Konfiguration wieder her und startet den unverÃ¤nderten GP-Ausgangsstand. Die finale Quellkopie, die ursprÃ¼ngliche SQLite-Datei und Fehlernachweise bleiben erhalten. Die AbbruchfÃ¤lle jeder einzelnen Ablaufstufe sind gezielt geprÃ¼ft. Bei hart beendetem Root-Auftrag ist der dauerhafte Zustand zuerst zu prÃ¼fen; ein fehlender Erfolgsbeleg ist keine Freigabe zum LÃ¶schen oder Wiederholen.

Ab VerÃ¶ffentlichung kann die neue Anwendung schreiben. Von da an bleibt PostgreSQL maÃŸgeblich, auch wenn eine nachfolgende BereitschaftsprÃ¼fung fehlschlÃ¤gt. Ein automatisches ZurÃ¼ckschalten auf SQLite ist gesperrt. Auch das Ã¤ltere SQLite-Recovery-Werkzeug verweigert PostgreSQL-Sicherungen beziehungsweise einen aktiven PostgreSQL-Paarbezug, bevor es Dateien ersetzt.

Der verbindliche Reparaturweg beginnt mit einer Diagnose auf dem neuen Bestand; ein kompatibler Code-RÃ¼ckschritt erhÃ¤lt beide Datenbanken und alle seit dem Wechsel geschriebenen Ã„nderungen. Falls eine Datenwiederherstellung nÃ¶tig ist, werden **beide Datenbanken, geschÃ¼tzte Dateien und die zugehÃ¶rigen SchlÃ¼ssel gemeinsam** aus demselben verifizierten Paket wiederhergestellt. Der logische Restore in einer eigenen, anschlieÃŸend gestoppten Instanz samt Inhalts-, Sequenz-, Rechte-, SchlÃ¼ssel- und AnwendungsprÃ¼fung wurde in Block 10/11 bestanden.

Die Freigabe einer solchen wiederhergestellten Instanz fÃ¼r den Produktivbetrieb ist ein betreuter Root-Vorgang: beschÃ¤digten Stand sichern/erhalten, GP und ausschlieÃŸlich seine eigene Datenbank anhalten, einen frischen unverÃ¤nderten Restore aus dem geprÃ¼ften Paar erzeugen, neue Cluster-ID in App-/Betriebskonfiguration und Paarbezug zusammen binden, private Dateien und SchlÃ¼ssel aus genau diesem Paket bereitstellen, EigentÃ¼mer/Port/Ressourcen prÃ¼fen und anschlieÃŸend GP samt Funktionen abnehmen. Eine fÃ¼r HTTP-Importtests verÃ¤nderte PrÃ¼finstanz darf nicht direkt produktiv Ã¼bernommen werden. **Der bisherige generische SQLite-`recovery apply` automatisiert diesen PostgreSQL-Tausch nicht.** Die gemessene reine Wiederherstellung ist deshalb keine zugesagte Gesamtdauer fÃ¼r einen betreuten Produktivrestore.

Das anfÃ¤ngliche Betriebsprofil bleibt die tÃ¤gliche gekoppelte Offsite-Sicherung. Lokaler PITR ist geprÃ¼ft; kontinuierlicher Offsite-WAL-Transport ist nicht aktiviert. Ein 15-Minuten-RPO wird nicht zugesagt.

## PrÃ¼fgrenzen und erhaltene Belege

Die ausfÃ¼hrbaren Teile wurden isoliert geprÃ¼ft; der gesamte Root-Migrationsbefehl hat noch keinen produktiven Durchlauf. Beim Aufbau der zusÃ¤tzlichen Wartungsprobe wurden falsche relative Modulpfade und ein unvollstÃ¤ndiger fester Linux-Suchpfad korrigiert. Ein spÃ¤terer abgewiesener Versuch enthielt doppelte SchlÃ¼ssel ausschlieÃŸlich in der wiederverwendeten Testkonfiguration; der unverÃ¤nderte strenge Umgebungsdateileser hat dies korrekt erkannt. Die Testkonfiguration wurde berichtigt.

Die finale Quellenaufnahme war bereits vollstÃ¤ndig und bytegenau identisch. Ein zusÃ¤tzlicher langsamer IntegritÃ¤tsscan derselben unverÃ¤nderten SQLite-Bytes wurde beendet; anschlieÃŸend wurden beide vollstÃ¤ndigen Dateihashes und sÃ¤mtliche mitgenommenen Dateien erneut bestÃ¤tigt. Es wird kein bestandener zusÃ¤tzlicher IntegritÃ¤tslauf behauptet. Die identische zusÃ¤tzliche 2,59-GB-Kopie wurde erst nach ihrem Nachweis entfernt; das unverÃ¤nderliche Original aus Block 9 bleibt erhalten.

Der [geprÃ¼fte Quellstand](block-12-source-review.json) beschreibt 645 zur Paketquelle gehÃ¶rende Arbeitsdateien mit 19.236.814 Byte und Fingerprint `74f68739ba9a2171e6244b2893b15ab582a37e1d2cd91ffb285941f8f19c705f`. Alle 252 relativen ModulabhÃ¤ngigkeiten der PostgreSQL-Bibliotheken und Root-Einstiege liegen innerhalb dieses Dateisatzes. Dieser Nachweis beschreibt die Arbeitskopie; er ist ausdrÃ¼cklich kein offizielles Releasepaket und ersetzt dessen ManifestprÃ¼fung nicht.

Der frÃ¼here Gesamtlauf der 3.397 Tests wird nicht erneut als vollstÃ¤ndig grÃ¼n ausgegeben: alle darin gefundenen Fehler wurden durch die dokumentierten gezielten FolgelÃ¤ufe geschlossen. Die neuen Aktivierungs-, RÃ¼ckkehr-, Recovery- und PaketprÃ¼fungen werden separat in den Block-12-Nachweisen festgehalten. Keine SchlÃ¼ssel, KontopasswÃ¶rter oder privaten Belegdaten gehÃ¶ren in diese Dokumentation.

Die [nativen Nachweise](block-12-activation-verification.json) enthalten die gesamte zusÃ¤tzliche Aktivierungsprobe einschlieÃŸlich Wiederherstellung. Die [lokalen PrÃ¼fgruppen](block-12-local-verification.json) dokumentieren ihre einzelnen Protokolle; Ã¼berlappende FÃ¤lle werden nicht als zusÃ¤tzliche eindeutige Tests gezÃ¤hlt. Der Persistenzaudit meldet keine unklassifizierten produktiven Zugriffe und keine Grenzverletzungen.
