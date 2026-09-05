# TradeFoto-Artikelstamm · Analyse v0.1

Ergänzung 05.09.2026: Die [Gesamtinventur, Block 1/6](tradefoto-gesamtimport-v0.1/README.md)
erfasst die neu bereitgestellten Trade- und Kassendateien einschließlich CRM und
Verkaufsverknüpfungen. Die folgenden älteren Snapshot-Befunde und das vorhandene
Artikelprofil bleiben als historische bzw. implementierte Grundlage erhalten.

## 1. Dokumentstatus und Grenze

| Merkmal | Stand |
| --- | --- |
| Fachbereich | Verkaufsverwaltung · Artikelstamm |
| Version | v0.1 |
| Stand | 03.09.2026 |
| Status | Read-only-Struktur- und Qualitätsanalyse |

Dieses Dokument beschreibt den verifizierten Aufbau des TradeFoto-Artikelstamms
und die daraus abgeleitete Zielzuordnung für den Grabenplaner. Es enthält keine
Quelldatensätze, Zugangsdaten, lokalen Verzeichnispfade oder personenbezogenen
Informationen.

Die Analyse ist keine Freigabe, ungeprüfte Quellwerte produktiv zu übernehmen.
Insbesondere bleiben unbekannte Preissemantiken, Identifier-Konflikte und
Schemaabweichungen fail-closed.

## 2. Prüfquelle und Read-only-Nachweis

| Eigenschaft | Verifizierter Wert |
| --- | --- |
| Dateiname | `Trade_Daten.accdb` |
| Größe | 185.028.608 Bytes |
| Änderungszeit | 29.06.2026, 12:36:54 Uhr |
| SHA-256 | `B6FFD5D7FD439835CC52961709AA89E772894C3ABD12569C5AD6A6486AC3FD9D` |
| Access-Dateiformat | Access 2010 / Version 14 |

Die verschlüsselte Access-Datei wurde mit Jackcess und CryptCodec ausdrücklich
im Read-only-Modus geöffnet. Tabellen, Spalten, Indizes, Beziehungen und
Aggregatwerte wurden ausschließlich gelesen. Nach der Analyse stimmte der
SHA-256 erneut exakt mit dem Ausgangswert überein; es bestand keine Access-
Lockdatei. Das Quelloriginal wurde nicht verändert.

## 3. Zentraler Identitätsbefund

### 3.1 `ARTIKEL_STAMM.EAN` ist die Artikelnummer

`ARTIKEL_STAMM` enthält 18.996 Zeilen. Das Feld `EAN` ist als `TEXT(13)`
definiert und der deklarierte Primärschlüssel der Quelltabelle.

| Prüfung | Ergebnis |
| --- | ---: |
| Zeilen | 18.996 |
| nicht leer | 18.996 |
| eindeutig | 18.996 |
| genau 13 Ziffern | 18.996 |
| mit führender Null | 18.996 |
| numerischer Inhalt ohne Padding | 1 bis 908.452 |
| gültige GTIN-Prüfziffer | 1.859 |

Damit ist `EAN` trotz seines Namens kein verlässliches Barcodefeld. Es ist der
auf 13 Stellen mit Nullen aufgefüllte TradeFoto-Artikelschlüssel. Die wenigen
formal gültigen GTIN-Prüfziffern ändern diese Einordnung nicht.

Für die Zielabbildung gilt daher:

- Quellfeld `ARTIKEL_STAMM.EAN` → unveränderter `source_article_key`;
- Speicherung des Quellschlüssels als 13-stelliger Text einschließlich aller
  führenden Nullen;
- verlustfreie Ableitung der sichtbaren TradeFoto-Artikelnummer als genau
  sechsstelliger, links mit Nullen aufgefüllter Text aus dem numerischen
  Quellwert;
- keine Umwandlung in `INTEGER` oder `BIGINT`;
- keine automatische Kennzeichnung als EAN oder GTIN.

Beispiel der verbindlichen Transformationsregel:

```text
source_article_key = 0000000093757
article_number     = 093757
```

Der bestätigte numerische Quellbereich von 1 bis 908.452 passt vollständig in
sechs Stellen und bleibt eindeutig. Aus der sechsstelligen Artikelnummer lässt
sich der 13-stellige Quellschlüssel für diesen bestätigten Snapshot durch
erneutes Linkspadding rekonstruieren. Ein späterer Quellwert mit mehr als sechs
signifikanten Stellen wird nicht abgeschnitten, sondern als Schemadrift in
Quarantäne gestellt.

### 3.2 Zielschlüssel

Die fachliche Artikelnummer ist eindeutig, soll aber nicht die physische
Fremdschlüsselbasis des neuen Modells bilden. Empfohlen wird:

- `product_id`: unveränderlicher interner Primärschlüssel;
- `article_number`: sichtbarer, eindeutiger sechsstelliger fachlicher
  Textschlüssel nach der dokumentierten Transformationsregel;
- `source_article_key`: unveränderter 13-stelliger TradeFoto-Schlüssel;
- zusätzliche Eindeutigkeit aus `source_system` und `source_article_key`.

Damit bleibt ein Produkt auch dann technisch stabil, wenn später weitere
Quellsysteme hinzukommen oder eine fachliche Artikelnummer kontrolliert geändert
werden muss. Für SQLite kann `product_id` als kanonischer UUID-Text und für
PostgreSQL als `UUID` gebunden werden; der Providervertrag muss in beiden Fällen
dieselbe fachliche Identität liefern.

