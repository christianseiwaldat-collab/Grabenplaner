# TradeFoto-Gesamtimport – Block 4: Verkaufs- und Kassenhistorie

Stand: 05.09.2026. Lokal implementierter, isolierter Backend-Baustein. Ausgangspunkt: Branch `feature/schedule-pdf-day-separators`, HEAD `8e0131f3a036fdda2ebd4fcc6aaab45b8a359478`, App `0.92.26-beta`. Die bestehenden uncommitteten Arbeiten aus Block 1–3 bleiben erhalten.

**Keine Übernahme echter Geschäftszeilen, keine produktive Schema-/API-/Rechteaktivierung, keine Versionierung, kein Commit, Push oder Deploy.** Die originale Access-Datenbank wurde in diesem Block nicht erneut eingelesen. Schema-/Klassifikationsmetadaten stammen aus dem bereits geprüften Block-1-Katalog; alle neu geschriebenen Geschäftszeilen sind synthetische Testdaten in einer isolierten Datenbank.

## 1. Umfang und Abgrenzung

43 weitere Tabellen mit 433 Feldern besitzen feste, typisierte Historienprofile: alle sieben nicht-systeminternen Kassentabellen sowie 36 Trade-Tabellen für Bestands-/Preisprotokolle, Finanzreferenzen, Reparatur-/Dokumentexporte und Vertriebskanalreferenzen. Zusammen mit Block 3 sind damit 109 Tabellen / 1.194 Felder in Stammdaten- oder Historienprofilen beschrieben. Die beiden dort ausgeschlossenen Kennwortfelder werden weiterhin nicht übernommen. Weitere 26 Tabellen / 169 Felder für technische bzw. alte Anwendungskonfiguration sind dadurch nicht aktiviert.

Die Historienablage ist keine zweite aktive Artikel-, Kunden-, Kassen- oder Lagerbuchhaltung. Keine Preise, Bestände, Rollen, Personalstammdaten, Öffnungszeiten, Einwilligungen oder operativen Zahlungs-/Reparaturvorgänge werden daraus automatisch geändert. Externe Pfade, URLs und Freitext werden nicht ausgeführt oder nachgeladen.

| Datenart | Identität und Behandlung |
| --- | --- |
| `Umsatz_KASSE` | Geprüfter zusammengesetzter Kandidat: `Bonnr + Filialid + Kassenid + Bondatum`. Vollständiger lokaler Datumswert bleibt Bestandteil des Schlüssels. |
| `Umsatz_Kasse_Details` | Kanonische `RepID`-GUID. Belegkopf muss im selben Quellnummernraum bereits vorhanden sein. |
| `KassenJournal` | Geprüfter Kandidat `Vorgang`; leere Datums-/Standortfelder bleiben erhalten. |
| `KassenJournal_Details` | Kopfbezug `Vorgang`; echte gleiche Detailzeilen bleiben über Dateihash und Quellzeile getrennt. |
| `Tagesbericht` | Dateihash und Quellzeile. Der mehrfach vorkommende fachliche Schlüsselkandidat wird ausdrücklich nicht zur Deduplizierung verwendet. |
| `tblProtBestand`, `tblProtBestand_comp` | Je Tabelle eigene GUID-Identität. Keine Behauptung, dass gleiche oder unterschiedliche IDs fachliche Überschneidungen ausschließen. |
| `tblProtPreis`, `ARTIKEL_FILIALEN`, weitere unsichere Tabellen | Getrennte Snapshot-/Quellzeilenidentität. Keine vollständige Bewegungs- oder Preisgeschichte daraus ableiten. |

Die genannten Kandidaten sind im gepinnten Katalog auf Eindeutigkeit geprüft, keine nachträglich behaupteten Access-Primärschlüssel. Andere ausdrücklich geprüfte Schlüssel sind im Metadatengenerator festgelegt. Unbekannte Tabellen/Spalten werden nicht still übernommen; ungültige bekannte Werte bleiben im geschützten Prüfbereich.

