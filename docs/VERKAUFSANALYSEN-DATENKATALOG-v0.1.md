# Verkaufsanalysen · Datenkatalog v0.1

## 1. Dokumentstatus und Grenze

| Merkmal | Stand |
| --- | --- |
| Fachbereich | Verkaufsverwaltung → Verkaufsanalysen |
| Block | 2 · Datenkatalog |
| Version | v0.1 |
| Stand | 03.08.2026 |
| Status | fachlicher Katalog auf Basis zweier lokaler Datenbank-Snapshots |

Dieser Katalog legt fest, welche vorhandenen Quelldaten für spätere Verkaufsanalysen fachlich sinnvoll sind, welche Daten nur zur Importprüfung verwendet werden dürfen und welche Daten ausgeschlossen bleiben.

Der Katalog ist noch keine Freigabe für eine technische Datenübernahme. Block 2 enthält insbesondere keine produktiven Tabellen, Migrationen, API-Endpunkte, Importprogramme, Hintergrundläufe, Rollenfreigaben oder Echtdaten im Repository. Zugangsdaten und einzelne Quelldatensätze werden nicht dokumentiert.

Die untersuchten Dateien sind nicht als aktuelle Produktionsdaten zu behandeln. Sie dienen ausschließlich als Struktur- und Qualitätsnachweis für diesen Katalog.

## 2. Verbindliche Katalogbegriffe

| Kennzeichnung | Bedeutung |
| --- | --- |
| `KERN-ALLOWLIST` | Das Feld oder die Tabelle ist für einen ersten fachlich begrenzten Import vorgesehen, sobald die zugehörigen offenen Regeln entschieden sind. |
| `STAGING/PRÜFUNG` | Der Wert darf später nur vorübergehend zur technischen Prüfung, Zuordnung oder Abstimmung verarbeitet werden. Er gehört nicht automatisch in den dauerhaften Analysebestand. |
| `SPÄTER OPTIONAL` | Ein denkbarer späterer Umfang mit eigenem Nutzen- und Rechteentscheid. Er gehört nicht zum ersten Import. |
| `FACHLICH ZU KLÄREN` | Inhalt oder Semantik sind noch nicht hinreichend sicher. Bis zur Klärung gilt keine Importfreigabe. |
| `AUSSCHLUSS` | Der Inhalt wird für Verkaufsanalysen nicht übernommen. |

Die Auswahl ist fail-closed: Nicht ausdrücklich in der `KERN-ALLOWLIST` genannte Tabellen und Felder gelten als `AUSSCHLUSS`. Ein später geändertes Quellschema erweitert die Allowlist nicht automatisch.

## 3. Quelleninventar

Die Prüfbasis wird nur über Dateieigenschaften und kryptografische Fingerprints beschrieben. Die Datenbankdateien selbst und daraus gelesene Einzelzeilen gehören nicht in den Grabenplaner-Quellcode.

| Quellsystem | Snapshot | Größe | Änderungsstand | SHA-256 |
| --- | --- | ---: | --- | --- |
| Kassenumsätze | `Kassen_Umsätze.accdb` | 222.531.584 Bytes | 09.06.2020, 11:13 Uhr | `390818D10567DB5D9EE8C262D8E98798C9A69B219FE0F72CC59B184DFCC02D7C` |
| Warenwirtschaft | `Trade_Daten.accdb` | 185.028.608 Bytes | 29.06.2026, 12:36:54 Uhr | `B6FFD5D7FD439835CC52961709AA89E772894C3ABD12569C5AD6A6486AC3FD9D` |

Die Kassen- und Warenwirtschaftsdaten bilden deutlich verschiedene Zeitstände ab. Historische Verkäufe bis Juni 2020 und Warenwirtschafts-Snapshots aus 2026 bleiben deshalb getrennte Datensichten. Aktuelle Artikel- oder Bestandswerte dürfen historische Kassenpositionen nicht rückwirkend verändern oder als damals gültige Werte erscheinen lassen.

## 4. Festgestellte Datenbasis

### 4.1 Kassenumsätze