## 4. Barcodes und weitere Identifikatoren

### 4.1 `ARTIKEL_ZWEITEAN`

Die Tabelle besitzt 37.412 Zeilen. `ZweitEAN` ist ein eindeutiger Primärschlüssel
vom Typ `TEXT(13)`, `EAN` ist der Fremdschlüssel auf die Quellartikelnummer und
`Rang` ist `BYTE`.

| Prüfung | Ergebnis |
| --- | ---: |
| Zeilen / eindeutige `ZweitEAN` | 37.412 |
| leere Werte | 0 |
| verwaiste Artikelbezüge | 0 |
| Selbstaliase, bei denen `ZweitEAN = EAN` | 18.994 |
| echte zusätzliche Identifikatoren | 18.418 |
| davon GTIN-prüfziffergültig | 18.340 |
| davon GTIN-ungültig | 78 |
| Produkte mit mindestens einem echten Alias | 17.169 |
| Produkte mit mindestens einem gültigen GTIN-Alias | 17.134 |
| Produkte mit mehreren echten Aliasen | 943 |
| Produkte mit mehreren gültigen GTIN-Aliasen | 910 |
| echte Aliase mit Kollision zu einem anderen Stammartikel | 0 |

Von den echten zusätzlichen Identifikatoren sind 18.410 genau 13-stellig und
rein numerisch. Die übrigen Längen verteilen sich auf vier 12-stellige sowie je
einen 5-, 6- und 11-stelligen Wert; drei Werte sind nicht rein numerisch.

18.994 Quellartikelnummern erscheinen zusätzlich als `ZweitEAN`, ausschließlich
als Selbstalias. Darunter bestehen 1.858 Werte zufällig beziehungsweise formal
die GTIN-Prüfziffer. Selbstaliase werden im Ziel nicht als zusätzliche Barcodes
dupliziert.

### 4.2 Weitere Identifier-Felder

| Feld | Befund | Zielbehandlung |
| --- | --- | --- |
| `ScanEAN` | 2.689 belegt, 2.680 verschieden, 2.649 GTIN-gültig; acht Werte werden von insgesamt 17 Produktzeilen mehrfach verwendet; 31 Werte sind laut Alias-Tabelle einem anderen Produkt zugeordnet | ausschließlich Quarantäne und manuelle Konfliktprüfung |
| `NachfolgeEAN` | 2.095 belegt; davon 2.087-mal der Platzhalter `0` und acht echte Verweise | als mögliche Nachfolge-Artikelnummer prüfen, nicht als Barcode |
| `Bestellnummer` | 9.704 belegt, 9.432 verschieden | Lieferanten-/Bestellbezug, kein Produktprimärschlüssel |

### 4.3 Zielstruktur für Identifikatoren

Barcodes und weitere Kennungen gehören in eine eigene Entität mit mindestens:

- `product_identifier_id`;
- `product_id`;
- `identifier_type`, zum Beispiel `gtin`, `source_alias`, `scan_code` oder
  `successor_article_number`;
- `raw_value` und kanonischer Vergleichswert;
- `source_system`, `source_field`, `rank` und `observed_at`;
- `is_valid_gtin`, `validation_status` und `conflict_status`;
- Bezug zum Importlauf.

Eine globale Barcode-Eindeutigkeit darf erst nach erfolgreicher Validierung und
Konfliktauflösung gelten. Ungültige oder widersprüchliche Quellwerte werden nicht
verworfen, aber auch nicht als aktive Scan-Kennung freigeschaltet.

## 5. Kernfelder und Produkttaxonomie

### 5.1 Artikelstamm

| Quellfeld | Access-Typ | Abdeckung | Zielbedeutung |
| --- | --- | ---: | --- |
| `EAN` | `TEXT(13)` | 18.996 | unveränderter `source_article_key`; Quelle der sechsstelligen `article_number` |
| `Artikelbezeichnung` | `TEXT(50)` | 18.996 | primäre Bezeichnung |
| `Erklärung` | `TEXT(50)` | nicht als Pflichtfeld bewertet | ergänzende Kurzbeschreibung |
| `Artikelbezeichnung3` | `TEXT(100)` | nicht als Pflichtfeld bewertet | zusätzliche Bezeichnung |
| `Artikelbezeichnung4` | `TEXT(100)` | nicht als Pflichtfeld bewertet | zusätzliche Bezeichnung |
| `ArtikelBezInternet` | `TEXT(200)` | 10.582 | Internetbezeichnung |
| `Marke` | `TEXT(20)` | 18.192 | Markenbezug |
| `Sortiment` | `LONG` | 18.996 | Sortimentsschlüssel |
| `Suchname` | `TEXT(3)` | 18.996 | primärer Lieferantencode |
| `Bestellnummer` | `TEXT(20)` | 9.704 | primäre Lieferantenartikelnummer |
| `MWST` | `BYTE` | 18.995 | TradeFoto-Steuercode |
| `Anlagedatum` | `SHORT_DATE_TIME` | 18.996 | Quell-Anlagezeitpunkt |
| `Änderungsdatum` | `SHORT_DATE_TIME` | 18.996 | Quell-Änderungszeitpunkt |

Die Änderungszeitpunkte reichen bis 29.06.2026, 12:36:53 Uhr. Sie sind
Quellmetadaten und keine Import- oder Systemzeitpunkte des Grabenplaners.

### 5.2 Statusfelder

