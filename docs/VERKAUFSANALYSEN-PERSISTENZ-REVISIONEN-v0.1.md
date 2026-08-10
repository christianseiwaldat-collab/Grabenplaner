# Verkaufsanalysen · Persistenz- und Revisionsfundament v0.1

## 1. Dokumentstatus und Blockgrenze

| Merkmal | Stand |
| --- | --- |
| Fachbereich | Verkaufsverwaltung → Verkaufsanalysen |
| Block | 5 · Persistenz und Revisionen |
| Version | v0.1 |
| Stand | 03.08.2026 |
| Status | nicht aktivierter Dual-Provider-Entwicklungsslice |

Dieser Block baut auf dem [Datenmodell und Importfundament v0.1](./VERKAUFSANALYSEN-DATENMODELL-IMPORTFUNDAMENT-v0.1.md) auf. Er schafft eine testbare technische Speicherung für Importprofile, Vorschau-Laufnachweise, fristgebundenes Staging und Filialzuordnungen.

Block 5 aktiviert noch keine Produktfunktion. Der Slice wird weder in den SQLite-Anwendungsstart noch in den vollständigen Anwendungskatalog, die allgemeinen Anwendungsrepositories, eine Serverroute oder eine Browseransicht eingebunden. Es gibt weiterhin keinen echten Access-, Datei-, SQL-, API- oder OCR-Import und keine Verarbeitung der bereitgestellten Datenbankdateien.

## 2. Bewusste Umfangsentscheidung

Dieser Block persistiert ausschließlich die technische Steuerungs- und Prüfebene:

- versionierte Importprofile,
- unveränderliche Profilrevisionen,
- unveränderliche Trockenlauf-Nachweise,
- ausschließlich kanonische, zeitlich begrenzte Vorschauzeilen,
- revisionsfeste Filialzuordnungen mit Nachweisreferenz.

Noch nicht angelegt werden produktive Beleg-, Positions-, Artikel-, Bestands-, Taxonomie- oder Shop-Umsatztabellen. Dadurch kann aus dem Persistenzfundament kein Verkaufsdatenbestand und keine Kennzahl entstehen.

## 3. Tabellenvertrag

| Tabelle | Zweck | Änderungsregel |
| --- | --- | --- |
| `sales_import_profiles` | stabiler Profilkopf und aktive Revision | aktive Revision nur optimistisch und atomar wechseln |
| `sales_import_profile_revisions` | vollständiger normalisierter Profilvertrag mit Modell-, Schema- und Inhaltsfingerprint | unveränderlich; kein Update und kein Löschen |
| `sales_import_runs` | idempotenter Nachweis einer erzeugten Trockenlauf-Vorschau | unveränderlich; kein Update und kein Löschen |
| `sales_import_staging_records` | kanonische Vorschauwerte und datensparsame Prüfhinweise | kein Update; Löschung nach Frist ausdrücklich vorgesehen |
| `sales_branch_mapping_heads` | stabiler Kopf je Quellsystem und externer Filialkennung | aktive Revision nur optimistisch und atomar wechseln |
| `sales_branch_mapping_revisions` | freigegebene oder ausdrücklich abgewiesene Filialzuordnung mit Gültigkeit und Nachweis | unveränderlich; kein Update und kein Löschen |

Profil- und Filialrevisionen sind append-only. Eine Korrektur erzeugt eine neue Revision; die frühere Fassung bleibt als Nachweis erhalten.

## 4. Profilrevisionen

Vor dem Speichern wird jedes Profil erneut durch den Block-4-Vertrag normalisiert. Unbekannte Felder, Pfade, Zugangsdaten, frei ausführbarer Code, unzulässige Zielspalten und geschützte Quellfelder bleiben damit abgewiesen.

Jede Revision speichert:

- Vertrags- und Modellversion,
- SHA-256 des erlaubten strukturierten Zeilenschemas,
- SHA-256 des kanonisch sortierten vollständigen Profilvertrags,
- das normalisierte Profil als strukturiertes JSON,
- technische Akteur- und Zeitangaben.