| Tabelle | Festgestellter Umfang | Fachliche Einordnung |
| --- | --- | --- |
| `Umsatz_KASSE` | 212.726 Belege vom 02.01.2018 bis 09.06.2020; 13 Filialkennungen; 10 Kassenkennungen | Belegkopf und zeitliche/organisatorische Zuordnung |
| `Umsatz_Kasse_Details` | 334.041 Positionen; 14.653 unterschiedliche EANs; 19.137 Artikelbezeichnungen; 199 Sortimente; 306 Markenwerte | zentrale historische Verkaufsfakten |
| `Tagesbericht` | aus Kassendaten abgeleitete Tageswerte | kein Primärbestand; aus importierten Positionen reproduzierbar |
| `KassenJournal` und `KassenJournal_Details` | zusätzliche Kassen- und Bewegungsdaten | nicht Teil des ersten Verkaufsanalyse-Imports |

Wesentliche Qualitätsbefunde:

- In `Umsatz_KASSE` ist `RechnungsBetrag` bei 208.093 von 212.726 Belegen null, also bei rund 97,8 Prozent. Das Feld ist kein verlässlicher Umsatzanker; Belegwerte müssen aus den Positionen abgeleitet und gegen vorhandene Kopfwerte geprüft werden.
- In den Positionen kommen 14.427 negative Mengen vor. Sie sprechen für Retouren oder Korrekturen, dürfen aber ohne geklärte Storno- und Retourenlogik nicht automatisch so bezeichnet werden.
- Die Belegköpfe enthalten 7.219 unterschiedliche Kundenkennungen; bei 198.853 Belegen steht der Wert null. Kundenkennungen sind für den vorgesehenen Analyseumfang nicht erforderlich und bleiben ausgeschlossen.
- Es kommen 69 unterschiedliche Verkäuferkennungen vor. Personenbezogene Mitarbeiter- oder Leistungsanalysen sind nicht Ziel dieses Fachbereichs; die Kennungen bleiben ausgeschlossen.

### 4.2 Warenwirtschaft

| Tabelle | Festgestellter Umfang | Fachliche Einordnung |
| --- | --- | --- |
| `ARTIKEL_STAMM` | 18.996 eindeutige 13-stellige EANs; 18.192 Markenangaben; 8.471 Internet-Kennzeichen; 10.582 Internetbezeichnungen | aktueller Artikelstamm-Snapshot, nicht historische Wahrheit |
| `ARTIKEL_FILIALEN` | 228.302 Artikel-Filial-Sätze über 13 Filialkennungen | aktueller Filialbestand und Filialpreis als Snapshot |
| `ARTIKEL_ZWEITEAN` | 37.412 alternative EAN-Zuordnungen | Aliasauflösung zur primären EAN |
| `Shopware_Artikel` | 10.402 Artikelzuordnungen | technische Produktzuordnung, keine Shopbestellungen und keine Shopumsätze |
| `ARTIKEL_Sortimente` | 229 Einträge | Sortimentstaxonomie |
| `ARTIKEL_Warengruppen` | 92 Einträge | Warengruppentaxonomie |
| `ARTIKEL_Sparten` | 18 Einträge | Spartentaxonomie |
| `Marken` | 605 Einträge | Markenregister |
| `tblProtBestand_comp` | 10.339 Zeilen vom 12.03.2026 bis 25.03.2026 über 7 Filialkennungen | zu kurzer und unvollständiger Zeitraum für eine verlässliche Bestandshistorie |

Für `ARTIKEL_FILIALEN` wurden Bestandsänderungsdaten vom 21.12.2021 bis 25.03.2026 und Inventurdaten bis 19.03.2026 festgestellt. Der Tabelleninhalt ist dennoch als Snapshot zu behandeln: Ein Änderungsdatum je Artikel-Filial-Satz ersetzt keine vollständige Bestandszeitreihe.

### 4.3 Verbindung beider Quellen

