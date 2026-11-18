# Deploy-Recovery: Core und eigene GP-Inhalte

Stand: 17.11.2026, Entwicklungszweig
`feature/deploy-recovery-core-owned-20261116`. Der kleinere Modus verwendet V4 mit
`basis:fresh-source-rebuild`. Er sichert GP-eigene Inhalte und erlaubt, reine
Importbestände später aus sechs frisch erzeugten Access-Dateien neu aufzubauen.
Alte Originaldateien, deren Hashes und ein bestehendes Quellarchiv sind dafür
keine Voraussetzung. Der Ansatz ist noch nicht produktiv aktiviert oder
ausgeliefert. Der native durchgängige V4-Neuaufbau mit neuen Testdateien ist
bestanden. Der neue Sicherungspunkt des echten Bestands ist auf einer isolierten
Kopie erstellt und gemessen; seine schnelle Wiederherstellung und der
unabhängige Inhaltsvergleich sind bestanden. Ein vollständiger Neuaufbau des
echten Bestands mit aktuellen Access-Dateien ist nicht abschließend qualifiziert;
der zuletzt laufende Test wurde auf Benutzerwunsch kontrolliert beendet.

## Auswahl in den GP-Einstellungen

Unter **Einstellungen → System & Backups → Sicherungsumfang bei Updates**
verwaltet die berechtigte Serveradministration die globale Voreinstellung.
Sie benötigt wie die bestehende Backupverwaltung die Rolle `developer`,
`it_admin` oder `admin` und das Recht `backup:write`.

- **Vollständig: GP Core und Sales** ist die Voreinstellung, solange keine
  andere Auswahl gespeichert wurde. Sie bevorzugt den vollständigen Weg.
- **GP Core und eigene Inhalte** bevorzugt den kleineren Sicherungspunkt.
  Importwerte, zugehörige Historien und abgeleitete Zuordnungen lassen sich
  bei Bedarf aus sechs neuen Access-Dateien aufbauen; eigene GP-Inhalte
  einschließlich Bildern und manuellen Änderungen bleiben gesichert.

Die Auswahl wird erst mit **Auswahl speichern** wirksam. Die Karte liest und
schreibt `/api/backup/deploy-scope` mit der bestätigten Revision. Eine parallel
geänderte Einstellung muss neu geladen werden, bevor sie überschrieben wird.
Ohne bestätigte Serverantwort bleibt die Bearbeitung gesperrt.

Die Präferenz gilt für Vorsicherungen bei Updates mit automatischer Auswahl
(`--verification auto`). Ist Core Plus gewählt und das Paket dafür ungeeignet
oder schlägt die Core-Plus-Sicherung fehl, endet der Deploy vor dem App-Tausch.
Der volle Umfang erfordert die ausdrückliche CLI-Auswahl oder die gespeicherte
Voll-Einstellung. Nächtliche Vollsicherungen und Recovery Assurance verwenden
weiterhin den vollständigen Umfang. Die Einstellung wird bei einem ausgelösten
Update angewendet.

## Manuelle Google-Drive-Sicherung

Die zusätzliche Karte **Google-Drive-Sicherungen** unter **System & Backups**
ermöglicht berechtigten Backupadministratoren eine vollständige Sicherung von
Core, Sales, eigenen GP-Dateien und Wiederherstellungskonfiguration. Diese
manuelle Aktion verwendet immer den vollständigen Umfang; die Auswahl für
Updates ändert sie nicht. Der normale lokale Sicherungsschritt hält die
Anwendung vorübergehend an und startet sie anschließend wieder. Der Auftrag
und der Upload laufen unabhängig vom Browser. Es wird kein Wiederherstellungs-
oder Assurance-Test und keine zusätzliche Repository-Bereinigung gestartet.

Die Tabelle zeigt ausschließlich im gebundenen Google-Drive-Repository
bestätigte Grabenplaner-Sicherungspunkte. Sie nennt Zeitpunkt, Dateiumfang,
Auslöser und Status. Während eines laufenden Vorgangs kann sie ausdrücklich
den zuletzt bestätigten Stand anzeigen; Änderungen bleiben dann gesperrt.
Spaltenansicht, Breiten, Reihenfolge und Sortierung werden im Browser je
angemeldetem Konto gespeichert. Eine unterbrochene Verbindung gilt nicht als
Nachweis eines fehlgeschlagenen Hintergrundauftrags.

