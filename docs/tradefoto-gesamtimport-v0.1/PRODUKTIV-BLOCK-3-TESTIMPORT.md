# Produktivanbindung · Block 3/4 – isolierte Abnahme

Stand: 06.09.2026; Erstlauf vom 05.09.2026. Fortsetzung von [Block 2](PRODUKTIV-BLOCK-2-ZUORDNUNGEN-ANSICHTEN.md).

**Nachtrag zur Freigabe:** Der Auftraggeber hat Q01 am 05.09.2026 ausdrücklich als eng dateigebundene Quellzähler-Toleranz akzeptiert. Umfang, unabhängiger Nachweis und technische Begrenzung stehen in [Q01 – Fehlertoleranz](Q01-FEHLERTOLERANZ-2026-09-05.md). Der anschließend durchgeführte Vollimport einschließlich Rücknahme ist am 06.09.2026 erfolgreich abgeschlossen. Der neue [aggregierte Abnahmenachweis](PRODUKTIV-BLOCK-3-ABNAHME-2026-09-06.json) ergänzt den unverändert erhaltenen historischen Erstbericht.

**Technische Abnahme von Block 3 bestanden.** Alle 1.477.330 erwarteten Zeilen aus 109 Tabellen wurden übernommen und vollständig zurückgenommen. Integritäts- und Fremdschlüsselprüfungen bestanden; keine verbleibenden Zielidentitäten, Historienversionen, Abhängigkeitsbindungen oder Quell-Ziel-Links. Dies ist weiterhin keine bereits durchgeführte Produktivübernahme.

Produktive Datenbanken und Quelldateien blieben unverändert. Die temporäre Testdatenbank samt WAL/SHM wurde entfernt, die flüchtige Schlüsselbasis verworfen. Während Block 3 erfolgten keine Versionierung, kein Commit, Push oder Deploy. Block 4 ist inzwischen ausdrücklich beauftragt; dessen [Betriebsvorprüfung](PRODUKTIV-BLOCK-4-BETRIEBSVORPRUEFUNG.md) hält die Produktivgates weiterhin geschlossen, solange Großdaten-Backup und Kapazität nicht abgesichert sind.

## 0. Nachtrag Q01: abgeschlossene Prüfungen und Vollabnahme

- Die datengebundene Ausnahme ist implementiert, im Import sichtbar und revisionssicher protokolliert. Im Großtest wurden genau zwei Ereignisse `import.source-tolerance.accepted` bestätigt. Originalzähler und ursprüngliche Gates bleiben erhalten.
- Aktuelle Vollsuite einschließlich Ausnahmen-, Integritäts- und Indexregression: **2.884 Tests; 2.844 bestanden, 40 bewusst übersprungen, 0 Fehler**, 742.396,5 ms. Lokaler Nachweis: `tmp/data-import-q01-index-full.tap`.
- Erneuter echter Belegtest: **68 Belegköpfe und 86 Positionen feldgenau**, bestätigte Summen unverändert, explizite Referenz-Neubewertung ohne neue Belegidentitäten, vollständige Rücknahme sowie Integritäts-/Fremdschlüsselprüfung bestanden. Dauer 146.582 ms; Quelle unverändert, temporäre Datenbankdateien entfernt. Lokaler Nachweis: `tmp/tradefoto-block3-receipts-TbtwXx/report.json`. Dieser Test ist ausdrücklich eine Teilmenge, kein vollständiger Kassenimport.
- Neuer Großtest: Alle **395.163 TradeFoto-Zeilen und 1.082.167 Kassenzeilen vollständig übernommen**, einschließlich der beiden genau freigegebenen Tabellen. Drei explizite Zuordnungen auf ausschließlich synthetische GP-Ziele wurden vor abhängiger Historie gesetzt. Wiederholte Uploads nach Übernahme erzeugten keine Duplikate. Anschließend wurden beide Quellen vollständig in zulässiger Abhängigkeitsreihenfolge zurückgenommen; auch die synthetischen Bindungen wurden gelöst.
- Laufbericht: `tmp/tradefoto-block3-7ZXLcj/report.json`, Exit-Code 0, `passed_full_import`, vollständige Rücknahme und Datenbankprüfung bestanden. Quellenhashes und Änderungszeiten blieben gleich; die Testdateibereinigung ist abgeschlossen. Dauer **24.234.317 ms, rund 6 Stunden 44 Minuten**. Gemessene Spitzen: **1.215.750.144 Bytes Prozess-RSS** und **21.297.287.384 Bytes Testdatenbank/WAL/SHM**. Eine kompaktierte vollständige Backupgröße wurde damit nicht gemessen.