| Quellfeld | Access-Typ | Wahr | Einordnung |
| --- | --- | ---: | --- |
| `Auslaufartikel` | `BOOLEAN` | 11 | möglicher Auslaufstatus |
| `Loeschen` | `BOOLEAN` | 0 | Legacy-Löschkennzeichen |
| `versteckt` | `BOOLEAN` | 6 | Sichtbarkeitskennzeichen |
| `Kassensperre` | `BOOLEAN` | 32 | Verkaufssperre an der Kasse |
| `Internet` | `BOOLEAN` | 8.471 | Internetfreigabe/-kennzeichen |

Die Felder werden getrennt übernommen. Sie werden nicht zu einem einzigen
`active`-Schalter zusammengefasst, solange ihre fachliche Priorität und
Wechselwirkung nicht bestätigt sind.

### 5.3 Taxonomie und Referenzqualität

| Tabelle | Schlüssel | Zeilen | Beziehung |
| --- | --- | ---: | --- |
| `ARTIKEL_Sortimente` | `Sortiment LONG` | 229 | Artikel → Sortiment |
| `ARTIKEL_Warengruppen` | `Warengruppe INT` | 92 | Sortiment → Warengruppe |
| `ARTIKEL_Sparten` | `Sparte INT` | 18 | Warengruppe → Sparte |
| `Marken` | `Marke TEXT(20)` | 605 | Markenregister ohne deklarierte Access-FK vom Artikel |

Alle 18.996 Sortimentswerte sind auflösbar. Von 18.192 belegten Markenwerten
stimmen 18.190 mit dem Markenregister überein; zwei Werte benötigen eine
Prüfentscheidung. Alle 18.996 primären Lieferantencodes sind auflösbar.

### 5.4 Umsatzsteuer

| TradeFoto-Code | Faktor | Beschreibung |
| ---: | ---: | --- |
| 0 | 0 | ohne Umsatzsteuer |
| 1 | 20 | 20 Prozent |
| 2 | 10 | 10 Prozent |
| 3 | 19 | 19 Prozent Deutschland |
| 4 | 7 | 7 Prozent Deutschland |

Ein Artikel besitzt keine auflösbare Steuerzuordnung. Der Quellcode wird nicht
direkt als Prozentwert behandelt, sondern über diese Referenztabelle aufgelöst.

## 6. Preisfeldkatalog im Artikelstamm

Alle nachfolgenden Betrags- und Kalkulationsfelder sind in Access als `DOUBLE`
gespeichert. `Nicht 0` zählt belegte numerische Werte ungleich null; ein
Quell-`NULL` ist ausdrücklich nicht dasselbe wie der Wert `0`. In keinem
untersuchten numerischen Preisfeld kamen `NaN` oder unendliche Werte vor.

### 6.1 Verkauf, Empfehlung und allgemeine Kanäle

| Quellfeld | Nicht NULL | Nicht 0 | Negativ | Min. | Max. | Vorläufige Semantik |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `UPE` | 18.995 | 18.759 | 0 | 0 | 23.449 | Preisempfehlung; Bezeichnung fachlich bestätigen |
| `Verkaufspreis` | 18.996 | 18.775 | 0 | 0 | 23.449 | allgemeiner Brutto-Verkaufspreis |
| `Großhandelspreis` | 18.822 | 18.575 | 0 | 0 | 23.449 | Großhandels-Verkaufspreis; Brutto-/Nettostatus offen |
| `Internet_VK` | 18.821 | 18.558 | 0 | 0 | 23.449 | Internet-Bruttopreis |
| `ZukunftsUVP` | 16.555 | 16.408 | 0 | 0 | 23.449 | zukünftige Preisempfehlung |
| `eNvk` | 18.992 | 18.774 | 0 | 0 | 19.540,833333333332 | nahezu vollständiges Netto-Pendant zu `Verkaufspreis` |
| `Invk` | 18.806 | 18.561 | 0 | 0 | 19.540,833333333332 | nahezu vollständiges Netto-Pendant zu `Internet_VK` |
| `GNVK` | 18.821 | 18.574 | 0 | 0 | 19.540,833333333332 | Semantik offen; kein verlässliches Netto-Pendant zu `Großhandelspreis` |

### 6.2 Weitere Internetpreispaare

| Quellfeld | Nicht NULL | Nicht 0 | Negativ | Min. | Max. | Einordnung |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `InternetVK2` | 4.581 | 3.925 | 0 | 0 | 4.745 | Kanal-/Stufenpreis brutto |
| `InternetVKN2` | 4.577 | 3.925 | 0 | 0 | 3.954,1666666666665 | Netto-Pendant |
| `InternetVK3` | 18.987 | 18.753 | 0 | 0 | 23.449 | Kanal-/Stufenpreis brutto |
| `InternetVKN3` | 18.982 | 18.752 | 0 | 0 | 19.540,833333333332 | Netto-Pendant |
| `InternetVK4` | 623 | 591 | 0 | 0 | 9.250 | Kanal-/Stufenpreis brutto |
| `InternetVKN4` | 598 | 590 | 0 | 0 | 7.708,333333333333 | Netto-Pendant |
| `InternetVK5` | 17.735 | 17.061 | 3 | -100 | 67.929 | Kanal-/Stufenpreis brutto; Negativwerte quarantänisieren |
| `InternetVKN5` | 17.733 | 17.060 | 3 | -100 | 56.607,5 | Netto-Pendant; Negativwerte quarantänisieren |

