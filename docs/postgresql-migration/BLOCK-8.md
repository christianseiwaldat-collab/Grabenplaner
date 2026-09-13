# Block 8: Berichte, Suche und Lastnachweis

Stand 12.09.2026. In der isolierten PostgreSQL-Umgebung einschließlich Fach- und Lastnachweis abgeschlossen. Keine produktive Umschaltung.

## Umfang

Die zehn verbleibenden Sales-Tabellen für Berichtaufträge, Importprofile, Aggregatberichte und Kennzahlen sind einschließlich acht Quellindizes und 15 Triggern übertragen. Der Sales-Katalog umfasst 219 gegen PostgreSQL vorbereitete Quellanweisungen. Drei zusätzlich geprüfte Anweisungen übernehmen die lokale Core-Filialreferenz und lesen Belegköpfe/Positionen gebündelt. Schema, Original-SQL-Verträge und Zusatzkatalog sind getrennt versioniert.

Ein echter Node-Worker liest Core und Sales mit getrennten Leserrollen. Er ermittelt aktuelle Rechte aus dem Core und verwendet die bestehende Kassenlogik, Revisionsbindung, begrenzte Analyseschritte und PDF-Erstellung. Auftragsinhalt und PDF bleiben verschlüsselt gespeichert. Rechte werden auch nach einem Worker-Schritt erneut geprüft. Auftragsabbruch, Rechteentzug, Worker-Timeout und Herunterfahren führen zu den vorhandenen kontrollierten Zuständen. Nach Prozesswechsel und abgelaufener Sperrfrist beginnt ein unvollständiger Bericht bei null; er übernimmt keine unvollständigen Zwischensummen als Endergebnis.

Das bisherige PDF-Monatsarchiv wurde über denselben Repository-Ablauf geprüft: bestätigter Import, unveränderte Quellidentität bei Wiederholung, exakte Kennzahlen, unveränderlicher Bericht und atomare Filialzuordnung. Eine fehlende Core-Filiale führt zum Rollback samt eindeutigem Fremdschlüsselfehler.