### Messgrenze des Großtests

Ein gezielter, auch PostgreSQL-kompatibler Teilindex für noch zu übernehmende Zeilen verhindert das erneute Durchsuchen bereits erledigter Tabellenpräfixe. Die Auswahl derselben 200 verschlüsselten Zeilen dauerte im isolierten TradeFoto-Test vor dem Index 824,1 ms, danach 1,9 ms; die Ergebnismenge war innerhalb einer gemeinsamen Transaktion identisch. Die Indexanlage dauerte 1.084,3 ms. Die separate Regression prüft die tatsächlichen Abfragen mit Paketgrößen 1 und 200.

Der Index wurde **während dieses Großtests ausschließlich in dessen temporärer Datenbank** ergänzt. Die Gesamtzeit dieses Laufs ist deshalb weder eine reine Messung des vollständig optimierten Starts noch eine VPS-Laufzeitprognose. Es wurden keine Quell- oder Fachdaten geändert. Der Rücknahmeindex wurde zusätzlich nur lesend geprüft; beide Rücknahmeabfragen verwenden bereits den vorgesehenen Index.

Die folgenden Erstlaufzahlen und der bisherige `PRODUKTIV-BLOCK-3-PRUEFBERICHT.json` bleiben historische Nachweise. Maßgeblich für den späteren erfolgreichen Vollimport ist der separate [Abnahmenachweis vom 06.09.2026](PRODUKTIV-BLOCK-3-ABNAHME-2026-09-06.json).

## 1. Vollständiger Prüfbestand

| Quelle | Geschäftstabellen einschließlich leerer Tabellen | Tatsächlich bereitgestellte Zeilen |
| --- | ---: | ---: |
| TradeFoto | 102 | 395.163 |
| Kassen-Umsätze | 7 | 1.082.167 |
| Gesamt | 109 | 1.477.330 |

Der Kassenbestand umfasst 219.920 Belegköpfe, 385.877 Verkaufspositionen, 346.921 Tagesberichtszeilen, 39.865 Journalköpfe und 89.584 Journalpositionen. Alle 385.877 Verkaufspositionen besitzen einen passenden Kopf in der Rohquelle. Die zwei weiteren Kassentabellen sind leer und bleiben Teil des Manifests.

Die 26 ausgeschlossenen technischen TradeFoto-Tabellen und die verknüpfte Kassentabelle werden nicht importiert. Es werden keine Links, Makros, Access-/ODBC-Prozesse oder Alt-Zugangskonfigurationen ausgeführt. Erfasste Mengen bedeuten nicht, dass historische Kundentypen, Verkäufer oder sämtliche Umsatzstatus schon fachlich zugeordnet sind.

Der große Test verwendet die tatsächliche verwaltete Upload-/Leser-/Staging-Laufzeit, keine nachgebildete HTTP- oder Importlogik. Direkt nach dem ersten bestätigten Paket wurde gezielt abgebrochen, die Testdatenbank geschlossen und mit derselben flüchtigen Vault-Schlüsselbasis neu geöffnet. Derselbe Dateistand setzte denselben Quelllauf ohne Zeilenverdopplung fort. Auch der erneute Upload beider vollständig bereitgestellten Quellen erzeugte keine zusätzlichen Zeilen oder Läufe.

## 2. Q01: unabhängig bestätigt, aber nicht still aufgehoben

| Tabelle | Deklarierter Quelldateizähler | mdb-reader | Unabhängige Jackcess-Iteration |
| --- | ---: | ---: | ---: |
| ARTIKEL_STAMM | 19.187 | 19.186 | 19.186 |
| ARTIKEL_FILIALEN | 231.355 | 231.351 | 231.351 |