Die Nummern 2 bis 5 belegen mehrere Internetpreisstufen oder -kanäle. Welche
konkreten Kanäle gemeint sind, ist aus Tabellenbeziehungen nicht ableitbar. Im
Ziel bleiben sie deshalb als getrennte, quellbenannte Preisarten erhalten.

### 6.3 Einkauf und Lieferantenkalkulation

| Quellfeld | Nicht NULL | Nicht 0 | Negativ | Min. | Max. | Vorläufige Semantik |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `DurchschnittEK` | 18.978 | 18.541 | 0 | 0 | 15.771,423075 | durchschnittlicher Einkaufspreis |
| `Listeneckpreis` | 18.995 | 18.543 | 0 | 0 | 18.719,79 | Lieferanten-Listeneinkaufspreis |
| `Rechnungspreis` | 18.995 | 18.543 | 0 | 0 | 18.719,79 | Lieferanten-Rechnungspreis |
| `NNPreis` | 18.995 | 18.543 | 0 | 0 | 15.771,423075 | Netto-Netto- beziehungsweise Konditionspreis; bestätigen |
| `SonderPreis` | 18.995 | 18.542 | 0 | 0 | 15.771,423075 | Sonder-Einkaufspreis; bestätigen |
| `EKBestell` | 18.996 | 828 | 0 | 0 | 9.213,723225 | Einkaufspreis offener Bestellung; Zeitpunktbezug bestätigen |
| `ListeneckpreisZu` | 18.979 | 1.440 | 0 | 0 | 20.312 | zukünftiger/alternativer Listeneinkaufspreis; Semantik offen |
| `RechnungspreisZu` | 18.995 | 1.447 | 0 | 0 | 13.671,442678739999 | zukünftiger/alternativer Rechnungspreis; Semantik offen |
| `NNPreisZu` | 18.995 | 1.453 | 6 | -396,405 | 12.851,156118015599 | zukünftiger/alternativer Konditionspreis; quarantänepflichtige Negativwerte |
| `SonderPreisZu` | 18.995 | 1.448 | 6 | -396,405 | 12.851,156118015599 | zukünftiger/alternativer Sonderpreis; quarantänepflichtige Negativwerte |
| `ZDEK` | 18.221 | 2.677 | 0 | 0 | 9.719 | Einkaufskalkulationswert; Semantik offen |
| `DEK_A` | 18.996 | 1 | 0 | 0 | 18 | Einkaufskalkulationswert; Semantik offen |

Die Werte bilden eine plausible Lieferantenkette: Bei 18.500 von 18.543
nichtleeren, von null verschiedenen Paaren gilt
`Listeneckpreis >= Rechnungspreis`; bei allen 18.543 gilt
`Rechnungspreis >= NNPreis`. `NNPreis` und `SonderPreis` sind in 18.528 von
18.542 vergleichbaren Paaren identisch. Diese Evidenz rechtfertigt keine
Zusammenführung; alle Quellfelder bleiben getrennt nachvollziehbar.

### 6.4 Kalkulations-, Gebühren- und Legacy-Werte

| Quellfeld | Nicht NULL | Nicht 0 | Negativ | Min. | Max. | Einordnung |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `Provision` | 18.996 | 44 | 0 | 0 | 20 | Provisions-/Kalkulationssatz, kein Stückpreis |
| `SOnderRoh` | 18.985 | 307 | 0 | 0 | 100 | Rohertrags-/Kalkulationswert; Semantik offen |
| `WKZ` | 18.996 | 250 | 43 | -22,99 | 1.000 | Kalkulationswert; kein bestätigter Preis |
| `PVers` | 2 | 2 | 0 | 0,25 | 3 | sehr schwach belegter Kalkulationswert |
| `GVKKosten` | 18.996 | 6.423 | 0 | 0 | 8,5 | Verkaufskostenkomponente |
| `IVKKosten` | 18.996 | 6.423 | 0 | 0 | 5 | Verkaufskostenkomponente |
| `VKKostenP` | 18.996 | 6.423 | 0 | 0 | 1,5 | Verkaufskosten-/Prozentkomponente |
| `EuroEk` | 18.996 | 0 | 0 | 0 | 0 | vollständig inaktives Legacy-Feld |
| `EuroVK` | 18.996 | 0 | 0 | 0 | 0 | vollständig inaktives Legacy-Feld |
| `Pfand` | 18.996 | 0 | 0 | 0 | 0 | vollständig mit `0` belegtes Betragsfeld |
| `VertragsVK` | 18.694 | 0 | 0 | 0 | 0 | inaktiver Vertrags-Verkaufspreis |
| `RVK` | 18.558 | 0 | 0 | 0 | 0 | inaktives Legacy-Feld |
| `REVK` | 18.558 | 0 | 0 | 0 | 0 | inaktives Legacy-Feld |
| `VWien` | 18.996 | 0 | 0 | 0 | 0 | inaktives Legacy-/Standortfeld |
| `VAufschlag` | 18.996 | 0 | 0 | 0 | 0 | inaktiver Aufschlagswert |

Diese Werte werden nicht still als Geldbetrag interpretiert. Satz-, Prozent-,
Kosten- und Legacy-Felder benötigen jeweils eine eigene `price_kind`-
beziehungsweise Kalkulationsklassifikation oder verbleiben ausschließlich im
Importnachweis.