Die Profil-ID und Zielentität bleiben stabil. Ein Revisionswechsel verwendet eine erwartete vorherige Revision. Bei paralleler oder veralteter Änderung bricht die Operation fail-closed als wiederholbare Transaktionskollision ab.

Der Profilfingerprint ist nun Bestandteil des Vorschau-Idempotenzschlüssels. Eine geänderte Mapping-, Filial- oder Entscheidungsrevision kann deshalb nicht versehentlich denselben Lauf wie ein älteres Profil erhalten.

## 5. Vorschau-Läufe und Idempotenz

Nur ein echtes, im aktuellen Prozess durch `createSalesImportPreview` erzeugtes und intern markiertes Vorschauobjekt darf gespeichert werden. Eine aus dem Browser, einer Datei oder JSON nachgebaute Struktur genügt nicht.

Vor dem Schreiben werden Profil-ID, Profilrevision, Profilfingerprint, Zielentität und Zeilenschema gegeneinander geprüft. Lauf und sämtliche Stagingzeilen werden in einer gemeinsamen Transaktion gespeichert.

Ein Lauf enthält ausschließlich:

- Idempotenz-, Profil-, Inhalts- und Schemafingerprints,
- Zielentität und Snapshot-Zeit,
- `previewed` oder `needs_review`,
- die vier getrennten Zeilenzähler,
- offene fachliche Entscheidungstore,
- Akteur, Beginn, Abschluss und Staging-Ablaufzeit.

Ein identischer Inhalt mit identischer Profilrevision erzeugt keinen zweiten Lauf. Ein erneuter Speicherversuch liefert den bereits vorhandenen Lauf zurück.

## 6. Datenminimiertes Staging

Staging speichert niemals die ursprüngliche Quelldatei, lokale Dateipfade, Quellpasswörter oder ungefilterte Quellzeilen. Gespeichert werden nur die durch Block 4 kanonisch erzeugten Zielwerte.

Für `rejected` und `duplicate` wird auch der bereits teilweise normalisierte Dateninhalt verworfen; gespeichert werden lediglich Zeilennummer, Status und datensparsame Fehlerklassen. Damit wird verhindert, dass fehlerhafte oder doppelte Inhalte unnötig im Staging verbleiben.

Jede Stagingzeile besitzt eine verbindliche Ablaufzeit. Der Slice stellt eine gezielte Löschoperation für abgelaufene Stagingzeilen bereit. Der unveränderliche Laufnachweis bleibt dabei erhalten, enthält aber keine vollständigen Ergebniszeilen.

Die endgültige produktive Aufbewahrungsfrist ist weiterhin fachlich und datenschutzrechtlich festzulegen. Block 5 setzt keine Standardfrist für Kundeninstallationen.

## 7. Revisionsfeste Filialzuordnung

Eine externe Filialkennung wird immer zusammen mit ihrem Quellsystem geführt. Eine Revision enthält:

- Quellsystem und externe Kennung,
- zugeordneten Grabenplaner-Standort oder ausdrückliche Abweisung,
- `approved` oder `rejected`,
- fachlichen Gültigkeitszeitraum,
- eine stabile Nachweisreferenz,
- Mapping-Fingerprint, Akteur und Zeitpunkt.

Sonderkennungen wie `0` und `99` werden dadurch nicht geraten. Sie erscheinen erst nach einer ausdrücklich gespeicherten Revision als zugeordnet oder abgewiesen. Eine freigegebene Zuordnung verweist per Fremdschlüssel auf einen vorhandenen Grabenplaner-Standort.

## 8. SQLite- und PostgreSQL-Vertrag

### 8.1 SQLite

SQLite erhält:

- eine eigenständige, idempotente Schemafunktion,
- 21 typisierte Persistenzstatements,
- einen eigenständigen Katalog,
- Transaktions-, Fremdschlüssel-, Check- und Unveränderlichkeitsregeln.

Die Schemafunktion wird in Block 5 absichtlich nicht von `ensureSqliteApplicationSchema` aufgerufen. Der Verkaufsanalyse-Slice ist daher auch nach einem normalen Anwendungsstart nicht vorhanden oder nutzbar.