Von 14.653 unterschiedlichen EANs aus den Kassenpositionen stimmen 5.388 direkt mit einer aktuellen primären EAN im Artikelstamm überein. Das entspricht 36,77 Prozent der unterschiedlichen historischen EANs. Weitere 9.265 EANs bleiben ohne sichere aktuelle Zuordnung; reine Treffer ausschließlich über `ARTIKEL_ZWEITEAN` wurden in diesem Snapshot nicht festgestellt.

Von den direkt zugeordneten historisch verkauften Artikeln besitzen 3.120 auch eine Zuordnung in `Shopware_Artikel`. Daraus folgt lediglich eine Produktverknüpfung. Es folgt daraus weder ein Onlineverkauf noch ein Shopumsatz.

Historische `Artikelbezeichnung`, `UMarke` und `Sortiment` aus der Kassenposition werden als damaliger Beleg-Snapshot erhalten. Aktuelle Stammdaten dürfen diese Werte nur ergänzen, niemals überschreiben.

## 5. Sinnvolle fachliche Importpakete

Nach Klärung der offenen Regeln sind folgende voneinander getrennte Pakete sinnvoll:

1. **Historische Verkaufsfakten 2018–2020**<br>
   Belege und Positionen mit Datum, Uhrzeit, Filial- und Kassenbezug, EAN, Menge, Verkaufspreis, Sollpreis, Rabatt, Umsatzsteuer sowie historischem Artikel-, Sortiments-, Marken- und Rohertrags-Snapshot. Ohne Kunden- und Verkäuferbezug.

2. **Artikelstamm-Snapshot 2026**<br>
   Primäre EAN, Bezeichnung, Marke, Sortiment und Taxonomie, Artikelstatus, Internetkennzeichen sowie eindeutig definierte aktuelle Preisangaben. Dieser Snapshot wird mit seinem Gültigkeitszeitpunkt geführt.

3. **Filialbestand-Snapshot 2026**<br>
   EAN, Filialzuordnung, Bestand, bestellt, im Zulauf, Filialverkaufspreis sowie Inventur- und Bestandsänderungsdatum. Der Snapshot erlaubt eine aktuelle Bestandsansicht, aber noch keinen historischen Bestandsverlauf.

4. **EAN-Aliase und Taxonomien**<br>
   Zweit-EAN-Zuordnungen sowie Sortiment, Warengruppe, Sparte und Marke zur nachvollziehbaren Gruppierung.

5. **Shopware-Produktzuordnung**<br>
   Ausschließlich die Zuordnung einer EAN zu vorhandenen Shopware-Artikelkennungen. Für Onlineshop-Umsatzanalysen wird eine eigene Bestell- oder Umsatzquelle benötigt.

Diese Pakete dürfen erst nach einem späteren Import- und Rechteentscheid technisch umgesetzt werden. Insbesondere ist das Alter der Kassenquelle sichtbar auszuweisen; sie liefert keine Aussage über aktuelle Umsätze.

## 6. Vorgesehener fachlicher Zielkatalog

Die folgenden Entitäten beschreiben ein Zielbild, keine bereits anzulegenden Datenbanktabellen.

| Zielentität | Minimaler Inhalt | Zweck und Grenze |
| --- | --- | --- |
| Importlauf | Quellsystem, Datei-Fingerprint, Snapshot-Zeit, Profilversion, Start/Ende, Status, gelesene/akzeptierte/verworfene Zeilen | Nachvollziehbarkeit und idempotente Wiederholung; kein Quellpasswort und kein dauerhafter lokaler Dateipfad |
| Filialzuordnung | Quellsystem, externe Filialkennung, Grabenplaner-Standort, Gültigkeit, Zuordnungsstatus | kontrollierte Abbildung auf Grabenplaner-Standorte; Sonderkennungen werden nicht geraten |
| Verkaufsbeleg | interne Beleg-ID, gehashte Quellidentität, Importlauf, Filialzuordnung, Kassenkennung, lokales Datum und lokale Uhrzeit | Gruppierung der Positionen; keine Kunden- oder Mitarbeiterkennung |
| Verkaufsposition | interne Positions-ID, Beleg-ID, EAN, Menge, Soll- und Istpreis, Rabatt, Steuersatz, Rohertrags-Rohwert, historische Artikelbezeichnung, Marke und Sortiment | historische Verkaufsfakten; ungeklärte Statuswerte bleiben gesonderte Rohwerte |
| Artikel-Snapshot | EAN, Bezeichnung, Marke, Sortiment/Taxonomie, Internet- und Artikelstatus, definierte Preiswerte, Snapshot-Zeit | zeitpunktbezogene aktuelle Anreicherung; keine rückwirkende Änderung alter Belegtexte |
| EAN-Alias | alternative EAN, primäre EAN, Rang, Quellsnapshot | nachvollziehbare Aliasauflösung ohne unsichere Textsuche |
| Bestand-Snapshot | EAN, Filialzuordnung, Bestand, bestellt, im Zulauf, Filialpreis, Inventurdatum, Bestandsänderungsdatum, Snapshot-Zeit | zeitpunktbezogene Bestandsansicht, keine erfundene Zeitreihe |
| Shop-Produktzuordnung | EAN, technische Shopware-Artikelkennungen, Snapshot-Zeit | Verbindung zum Shopprodukt; keine Bestellung, kein Kunde und kein Umsatz |