Ältere manuell erstellte Punkte lassen sich nach konkreter Auswahl,
Bestätigung und Passwortprüfung löschen. Automatische Punkte und der jüngste
Sicherungspunkt bleiben geschützt. Der Server prüft die vollständige
Snapshotkennung, Installation, Repository, Pfad und Tags erneut; andere
Snapshots werden unverändert nachgewiesen. Nicht mehr benötigter Speicherplatz
wird erst bei der regulären automatischen Bereinigung freigegeben.

Die API `/api/backup/drive` verwendet einen festen lokalen, privilegierten
Broker. Sie übergibt weder Providerzugänge noch freie Befehle oder Dateipfade.
Die normalen Installations- und Updatepfade richten die feste Socketfähigkeit
erst nach erfolgreichem Appabschluss ein. Bis zur sicheren Einrichtung bleibt
die API nicht verfügbar. Diese Erweiterung ist im Entwicklungszweig umgesetzt
und noch nicht auf dem VPS installiert.

## Sicherungsgrenze

Der kleinere Punkt enthält die vollständige Core-Datenbank, geschützte Dateien
und Schlüssel sowie das vollständige Sales-Schema. Eigene GP-Inhalte bleiben
erhalten: manuelle Artikel und Änderungen, eigene Preise, Bilder einschließlich
Löschmarkierungen, Notizen, Zuordnungen, Entscheidungen, eigene
Rücknahme-Vorwerte, PDF-Berichte und Auditdaten. Unbekannte Quellen und Tabellen
sowie bereits teilweise angewendete oder zurückgenommene Vorgänge werden
konservativ behalten.

Rekonstruierbare Access-Historien, technische Importzeilen, Verknüpfungen und
abgeleitete Identitäten dürfen beim Neuaufbau neu entstehen. V4 behauptet keine
bytegleiche Wiederherstellung dieser früheren Importgeneration. Die für eigene
GP-Daten erforderlichen ursprünglichen Anker, IDs, Revisionen und Werte bleiben
hingegen im Punkt. Core-Bindungen, Haltevermerke, Artikelreferenzen und eigene
Rücknahme-Vorwerte bestimmen ihren Beziehungsabschluss.

GP-Artikelidentitäten und unveränderliche Nachweise bleiben ebenfalls erhalten:
Produkt-UUIDs, ursprüngliche Quellverknüpfungen, erste GTIN-Eigentümerschaften
und geschützte frühere Kassa-Publikationsentscheidungen lassen sich aus sechs
neuen Dateien mit anderen Hashes nicht identisch rekonstruieren. Die Katalog-
Köpfe benötigen per Fremdschlüssel ihre aktuelle Revision; damit bleiben auch
deren aktuelle Beschreibung, Aktivstatus und passende Kennungen als
konservative Identitätsbasis im Punkt. Es wird nicht für jeden Produktkopf
eine konkrete GP-Verwendung verlangt. Alte Kassa-Publikationsnachweise binden
auch automatisch erzeugte Zuordnungen in ihren geschützten Anzahl-/Generations-
Beweisen; sie werden unverändert erhalten. Die neue Publikation baut gewöhnliche
Artikelzuordnungen dagegen neu auf und übernimmt nur authentifizierte GP-
Auswahlentscheidungen. V4 bedeutet daher keine vollständige Entfernung jedes
Access-abgeleiteten Einzelwerts aus allen GP-Identitäts- und Auditregistern.

Ein Import wird nur als bekannte Access-Herkunft ausgelassen,
wenn Profil, Quellsystem, Manifest, Schema und Lauf-HMAC einschließlich Akteur
und Versuch zusammenpassen. Ein lediglich kopierter Profilname reicht nicht.
Unbekannte, nicht authentifizierbare und manuelle Daten werden dadurch nicht
zu löschbarem Importbestand. Auch authentifizierte, noch nicht angewendete
Access-Vorschauen werden ausgelassen, wenn der Snapshot ausdrücklich keine
Änderungs-Vorwerte und keine angewendeten oder zurückgenommenen Zeilen nachweist.
Ihre GP-Prüfentscheidungen bleiben in Core, Laufmanifesten und Ereignissen
erhalten. Die automatisch erzeugten Vorschauzeilen sind keine eigenen Inhalte.
Beim Restore werden bekannte Access-Quellen bis zum neuen Einlesen als
unterbrochen und erneut hochzuladen gekennzeichnet; eine leere Vorschau wird
nicht als verwendbarer alter Import ausgegeben.

`pg_dump` lässt im vollständigen aktuellen Sales-Schema exakt 32 Tabellendaten
mit `--exclude-table-data` aus. Schema, Constraints und Sequenzen bleiben
enthalten; der SQL-Dumptext wird nicht nachträglich bearbeitet:

- Sieben reine Kassa-Zeilenrelationen: `kassa.cash_snapshot_0` bis
  `kassa.cash_snapshot_6`.
- 23 Tabellen mit einer getrennten Auswahl eigener oder erforderlicher Zeilen:
  die sieben technischen Importrelationen `data_import_rows`,
  `data_import_changes`, `data_import_links`, `data_import_payload_blocks`,
  `data_import_row_payload_refs`, `data_import_change_payload_refs` und
  `data_import_run_state_counts`; die acht Historienrelationen
  `import_history_records`, `import_history_versions`, `import_history_segments`,
  `import_history_references`, `import_history_holds`,
  `import_history_snapshots`, `import_history_snapshot_members` und
  `import_history_snapshot_attestations`; die drei Stammdatenrelationen
  `import_master_records`, `import_master_segments` und
  `import_master_relations`; sowie `sales_article_revisions`,
  `sales_article_price_snapshots`, `sales_article_identifiers`,
  `sales_article_import_impacts` und `sales_article_import_findings`.
- Zwei abgeleitete Caches: `trade.sales_article_search_projection` und
  `trade.sales_article_search_dirty`. Die Artikelsuche wird nach dem
  vollständigen Neuaufbau aus den maßgeblichen Artikelrevisionen aufgebaut.

Die verschlüsselte Datei `access-owned-state.rows` enthält nur die behaltenen
Zeilen der 23 ausgewählten Tabellen. Sie führt keine Wertrezepte oder
Identitätslisten für jede ausgelassene Importzeile. Eigene Vorwerte, manuelle
und Rücknahme-Artikelsnapshots sowie deren benötigte frühere Revisionen, Preise
und Kennungen bleiben unverändert. Alle kleinen Artikelköpfe und ihre aktuellen
Revisionen bilden zusätzlich eine begrenzte Ausgangsbasis; daraus folgt keine
Aufbewahrung aller importierten Preise.

Import-Laufköpfe und Ereignisprotokolle bleiben im normalen Dump. Ebenso bleiben
Artikelbilder, Quellverknüpfungen, Kennungsansprüche, Kassa-Zuordnungen,
Publikationsmetadaten, Berichte und sonstige nicht ausdrücklich ausgeschlossene
Daten erhalten. Automatisch entstandene und manuelle Kassa-Zuordnungen werden
nicht anhand einer vermuteten Herkunft getrennt. Fremdschlüssel werden vor dem
Sichern auf den ausgewählten Zeilenabschluss geprüft. Eine nicht auflösbare
Referenz verhindert den kleineren Punkt.

## Kleiner Sicherungspunkt ohne alte Access-Dateien

Die Sicherung lässt sich erstellen, bevor neue Access-Dateien bereitliegen.
V4 benötigt weder den alten Archivindex noch alte `.source`-Objekte und kopiert
sie nicht in den Punkt. Der kompakte Neuaufbauplan beschreibt unterstützte
Quellarten, Profile, Akteure und die behaltenen Kassa-Metadaten. Er behauptet
keine bereits vorhandene oder bereits geprüfte neue Quelldatei.

Der Punkt verwendet `grabenplaner-postgresql-deploy-owned`, Endung `.owned`,
Umfang `deploy-owned`, `basis:fresh-source-rebuild`, `requiresFreshAccess:true`
und `fullRecovery:false`. Die eigene Sales-Auswahl hat das Format
`grabenplaner-access-owned-state-v4` und enthält keinen erfundenen alten
Archivhash. Vollständige Paare behalten `grabenplaner-postgresql-pair` und
`.pair`. Nacht-, Offsite- und Assurance-Sicherungen bleiben vollständig und
unverändert. Kleinere Punkte ersetzen oder löschen diese Paare nicht.

Der kleine Deploy-Test stellt Core und die behaltenen Sales-Inhalte in einem
eigenen PostgreSQL-Cluster wieder her. Er prüft Dateien, Schema, ausgewählte
Zeilenzahlen, Sequenzen und GP-Funktionen wie Login, Dienstplan/PDF, parallele
berechtigte Zugriffe und Sessionentzug. Ausgelassene Importrelationen bleiben
leer. Vor dem HTTP-Test werden die früheren Kassa-Bereitschafts- und
Publikationsverweise in dieser isolierten Kopie ausdrücklich ungültig gemacht;
leere Rohdaten dürfen nicht als fertiger alter Import erscheinen. Originale
Zuordnungen und die nachgewiesenen Metadaten bleiben als Wiederaufbaugrundlage
behalten. Das Ergebnis bestätigt Core und eigene Inhalte; es bestätigt keinen
vollständigen Importbestand und keinen vollständigen Sales-Recovery-Test.