Jackcess 4.0.11 hat beide Tabellen vollständig und ausschließlich lesend durchlaufen. Das ist ein unabhängiger Parser, **kein ausgeführter Microsoft-Access-Datenbankmotor**. Dateihash und Änderungszeit blieben unverändert. Der frühere Versuch mit `access-parser 0.0.6` scheiterte beim Dekodieren und wird ausdrücklich nicht als Bestätigung gewertet.

Damit ist die Differenz zwischen Metadaten und tatsächlich enumerierbaren Datensätzen reproduzierbar, nicht bloß eine Vermutung über den ersten Leser. Die Ursache der höheren Metadatenzähler ist damit jedoch nicht bewiesen. Es wird insbesondere nicht behauptet, fünf fehlende Datensätze gefunden, rekonstruiert oder als gelöscht identifiziert zu haben.

Im historischen Erstlauf blieb `SOURCE_ROW_COUNT_MISMATCH` wirksam. Inzwischen ist die gezielte [Q01-Freigabe](Q01-FEHLERTOLERANZ-2026-09-05.md) umgesetzt: Originalzähler, ursprüngliches Gate, Freigabe und Auditnachweis bleiben erhalten. Weder die Quelldatei noch `declaredRows` wurden korrigiert. Andere Dateien, Tabellen, Schema- oder Zeilenzahlen werden dadurch nicht freigegeben; ein beliebiges HTTP-Freigabefeld gibt es nicht.

Der historische Erstlauf hat deshalb keinen TradeFoto-Zielbestand angelegt. Die Kassenquelle wurde damals ebenfalls nicht angewandt: Der damalige Testtreiber stoppte bereits bei Konflikten der ersten Vorschau. Dort sind fehlende **bereits importierte** Köpfe vor dem Elternimport erwartete Abhängigkeiten, kein Nachweis verwaister Rohzeilen. Der neue Großtest prüfte diese Pläne mit der tatsächlichen Anwendung nach dem Elternimport erneut und übernahm beide Quellen ohne verbleibende Konflikte oder ungültige Zeilen.

## 3. Echte bestätigte Belege: Übernahme, Zuordnung und Rücknahme

Ein getrennt gekennzeichneter, vollständig bestimmter Beleg-Teilexport wurde in einer zweiten frischen Testdatenbank angewandt. Er hat einen eigenen Exportfingerabdruck und eine eigene Testquelle; er wird nicht als vollständiger ACCDB-Import ausgegeben und umgeht kein Gate der Originalquelle.

| Bestätigter Fall | Belege | Positionen | Exakt geprüfter Bruttobetrag |
| --- | ---: | ---: | ---: |
| Originalbeleg vom 26.08.2026 | 1 | 2 | 525,78 EUR |
| Filiale/Kasse 18, 03.09.2026 | 35 | 47 | 2.494,51 EUR |
| Filiale/Kasse 18, 04.09.2026 | 32 | 37 | 1.001,71 EUR |

Insgesamt wurden 68 Köpfe und 86 Positionen, also 154 Historienzeilen, feldgenau mit ihrer vorbereiteten Quelle verglichen. Nullpreisbeleg und negativer Beleg bleiben enthalten. Zwei Positionen mit Steuerkennzeichen 0 im bestätigten Tagesbestand sind tatsächlich Nullpreispositionen; daraus wird keine pauschale Freigabe ungeprüfter Steuerkennzeichen für den gesamten Datenbestand abgeleitet. Die vorhandenen bestätigten Status-/Rabatt-/Rundungsregeln bleiben unverändert. Belege vom 05.09.2026 werden nicht nachgefordert.

GP-Ziele waren ausdrücklich synthetische Test-Standort-/Personalidentitäten, keine geratenen produktiven Zuordnungen. Die Standortbindung wurde vor dem Historienimport gesetzt. Nachträgliche Verkäuferbindungen veränderten bestehende Belegversionen nicht. Erst ein neuer ausdrücklich geprüfter Importversuch übernahm die Referenzen:

- 154 Historienidentitäten vor und nach der Aktualisierung, ohne Doppelzählung.
- Historienversionen 154 → 308; unveränderte Geldbeträge.
- Abhängigkeitsbindungen 308 → 616. Zuordnungsrücknahme bei bestehender Historie korrekt gesperrt.
- Rücknahme anschließend in gültiger Abhängigkeitsreihenfolge: keine verbleibenden Zielidentitäten, Historienversionen oder Bindungen. 314 Prüf-/Änderungsnachweise blieben bis zur Entfernung der temporären Datenbank erhalten.
- SQLite-Integritäts- und Fremdschlüsselprüfung erfolgreich. Quelldatei unverändert.

Dieser Test bestätigt den Ablauf an echten Belegen, nicht die Laufzeit oder Rücknahme aller 1,48 Millionen Zielzeilen. Die umfangreichen synthetischen CRM-/Konflikt-/Rechteprüfungen aus Block 2 sind zusätzlich weiterhin erfolgreich; kein vollständiger realer CRM-Bestand wurde aktiven GP-Karten zugeordnet.

## 4. Leser und Ressourcen

Der Leser hält die projizierten Feldwerte nicht mehr als eine einzige große Tabellenliste, sondern liest Seiten von höchstens 10.000 Zeilen. Der bestätigte Übergabeschritt bleibt bei 200 Zeilen. Ein feldfreier Zähldurchlauf mit demselben Parser bestimmt zuvor die erwartete Anzahl; er wird nicht als unabhängige Bestätigung ausgegeben. Eine anschließend zu kurze Seite bricht geschlossen ab.

Ein kompletter Vergleich der bisherigen Ganzlisten-Lesemethode mit der neuen Seitenlesemethode deckt alle 109 Tabellen und 1.477.330 Zeilen ab. Ein flüchtig geschlüsselter Inhaltsvergleich schließt **alle erlaubten Felder und ihre Zeilenreihenfolge** ein. Beide Methoden lieferten identische Inhalte und bewahrten Q01. Es werden weder Rohfelder noch prüfbare Einzelpersonen-Hashes im Bericht gespeichert.

Der Leser-Worker begrenzt den V8-Old-Generation-Heap auf 512 MiB. Das ist ausdrücklich **kein 512-MiB-Limit des Gesamtprozesses**: Rohdateipuffer, Übergabekopien, native Speicherbereiche und die verschlüsselte Datenbank kommen hinzu. Auch mit Seitenlesen lag die gemessene Prozessspitze des reinen Kassen-Lesevergleichs bei ungefähr 2,04 GB. Eine erhebliche Senkung der gesamten RSS-Spitze ist mit diesem Vergleich nicht nachgewiesen; nur die lebende projizierte Seitenmenge ist jetzt begrenzt.

Der historische Bereitstellungs-/Prüflauf dauerte rund **49 Minuten**. Seine Spitze lag bei **2,49 GB Prozess-RSS** und **5,81 GB für Testdatenbank, WAL und SHM zusammen**. Die damaligen Messwerte stehen im [historischen Prüfbericht](PRODUKTIV-BLOCK-3-PRUEFBERICHT.json). Der spätere vollständige Zielimport einschließlich Rücknahme benötigte deutlich mehr Speicher; seine Werte stehen in Abschnitt 0. Beide Läufe sind keine VPS-Laufzeitprognose. Der Erstlauf startete vor der abschließenden Leser-Seitenänderung; deren vollständiger Inhaltsvergleich und Regression wurden separat durchgeführt. Sicherungskopien, Wiederherstellung und bestehende Produktivdaten kommen zum gemessenen Großtestbedarf hinzu. Die Produktivkapazität bleibt Gegenstand von Block 4.

Alle Testdatenbanken liegen in eigens erzeugten Unterverzeichnissen des ignorierten Repository-`tmp`. Ihr Daten-/Indexschlüssel ist nur prozessintern verfügbar; die verschlüsselten Vault-Umschläge befinden sich ausschließlich in der jeweiligen Testdatenbank. Nach dem Test werden die drei konkret benannten Datenbank-/WAL-/SHM-Dateien entfernt und die flüchtige Schlüsselbasis verworfen. Erhalten bleiben aggregierte Berichte, keine privaten Kundenfelder oder wiederherstellbaren Testschlüssel. Vor und während größerer Schreibschritte bleibt eine Reserve von mindestens 10 GiB auf C: erforderlich.