## 7. Feldkatalog Kassenumsätze

### 7.1 `Umsatz_KASSE`

| Quellfelder | Kennzeichnung | Geplanter Umgang |
| --- | --- | --- |
| `Bonnr`, `Filialid`, `Kassenid`, `Bondatum` | `KERN-ALLOWLIST` | zusammengesetzte Quellidentität; im Ziel nur interne beziehungsweise gehashte Belegidentität |
| `Bondatum`, `Bonzeit` | `KERN-ALLOWLIST` | lokales Verkaufsdatum und lokale Verkaufszeit |
| `Filialid` | `KERN-ALLOWLIST` | nur über eine freigegebene Filialzuordnung |
| `Kassenid` | `KERN-ALLOWLIST` | organisatorische Kassenkennung, keine Person |
| `RechnungsBetrag` | `STAGING/PRÜFUNG` | wegen 97,8 Prozent Nullwerten nur zur Abstimmung, nicht als führender Umsatzwert |
| `RechnungsNr` | `STAGING/PRÜFUNG` | nur für Identitäts- und Dublettenprüfung; nicht als sichtbarer Rohwert im Analysebestand |
| `KUND_NR`, `KPLZ` | `AUSSCHLUSS` | Kundenbezug und kundenbezogene Ortsinformation sind für den Zweck nicht erforderlich |
| `VerkäuferID`, `Personalkennziffer` | `AUSSCHLUSS` | keine personenbezogene Mitarbeiter- oder Leistungsanalyse |
| `KontoNr` | `AUSSCHLUSS` | kein erforderlicher Analysewert; im Snapshot ohne brauchbare Differenzierung |

Alle weiteren Kopf-Felder bleiben bis zu einer ausdrücklichen Katalogerweiterung ausgeschlossen.

### 7.2 `Umsatz_Kasse_Details`