Zusätzlich bearbeiten drei begrenzte Worker die aufwendige Entschlüsselung und Prüfung der Belegsuche. Höchstens zehn weitere Anfragen warten in der Warteschlange. Jeder Worker besitzt ausschließlich Leserzugänge und prüft die Person sowie den Quellstand selbst; nach dem Ergebnis prüft auch der aufrufende Ablauf die Rechte erneut. Jeder Worker ist auf 512 MiB Old-Generation- und 32 MiB Young-Generation-Heap begrenzt. Das sind V8-Heapgrenzen, keine Garantie für den gesamten Prozess-RSS. Die Datenbankpools sind separat begrenzt. Die HTTP-Einbindung in den späteren PostgreSQL-Gesamtbetrieb gehört zu Block 11. Unter Linux erhalten die eigenen Worker Nice 19; ein nativer Test weist nach, dass der Hauptthread dabei seine bisherige Priorität behält. Diese Linux-spezifische Eigenschaft wird auf anderen Plattformen nicht vorausgesetzt. [Node.js: Priorität](https://nodejs.org/api/os.html#ossetprioritypid-priority), [Linux: Priorität je Thread](https://man7.org/linux/man-pages/man2/setpriority.2.html).

## Suchoptimierungen

Der erste echte SQL-Plan zeigte etwa 413 ms für nur eine häufige Artikelsuche über 20.000 Artikel: dieselbe ASCII-Umrechnung des Textes wurde je Suchwort und Datensatz wiederholt. Eine von PostgreSQL automatisch gespeicherte berechnete Spalte verwendet exakt denselben Ausdruck; jeder Schreibweg hält sie aktuell. Ein Trigrammindex unterstützt Textteile, ein zusätzlicher Sortierindex die Artikelnummer. Vergleichstests mit SQLite prüfen Umlaute, Platzhalter, führende Nullen, keine Treffer, Preisnullwerte und sechs Sortierfelder in beiden Richtungen. Die sechs Suchpreise und Originalpreise verwenden `NUMERIC(30,12)`. [PostgreSQL: berechnete Spalten](https://www.postgresql.org/docs/18/ddl-generated-columns.html), [Trigrammindizes](https://www.postgresql.org/docs/18/pgtrgm.html), [exakte Zahlen](https://www.postgresql.org/docs/18/datatype-numeric.html).

Die PostgreSQL-Belegsuche lädt höchstens 20 Köpfe gemeinsam. Fehlende Positionszusammenfassungen erhalten einen gebündelten, auf 2.001 Zeilen begrenzten Lesezugriff. Ein angeschnittener Batch gilt niemals als vollständiger Beleg: in diesem Fall greifen weiterhin die bisherigen Einzelabfragen und Beleggrenzen. Entschlüsselung, Indexintegrität, vollständige Belegabstimmung und persönliche Rechte bleiben verbindlich. Der Cache gilt nur innerhalb der Transaktion; der vorhandene Zusammenfassungscache bleibt verschlüsselt und an Quelle, Regelstand und Rechte gebunden. Die normale SQLite-Komposition nutzt weiterhin den bisherigen Backend-Standard.

Ein CPU-Profil zeigte zusätzlich wiederholte Normalisierung und Hashbildung bereits validierter Kassenzeilen. Ausschließlich selbst erzeugte, vollständig geprüfte und unveränderliche Zeilen dürfen dieses Ergebnis wiederverwenden. Veränderliche Eingaben, fremde eingefrorene Objekte und andere Quellprofile werden weiterhin vollständig geprüft. Die kanonische Reihenfolge und bisherigen Hashes bleiben unverändert. Beim Lesen gespeicherter Kassenwerte entfällt außerdem die doppelte Rohdaten-Konvertierung: Die vollständige Profilprüfung arbeitet direkt auf den gespeicherten skalaren Werten. Der exakte Vergleich aller Originalwerte bleibt erhalten.

Die feste Feldreihenfolge wird einmal aus dem geprüften Quellprofil vorbereitet. Bereits validierte skalare Werte werden pro Zeile einmal kodiert und für Quelle, Ziel und Schlüssel wiederverwendet. Tests vergleichen die bisherigen kanonischen Bytes auch bei numerischen Feldnamen, Unicode, Steuerzeichen, Nullwerten und eingebetteten Zeilen. Die gesamte Zeilengröße und die maximale Verschachtelung bleiben begrenzt.

## Prüfungen

- Alle vier Core-/Sales-Fachtests aus Block 7 bestanden erneut gemeinsam.
- Aggregatarchiv einschließlich Rollback/Referenz, sechs Sortierfelder mit neun Suchmustern und beiden Richtungen, PDF/Rohertrag sowie Rechteentzug/Abbruch wurden auf echter PostgreSQL geprüft.
- Ein Worker wurde nach einem Teilbatch gestoppt. Der neue Worker erstellte nach abgelaufener Sperrfrist das vollständige Ergebnis mit genau 600 Positionen und einem protokollierten Wiederanlauf.
- Die kleine PDF-Probe enthält 159,08 EUR brutto und 36,28 EUR Kassen-Rohertrag. Neun A4-Querformatseiten wurden gerendert und visuell geprüft; keine abgeschnittenen Inhalte. Die Datei ist rein synthetisch.
- 25 bestehende Provider-/Worker-/Berichts-/Routentests und 55 bestehende Beleg-/Kassen-/Cachetests bestanden. Ein echter PostgreSQL-Idle-Timeout wird zusätzlich ausgelöst; der folgende Datenbankvorgang bleibt nutzbar.

Nach den letzten Decoder-Optimierungen bestanden 63 gezielte Kassen-/Berichts-/Cachetests und alle 143 Import-/Quellvertragstests. Zusätzlich wurde die exakte kanonische Kodierung mit numerischen Feldnamen, Unicode, Grenzgrößen und Verschachtelung geprüft.

Der erste Aggregat-Test erwartete zunächst einen unverpackten internen Fehler. Der fehlende Standort wird nun ausdrücklich als öffentlicher Fremdschlüsselfehler gemeldet; der gezielte erneute Lauf bestand beide Archiv-/PDF-Prüfungen. Fehlgeschlagene erste Lastläufe bleiben als Vergleich erhalten und werden nicht als erfolgreiche Abnahme ausgegeben.

## Lastprofil und Grenzen

Das reproduzierbare Skript `scripts/postgresql/qualify-load.js` läuft im eigenen markierten Serververzeichnis mit fünf gleichzeitigen Benutzern, 20.000 synthetischen Artikeln, 2.000 vollständigen Belegen und 8.000 Positionen. Je Phase werden 100 komplette interaktive Abläufe gemessen: frische Anwendungscaches, warme Caches und parallel ein großer PDF-Bericht. Alle 100 Abläufe der letzten Phase müssen während der Berichtverarbeitung stattfinden. PostgreSQL-/Betriebssystem-Caches werden auf dem gemeinsam genutzten Host nicht geleert.

Die Beleg-Worker werden vor der Messung gestartet und verbinden sich zur geprüften Datenbank. In der kalten Phase bekommt jeder einzelne Belegaufruf neue Anwendungscaches; Threadstart und Schema-Vorprüfung sind damit bewusst kein Bestandteil der interaktiven Seitenlatenz. Der Bericht wird im vorhandenen Ein-Sekunden-Takt der Auftragsverarbeitung weitergeführt. Das ist keine künstlich engere Endlosschleife und kein Nachweis für HTTP-Kaltstartzeiten.

Artikel für den wiederholten Lasttest werden nach dem separaten erfolgreichen PostgreSQL-Importnachweis per begrenztem Test-Bulkaufbau mit aktiven Constraints vorbereitet. Kassenbelege durchlaufen den wirklichen verschlüsselten Import und die Freigabe. Der Bulkaufbau ist weder historischer Migrationslauf noch Importbenchmark. CPU, Prozess-RSS einschließlich Worker-Threads, Eventloop, Poolwartezeiten der interaktiven Komposition, vollständige Ergebnisse und tatsächliche SQL-Pläne werden zusammen mit p50/p95 protokolliert. Separate Worker-Poolwartezeiten werden nicht als vollständig gemessen ausgegeben. Fünf parallele Clientabläufe verwenden drei synthetische Core-Identitäten; die Belegabfragen verwenden dasselbe berechtigte Testkonto. Historische Benutzer-/Filialkombinationen gehören zur Gesamtprobe in Block 11.

**Laststatus: bestanden.** Alle fünf festgelegten Prüfungen sind erfüllt. p95 aus jeweils 100 vollständigen Abläufen:

| Phase | Artikel zuerst / weiter | Belege zuerst / weiter | Core |
|---|---:|---:|---:|
| Kalte Anwendungscaches | 120 / 116 ms | 638 / 482 ms | 28.99 ms |
| Warme Caches | 106 / 126 ms | 347 / 361 ms | 19.46 ms |
| Mit Bericht | 116 / 125 ms | 362 / 396 ms | 20.87 ms |

Auftragsannahme: 132 ms. Core unter Berichtlast: +7.25 %, unter dem Ziel von 20 %. Alle 100 parallelen Abläufe überlappten den Bericht. Genau 8.000 Positionen wurden verarbeitet; die PDF weist für Sony aktuell und im Vergleich jeweils 240.000,00 EUR brutto, 200.000,00 EUR netto und 40.000,00 EUR Rohertrag aus. Die vollständigen Messwerte, Ressourcen und SQL-Pläne stehen in [block-8-load.json](block-8-load.json), frühere erfolglose Ansätze in [der Messhistorie](block-8-performance-history.json).

Der endgültige native Kassenlauf bestand alle fünf Tests gemeinsam. Der abschließende PDF-/Beleg-/Rechteentzugstest bestand ebenfalls; 219 SQL-Anweisungen und alle 15 Stufe-8-Trigger wurden erneut gegen PostgreSQL aufgelöst.

Die vollständige historische Übernahme mit Zeilen-/Inhaltsvergleich folgt in Block 9. PostgreSQL-Backup, Offsite und zusammengehöriger Restore folgen in Block 10; produktionsähnliche HTTP-/Browser-, Mehrjahres-, Gesamtfilial- und Ausfallproben mit historischen Daten in Block 11. Die bisher separat festgestellten fehlgeschlagenen Offsite-Assurance-Läufe müssen vor einer Freigabe geklärt werden. Block 12 bleibt die gesondert freizugebende produktive Umschaltung.
