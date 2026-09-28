# Trade-Daten: Performanceprüfung und Optimierungen

Stand: 28.09.2026 · Basis: `45dbf13` · Branch: `feature/trade-db-import-overview-20260925`

Die Verbesserungen sind lokal umgesetzt und mit SQLite, nativem PostgreSQL sowie im Browser geprüft. Dieser Bericht dokumentiert die Prüfungen vor Commit und Veröffentlichung. Es erfolgten kein Deploy und keine Änderung an produktiven Datenbanken oder den Access-Quelldateien.

## Ergebnis

Der wichtigste Engpass waren viele einzelne Datenbankzugriffe für zusammengehörige Artikel, Bestände und Belege. Diese Daten werden jetzt in begrenzten Paketen innerhalb derselben Lesetransaktion geladen. Wiederholte Browserarbeit beim Tabellenaufbau und bei der Zahlenformatierung entfällt ebenfalls.

| Bereich | Prüfung | Vorher | Nachher |
| --- | --- | ---: | ---: |
| Warenbewegungen | 200 Zeilen, native PostgreSQL-Leseaufrufe insgesamt | 1.102 | **33** |
| Artikelkartei | 100 Notizen und 20 Filialbestände, SQLite-Leseaufrufe | 232 | **18** |
| Belegsuche | 50 Belege, PostgreSQL-Abfragen insgesamt | 76 | **20** |
| Belegexport | 50 Belege, PostgreSQL-Abfragen insgesamt | 111 | **17** |
| Artikelnotizen suchen | 100.000 Notizen, 10 Treffer, SQLite | 117,50 ms | **0,05 ms** |
| Filialbestand suchen | 100.000 Positionen, 10 Treffer, SQLite | 59,64 ms | **7,37 ms** |
| Bestellnummern filtern | 50.000 bereits geladene Nummern | 81,89 ms | **ca. 18–20 ms** |
| Tabellenwerte formatieren | 20.000 Zahlen/Währungswerte | 620,69 ms | **16,48 ms** |
| Spezialtabellen aufbauen | Warenbewegungen, Inventuren, Vorschläge | zweimal | **einmal** |

Dies sind lokale Vergleichsmessungen, keine Messung der produktiven GP-Ladezeit. Insbesondere die Millisekunden einzelner SQL-Abfragen und Formatierungsfunktionen dürfen nicht als gesamte Seitenladezeit gelesen werden.

Die vollständige Warenbewegungsseite benötigte lokal vor der Änderung 705 bzw. 717 ms und danach in den Prüfläufen 324–377 ms. Der Test enthält 80 aktuelle, 80 archivierte und 40 fehlende Artikel sowie einen gemeinsamen Bestellbezug. Das Abfragebudget ist als Regressionstest festgehalten. Beide aktuellen Testvarianten nutzen die neue Paketabfrage; ihr Schalter `legacyImportCapability` prüft nur die Kompatibilität mit der älteren Provider-Fähigkeit und stellt keinen Vorherzustand dar.

Bei der Belegsuche sank der Median aus drei lokalen PostgreSQL-Läufen von 211,80 auf 161,43 ms, beim Export von 184,17 auf 142,60 ms. Die eigentlichen Kopf-/Positionsabfragen reduzieren sich dabei von 62 auf 6 bzw. von 100 auf 6. Eine bereits zwischengespeicherte Suche benötigt im gleichen Test etwa 32–39 ms. Die Kontrollvariante reproduziert den bisherigen Abruf der ersten 20 Belege und die anschließenden Einzelabfragen mit denselben Decodern und Rechten.

Die Artikelkartei benötigt wesentlich weniger Abfragen; ihre gesamte lokale Laufzeit schwankt aber zwischen ca. 38 und 48 ms bei vorher 47,92 ms. Entschlüsselung und Authentifizierung bleiben vollständig erhalten. Für diese Gesamtansicht lässt sich deshalb noch keine belastbare pauschale Beschleunigung in Prozent angeben.