| Quellfelder | Kennzeichnung | Geplanter Umgang |
| --- | --- | --- |
| `RepID`, `Bonnr`, `Filialid`, `Kassenid`, `Bondatum` | `KERN-ALLOWLIST` | technische Zuordnung und idempotente Positionsidentität; Quellschlüssel nicht ungefiltert ausgeben |
| `EAN`, `VKMenge`, `Sollpreis`, `VK_Preis`, `MWST` | `KERN-ALLOWLIST` | Kernwerte einer Verkaufsposition; Einheit, Vorzeichen, Brutto/Netto und Steuermapping müssen vor Import feststehen |
| `Rabatt_DM`, `RohertragDM` | `KERN-ALLOWLIST` als Rohwert | fachlich sinnvoll, aber erst nach geklärter Währung, Berechnungsbasis und Vorzeichenlogik auswertbar |
| `Artikelbezeichnung`, `Sortiment`, `UMarke` | `KERN-ALLOWLIST` | historischer Beleg-Snapshot; nicht durch aktuelle Stammdaten überschreiben |
| `RechnungsNr` | `STAGING/PRÜFUNG` | zusätzliche Identitäts- und Abstimmhilfe; nicht als sichtbarer Analysewert |
| `set`, `SonderartikelS`, `R`, `N`, `ZR`, `Ret`, `BStorno`, `AStorno` | `FACHLICH ZU KLÄREN` | mögliche Set-, Rabatt-, Retouren- und Stornokennzeichen; keine Bedeutungsannahme ohne Fachprüfung |
| `Anfilialid`, `Bestandsfilialid` | `FACHLICH ZU KLÄREN` | mögliche abweichende Verkaufs-/Bestandsfiliale; benötigt eine definierte Filialregel |
| `KalkRohertrag`, `NachlaßDM`, `Rabatt`, `ZRRabatt`, `SoBetrag` | `FACHLICH ZU KLÄREN` | mögliche alternative Rechenwerte; Doppelzählung zu Kernwerten muss ausgeschlossen werden |
| `SETEAN`, `AltSortiment`, `DEK_A`, `TDEK` | `FACHLICH ZU KLÄREN` | potenzielle Zusatzzuordnung beziehungsweise Einstandswerte mit noch ungeklärter Semantik |
| `Provision_dm`, `Prov`, `Provision`, `Verkäuferid`, `Beratung` | `AUSSCHLUSS` | provisions- und mitarbeiterbezogene Auswertung ist nicht vorgesehen |
| `KameraNr`, `Colorbildid`, `Suchname` | `AUSSCHLUSS` | für die definierten Kennzahlen nicht erforderlich beziehungsweise nicht ausreichend strukturiert |
| `Importiert`, `ExportWWS`, `Bestandgebucht` | `AUSSCHLUSS` | technische Alt-Systemzustände ohne Zielnutzen |

Die 14.427 negativen Mengen werden bis zur Entscheidung über `Ret`, `BStorno`, `AStorno` und verwandte Felder nicht pauschal als Retouren verbucht.

### 7.3 Weitere Kassentabellen

| Tabelle/Gruppe | Kennzeichnung | Begründung |
| --- | --- | --- |
| `Tagesbericht` | `AUSSCHLUSS` im ersten Import | abgeleitete Verdichtung; muss aus den freigegebenen Positionen reproduzierbar sein |
| `KassenJournal`, `KassenJournal_Details` | `SPÄTER OPTIONAL` | möglicher eigener Finanz-/Kassenbewegungsumfang mit gesonderten Regeln |
| Konfigurations-, Ressourcen-, System- und leere Legacytabellen | `AUSSCHLUSS` | kein fachlicher Verkaufsanalysewert |

## 8. Feldkatalog Warenwirtschaft