Numerische Felder wie `Vkw`, `Vk4w`, `Vkj`, `VK12W`, `GWertmenge`,
`ZuGesamt` und `AbGesamt` wurden ebenfalls geprüft. Sie sind nach Name,
Werteverteilung und Tabellenkontext Umsatz-/Mengen- oder Summenfelder und keine
belegten Stückpreise. Sie werden nicht in den Preis-Snapshot übernommen. Eine
spätere andere Verwendung benötigt eine eigene fachliche Semantikentscheidung.

### 6.5 Preisnahe Metadaten

Die Quelle enthält außerdem:

- Gültigkeits- und Änderungsdaten vom Typ `SHORT_DATE_TIME`:
  `ZKGueltigab`, `ZukunftsUVPab`, `ListeneckVom`, `LVKDatum`, `LUVPDatum`,
  `LGHDatum`, `LInternetDatum`, `LInternet2Datum`, `LInternet3Datum`,
  `LInternet4Datum`, `LInternet5Datum`, `DEK_AAB` und `S_Oab`;
- Steuerungsfelder vom Typ `BOOLEAN`: `SPreis`, `DEKAK`, `Vertragswahl`,
  `Wertliste`, `VKKosten` sowie die Internet- und Zonenkennzeichen;
- Quellcodes: `Listenpreisvon TEXT(3)`, `KZvon TEXT(1)`,
  `WKZArt TEXT(1)` und `KZBestellNr TEXT(50)`;
- historische Akteurscodes vom Typ `LONG`: `LVKAe`, `LZUVPAe`, `LUVPAe`,
  `LGHAe` und `LInternetAe` bis `LInternet5Ae`.

Historische Akteurscodes sind keine Preiswerte und werden nicht in den
Artikelstamm oder eine allgemein lesbare Preisansicht übernommen.

## 7. Evidenz für Brutto-/Nettopreise

Die Quell-Steuercodes erlauben eine zeilenweise Kontrolle, ob ein Bruttopreis
dem Nettopreis zuzüglich des jeweiligen Steuersatzes entspricht.

| Brutto-Feld | Netto-Feld | vergleichbar | Steuerformel erfüllt | Abweichungen |
| --- | --- | ---: | ---: | ---: |
| `Verkaufspreis` | `eNvk` | 18.992 | 18.984 | 8 |
| `Internet_VK` | `Invk` | 18.806 | 18.794 | 12 |
| `InternetVK2` | `InternetVKN2` | 4.576 | 4.576 | 0 |
| `InternetVK3` | `InternetVKN3` | 18.982 | 18.968 | 14 |
| `InternetVK4` | `InternetVKN4` | 598 | 598 | 0 |
| `InternetVK5` | `InternetVKN5` | 17.733 | 17.714 | 19 |

Damit sind diese Paare fachlich stark als Brutto-/Nettowerte belegt. Die
Abweichungen werden einzeln quarantänisiert; der Import berechnet oder
überschreibt keinen Quellwert still.

`GNVK` ist dagegen kein verlässlich nachgewiesenes Netto-Pendant zu
`Großhandelspreis`: Nur 5.149 von 18.821 vergleichbaren Paaren erfüllen diese
Steuerformel. Die Semantik bleibt offen.

## 8. Abgegrenzte Preis- und Bestandsbereiche

### 8.1 Filialpreise und Bestände

`ARTIKEL_FILIALEN` enthält 228.302 Zeilen und besitzt den zusammengesetzten
Primärschlüssel aus `EAN TEXT(13)` und `FilialID BYTE`. Alle 18.996 Artikel sind
über 13 externe Filialkennungen vertreten; es bestehen keine verwaisten
Artikelbezüge.

| Feld | Typ | Nicht NULL | Nicht 0 | Negativ | Min. | Max. |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `Verkaufspreis` | `DOUBLE` | 228.299 | 225.754 | 0 | 0 | 23.449 |
| `AktionVerkaufspreis` | `DOUBLE` | 228.302 | 0 | 0 | 0 | 0 |
| `AVerkaufspreis` | `DOUBLE` | 228.302 | 0 | 0 | 0 | 0 |

`FBestand`, `Bestellt`, `im_Zulauf`, Inventurdatum und
Bestandsänderungsdatum sind Filial-Snapshotwerte. Sie gehören weder in den
Produktkern noch in eine historische Preiswahrheit. Externe Sonderfilialen
werden nur über eine ausdrücklich bestätigte Standortzuordnung übernommen.

### 8.2 Zweitlieferantenpreise

`ARTIKEL_ZWEITLIEFERANT` enthält 4.280 Zeilen und Fremdschlüssel zum Artikel
sowie zum Lieferanten. Die Tabelle besitzt keinen deklarierten Primärschlüssel.

| Feld | Typ | Nicht NULL | Nicht 0 | Negativ | Min. | Max. |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| `ZListeneckpreis` | `DOUBLE` | 4.280 | 4.196 | 0 | 0 | 18.719,79 |
| `ZRechnungspreis` | `DOUBLE` | 4.280 | 4.152 | 0 | 0 | 18.719,79 |
| `ZNNPreis` | `DOUBLE` | 4.280 | 4.152 | 0 | 0 | 15.771,423075 |
| `ZListeneckpreis2` | `DOUBLE` | 4.280 | 0 | 0 | 0 | 0 |
| `ZWKZ` | `DOUBLE` | 4.280 | 146 | 56 | -4,5 | 500 |