## Wiederaufbau aus einer neuen Access-Generation

Für die isolierte Generalprobe werden diese sechs Dateien unter ihren
festgelegten Namen in einem privaten Eingabeverzeichnis bereitgestellt:

| Importart | Dateiname |
| --- | --- |
| `trade` | `Trade_Daten.accdb` |
| `cash` | `Kassen_Umsätze.accdb` |
| `bestell` | `Trade_DatenBestell.accdb` |
| `weum` | `WEUM.accdb` |
| `inventur` | `InventurProtokoll.accdb` |
| `lieferantenrechnungen` | `TRADE_AusgangsRech.accdb` |

Aufruf des getrennten Linux-Prüfwerkzeugs:

```sh
node server-tools/linux/lib/deploy-owned-recovery.js BUNDLE MARKER SOURCE_ROOT TARGET_ROOT --fresh-access /private/dir
```

Alle Pfade müssen den privaten Pfad- und Eigentumsprüfungen entsprechen.
`/private/dir` steht für das tatsächliche Verzeichnis mit den sechs Dateien.
Der kontrollierende Prozess prüft die Dateien und stellt kontrollierte private
Kopien für den Testdienst bereit. Dessen PostgreSQL-Cluster und Netz sind
isoliert; produktive Datenverzeichnisse und PostgreSQL-Sockets sind nicht
zugänglich. Bereitgestellte Dateien und neue Datei-Hashes bezeichnen die neue
Generation, nicht die früher gesicherten Importwerte.

Die Wiederherstellung lädt zuerst Schema und normale behaltene Daten,
anschließend die geschützte eigene Auswahl und danach die PostgreSQL-
Nachbedingungen einschließlich Fremdschlüsseln. Der reguläre Access-Leser und
Importmotor prüfen und übernehmen die neue Generation. Neue Quellen erhalten
ihre tatsächlichen Datei-, Profil-, Akteur- und Laufnachweise; alte Ausnahme-
oder Zählfreigaben werden nicht pauschal auf andere Dateien übertragen.

Erhaltene GP-Anker dürfen nur bei tatsächlich gleichem normalisiertem Inhalt
als unverändert übernommen werden. Ein authentifizierter ursprünglicher
Import-Link darf als echter Vergleichsstand dienen, wenn seine ursprünglichen
Werte und Zielrevision zum geschützten Anker passen. Der reguläre Importmotor
kann dann geänderte neue Quellwerte unter derselben Identität fortschreiben;
die geschützten GP-Referenzen bleiben erhalten. Für tatsächliche eigene
Änderungen, Rücknahmen und offene eigene Bearbeitungen entsteht daraus keine
Freigabe. Abweichende eigene Werte bleiben erhalten und werden ausdrücklich als
Konflikt behandelt. Eigene Artikel, Preise, Bilder,
Zuordnungen, Referenzen und Rücknahme-Vorwerte dürfen nicht durch einen
Neuimport überschrieben werden. Ein neu aufgebauter Kassenbestand benötigt
seine eigene Dataset- und Publikationsherkunft; er darf nicht unter dem alten
Dateihash als unveränderter alter Bestand ausgegeben werden. Nach dem
Wiederaufbau entsteht der Artikelsuchcache aus den maßgeblichen Revisionen.
Fehlende oder unpassende Dateien, offene reguläre Importgates und ein
unvollständiger Neuaufbau verhindern den Erfolgsnachweis.

Der Platzvorabcheck berücksichtigt die ursprünglichen vollständigen Core-/Sales-
Größen und zusätzlichen Arbeitsbedarf. Die kleine Dump-Größe darf keinen großen
Wiederaufbau autorisieren. Auch eine erfolgreiche Generalprobe ändert `.owned`
nicht in einen vollständigen Assurance-Nachweis. Das Werkzeug übernimmt keine
Daten in den laufenden Produktivcluster; eine echte Notfallübernahme benötigt
den regulären kontrollierten Wiederherstellungsablauf.

## Frühere Verfahren bleiben getrennt

Der vorhandene Modus `--rehydrate` bleibt für frühere Punkte mit exakter
Archivbindung erhalten. Er benötigt die ursprünglich gebundenen Serverobjekte
beziehungsweise exakt passenden Access-Originale. Fehlende oder beschädigte
Objekte führen dort weiterhin zum Fehler. Er ist kein Ersatz für den neuen
Aufruf `--fresh-access` und darf dessen andere Bedeutung nicht erhalten.