| Quelltabelle und Felder | Kennzeichnung | Geplanter Umgang |
| --- | --- | --- |
| `ARTIKEL_STAMM`: `EAN`, `Artikelbezeichnung`, `Marke`, `Sortiment`, `Auslaufartikel`, `Sonderartikel`, `Internet`, `ArtikelBezInternet`, `Anlagedatum`, `Änderungsdatum` | `KERN-ALLOWLIST` | zeitpunktbezogener Artikel-Snapshot |
| `ARTIKEL_STAMM`: `MWST` | `KERN-ALLOWLIST` | nur als Steuercode über die Quelltabelle `MWST_Sätze` auflösen; nicht direkt mit Kassen-Prozentwerten gleichsetzen |
| `ARTIKEL_STAMM`: `Verkaufspreis`, `Internet_VK` | `KERN-ALLOWLIST` nach Preisregel | aktuelle Snapshot-Preise; Einheit und Brutto/Netto müssen geklärt sein |
| `ARTIKEL_STAMM`: `DurchschnittEK`, `Listeneckpreis`, `Rechnungspreis` | `FACHLICH ZU KLÄREN` | wirtschaftlich sensible Kostenwerte; Zweck, Berechnung und späteres Leserecht separat entscheiden; niemals rückwirkend auf Verkäufe anwenden |
| `ARTIKEL_STAMM`: `versteckt`, `Loeschen` | `STAGING/PRÜFUNG` | mögliche Statuskennzeichen; Semantik vor dauerhafter Übernahme bestätigen |
| `ARTIKEL_FILIALEN`: `EAN`, `FilialID`, `FBestand`, `Verkaufspreis`, `Bestellt`, `im_Zulauf`, `inventurdat`, `Bestandsänderungsdatum` | `KERN-ALLOWLIST` | Filialbestand und Preis als gekennzeichneter Snapshot |
| `ARTIKEL_FILIALEN`: `LInventurBestand` | `FACHLICH ZU KLÄREN` | nur übernehmen, wenn Zeitpunkt und Beziehung zum aktuellen Bestand eindeutig sind |
| `ARTIKEL_FILIALEN`: `Fvkw`, `Fvk4w`, `FVK3M`, `Fvkj`, `S_out` | `AUSSCHLUSS` im ersten Import | unklare rollierende/abgeleitete Altkennzahlen; keine Parallelwahrheit zu eigenen Verkaufsfakten |
| `ARTIKEL_ZWEITEAN`: `EAN`, `ZweitEAN`, `Rang` | `KERN-ALLOWLIST` | kontrollierte Aliasauflösung |
| `ARTIKEL_Sortimente`, `ARTIKEL_Warengruppen`, `ARTIKEL_Sparten`, `Marken`: Schlüssel, Bezeichnung und notwendige Hierarchieverknüpfungen | `KERN-ALLOWLIST` | nachvollziehbare Produkttaxonomie; keine unbenötigten Freitexte |
| `FILIALEN`: `FilialID`, `FName`, `UmsatzFilialid`, `BestandsFilialid`, `Typ` | `STAGING/PRÜFUNG` | ausschließlich zur Zuordnung auf einen Grabenplaner-Standort beziehungsweise eine definierte Onlineshop-Sicht |
| `FILIALEN`: Anschrift, Telefon, E-Mail, SEPA-, IBAN- und BIC-Felder | `AUSSCHLUSS` | für Verkaufsanalysen nicht erforderlich |
| `Shopware_Artikel`: `EAN` und technische Shopware-Artikelkennungen | `KERN-ALLOWLIST` | Produktzuordnung ohne Bestell-, Kunden- oder Umsatzdaten |
| `tblProtBestand_comp` | `SPÄTER OPTIONAL` | Zeitraum und Filialabdeckung sind für eine Kern-Bestandshistorie derzeit unzureichend |

### 8.1 Ausgeschlossene Warenwirtschaftsbereiche

Folgende Datenbereiche bleiben ausdrücklich außerhalb der Verkaufsanalysen:

- `KUNDEN` und sämtliche Kunden-, Kontakt-, Adress-, Bonus-, Zahlungs- oder Kommunikationsdaten,
- `MITARBEITER`, `Benutzer`, `Zugang`, `Zugang_Mitarbeiter` und sonstige Anmelde-, Rollen- oder Personaldaten,
- Lieferantenadressen, Ansprechpartner, freie Notizen sowie Bank-, SEPA-, IBAN- und BIC-Daten,
- Bilder, OLE-Inhalte, Anhänge, HTML-Inhalte und lange Shop- oder Marketingtexte,
- Protokoll-, Log-, Temporär-, Import-, Export- und Migrationstabellen ohne ausdrücklich katalogisierten Analysezweck,
- leere oder historische Verkaufs-/Transferstrukturen wie `Verkauf_Artikel`, `Transfer_Alte...` und `FiL_Umsatz`,
- abgeleitete Lagerumschlags- und Sell-out-Werte als Parallelwahrheit zu später selbst berechneten Kennzahlen.

Eine spätere minimale Lieferanten-Artikelbeziehung wäre nur mit einem eigenen fachlichen Nutzen- und Rechteentscheid zulässig; Kontaktdaten bleiben auch dann ausgeschlossen.

## 9. Umwandlungs- und Qualitätsregeln

Ein späterer technischer Import muss mindestens folgende Regeln erfüllen:

1. **Quellnachweis**<br>
   Jeder Lauf erhält Quellsystem, Snapshot-Zeit, SHA-256-Fingerprint und Importprofil-Version. Die beiden in Abschnitt 3 genannten Fingerprints identifizieren nur die untersuchten Snapshots.