Zusätzlich wurde die vorhandene lokale Reportingkopie mit 19.584 aktuellen Artikeln, 17.468 Archivartikeln, 141.084 Warenbewegungen und 4.902 ausgewählten Inventurpositionen ausschließlich lesend geprüft. Ein direkter Vergleich der bisherigen Trade-Lesewege aus `45dbf13` mit dem aktuellen Stand ergab:

| Vollständige Ansicht | Zeilen / Seiten | Vorher | Nachher |
| --- | ---: | ---: | ---: |
| Inventurübersicht | 438 / 3 | 206 ms | 194 ms |
| Größte Inventurdetails | 419 / 3 | 663 ms | 580 ms |
| Warenbewegungen 01.–18.09.2026 | 2.234 / 12 | 9.159 ms | 8.781 ms |

Dies ist ein einzelner sequenzieller SQLite-Vergleich ohne zusätzliche Testlast, keine statistisch abgesicherte Prozentprognose. Die SHA-256-Prüfsummen der vollständigen Ergebnisse aller drei Ansichten stimmen zwischen vorher und nachher exakt überein. Ein erster Lauf mit paralleler Testlast benötigte für die Warenbewegungen 20,7 Sekunden; er wird nicht als vergleichbarer Vorher-/Nachherwert verwendet. Große Gesamtauswertungen bleiben trotz weniger Einzelabfragen aufwendiger als einzelne Seiten. Die Datenbank wurde mit `readOnly:true` und `query_only=ON` geöffnet; Dateigröße und Änderungszeit blieben unverändert.

## Was geändert wurde

- **Artikelstamm und Notizen:** Den vorhandenen Relationsindex zuerst verwenden; Notizsegmente, Bestandsdaten und Filialnamen paketweise lesen. Bestellnummern-Suchmuster nur einmal je Suchanfrage vorbereiten.
- **Warenbewegungen, Artikelhistorie und Inventurdetails:** Aktuelle und archivierte Artikel vorab bündeln; bereits geprüfte Artikel innerhalb derselben Anfrage wiederverwenden. Führende Nullen und zeitliche Zuordnungen bleiben unverändert.
- **Einkauf und Lieferantenrechnungen:** Zugehörige Bestell- und Rechnungsköpfe bündeln. Auch nicht vorhandene Bezüge werden innerhalb der Anfrage einmal ermittelt, statt sie je Position erneut zu suchen.
- **Belegsuche und Export:** Weitere benötigte 20er-Gruppen tatsächlich vorladen; kleine Ergebnisse bleiben begrenzt. Deutschen Zahlen-Collator beim Sortieren wiederverwenden, bei identischer Sortierreihenfolge.
- **Oberfläche:** Formatierer wiederverwenden und doppelte Tabellenaufbauten entfernen. Beim Sortieren, Nachladen und Einklappen der Artikelliste wird die unveränderte Artikelkartei nicht erneut aufgebaut. Versuchswerte und Notizenfilter bleiben dadurch erhalten.
- **Bestands- und Kundenansichten:** Einen innerhalb derselben Transaktion bereits gelesenen Änderungsstand wiederverwenden.

Keine neue Datenbankmigration, keine zusätzlichen persistenten Klartextkopien und keine Löschung von Import- oder Historiedaten. Neue Abfragepakete gelten nur innerhalb der jeweiligen Transaktion. Herkunft, Hashes, Revisionen, Filialrechte und aktuelle Sitzungsberechtigungen werden weiterhin geprüft. Unvollständige Importe und veraltete Cursor bleiben gesperrt.

## Prüfung

Erfolgreich ausgeführt wurden:

- 28 Tests für Artikelhistorie, Warenbewegungen, Inventuren, Lieferantenrechnungen sowie Trade-API und Einkauf.
- 36 ergänzende Tests für Bestände, Summen, Kundenhistorie, Vorschläge und Artikelrechte/-routen.
- 65 kombinierte Tests für Oberfläche, Preisversuch, Suche, Artikelnotizen, Abfragebudgets, Messprovider und Belegsortierung.
- 69 bestehende Kassen-/Belegtests im entsprechenden Arbeitspaket.
- Sechs unterschiedliche native PostgreSQL-Tests: Artikelkartei, Trade-Blöcke 2–5, weitere Trade-Ansichten, Performance/Rechteentzug, Beleg-Prefetch und Lieferantenrechnungen. Der lokale Weg über den Reporting-Worker ist mitgeprüft.
- Browserprobe am vorhandenen synthetischen GP-Preview: Versuch mit 100 Euro Rohertrag und Notizenfilter ab 01.09.2026 bleiben nach Sortierung und Einklappen erhalten; keine Konsolenfehler.
- `git diff --check`: keine Fehler. Der eigens gestartete lokale PostgreSQL-Testcluster wurde danach beendet.

Die Tests umfassen Quellenwechsel, Importinvalidierung, archivierte Artikel, negative Mengen, exakte Dezimalwerte, Manipulationsabwehr, PDF-Ausgaben, unvollständige Importe, Undo, Filialrechte, Preisrechte und Berechtigungsentzug während einer Anfrage. Es handelt sich um die gezielten Prüfungen dieser Änderungen, nicht um einen Lauf der gesamten Projekt-Testsuite.

## GP-Start und weitere sinnvolle Hebel

Der initiale GP lädt derzeit 36 Script- und 12 Stylesheet-Verweise. Die großen Quelldateien sind `app.js` mit etwa 2,43 MB, `styles.css` mit 0,72 MB und `index.html` mit 0,50 MB. Testweise gzip-komprimiert ergeben sie etwa 477, 104 und 91 kB. Das sind Dateimessungen, keine gemessenen Live-Transfergrößen. Die vorhandenen Caddy-Konfigurationen aktivieren bereits gzip/zstd.

Ein größerer nächster Schritt wäre, Fachbereiche und selten benötigte Dialoge erst beim Öffnen zu laden. Das betrifft die zentrale GP-Struktur und benötigt eine eigene Prüfung von Navigation, Rechten und Direktlinks. Die aktuelle Optimierung entfernt bereits unnötige Arbeit in den betroffenen Trade-Ansichten.

Weitere konkrete Kandidaten sind das tatsächliche Abbrechen überholter Artikel-/CRM-/Rechnungsanfragen, weniger Neuaufbau unveränderter Importstatuslisten sowie die begrenzte Darstellung sehr großer gespeicherter Auswertungen. Veraltete Antworten werden bereits verworfen; ein echter Abbruch könnte zusätzlich Serverarbeit sparen.

Ein weiterer Bestandsindex wurde nur in einer synthetischen Speicherbank erprobt und ist nicht eingebaut. Vor Einführung sind sein Platzbedarf, die Kosten beim Import und der PostgreSQL-Abfrageplan am tatsächlichen Datenumfang zu prüfen. Ein reines Löschen älterer Importdaten ist aus den Messungen nicht als notwendige Performance-Maßnahme ableitbar.

## Nachweise und Reproduktion

- [Artikelmessung und technische Grenzen](ARTICLE-PERFORMANCE.md)
- `node docs/prototypes/trade-performance/article-performance.cjs`
- `node scripts/benchmark-trade-ui.cjs`
- `node docs/prototypes/trade-performance/read-volume.cjs` – vorhandene private Volumenkopie ausschließlich lesend prüfen.
- Native Tests über den vorhandenen isolierten Runner `docs/prototypes/trade-final/native-postgresql.cjs`; benötigen dessen eigenen lokalen Testcluster, keine produktiven Verbindungsdaten.
- Browserbilder: `C:/Users/chris/Documents/Lamprechter/output/GP-Trade-Performance-2026-09-28/`

Vor Aussagen zur Geschwindigkeit im Livebetrieb ist nach einem separat freigegebenen Deploy eine Messung derselben Ansichten auf dem VPS erforderlich.