### 8.2 PostgreSQL

PostgreSQL erhält:

- einen schemaqualifizierten DDL-Vertrag mit `JSONB`, `TIMESTAMPTZ`, Fremdschlüsseln und Unveränderlichkeitstriggern,
- eine reproduzierbar aus denselben 21 Statements kompilierte Providerbindung,
- eindeutige Schema-, Quellkatalog- und Slice-Fingerprints.

Der PostgreSQL-Slice ist als `development-contract` ausführbar, aber ausdrücklich mit `applicationExecutable: false` und `productActivation: false` gekennzeichnet. Er ist kein vollständiger PostgreSQL-Anwendungskatalog und aktiviert keinen Providerwechsel.

Das zentrale Persistenz-Kopplungsinventar führt alle sechs Slice-Dateien und den zugehörigen Vertragstest namentlich. Es prüft 21/21 Providerstatements, 16/16 PostgreSQL-DDL-Schritte und genau null Anwendungsverdrahtungen. Der bestehende PostgreSQL-Vollanwendungskatalog bleibt davon getrennt bei 950 Statements und geschlossener Freigabe 0/950.

## 9. Repositoryvertrag

Das provider-neutrale Repository stellt ausschließlich folgende kontrollierte Operationen bereit:

- Profile auflisten und einzelne Revisionen lesen,
- ein Profil atomar mit Revision 1 anlegen,
- eine neue Profilrevision mit optimistischer Revisionsprüfung anhängen,
- echte Block-4-Vorschauen idempotent als Lauf und Staging speichern,
- Läufe und Stagingzeilen lesen,
- abgelaufenes Staging gezielt löschen,
- Filialzuordnungsrevisionen anlegen und lesen.

Es gibt keine Operation zum Schreiben kanonischer Verkaufsfakten, zum Berechnen von Kennzahlen oder zum Freigeben eines Imports in produktive Analysebestände.

## 10. Rechte- und Aktivierungsgrenze

Die Verkaufsdatenrechte aus Block 3 erlauben keine Verwaltung von Importprofilen oder Importläufen. Block 5 ergänzt bewusst kein Importverwaltungsrecht und keinen Serverendpunkt.

Vor einer späteren Aktivierung sind mindestens erforderlich:

1. eigenes Recht für Importverwaltung mit klarer Zielrolle und Audit,
2. serverseitige Autorisierung jeder Lese- und Schreiboperation,
3. festgelegte Aufbewahrungs- und Löschfrist,
4. freigegebene fachliche Entscheidungstore des jeweiligen Profils,
5. ein separat geprüfter konkreter Quelladapter,
6. Migrationseinbindung und reale Dual-Provider-Abnahme.

Keine dieser Freigaben wird durch diesen Block vorweggenommen.

## 11. Technischer Lieferumfang

Block 5 ergänzt:

- `lib/persistence/statements/sales-analytics.js`,
- `lib/persistence/repositories/sales-analytics.js`,
- `lib/persistence/sqlite/sales-analytics-catalog.js`,
- `lib/persistence/sqlite/operations/sales-analytics-schema.js`,
- `lib/persistence/postgresql/sales-analytics-catalog.js`,
- `lib/persistence/postgresql/sales-analytics-schema.js`,
- synthetische Persistenz-, Revisions-, Idempotenz- und Dialektvertragstests,
- dieses versionierte Grenzdokument.

## 12. Abschluss und nächstes Entscheidungstor

Block 5 endet mit einer nicht aktivierten, provider-neutralen technischen Prüfspeicherung. Es wurden keine Echtdaten verarbeitet, keine Quelldatei geöffnet, keine Datenbankmigration in den Anwendungsstart aufgenommen und keine Oberfläche erweitert.

Der nächste Datenblock muss ausdrücklich festlegen, ob zuerst ein kontrollierter Access-Snapshot-Adapter, eine Importverwaltungs-API mit eigenem Recht oder – nach Prüfung der angekündigten PDF – ein reiner OCR-Berichtsprototyp gestartet wird. Dieses Dokument gibt keinen dieser Schritte automatisch frei.