Diese Preise gehören in einen Lieferanten-Scope. Vor einer Übernahme braucht
jede Quellzeile eine deterministische Identität; eine nicht deklarierte
Schlüsselkombination wird nicht geraten.

### 8.3 Staffel- und Preisgruppenpreise

| Tabelle | Zeilen | Quellschlüssel | Preisfelder und Abdeckung |
| --- | ---: | --- | --- |
| `Artikel_Stamm_StaffelPreise` | 308 | `EAN`, `SMenge`, `Preisgruppe`, `Gab` | `SVerkaufspreis`: 307 ungleich 0, 0 negativ, 0 bis 39,99; `NVK`: 307 ungleich 0, 0 negativ, 0 bis 33,33 |
| `ARTIKEL_GKundenPreisgruppe` | 65 | `EAN`, `GPreisgruppe` | `VK`, `NVk`, `EK`: je 64 ungleich 0; `Aufschlag`: 63 ungleich 0, davon 27 negativ |
| `ARTIKEL_KundenPreisgruppe` | 171 | `EAN`, `Preisgruppe`, `Gab` | `VK` und `NVk`: je 171 ungleich 0, keine Negativwerte |

Staffel- und Preisgruppenpreise bleiben getrennte Scopes. Sie werden nicht in
einen allgemeinen Artikelverkaufspreis verdichtet.

### 8.4 Fehlende Preishistorie

`tblProtPreis` definiert zwar einen zusammengesetzten Primärschlüssel aus
`Aenderung`, `FilialID` und `EAN` sowie das Feld `NVKPreis`, enthält aber keine
Zeile. Die Quelle liefert damit keine belastbare Preishistorie. Sämtliche
ausgelesenen Preisangaben sind als zeitpunktbezogener Snapshot zu kennzeichnen.

### 8.5 Preisberechnungskonfiguration

`Artikel_PreisSpannen` und `Preis_Kennung` enthalten jeweils nur eine
Konfigurationszeile. Die erste Tabelle beschreibt eine Spanne von -100 bis 500
und vier prozentuale Kennungen; die zweite benennt und steuert diese Kennungen.
Beides sind Alt-Systemregeln zur Preisberechnung, keine Preise eines Artikels.
Sie werden im ersten Produktimport nicht als Produkt- oder Preis-Snapshot
übernommen.

## 9. Providerneutrales Zielmodell

### 9.1 Produkt

Der Produktkern soll nur stabile Stammdaten enthalten:

- `product_id` als interner Primärschlüssel;
- `article_number` als eindeutiger sechsstelliger fachlicher Textschlüssel;
- `source_article_key` als unveränderter 13-stelliger TradeFoto-Schlüssel;
- Bezeichnung und optionale Zusatzbezeichnungen;
- getrennte Marken- und Taxonomiebezüge;
- TradeFoto-Steuercode plus aufgelöste Steuerreferenz;
- getrennte Statuskennzeichen;
- Quell-Anlage- und Änderungszeitpunkt;
- Importlauf, Revision und Auditmetadaten.

### 9.2 Preis-Snapshots

Die zahlreichen Preisfelder werden nicht als breite Produktspalten nachgebaut.
Eine zeilenorientierte Preis-Snapshot-Entität benötigt mindestens:

- `product_price_snapshot_id` und `product_id`;
- `scope_type`: `global`, `branch`, `channel`, `customer_group` oder
  `supplier`;
- `scope_key`;
- stabile `price_kind` und das ursprüngliche `source_field`;
- `amount`, `currency`, `tax_inclusion` und optionalen Steuercode;
- `valid_from`, `valid_to` und `observed_at`;
- `semantic_status`, `validation_status` und `import_run_id`.

Für PostgreSQL ist `NUMERIC(30,12)` vorgesehen. Im SQLite-Provider wird derselbe
Wert als validierte kanonische Dezimalzeichenfolge mit genau zwölf
Nachkommastellen gespeichert. `REAL`, `DOUBLE PRECISION` und binäre
JavaScript-Gleitkommazahlen sind im Zielvertrag für Geldwerte unzulässig.

Die hohe Skala bewahrt die aus Access gelesenen Werte zunächst ohne zusätzliche
Rundungsentscheidung. Eine spätere fachliche Rundung auf Kassen-, Anzeige- oder
Buchungspräzision erzeugt einen abgeleiteten Wert und überschreibt nie den
importierten Snapshot.

### 9.3 Null, Nullwert und Quarantäne

- Quell-`NULL` bedeutet „kein Wert vorhanden“.
- Numerisch `0` bedeutet „vorhandener Nullwert“.
- Beide Zustände bleiben im Import und im Ziel unterscheidbar.
- Negative Beträge werden nicht automatisch als Rabatt, Gutschrift oder
  Korrektur interpretiert.
- Ein Importlauf schreibt nur vollständig validierte Datensätze in den aktiven
  Katalog; Prüfwerte bleiben laufbezogen in Quarantäne.

Mindestens folgende Fälle erfordern Quarantäne:

- ungültige oder widersprüchliche GTINs und Scan-Kollisionen;
- negative Preiswerte;
- Abweichungen in bestätigten Brutto-/Nettopaaren;
- unbekannte Steuer-, Marken-, Taxonomie- oder Standortbezüge;
- Zweitlieferantenzeilen ohne deterministische Identität;
- neue, fehlende oder typveränderte Quellspalten;
- Werte außerhalb der explizit freigegebenen Preisarten.