## 2. Werte und historische Zuordnungen

- IDs bleiben Text einschließlich führender Nullen. GUID-Schreibweisen mit/ohne Klammern bzw. Großbuchstaben erhalten dieselbe kanonische Identität.
- Access-Datumswerte behalten lokale Kalender-/Uhrzeitkomponenten. `1899-12-30` in `Bonzeit` ist ein Zeitträger und wird nicht als Geschäftstag oder UTC-Zeitverschiebung behandelt.
- Currency-Werte bleiben Dezimaltext. Float/Double-Werte werden als verlustfreie Dezimaldarstellung der vom Reader gelieferten Zahl aufbewahrt, einschließlich Round-trip-Ziffern und sehr kleiner Werte. Beispiel: `12.34000015258789` wird in der Historie nicht zu `12.34` umgeschrieben. Eine bestätigte Rechenregel darf erst beim Summenabgleich auf die Währungseinheit runden.
- Kunden-, Artikel-, Standort-, Kopfverkäufer- und Positionsverkäuferbezüge bleiben getrennt. Die Quell-`Verkäufer_ID` wird niemals als aktuelle GP-Personalnummer angenommen. Es gibt keinen automatischen Rückfall vom Positions- auf den Kopfverkäufer.
- Kunden-/Verkäufer-0 bedeutet „nicht zugeordnet“, nicht einen Sammelkunden oder eine Sammelperson. Fehlende Altstämme bleiben `missing_source`, vorhandene unverbundene Stämme `unlinked`. Historische Artikelbezeichnungen und Preise bleiben auch ohne heutigen Artikel erhalten.
- Ein Artikelziel stammt ausschließlich aus der bereits bestätigten Bindung an den zentralen GP-Artikelstamm. Keine Platzhalterartikel, Preisüberschreibungen oder neue unabhängige Artikelnummern.
- Die Zuordnung einer Kassen-Quellinstanz zur passenden Trade-Stammdateninstanz ist eine ausdrückliche Entscheidung der späteren Server-Komposition (`resolveMasterSourceInstance`), keine Dateinamenheuristik.

Der neue transaktionsgebundene Stammdaten-Referenzleser prüft Quellintegrität, bestätigte Bindung, konkretes Zielrecht und Zielzustand. Er liefert keine kompletten CRM-/Personalakten. Ein vorhandener historisch zugeordneter inaktiver Mitarbeiter bleibt `historical_mapping`; fehlende bzw. später deaktivierte Ziele bleiben sichtbar.

## 3. Versionen, Integrität und Rücknahme

Fünf isolierte Tabellen bilden Datensatzidentitäten, unveränderliche Versionen, verschlüsselte Datenklassensegmente, Referenzindizes und Folgeabhängigkeiten ab. Jede Version enthält Herkunftsdateihash, Snapshotzeit, Importlauf und Akteur. Werte und Referenzdetails sind AES-256-GCM-geschützt; der Authentifizierungskontext bindet Bereich, Quellinstanz, Tabelle, Profil, Identität, Revision, Herkunft und Elternversion. Zielindizes verwenden einen HMAC statt offener Kunden-/Personalnummern.

Eine Position bindet genau eine Kopfversion. Nach einer Kopfkorrektur bleiben bisherige Positionen historisch lesbar; der Beleg kann bis zum erneuten Positionsabgleich als veraltet gesperrt sein. Erneuter Import desselben stabilen Quellschlüssels dupliziert keinen Datensatz. Eine geänderte bestätigte Stammdatenzuordnung kann auch bei identischen Quellwerten eine neue, auditierte Referenzversion erzeugen. Alte Versionen werden dabei nicht nachträglich umgehängt.

Vorprüfung und Übernahme vergleichen einen verschlüsselten, geprüften Abhängigkeitstoken. Ein nach der Vorschau geänderter Kopf bzw. eine geänderte Zuordnung stoppt die Übernahme; es wird nicht still neu geplant. Fehlende Köpfe erzeugen `needs_review`. Nach dem Kopfimport kann ein neuer expliziter Versuch gestartet werden; der ursprüngliche Prüflauf bleibt nachvollziehbar.

