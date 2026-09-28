# Artikelstamm: lokale Leistungsprüfung vom 28.09.2026

Ausgangspunkt: Commit `45dbf13`. Ausschließlich synthetische Daten, disposable SQLite-Speicherbanken; keine produktiven Datenbanken oder VPS-Dienste verändert.

## Umgesetzte Änderungen

- Artikelnotizen werden über den bestehenden Artikel-Relationsindex ermittelt. Eine selektive, deduplizierte Unterabfrage verhindert den bisherigen Durchlauf durch sämtliche Notizdatensätze.
- Notizsegmente, Bestandsversionen, deren authentifizierte Referenzen und Filialnamen werden paketweise in derselben Lesetransaktion geladen. Die bestehende Entschlüsselung, Integritätsprüfung, Scope- und Rechteprüfung bleibt erhalten.
- Die Bestandsabfrage ermittelt zuerst die passenden Artikelreferenzen. SQLite prüft anschließend nur deren Bestands-Header und Versionen; PostgreSQL erhält die gleiche selektive Abfrage.
- Für die Bestellnummernsuche werden Suchbegriffe einmal pro Anfrage vorbereitet. Bereits normalisierte Nummern müssen nicht nochmals pro Datensatz normalisiert werden. Platzhalter, Umlautbehandlung und Importinvalidierung bleiben erhalten.
- Keine zusätzlichen Datenbankindexe oder persistenten Klartext-Suchkopien, keine globale Zwischenspeicherung von entschlüsselten Notizen oder Bestandsdaten.

## Messwerte

Jeweils Median aus sieben Durchläufen auf diesem Windows-Rechner mit Node.js/SQLite, ohne künstliche Netzwerklatenz. Laufzeiten sind lokale Vergleichswerte und keine Prognose für den VPS.

| Fall | Datenumfang | Vorher | Nachher |
| --- | --- | ---: | ---: |
| Artikel-Detail, SQL-Leseaufrufe | 100 Notizen, 20 Filialbestände | 232 | 18 |
| Artikel-Detail, gesamte lokale Laufzeit | gleicher Fall | 47,92 ms | ca. 38–48 ms |
| Bestellnummern-Matching, bereits aufgebauter Cache | 50.000 Nummern, 1 Treffer | 81,89 ms | ca. 18–20 ms |
| Artikelnotiz-Lookup | 100.000 Zeilen, 10 Treffer | 117,50 ms | 0,05 ms |
| Filialbestands-Lookup | 100.000 Zeilen, 10 Treffer | 59,64 ms | 7,37 ms |

Die Detailabfrage benötigt 92 % weniger SQL-Leseaufrufe. Die lokale Gesamtlaufzeit verbessert sich weniger deutlich, da Entschlüsselung und vollständige Authentifizierung weiterhin stattfinden. Bei PostgreSQL entfallen entsprechend viele einzelne Datenbank-Roundtrips; deren reale Wirkung ist separat zu messen.

Reproduktion:

```powershell
node docs/prototypes/trade-performance/article-performance.cjs
node docs/prototypes/trade-performance/article-performance.cjs --stock-index-probe
node --test test/flexible-search-compiled.test.js test/sales-article-performance.test.js test/sales-article-notes.test.js test/sales-article-workspace.test.js
```

Die elf gezielten Tests bestanden lokal. Sie prüfen unter anderem Query-Budget, Indexnutzung, Scope-/Snapshot-/Revisionsfilter, aktuelle Notizstände, unveränderte Preisrechte, Importinvalidierung und die Ablehnung manipulierter Chiffrate bzw. Referenzen. Der Artikelworkspace-Test bestand außerdem in der gemeinsamen nativen PostgreSQL-Prüfung des gesamten Änderungssatzes.

## Verbleibende Grenzen