Jeder Importlauf benötigt Dateifingerprint, Profilversion, Snapshot-Zeitpunkt,
Zählwerte, Fehlerklassen, Idempotenzschlüssel und eine abgegrenzte Rücknahme.
Quelldatei, Passwort und dauerhafter lokaler Pfad gehören nicht in den
Grabenplaner-Datenbestand.

## 10. Datenschutz- und Importgrenze

Für den Artikelstamm sind ausschließlich Produkt-, Taxonomie-, Steuer-, Preis-
und ausdrücklich freigegebene Bestandsdaten vorgesehen. Ausgeschlossen bleiben:

- Kunden-, Kontakt-, Adress-, Zahlungs- und Kommunikationsdaten;
- Mitarbeiter-, Benutzer-, Rollen- und Zugangsdaten;
- personenbezogene Verkäufer-, Änderer- und Leistungszuordnungen;
- Lieferantenkontakte, Ansprechpartner, Bank- und freie Notizdaten;
- Bilder, OLE-Inhalte, Anhänge und nicht benötigte Marketing-Langtexte;
- System-, Protokoll-, Zugangs- und temporäre Alt-Systemtabellen ohne
  ausdrücklich katalogisierten Produktzweck.

Lieferantenartikelnummern und Lieferantenpreise können später als betriebliche
Produktbezüge aufgenommen werden. Personen-, Kontakt-, Bank- oder Zugangsdaten
werden dadurch nicht freigegeben.

## 11. Abschluss

Der Snapshot erlaubt einen sauberen ersten Produktkatalog mit 18.996 eindeutigen
Artikelnummern, getrennten validierten Barcodes, vollständiger
Sortiment-Warengruppe-Sparte-Hierarchie sowie nachvollziehbaren Preis-Snapshots.

Die zentrale Migrationsregel lautet: Das historisch `EAN` genannte Quellfeld ist
die TradeFoto-Artikelnummer. Barcodes, Preise, Filialwerte und Lieferantenwerte
bleiben eigenständige, qualitätsgesicherte Entitäten. Ungeklärte Werte werden
weder verworfen noch still interpretiert.

## 12. Implementierungsstand des Grundgerüsts

Das lokale Grabenplaner-Grundgerüst bildet den derzeit freigegebenen Kern in zehn
getrennten Tabellen ab: Import-Snapshots, laufbezogene Befunde und Zählmetadaten,
Produkte, unveränderliche Revisionen, unveränderliche Importauswirkungen und
Quellbindungen, globale GTIN-Eigentümer, validierte Identifier sowie
unveränderliche Preis-Snapshots. `product_id` ist ein anwendungsseitig erzeugter
UUID-v4-Primärschlüssel; `article_number` bleibt der eindeutige fachliche
Schlüssel. Dadurch kann eine fachliche Artikelnummer später kontrolliert
korrigiert werden, ohne Referenzen auf das Produkt zu brechen.

Valide EAN/UPC/GTIN werden mit unverändertem Rohwert, Quellrang und einem auf
GTIN-14 aufgefüllten kanonischen Vergleichswert abgelegt. Eine kanonische GTIN
gehört snapshotübergreifend genau einer `product_id`. Äquivalente UPC-A-, EAN-13-
und GTIN-14-Darstellungen desselben Produkts werden kanonisch dedupliziert; ihre
Rohwerte und Herkunft bleiben als unveränderliche Beobachtungen erhalten. Der
niedrigste gültige TradeFoto-`Rang` bestimmt reproduzierbar die Hauptkennung;
Selbstaliase bleiben ausgeschlossen.

Der Inhaltsfingerprint wird aus den normalisierten Artikeln, Identifiern und
Preisen in stabiler Reihenfolge berechnet. Ein von der Importstufe gelieferter
abweichender Fingerprint wird vor jeder Datenbankmutation abgewiesen. SQLite
speichert Geldwerte als kanonische decimal12-Zeichenfolge; der deaktivierte
PostgreSQL-Vertrag verwendet dafür `NUMERIC(30,12)`.

Das versionierte TradeFoto-Profil akzeptiert nur seine explizit katalogisierten
Quellspalten. Neue, fehlende oder typveränderte Felder sowie ein abweichender
Quellschema-Fingerprint führen fail-closed in die Importprüfung; sie werden nicht
als scheinbar identischer Snapshot wiederverwendet.

Der kontrollierte Import nimmt sowohl das vorbereitete, versionierte JSON-Format
`grabenplaner.tradefoto.article-catalog.v1` als auch eine ausdrücklich ausgewählte
TradeFoto-`.accdb` entgegen. Die direkte Datenbankprüfung öffnet die Quelldatei
ausschließlich lesend in einem begrenzten Worker, liest nur die freigegebenen
Tabellen und Spalten und erzeugt intern exakt denselben versionierten Datenvertrag.
Schema-, Typ-, Beziehungs-, Zeilen-, Arbeits- und Zeitgrenzen schließen den Weg
fail-closed. Das beim Aufruf eingegebene Datenbankpasswort wird weder gespeichert
noch in Vorschau oder Audit übernommen; auch die hochgeladenen ACCDB-Bytes werden
nicht persistiert. Eine automatische Verbindung zum Altsystem findet nicht statt.