2. **Schemaschutz**<br>
   Tabellen- und Feldschema werden vor dem Lesen mit dem freigegebenen Profil verglichen. Neue oder umbenannte Felder werden nicht automatisch importiert. Abweichungen führen mindestens zur Quarantäne des betroffenen Pakets.

3. **Mengen- und Zeitprüfung**<br>
   Die festgestellten Zeilenzahlen und Datumsbereiche bilden eine Prüfbasis. Bei neuen Snapshots sind abweichende Mengen nicht automatisch falsch, müssen aber plausibilisiert und im Laufbericht sichtbar werden.

4. **Exakte Geldwerte**<br>
   Microsoft-Access-`Currency` wird als exakt skalierte Dezimalzahl mit vier Nachkommastellen gelesen und nicht als binärer JavaScript-Gleitkommawert verarbeitet. Rundung und Zielwährung werden fachlich festgelegt.

5. **Zeitbezug**<br>
   `Bondatum` und `Bonzeit` werden als lokale Geschäftszeit in `Europe/Vienna` zusammengesetzt. Eine UTC-Umrechnung darf den lokalen Verkaufstag nicht verschieben.

6. **Umsatzsteuer**<br>
   Kassenwerte erscheinen als tatsächliche Prozentwerte `0`, `10` und `20`. `ARTIKEL_STAMM.MWST` verwendet dagegen die Codes `0`, `1` und `2`. Die Warenwirtschaftscodes werden über `MWST_Sätze` aufgelöst und niemals direkt mit den Kassenwerten vereinigt.

7. **Filialzuordnung**<br>
   Externe Filialkennungen werden nur über eine geprüfte Zuordnung übernommen. Sonderwerte wie `0` und `99` werden ohne ausdrückliche Regel abgewiesen beziehungsweise in Quarantäne gehalten.

8. **Belegabstimmung**<br>
   Belegumsatz und weitere Kennzahlen werden aus Position, Menge und definierten Preisfeldern berechnet. Vorhandene Kopfwerte dienen nur zur Qualitätskontrolle. Abweichungen werden ausgewiesen und nicht still korrigiert.

9. **Retouren und Storno**<br>
   Negative Mengen sowie Statusfelder werden erst nach einer gemeinsamen, getesteten Vorzeichen- und Stornoregel in Kennzahlen aufgenommen.

10. **EAN-Zuordnung**<br>
    Direkte Primär-EAN, Alias-EAN und unaufgelöste EAN bleiben als unterschiedliche Qualitätszustände sichtbar. Es gibt keine automatische Zuordnung nur aufgrund ähnlicher Artikeltexte.

11. **Idempotenz und Rücknehmbarkeit**<br>
    Ein identischer Snapshot mit identischem Profil darf keine Doppelwerte erzeugen. Ein Lauf muss zunächst als Trockenlauf prüfbar, vollständig protokolliert und als abgegrenzter Importlauf rücknehmbar sein. Direkte Schreibvorgänge aus der Quelldatei in produktive Analysetabellen sind ausgeschlossen.

12. **Datensparsame Fehlerberichte**<br>
    Berichte enthalten Mengen, Feldnamen, Fehlerklassen und interne Referenzen, aber keine Kunden-, Mitarbeiter-, Zugangsdaten oder unnötigen Freitexte.

## 10. Datenminimierung und Aufbewahrungsgrenze

Für den ersten fachlichen Umfang gelten folgende Grundsätze:

- Verkaufsanalysen verwenden betriebliche Fakten, keine Kundenprofile und keine personenbezogene Mitarbeiterleistung.
- Kunden-, Verkäufer-, Personal-, Benutzer- und Zugangsdaten werden weder in den Analysebestand noch in Importfehlerberichte übernommen.
- Quelldumps werden nicht im Grabenplaner, nicht im Repository und nicht als Anhang eines Importlaufs gespeichert.
- Vorübergehende Staging-Daten sind nach Laufabschluss zu löschen; die konkrete Frist und der Umgang mit fehlgeschlagenen Läufen werden erst in einem späteren technischen und datenschutzfachlichen Block festgelegt.
- Gehashte Quellidentitäten sind interne technische Schlüssel und keine pauschale Anonymisierung. Sie werden nicht als sichtbare Analysemerkmale ausgegeben.
- Aufbewahrungsfristen für historische Verkaufsfakten, Bestands-Snapshots, Laufberichte und Rücknahmedaten sind noch festzulegen.
- Kosten-, Rohertrags- und Bestandsdaten benötigen im späteren Rechtekonzept eine engere Sicht als allgemeine Umsatzkennzahlen.

## 11. Was mit diesen Snapshots belastbar möglich ist

Nach Klärung der offenen Rechenregeln lassen sich aus der Kassenquelle historische Umsatz-, Mengen-, Preis-, Rabatt- und Rohertragsauswertungen für 2018 bis Juni 2020 nach Verkaufstag, Filiale, Kasse, EAN, damaliger Artikelbezeichnung, Sortiment und Marke aufbauen. Retouren- und Stornoauswertungen sind erst nach Semantikprüfung belastbar.

Aus der Warenwirtschaft lässt sich getrennt ein Artikel-, Filialbestands-, Preis- und Onlinekennzeichen-Snapshot aus 2026 darstellen. Taxonomien und sichere EAN-Verknüpfungen können beide Sichten ergänzen.

Mit den vorliegenden Dateien nicht belastbar möglich sind:

- aktuelle oder lückenlose Verkaufsentwicklungen nach Juni 2020,
- Shopbestellungen, Onlineshop-Umsatz, Conversion oder Kundenverhalten,
- Kundenkohorten oder personenbezogene Verkäuferleistung,
- eine vollständige Bestandsentwicklung über längere Zeit,
- rückwirkende historische Auswertungen mit heutigen Artikelpreisen, Kosten, Beständen oder Stammdaten,
- eine sichere Stammdatenanreicherung der 9.265 derzeit nicht zugeordneten historischen EANs.

## 12. Offene Fachentscheidungen vor einem technischen Import

Vor dem nächsten technischen Datenblock müssen mindestens entschieden und mit Beispielen geprüft werden:

1. Bedeutung von negativen Mengen sowie `Ret`, `BStorno`, `AStorno`, `R`, `N`, `ZR` und Set-Kennzeichen,
2. Mengeneinheit, Zielwährung, Brutto-/Nettologik und die tatsächliche Bedeutung der historisch benannten `_DM`-Felder,
3. Verhältnis von `RohertragDM`, `KalkRohertrag`, Einstands- und Kostenfeldern,
4. verbindliche Filialzuordnung einschließlich der Sonderkennungen `0` und `99` sowie einer möglichen Onlineshop-Filiale,
5. genaue Steuerzuordnung zwischen Kassen-Prozentwerten und Warenwirtschaftscodes,
6. gewünschte Snapshot-Frequenz und Aufbewahrung für Artikel und Filialbestände,
7. separate Quelle für Shopware-Bestellungen, falls Onlineshop-Umsatz tatsächlich analysiert werden soll,
8. Sichtbarkeit von Umsatz, Bestand, Kosten und Rohertrag je Rolle und organisatorischem Bereich,
9. endgültige Aufbewahrungs-, Lösch- und Auditregeln.

Mitarbeiterbezogene Verkaufsanalysen sind standardmäßig nicht vorgesehen. Eine spätere Abweichung wäre ein neuer, ausdrücklich freizugebender Zweck mit eigener Datenschutz- und Rechteprüfung.

## 13. Abschluss von Block 2

Block 2 endet mit diesem Datenkatalog und seinem statischen Dokumentationsvertrag. Es wurden keine Quelldaten in den Grabenplaner übernommen und keine Datenbank-, API-, Import-, Rollen- oder Oberflächenfunktion ergänzt.

Ein Folgeblock beginnt erst nach ausdrücklicher Freigabe. Der Katalog gibt dafür die fachliche Allowlist und die offenen Entscheidungstore vor, er erteilt aber keine automatische Umsetzungsfreigabe.