Das optionale verschlüsselte Quellarchiv kann erfolgreiche Uploads weiter
aufbewahren. Seine Verfügbarkeit ist keine Voraussetzung des V4-Punkts. Mit V4
werden weder eine automatische Archivbereinigung noch ein täglicher Importjob
eingeführt. Historische V2-Rezept- und V3-Originaldatei-Nachweise bestätigen
jeweils nur ihr damaliges Verfahren.

## Auswahl im Updater

Nach abgeschlossener Qualifikation kann der reguläre Updater ausdrücklich
`--verification deploy-owned` verwenden. Bei `auto` wählt die gespeicherte
GP-Einstellung den bestehenden vollständigen oder den kleineren geschützten
Entscheider. Eine fehlende Einstellung verwendet den Standardumfang `full`.
Bei einem unlesbaren oder ungültigen Wert bricht der Updater vor der Sicherung ab.
`full` wählt den Vollablauf ausdrücklich.

Der kleinere Weg benötigt weiterhin einen gültigen signierten Vollnachweis
innerhalb von 36 Stunden, unveränderte Paar-/Schema- und Konfigurationsbindungen
sowie den bestätigten Nachttermin mit unveränderlicher Frist. Er erlaubt nur
Änderungen an bereits bekannten GP-Geschäftsdateien. Änderungen an Sales, Import,
Persistenz, Schema, Backup/Recovery, Serverwerkzeugen, Abhängigkeiten oder der
Dateiliste verlangen den gesondert gewählten Vollablauf. Bei gewähltem
Core-Umfang beendet der Updater einen solchen Lauf vor der Sicherung. Das
gilt auch bei einem weiteren kleinen Deploy vor dem nächsten passenden Nachweis.

Schlägt der frische Core-Sicherungspunkt fehl, beendet der Updater den Lauf
vor dem App-Tausch. Das Fehlen alter Access-Dateien allein verhindert den V4-Punkt nicht.
Ein Fehler im gewählten Restore-/GP-Test verhindert den erfolgreichen
Update-Abschluss. Die signierte Nachtqueue und ihre feste Frist werden dadurch
nicht als bestanden markiert.

## Größen, Prüfstand und verbleibende Gates

Der vorhandene vollständige Vergleichspunkt umfasst **14092664854 Byte**
(14,09 GB beziehungsweise 13,13 GiB), einschließlich Manifest und Commit-Marker.
Der tatsächliche V4-Punkt derselben isoliert wiederhergestellten Bestandskopie
umfasst **580723970 Byte** (0,581 GB beziehungsweise 553,8 MiB) auf derselben
Grundlage: **95,879 % weniger**, etwa ein Vierundzwanzigstel des bisherigen
Umfangs. Er enthält 224 reguläre Dateien einschließlich Abschlussdatei; die
physische Speicherbelegung beträgt 581177344 Byte. Er enthält keine Access-
Originaldateien und keine künftigen Neuaufbau-Eingaben.

Gemessen am 17.11.2026 (Serverlauf 16.11.2026 UTC) nach vollständiger
Versiegelung und vor dem Restore: Punkt
`78339333-2e1e-4b04-88dc-2fb572d31693.owned`, Manifest-SHA-256
`56319b3aa31ad854e99f4f8a6504407037bf259500bccaf96f9b67cedd379d52`.
Die tatsächliche `createBackup`-Operation dauerte 935213 ms (15 min 35 s).
Dies ist die Sicherungsoperation; unabhängige Inhaltsbeweise, Restore,
Importneuaufbau und GP-Prüfung kommen hinzu. Es ist keine Deploy-Gesamtlaufzeit.
Der Messbeleg liegt unter
`../output/gp-deploy-owned-complete-20261116/real-capture-004/actual-backup-size.json`.

Die lesende Produktivmessung vom 16.11.2026 ergab 244209343 Byte für Core und
41741534 Byte für private/Branding-Dateien. Diese zusammen rund 0,286 GB sind
keine Messung des neuen Sicherungspunkts: behaltene Sales-Inhalte,
Beziehungsanker, Schema und geschützte Auswahl kommen hinzu. Die rund 40,4 GB
große produktive Sales-Datenbank ist ebenfalls kein direkt vergleichbarer
komprimierter Backupumfang. Herkunfts-, SQL-, Fremdschlüssel- und Dateiprüfungen
benötigen weiterhin Zeit. Der isolierte Messlauf ist kein Lasttest am laufenden
Produktivdienst und begründet keine feste Größen- oder Laufzeitgarantie.