## 5. Verifikation des Erstlaufs und Reproduktion

- Vollsuite: **2.880 Tests; 2.840 bestanden, 40 bewusst übersprungen, 0 Fehler**, rund 801,4 Sekunden. Der zuvor beobachtete Recovery-`EPERM` trat nicht wieder auf.
- Gezielte Laufzeittests: **19/19**, einschließlich 20.001-Zeilen-Seitengrenze, globaler Zeilenordinalität und Abbruch bei verkürzter Seite.
- Historientests: **42/42**, einschließlich der schrittweisen Jahresauswertung über 5.000 Verkäufe hinaus.
- Vollständiger Leser-Inhaltsvergleich, unabhängiger Zählervergleich und echter Beleg-/Zuordnungs-/Rücknahmetest erfolgreich.
- PostgreSQL-Vertragsinventar unverändert 1.249; keine Provider-Aktivierung. Die Testdatenbank nutzt die bestehenden SQLite-Providerverträge. Architektur-/Syntax-/Diff-Prüfungen sind Teil des Abschlusschecks; keine Browsersteuerung oder visuelle Browserabnahme.

Werkzeuge, jeweils mit expliziten Quellpfadargumenten und ausschließlich neuen temporären Testdateien:

```text
node --max-old-space-size=4096 scripts/verify-tradefoto-full-import.mjs TRADE.accdb CASH.accdb
node scripts/verify-tradefoto-confirmed-receipts.mjs CASH.accdb
node scripts/verify-tradefoto-reader-equivalence.mjs TRADE.accdb CASH.accdb
java -Xmx512m -cp OPTIONAL_JACKCESS_LIBRARIES scripts/VerifyTradeFotoIndependentCount.java TRADE.accdb
node --test --test-concurrency=1 test/data-import-runtime.test.js
node --test --test-concurrency=1 test/tradefoto-history.test.js
node --test --test-concurrency=1
```

Die Quelldateifingerabdrücke sind in den Verifikationswerkzeugen bewusst festgesetzt. Bei anderen Dateien brechen sie ab. Jackcess und seine Java-Laufzeit sind optionale lokale Prüfwerkzeuge, keine neue GP-Abhängigkeit oder globale Installation. Der Java-Leser verwendet den dokumentierten [Read-only-Modus von Jackcess](https://jackcess.sourceforge.io/apidocs/com/healthmarketscience/jackcess/DatabaseBuilder.html), verweigert Links und kontrolliert danach Hash und Änderungszeit.

## 6. Abschluss und Übergang in Block 4

1. Erledigt: ausdrücklich bestätigte, ausschließlich dateigebundene Q01-Behandlung mit unveränderten Originalzählern und dokumentierter Freigabe.
2. Erledigt: vollständiger Zielimport mit Zuordnungen vor abhängiger Historie. Erwartete Vorab-Abhängigkeiten wurden erst nach Elternübernahme erneut bewertet; keine Fremdschlüsselverletzung wurde übergangen.
3. Erledigt: vollständiger Zielbestand, Wiederholung, Rücknahme und Ressourcenmessung. Der explizite Referenz-Neulauf ist separat an 154 echten Historienzeilen geprüft; dies wird nicht als zweiter Referenz-Vollimport aller 1,48 Millionen Zeilen ausgegeben.
4. Block 4 wurde am 06.09.2026 ausdrücklich gestartet: Releasekette, VPS-Kapazität, gemeinsame Datenbank-/Vault-Wiederherstellung, kontrollierter produktiver Erstimport und Kennzahlenaktivierung. Die [Betriebsvorprüfung](PRODUKTIV-BLOCK-4-BETRIEBSVORPRUEFUNG.md) dokumentiert die noch erforderliche Absicherung des Großdatenbetriebs vor dem Rollout.

Branch `feature/schedule-pdf-day-separators`, HEAD `41e6d92e5fc95c30a4ecb11d478802a930ea44e1`, Version unverändert `0.92.27-beta`.