Stammdaten-Holds werden in derselben Transaktion wie die Belegversion angelegt. Auch historische Versionen behalten ihren Schutz. Rücknahme erfolgt in Abhängigkeitsreihenfolge: Positionen vor Köpfen, Historie vor verwendeten Stammdaten/CRM-Bindungen. Folge-Holds oder manuelle/spätere Änderungen verhindern eine destruktive Rücknahme. Eine Korrekturrücknahme erstellt eine neue fortlaufende Revision mit der früheren Daten- und Referenzfassung; Revisionsnummern werden nicht zurückgedreht. Bei Akteurs-/Bereichs-/Zielrechtsentzug bleibt auch die Rücknahme gesperrt.

Die bestehende Engine prüft zusätzlich optionale fachliche Vorprüfungen; ältere Schreiber bleiben ohne diesen Hook kompatibel. Die 30-Tage-Aufbewahrung des generischen Staging-/Undo-Payloads löscht keine Historienversion. Eine endgültige Aufbewahrungs-/Löschregel und produktive Schlüsselverwaltung bleiben vor Aktivierung gesondert festzulegen.

## 4. Rechenregeln und Abgleich – standardmäßig gesperrt

Es gibt **keine aktive TradeFoto-Umsatzregel**. Insbesondere die auffällig häufige Quellmarkierung `AStorno` wird weder als normaler Verkauf noch als Storno geraten.

Eine vertrauenswürdige, belegte Regeldefinition muss Bereich und Quellinstanz, Schema, Regelversion, Bestätigungsakteur/-zeit, Evidenzhash, Währung, Nachkommastellen, Brutto-/Nettobasis, endgültigen Stück-/Positionspreis, Steuerkodetabelle, Rundung und ausdrücklich geprüfte Statuskombinationen festlegen. Das ist kein frei vom Client übergebbarer JSON-Schalter; registrierte Regelobjekte werden nach Herkunft und Geltungsbereich geprüft.

Der Baustein unterstützt:

- positive Verkäufe, negative Retourenmengen, gebrochene Mengen und ausdrücklich ausgeschlossene Positionen;
- eindeutige Statusentscheidung anhand der erhaltenen Kennzeichen; unbekannte/überlappende Regeln sperren den Beleg;
- exakte BigInt-Dezimalrechnung und ausdrücklich festgelegte Rundung „halbe Einheiten vom Nullpunkt weg“;
- getrennte Brutto-/Netto-/Steuerwerte, bestätigte Steuerkodes und Kopf-/Positionssummenabgleich;
- endgültige Preise ohne erneutes automatisches Abziehen schon berücksichtigter Rabatte;
- Hinweise auf Köpfe ohne Positionen, veraltete Kopfversionen, abweichende Belegschlüssel, fehlende/auffällige Datums- bzw. Preiswerte.

**Ein passender Betrag beweist keine vollständige Übernahme.** Fehlende Nullpreis- oder ausgeschlossene Positionen können die Summe unverändert lassen. Deshalb benötigt eine Aggregationsfreigabe zusätzlich einen registrierten Beleg-Abdeckungsnachweis aus der vollständigen, unabhängig abgeglichenen Quelllesung: richtige Quelle/Schema, Evidenz, übereinstimmende Zeilenzahlen und die vollständige Menge eindeutiger Positionsinhalte dieses Belegs. Der Code stellt `defineTradeFotoReceiptCoverage` als vertrauenswürdige Kompositionsgrenze bereit; er erzeugt keinen echten Lesebeweis aus dem Inventurkatalog oder einer GP-Ergebnisseite. Die reale Beweiserzeugung und Prüfung gehören in den gesicherten Testimport (Block 6).