Die lokalen Auswahl-, Wiederaufbau-, Bundle-, Transport-, Shell- und
Architekturprüfungen sowie die normale Import-Runtime bestehen. V4 wird
ohne alte Originaldateien und ohne bereits vorhandenen künftigen Quelldateiplan
exportiert und wiederhergestellt. Eigene Vorwerte, manuelle Artikel, Preise,
Bilder und Core-Referenzen bleiben erhalten; fehlende eigene Fremdschlüsselanker
werden weiterhin vor dem Sichern abgewiesen. Nicht authentifizierbare Läufe mit
kopiertem Access-Profil werden behalten. Originale Import-Vergleichsstände
werden nur für den begrenzten eigenen Ankergraphen und nach Prüfung ihrer
Herkunft behalten; tatsächliche Rücknahmen, geänderte eigene Werte und veraltete
Zielrevisionen erhalten keine solche Freigabe. Frühere Originaldatei-Replay-
und Nachfolgerprüfungen bleiben getrennte Kompatibilitätsnachweise.
Die Architekturprüfung besteht elf Fälle ohne neue Treiberfreigaben.
Der native V4-Lauf mit sechs tatsächlich neu erzeugten synthetischen
Access-Dateien besteht: Operations-Backup, schneller Restore, tatsächlicher
Produkt-Recovery-Worker, Neuaufbau, GP-HTTP-Prüfung und PDF-Erstellung. Dabei
bleiben eigene Bilder, manuelle Artikel und Preise, Core-Referenzen und alte
gehaltene Versionen erhalten. Ein zusätzlicher WEUM-Fall bestätigt eine neue
Quellversion bei unverändertem ursprünglichem Haltevermerk und dessen Version.
Native V3-Fehlerläufe und frühere V2-Nachweise bleiben getrennte Belege.
Der echte Restore dieses Sicherungspunkts ist bestanden. Der unabhängige
Vergleich bestätigt 260 Tabellen-/Teilmengen-Nachweise mit 744960 Zeilen sowie
alle 436034 geschützten Auswahlzeilen anhand ihres ursprünglichen
Primärschlüssels und vollständigen Inhalts. Die 216 geschützten Dateien
(41741534 Byte) sind enthalten. Bekannte Access-Quellköpfe und Kassa-
Bereitschaftsmetadaten werden bestimmungsgemäß als erneut einzulesen markiert;
ihre unveränderte Nicht-Access-Teilmenge wird separat geprüft. Quell- und
Restorecluster sind normal beendet. Der Neuaufbau mit sechs aktuellen
Desktop-Access-Dateien ist noch nicht bestanden: Der erste korrigierte
Bestandslauf endete am 17.11.2026 um 03:24:56 UTC beim AF-Publikationsabschluss
mit `IMPORT_RETRY_LATER`. Das private PostgreSQL-Log bestätigt einen
Statement-Timeout am Statuswechsel des AF-Snapshots und dessen vollständiger
Zertifizierungsprüfung. Die Diagnosekopie bestätigt fehlende Statistiken für
drei neu aufgebaute History-Tabellen. Nach deren Aktualisierung besteht der
normale Freigabeschritt mit allen 238947 Mitgliedern und unverändertem
10-Sekunden-Abfragelimit; 909 andere Laufköpfe bleiben unverändert.
Der Bestandslauf mit `candidate-015` hat die AF-Publikation am 17.11.2026
ohne manuelle Statistik- oder Bereinigungsschritte bestanden. Die drei
automatischen Analysen sind an PostgreSQLs eigenen Zählern belegt. Dieser Lauf
endete jedoch um 06:59:06 UTC mit `IMPORT_ARTICLE_CATALOG_LIMIT` bei der
anschließenden Katalogaufbereitung. 19762 Artikel und 38924 Roh-Aliaszeilen
entsprechen 750356 Prüfeinheiten, gegenüber dem bisherigen Gesamtbudget von
750000. `candidate-016` verarbeitet die Aufbereitung in begrenzten Paketen.
Globale Eigentümer- und Duplikatprüfungen gelten über alle Pakete; der normale
Einzelpayload behält seine bisherigen Grenzen. Es werden keine Daten
abgeschnitten. Die lesende Prüfung der tatsächlichen Trade-Projektion besteht
mit 19762 Artikeln und 38924 Aliaszeilen. Sie ergibt 19686 akzeptierte und 76
blockierte Katalogartikel sowie 85 zurückgehaltene optionale Aliaszeilen.
Diese normalen Qualitätsbefunde bleiben erhalten; ein technisch vollständiger
Durchlauf bedeutet keine Übernahme blockierter Artikel. Ein neuer vollständiger
Sechs-Quellen-Lauf mit `candidate-016` wurde am 17.11.2026 um 07:55:24 UTC
gestartet und auf Benutzerwunsch am selben Tag um 10:07:38 UTC kontrolliert
beendet. PostgreSQL ist sauber heruntergefahren; Testunit und privater
Namespace sind beendet. Dieser Lauf ist weder als bestandener Gesamttest noch
als technischer Fehler zu werten. Ein vollständiger Sechs-Quellen-
Abschlussnachweis des echten Bestands liegt damit nicht vor.
Die fehlgeschlagenen früheren Läufe und beide Diagnosecluster
sind normal beendet und werden nicht als vollständiger Neuaufbaunachweis
gewertet.
Der Sicherungspunkt und der bestandene schnelle Restore sind getrennte
Nachweise. Lokale
TAP-Protokolle liegen unter `.local/deploy-owned-validation`, native Belege
unter `../output/gp-deploy-owned-complete-20261116/native-qualification-001`.