Vorschau und Übernahme verlangen das getrennte Recht
`sales:articles:import`; jede Mutation zusätzlich Sessionbindung, Live-Rechte und
CSRF. Die Datei ist auf 64 MiB, 25.000 Zeilen, 256 Aliase je Artikel und 100.000
Einzelbefunde begrenzt. Zusätzlich gilt vor der eigentlichen Adaption ein
Arbeitsbudget von 750.000 Einheiten: `Artikelzeilen × 36 + Aliaszeilen`. Der
analysierte Bestand liegt mit 18.996 Artikeln und 37.412 Aliaszeilen bei 721.268
Einheiten. Ein einzelner Schwerlauf ist zulässig; parallele Vorschauen,
Übernahmen oder Rücknahmen werden mit `429` geschlossen abgewiesen. Der
normalisierte, komprimiert zwischengespeicherte Snapshot darf entpackt höchstens
128 MiB umfassen.

Die Vorschau selbst verändert weder Artikeltabellen noch Auditdaten. Sie
klassifiziert jede Zeile als Anlage, Aktualisierung, unverändert oder Quarantäne.
Dateiinterne Konflikte bei Quellschlüssel, Artikelnummer oder GTIN sperren alle
beteiligten Zeilen; andere sichere Zeilen bleiben als exakt bezeichnete Teilmenge
übernehmbar. Blockierte Zeilen gelangen nie in den Artikelsnapshot. Ein vollständig
quarantänisierter Lauf kann ausschließlich zur revisionsfesten Protokollierung
seiner Befunde bestätigt werden und verändert dabei keinen Artikel. Reine
Hinweisläufe ohne sichere oder blockierte Zeile bleiben geschlossen.

Für die Brutto-/Nettopaare wird der jeweilige TradeFoto-Steuercode verwendet:
`0 = 0 %`, `1 = 20 %`, `2 = 10 %`, `3 = 19 %`, `4 = 7 %`. Die Prüfung rechnet
dezimalverlustfrei, rundet kaufmännisch auf Cent und toleriert höchstens einen Cent
Differenz. Ein unbekannter Steuercode, ein nur einseitig belegtes Paar oder eine
größere Abweichung quarantänisiert die Zeile und verhindert ihre Aktivierung.

Die bestätigte Übernahme wiederholt Zustands- und Konfliktprüfung innerhalb
derselben seriellen Transaktion wie Snapshot, Revisionen, Quellbindungen,
laufbezogene Befunde, Zählmetadaten und Audit. Nur weiterhin sichere Anlagen und
Aktualisierungen werden aktiv; unveränderte Artikel erzeugen keine Revision.
Manuell gepflegte oder archivierte aktuelle Stände werden weder überschrieben noch
reaktiviert. Idempotente Wiederholungen müssen Snapshot, Befunde und Laufmetadaten
exakt treffen; abweichende Daten unter demselben Schlüssel werden abgewiesen. In
Vorschau und Audit stehen keine Rohzeilen oder Rohpreise.

Für jede tatsächlich übernommene Teilmenge entsteht ein persönlicher,
eigentümergebundener Aktionsbeleg. Seine zeitlich begrenzte Rücknahme prüft das
aktuell wirksame Importrecht und jeden Artikelkopf gegen die unveränderlich
gespeicherte Importauswirkung. Neuanlagen werden durch eine Gegenrevision
archiviert, Aktualisierungen durch eine Gegenrevision auf den exakt vorherigen
Stand zurückgeführt. Import-Snapshots, Quellbindungen, Historie und Befunde werden
nicht gelöscht; ein veränderter Artikelkopf sperrt die gesamte Rücknahme atomar.

Der bestehende Leihartikelstamm wird beim Cutover unter der nachweisbaren Quelle
`legacy.loan_articles` in diesen Katalog überführt. Historische Leihpositionen
referenzieren danach die stabile `product_id`, bewahren aber Artikelnummer,
Bezeichnung und Produktrevision als Beleg-Snapshots. Ein späterer eindeutiger
TradeFoto-Treffer ergänzt eine eigene Quellbindung an dieselbe Produktidentität;
er schreibt weder Provenienz noch historische Belegtexte um. Die Leih-Laufzeit
und der F18-Import lesen beziehungsweise schreiben ausschließlich über den
zentralen Artikelkatalog.

Historische `product_snapshot`- und `inventory_snapshot`-Werte der
Verkaufsanalyse bleiben unveränderliche fachliche Fakten. Eine spätere
Zuordnung zu `product_id` muss als getrennte, auditierte Referenz erfolgen und
darf diese Snapshots nicht ersetzen oder rückwirkend korrigieren. Eine solche
Zuordnung ist in diesem Grundgerüst noch nicht implementiert. Ebenso existieren
noch keine erfundenen Integrationen für Angebote oder weitere
Warenwirtschaftsvorgänge; sobald diese Laufzeitpfade entstehen, ist das
`SalesArticleCatalog`-Repository mit seinen Quellbindungen die verbindliche
Artikelstammgrenze und keine zweite Artikeltabelle.

Die 18.996 realen Artikel sind mit diesem Arbeitsschritt weiterhin weder importiert
noch aktiviert. Implementiert sind jetzt die laufbezogene Quarantänepersistenz,
das Brutto-/Netto-Gate, die ausdrücklich bestätigte atomare Aktivierung, die
abgegrenzte Rücknahme und die direkte Read-only-Extraktion aus der ausgewählten
ACCDB. Ein realer Lauf startet weiterhin niemals automatisch: Erst Vorschau und
fachliche Prüfung, danach die ausdrückliche Bestätigung, dürfen den sicheren
Teilbestand aktivieren. Das vorbereitete JSON bleibt als alternative Importquelle
erhalten.