Laufende Teilimporte dürfen keine Kennzahlen freigeben. Ein Beleg mit mehr als 1.000 Positionen wird in diesem begrenzten Abgleich nicht abgeschnitten, sondern gesperrt. Bei irgendeiner offenen Prüfung bleiben `canAggregate: false` und `totals: null`. Rechenregel- und Abdeckungsnachweis sind auch bei vollständig gespeicherten Rohdaten weiterhin erforderlich.

Kassenjournal, Tagesbericht, alte Exportbelege, PDF-Aggregate und Einzelverkäufe werden niemals zusammengerechnet. Fachliche Abgleiche zwischen diesen Datenarten benötigen spätere bestätigte Vergleichsregeln. Bestands-/Preisprotokolle erhalten keine Vollständigkeitsbehauptung und ändern keine operativen Bestände.

## 5. Geschützte Backend-Schnittstelle für Block 5

`createImportHistoryService` stellt `detail`, eine schlüsselbasierte Seitennavigation und einen beschränkten Belegabgleich bereit. Snapshot-Tabellen benötigen zur Auflistung einen expliziten Dateihash. Eine Seite ist höchstens 100 Datensätze groß und enthält ausdrücklich keine Gesamtumsatzbehauptung. Versionsherkunft bezeichnet die gespeicherte Fassung, nicht einen erfundenen „zuletzt gesehen“-Zeitpunkt bei unveränderten Folgeimporten.

`history.read`, `history.list`, `history.reconcile`, `history.reference` und `history.scope` sind eigenständige Kompositionsanforderungen. Dokument-/Standortbereich muss geprüft werden, einschließlich nicht zugeordneter Standorte; letztere dürfen nicht als „für alle sichtbar“ gelten. Kunden-, Personal-, Kosten- und Finanzsegmente erhalten separate Klassenprüfung. Nicht erlaubte Felder/Referenzen fehlen in der Projektion, mit `partial` und `omittedClasses` gekennzeichnet. Auch Basis-/Metadatenansicht benötigt die ausdrückliche Dokument-Lesefreigabe. Alte GP-Rollen bekommen keine neuen Rechte.

Die bisherige personenfreie `sales-analytics-model`-Schnittstelle bleibt unverändert. Dieser Block registriert keine HTTP-Route und verändert keine bestehende Analyse-/Artikel-/CRM-Oberfläche. Tages-/Zeitraumfilter, Verkäuferauswahl, Kennzahlendarstellung, Zuordnungsanteile und passende Datenbank-Abfrageindizes gehören zur ausdrücklich freizugebenden GP-Ansicht in Block 5; keine Volltabellen-Entschlüsselung im Browser vorsehen.

## 6. Dateien und Prüfungen

| Datei | Zweck |
| --- | --- |
| [tradefoto-history-profiles.js](../../lib/tradefoto-history-profiles.js) | Feste Schemaadapter, Reader-Grenze, Schlüssel, Belegbezüge und Datenklassen |
| [tradefoto-history-metadata.json](../../lib/tradefoto-history-metadata.json) | 43 Tabellen / 433 Felddefinitionen ohne echte Geschäftszeilen |
| [build-tradefoto-history-metadata.mjs](../../scripts/build-tradefoto-history-metadata.mjs) | Reproduzierbare Ableitung und Prüfung gegen Block 1 |
| [tradefoto-sales-rules.js](../../lib/tradefoto-sales-rules.js) | Regel-/Abdeckungskontrakte, exakte Beträge und gesperrter Belegabgleich |
| [import-history.js – Repository](../../lib/persistence/repositories/import-history.js) | Historienversionen, Referenzen, Holds, geschützte Lesewege und Rücknahme |
| [import-history.js – Statements](../../lib/persistence/statements/import-history.js) | 20 providerneutrale Verträge |
| [import-history-catalog.js](../../lib/persistence/sqlite/import-history-catalog.js) | Festes parametrisiertes SQL |
| [import-history-schema.js](../../lib/persistence/sqlite/operations/import-history-schema.js) | Isolierte portable DDL, nicht im App-Start registriert |
| [tradefoto-history.test.js](../../test/tradefoto-history.test.js) | Synthetische Integrations-, Rechen-, Sicherheits- und Providerprüfungen |