Die Auswahlqualifikation `native017` verwendet `candidate-013`
(1512 gehashte Runtime-/Testhilfsdateien). Ihre 23 Tabellennachweise mit
64 erhaltenen Testzeilen, der vollständige neue Quelldateiplan und beide
Prüfpunkte entsprechen dem vorherigen gehaltenen WEUM-Test. Der synthetische
Punkt umfasst 3992299 Byte; diese Testgröße ist keine Bestandsmessung.
Der anschließende native Worker-Nachweis `native018` verwendet `candidate-014`
mit demselben unveränderten Testpunkt und denselben sechs Eingabedateien. Er
bestätigt die gruppierten Ankerprüfungen, eigene Core-/Artikel-/Bilddaten, die
alte gehaltene WEUM-Version, neue Läufe auch bei gleichem Dateihash sowie
Anmeldung, Sitzungswiderruf und PDF. Der aktuelle Nachweis `native019` mit
`candidate-015` bestätigt zusätzlich den automatischen Statistikschritt über
den tatsächlichen privaten Admin-Client und PostgreSQLs eigene Statistikzähler.
Alle drei Analysen werden genau einmal im normalen Wiederaufbau ausgeführt.
Der aktuelle Nachweis `native020` mit `candidate-016` bestätigt denselben
Wiederaufbau und zusätzlich die begrenzte Katalogaufbereitung mit 750356
Prüfeinheiten. Die normale Einzelpayload-Prüfung weist diese Menge weiterhin
ab; die vollständige Access-Aufbereitung verarbeitet sie mit unveränderten
globalen Qualitätsregeln. Dies ist eine reine Aufbereitungsprüfung ohne
zwanzigtausend zusätzliche Katalogschreibvorgänge. Insgesamt bestehen 292
getrennte lokale Prüfungen (208 gezielte, 53 normale Import-Runtime- und 31
Katalog-/Paketprüfungen) ohne übersprungene Fälle. Die kleine native Fixture
ist kein Durchsatznachweis des echten Bestands.
Die lokale Test-VM ist danach regulär heruntergefahren. Alle 25 nativen
PostgreSQL-Testcluster waren normal beendet, alle elf ursprünglichen
Native020-Gastbelege exportiert und sämtliche 19 lokalen Belege geprüft.
SHA-256, Größe und Zeitstempel aller zehn ursprünglichen
Parent-Dateien (47183998976 Byte) sind unverändert. Der erhaltene VM-Stand und
der Abschlussnachweis liegen unter `linux-fixture/normal-poweroff-native020-status.json`
im genannten Belegverzeichnis; es wurden keine Dateien gelöscht.

Die Bestandskopie hat unnötige Vollscans bei leeren Auswahlen sichtbar gemacht.
Der Selektor prüft deshalb zuerst die kleinen, eingefrorenen positiven
Auswahlmengen. Bei einer leeren Menge entfallen nur die logisch leeren
Export- und Fremdschlüsselprüfungen. Für den negativen Laufselektor gilt dies
zusätzlich nur nach Nachweis einer validierten, aktiven, nicht aufschiebbaren
Fremdschlüsselkette ohne Vererbung und mit allen Kindschlüsselspalten `NOT NULL`
bis zum tatsächlichen Laufkopf. Kein erhaltener Laufkopf darf übrig sein.
Unbekannte eingehende Referenzen, nullable oder unbestätigte Schemas behalten
ihre vollständige Prüfung. Der HMAC eines unveränderlichen Laufkopfs wird nur
einmal pro Snapshot geprüft; jede einzelne Verbindung und ihr tatsächlicher
Zielinhalt werden weiterhin authentifiziert. SQL- und Gesamtzeitbudgets bleiben
unverändert.