- Der erste Aufbau des Bestellnummern-Caches muss weiterhin die benötigten verschlüsselten Bestellnummern lesen. Dies ist im Matching-Messwert nicht enthalten.
- Alte Notiz-Snapshots eines Artikels werden weiterhin geprüft, bevor nur der aktuelle vollständig übernommene Stand angezeigt wird. Sie werden nicht gelöscht.
- Ein zusätzlicher Index auf `import_history_references(master_record_id, role, record_id, revision)` senkte den selektiven Bestands-Lookup im optionalen synthetischen Versuch weiter auf etwa 0,06 ms. Dieser Index ist **nicht eingebaut**; das Probeprogramm legt ihn nur in seiner temporären Speicherbank an. Für eine spätere Einführung sind Größe, Import-Schreibkosten und native PostgreSQL-Pläne gemeinsam zu prüfen.

## Größenprüfung der vorhandenen lokalen Volumenfixture

Zusätzlich wurde die bereits vorhandene private Reportingfixture ausschließlich mit einer nativen SQLite-Verbindung mit `readOnly:true`, `query_only=ON` und ohne Verbindungsinitialisierung geöffnet. Kein Neuimport und keine Migration. Die Datenbankgröße und ihr Änderungszeitpunkt blieben unverändert. Das Programm gibt ausschließlich aggregierte Messwerte aus.

Für den direkten Vergleich lädt `--baseline-head` ausschließlich innerhalb des Messprozesses die fünf betroffenen Reportingmodule aus Commit `45dbf13` mittels `git show`. Arbeitsverzeichnis und Git-Stand werden dabei nicht verändert. Anschließend wurde der aktuelle Stand auf derselben Fixture und Maschine gemessen. Die folgende Tabelle ist ein lokaler Einzelvergleich, keine Messung auf dem VPS:

| Vollständig geladene Ansicht | Zeilen | Seiten | Vorher | Aktuell |
| --- | ---: | ---: | ---: | ---: |
| Inventurübersicht | 438 | 3 | 206,40 ms | 193,72 ms |
| Größte Inventur, tatsächlich importierte Detailzeilen | 419 | 3 | 662,56 ms | 579,65 ms |
| Warenbewegungen 01.–18.09.2026 | 2.234 | 12 | 9.159,05 ms | 8.781,37 ms |

Eine separate Baseline-Wiederholung für die Ergebnisdigest-Prüfung ergab 200,44 / 685,92 / 9.024,72 ms. Alle drei SHA-256-Digests über die kanonischen Ergebniszeilen stimmen mit dem aktuellen Stand überein. Keine Geschäftsinhalte wurden ausgegeben:

| Ansicht | Identischer Ergebnisdigest vorher/aktuell |
| --- | --- |
| Inventurübersicht | `08ceaf57ca2fc644285cb624d728c6bb457ba477e2bb8bbab7e134e88a4ced30` |
| Größte Inventurdetails | `e84a661c5a6df1b5b5baa8ab4a91809db9f8e7b1fb02aa14d31d3194c55043e2` |
| Warenbewegungen | `fec3e8be5d5ea1ef496661a195ce74043b15755f84fe82a007351c7ea8a62d31` |

Der direkte Vergleich zeigt keine Regression. Die frühere Bewegungsmessung von rund 20,7 Sekunden fand während parallel laufender Arbeiten statt und wird nicht als Vergleichsmaßstab verwendet. Aus den lokalen Einzelmessungen wird keine feste prozentuale Beschleunigungszusage abgeleitet.

Die Warenbewegungen bleiben bei vollständigem Abruf über zwölf Seiten deutlich aufwendiger als die Inventuransichten. Die Zahlen umfassen authentifizierte Abfragen einschließlich Artikelauflösung, jedoch kein Browser-Rendering und keine Netzwerklatenz.

Reproduktion mit der vorhandenen privaten Fixture:

```powershell
node docs/prototypes/trade-performance/read-volume.cjs --baseline-head
node docs/prototypes/trade-performance/read-volume.cjs
```
