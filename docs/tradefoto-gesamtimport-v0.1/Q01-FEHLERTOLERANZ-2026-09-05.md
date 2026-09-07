# Q01 – bestätigte Quellzähler-Abweichung

Freigabe des Auftraggebers am 05.09.2026: Die bereits unabhängig untersuchte Abweichung darf als Fehlertoleranz protokolliert werden, um Block 3 mit einem isolierten Vollimport fortzusetzen. Keine Produktiv-, Release- oder pauschale Datenqualitätsfreigabe.

## Exakter Geltungsbereich

Quelle: TradeFoto-Stammdatei, 188.649.472 Bytes, SHA-256 `42a40cb19d867fcc5d6e6f3429065ba0ff77f65a7b9b7fcfaae3d0b61f8154f3`.

| Tabelle | Deklariert | Vollständig lesbar | Akzeptierte Zählerdifferenz |
| --- | ---: | ---: | ---: |
| ARTIKEL_STAMM | 19.187 | 19.186 | 1 |
| ARTIKEL_FILIALEN | 231.355 | 231.351 | 4 |

Die genehmigten Fingerabdrücke von Schema und Importprofil sind zusätzlich in `lib/tradefoto-source-tolerances.js` festgesetzt. Andere Dateien, Tabellen, Profile, Schemata oder Zahlenpaare erhalten keine Ausnahme. Es gibt weder Prozenttoleranz noch frei nutzbaren HTTP-Schalter.

## Prüfnachweis und verbleibende Unsicherheit

- mdb-reader 3.2.0 und Jackcess 4.0.11 lieferten dieselben vollständig enumerierten Bestände.
- Zusätzliche rein lesende Prüfung aller physischen Datenseiten: keine weiteren aktiven Zeilen dieser Tabellen außerhalb des regulären Durchlaufs.
- Alle acht physischen Artikelindizes sowie alle drei Artikel-Filialindizes bestätigen jeweils dieselbe aktive Zeilenanzahl ohne zusätzliche Zeilenidentitäten.
- Alte gelöschte Zeilenreste sind kein belastbarer Nachweis, welche genau eine bzw. vier Geschäftsdatenzeilen die höheren Metadatenzähler erklären. Ein leerer Artikel-Zeilenslot enthält keine zuverlässig rekonstruierbare Artikelidentität. Die 31 alten Artikel-Filialreste erklären nicht nachgewiesenermaßen genau vier Zeilen.
- Vermutete Fehlbuchungen oder Probleme des Quellsystems sind eine mögliche fachliche Erklärung des Auftraggebers, keine technisch nachgewiesene Ursache.
- Quelldateihash und Änderungszeit blieben unverändert. Keine Access-Ausführung, Reparatur, Verknüpfungsauflösung oder Wiederherstellung gelöschter Daten.

Der lokale Detailnachweis liegt unter `tmp/q01-pruefung-2026-09-05.md` und `tmp/q01-details-2026-09-05.json`. Diese privaten Prüffunde werden nicht in öffentliche Produktartefakte übernommen.

## Behandlung im Import

Die ursprünglichen Zähler und das ursprüngliche Gate bleiben im integritätsgeschützten, an die Laufidentität gebundenen Manifest erhalten. Das wirksame Zähler-Gate wird ausschließlich bei exakt passender Freigabe durch einen sichtbaren Warnnachweis ersetzt. Ereignis `import.source-tolerance.accepted` protokolliert die Annahme einmalig mit Importakteur, Zeit und Revision; die Freigabereferenz und der vollständige Prüfumfang bleiben Teil des Manifests.

Alle lesbaren Zeilen werden unverändert nach dem regulären Feldvertrag geprüft. Keine Artikel-, Buchungs-, Preis-, Bestands- oder Umsatzkorrektur; keine Erfindung fehlender Datensätze. Schema-, Quellschlüssel-, Abhängigkeits-, Rechte-, Revisions- und Rücknahmeprüfungen bleiben wirksam. Die Toleranz bestätigt keine fachliche Richtigkeit sämtlicher Buchungen.

Ein bestehender Lauf behält seine damalige Entscheidung auch nach Neustart. Die Freigabe verändert alte strenge Manifeste nicht rückwirkend. Wird eine Freigabe aus der vertrauenswürdigen Registrierung entfernt, bleiben ihre historischen Belege lesbar und Rücknahmen möglich; weitere Übernahmen unter dieser Freigabe werden gesperrt.

## Fortsetzung

Block 3 ist technisch abgenommen: 1.477.330 Zeilen aus 109 Tabellen vollständig importiert und zurückgenommen, Integritäts-/Fremdschlüsselprüfung erfolgreich, Originaldateien unverändert. Die Vollsuite besteht mit 2.844 erfolgreichen und 40 bewusst übersprungenen Tests ohne Fehler. Der [Block-3-Nachtrag](PRODUKTIV-BLOCK-3-TESTIMPORT.md) und der separate [Abnahmenachweis](PRODUKTIV-BLOCK-3-ABNAHME-2026-09-06.json) ergänzen den unveränderten historischen Erstbericht. Block 4 ist am 06.09.2026 ausdrücklich gestartet; dessen [Betriebsvorprüfung](PRODUKTIV-BLOCK-4-BETRIEBSVORPRUEFUNG.md) hält die Produktivschalter bis zur Absicherung von Großdaten-Backup und Kapazität geschlossen. Noch kein Commit, Push, Deploy oder Produktivimport.