Beim echten Neuaufbau wurde zusätzlich ein Aufwand pro erhaltenem Stammanker
sichtbar. `candidate-014` verarbeitet deshalb höchstens 100 passende Anker je
SERIALIZABLE-Transaktion. Ursprüngliche GP-Arbeit wird vor dem ersten neuen
Import einmal anhand ihrer Identitäten erfasst; späteres technisches Staging
ist keine ursprüngliche GP-Arbeit. Alte Zeilen ohne Schlüssel und unbekannte Zeilen
bleiben unverändert gespeichert. Zielrevision, vorhandene Verknüpfung, HMAC,
ursprünglicher Vergleichswert und echte GP-Konflikte werden weiterhin geprüft.
Quarantäneentscheidungen werden erst nach erfolgreichem Commit übernommen;
Rollback oder Transaktionswiederholung übernehmen keine verworfene Entscheidung.
Der erste echte Neuaufbau mit `candidate-013` wurde nach gesichertem Engpass
kontrolliert als Performance-Abbruch beendet. Sein Sicherungspunkt und der
bestandene schnelle Restore bleiben gültig. Der korrigierte Neuaufbau verwendet
denselben versiegelten echten Punkt; es wurde keine weitere Sicherung erzeugt.

Der große Bestandsneuaufbau läuft in einem privaten Restorecluster, dessen
automatische Hintergrundwartung wie im bestehenden Recovery-Test abgeschaltet
ist. Für den früheren Lauf mit `candidate-014` wurden einmal Planerstatistiken für neun feste Tabellen
erzeugt und nach nachgewiesenen alten Zeilenversionen vier Integrationstabellen
mit gewöhnlichem `VACUUM (ANALYZE, INDEX_CLEANUP ON)` gewartet. Die Befehle
blieben jeweils innerhalb von 30 Sekunden, mit zwei Sekunden Sperrwartezeit.
Es wurden keine Nutzdaten oder Schemadefinitionen geändert, keine Vollbereinigung
mit `VACUUM FULL`, kein Neustart und keine Änderung an Prüfungen oder Zeitbudgets
vorgenommen. `autovacuum` blieb unverändert abgeschaltet. Diese getrennte
Testumgebungspflege gehört zu den Laufzeitbelegen; sie ist keine produktive
Datenbankwartung und kein automatischer Bestandteil des neuen Sicherungsmodus.
Die Belege liegen unter `real-fresh-002/private-planner-statistics.json` und
`real-fresh-002/private-vacuum-maintenance.json` im genannten Belegverzeichnis.

`candidate-015` aktualisiert gezielt die Statistiken von
`import_history_snapshot_members`, `import_history_records` und
`import_history_versions`, unmittelbar bevor das letzte normale AF-Paket seine
vollständige Publikationsprüfung auslöst. Der private Socket, Cluster und das
Admin-Clientpaar werden erneut geprüft. Bei einem vollständigen Ready-Cursor
wird dessen Abschluss aus der authentifizierten privaten Quellzeile mit
passender Revision und Datei-/Tabellenbindung gelesen; interne Cursor bleiben
aus öffentlichen Antworten entfernt. Die drei festen `ANALYZE`-Befehle laufen
transaktionslokal mit zehn Sekunden Abfrage- und zwei Sekunden Sperrwartezeit.
Erst nach erfolgreichem Commit gilt der Schritt für diesen Lauf als erledigt.
Vollständigkeitsprüfung, Trigger, Schema und normale App-Abfragelimits bleiben
unverändert. Der kleine native Test bestätigt diesen Pfad einschließlich
Rollenkontext und tatsächlicher PostgreSQL-Statistikwerte.

Vor produktiver Aktivierung bleiben außerdem die Qualifikation des endgültigen
Pakets, vollständige CI-/Security-Prüfungen, der genaue Übergang mit den
tatsächlich installierten alten und neuen Einstiegspunkten samt Rollback sowie
die reguläre Offsite-/Assurance-Freigabe erforderlich. Die erste Einführung
verwendet den Vollablauf. Aus den lokalen Arbeiten folgt keine Deploy-Freigabe.