```text
node scripts/build-tradefoto-history-metadata.mjs
node scripts/build-tradefoto-master-metadata.mjs
node scripts/render-tradefoto-catalog.mjs docs/tradefoto-gesamtimport-v0.1/catalog.json --check
node --test --test-concurrency=1 test/data-import-foundation.test.js test/tradefoto-master-data.test.js test/tradefoto-history.test.js
node --test --test-concurrency=1 test/v087-database-coupling-inventory.test.js
git diff --check
```

31 neue Block-4-Tests prüfen unter anderem alle 43 Profile mit vollständigen synthetischen Zeilen, Haupt-/Detailreihenfolge, Wiederholung und echte Dubletten, Referenzversionen, späte Zuordnungen, unveränderte zentrale Artikelpreise, Historiengrenzen, verschiedene Verkäuferrollen, fehlende/alte Ziele, Rechteentzug, Ciphertext-/Indexmanipulation, Fremdschlüssel, Transaktionsrollback und kontrollierte Rücknahme. Ein 201-Zeilen-Test prüft die Sperre während eines nur teilweise übernommenen Laufs. Gleitkomma-/Dezimal-, Rabatt-, Retouren-, Steuer-/Status- und Abdeckungsfälle sind separat abgesichert.

Abschließender erweiterter Prüflauf: **166 Tests bestanden, 0 Fehler, 0 übersprungen**, etwa 15,6 Sekunden. Er umfasst die 31 neuen Historientests, die 64 Block-2-/Block-3-Tests sowie die bestehenden Artikel-/ACCDB-Importe, CRM-Domäne/-Persistenz/-Rechte, Analyse-Import-/Persistenzfundamente, den Artikel-PostgreSQL-Vertrag, SQLite-Provider und Architekturgrenzen. Zusätzlich: 12 Syntaxprüfungen, reproduzierbare Metadatengeneratoren, Katalog-/Dokumentationskonsistenz, neun lokale Dokumentationslinks und Whitespaceprüfung. Dies ist keine App-Vollsuite.

PostgreSQL-Kompatibilität wird auf Vertrags-/SQL-Compiler-/DDL-Ebene geprüft, ohne SQLite-spezifische Datentypkonvertierung oder Produktivaktivierung. Kein PostgreSQL-Server wurde gestartet; dadurch wird keine vollständige PostgreSQL-Fähigkeit der bestehenden GP-App behauptet. App-Vollsuite, Quellenprüfung mit echten Zeilen, Last-/Wiederanlaufprüfung und produktiver Schlüssel-/Rechtebetrieb bleiben Block 6 bzw. eine spätere ausdrücklich genehmigte Aktivierung.

## Übergabe an Block 5

Block 4 liefert den isolierten Historien-/Belegunterbau. Die inzwischen ausdrücklich freigegebenen Fortsetzungen sind in [Block 5 – GP-Ansichten](BLOCK-5-GP-ANSICHTEN.md) und [Block 6 – Prüfung/Abnahme](BLOCK-6-PRUEFUNG-UND-ABNAHME.md) dokumentiert. Block 5 ergänzt einen authentifizierten Geschäftstag und die 21. benannte Abfrage. Gesperrte Kennzahlen bleiben gesperrt; Quellarten werden nicht doppelt gezählt. Der obige Block-4-Prüfnachweis bleibt ein historischer Zwischenstand.

Offen bleiben die realen Entscheidungen Q01 (unabhängige Zeilendeckung), Q02 (Umsatz-/Storno-/Rabattsemantik), Q03/Q04 (Kunden-/Standort-/Personalzuordnungen), Q05/Q06/Q07 (historische Fehlstämme, Schlüsselfreigabe, Datums-/Standortfälle), Q08/Q09 (Medien, Rechte, Schlüssel, Aufbewahrung), Q10/Q12 (weitere Fachsemantik/Beziehungen). Synthetische Tests schließen keine dieser Echtdatenentscheidungen.
