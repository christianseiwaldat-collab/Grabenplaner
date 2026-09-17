# Artikelstamm: Suche und Detailansicht

Stand: 18.09.2026. Implementiert und lokal geprüft. Der VPS-Deploy steht aus.

## Oberfläche

- Desktop: Suche und Treffer links mit einem Drittel der Arbeitsfläche, Artikel rechts mit zwei Dritteln. Unter 1100 px folgen die Bereiche untereinander.
- Tabs: **Stammdaten**, **Preise**, **Kennungen & Verlauf**. Der dritte Tab enthält die bisherige EAN-Tabelle, Herkunft und Versionsverlauf.
- Stammdaten enthalten jetzt die früheren TradeFoto-Stammdaten, EH-/Internet-VK brutto, MwSt.-Prozent und vorhandene Produkt-, Geizhals- und Idealo-Links.
- Der Zeitpunkt „im GP aktualisiert:“ steht im Stammdaten-Kopf. Primäre EAN öffnet die Google-Bildersuche. Externe Links verwenden neue Tabs und `noopener noreferrer`.
- Eigenes quadratisches Fotofeld mit ungefähr einem Viertel der rechten Inhaltsbreite. Der bestehende Upload-/Entfernen-Dialog und das grüne Plus bleiben erhalten.
- Danach folgen Beschreibung/Lieferumfang mit Lieferanteninformationen, eine schmale Filialbestandstabelle und weitere Quellfelder. Lieferantencode und Filial-ID zeigen bei Hover oder Tastaturfokus den vorhandenen vollständigen Namen.
- EK-Matrix mit aktueller/zukünftiger Zeile; VK-Matrix mit UVP, EH, GH, Internet, Brutto/Netto, Rohertrag, UVP-Abschlag und Datum/Person. Weitere Preisarten stehen darunter.
- Nach einer Artikeländerung werden die ergänzten Details neu geladen.

## Daten und Suchverhalten

- Normale Suche: Artikelnummer, Bezeichnung und sämtliche Kennungen des aktuellen Artikelstands, einschließlich weiterer EANs.
- Erweiterte Suche: Bestellnummer und Status. Gesucht wird in `ARTIKEL_STAMM.Bestellnummer` und `ARTIKEL_ZWEITLIEFERANT.ZBestellnummer`.
- Die Bestellnummernsuche hält nur Artikelbezug, normalisierte Nummer, Quellstand und Revision im Prozessspeicher. Beim ersten Abruf werden die relevanten verschlüsselten Segmente gelesen; nach Importänderungen nur veränderte Revisionen erneut entschlüsselt. Veraltete Zweitlieferanten-Snapshots ergeben keine Treffer.
- Lieferantenname: `LIEFERANTEN.Firma`; Filialname: `FILIALEN.FName`. Bestände stammen aus dem jüngsten abgeschlossenen `ARTIKEL_FILIALEN`-Stand. Fehlende/mehrdeutige Bestände werden nicht zu Null oder einer erfundenen Summe.
- MwSt. nutzt die bereits vorhandene TradeFoto-Zuordnung. Unbekannte Kennzeichen werden ausdrücklich als nicht eindeutig hinterlegt angezeigt.
- Preise und Kosten bleiben getrennt berechtigt, einschließlich Suchsortierung, API, clientseitiger Darstellung und Rohertrag.
- Rechenbasis für Rohertrag ist bestätigter Netto-VK und durchschnittlicher Netto-EK. Die bislang ungeklärte Netto-Bedeutung von `DEK_A` wird nicht als bestätigt angenommen; die zugehörigen Rohertragszellen bleiben leer. Nicht bestätigte importierte EK-Werte erscheinen als gekennzeichnete Quellwerte. S-Out-B erhält ohne bestätigte Einheit kein Eurozeichen.
- Manuelle Preisrevisionen verwenden ihre eigenen aktuellen Kosten; ein später importierter Stammdaten-EK überschreibt diese Rechenbasis nicht.

## Technischer Umfang

Neue reine Lese-Statements und Laufzeitkataloge für SQLite und PostgreSQL. Keine neue Datenbankmigration und keine externe Abhängigkeit. Historisch festgeschriebene PostgreSQL-Kataloge bleiben unverändert.

Zentrale neue Dateien: `public/sales-article-layout.js`, `lib/sales-article-price-matrix.js`, `lib/sales-article-branch-stock.js`, `lib/persistence/repositories/sales-article-workspace.js` und zugehörige Statement-/Providerkataloge.

Vorherige lokale Änderungen zu Geschwindigkeit, Urlaub, PDF-Analyse, Xoffi und Filialeinsatz sind erhalten.

## Prüfung

- 105 Tests zu Artikeldomäne, Suche, Persistenz, API/Rechten, Import, Darstellung, Bildern und Kalkulation bestanden.
- Zusätzlich ein nativer PostgreSQL-Integrationstest bestanden: Bestellnummern beider Quellen, zusätzliche EAN, Importwechsel, Filialbestände und Preisberechtigungen.
- Die drei neuen Funktionstests nach den letzten Anpassungen an Preispriorität und Rechenbasis erneut bestanden.
- Browser mit synthetischen Daten: Suche nach weiterer EAN und Bestellnummer, Tabwechsel, Foto-Dialog, Links/Tooltipnamen und Layout geprüft. Desktopverhältnis 1:2, Foto quadratisch. Kompakte Bestandszeile enthält beide Spalten ohne seitlichen Überlauf.
- Schmale Ansicht geprüft: kein Seitenüberlauf; Preistabellen scrollen innerhalb ihrer Container. Temporäre Viewportänderung zurückgesetzt.
- Syntax und `git diff --check` bestanden.
- Persistenzaudit: null unklassifizierte Dateien und null Phasengrenzverletzungen. Die beiden bereits vor diesem Arbeitsblock dokumentierten Phase-4-/historischen Provider-Slice-Befunde bleiben offen; der Gesamtaudit ist deshalb nicht grün.

Protokolle: `tmp/article-workspace-tests-20260917.log`, `tmp/article-workspace-native-20260917.log`, `tmp/article-workspace-final-unit-20260917.log`, `tmp/article-workspace-persistence-audit-20260917.log`.

Der ausschließlich für diesen Test gestartete lokale PostgreSQL-Cluster wurde anschließend wieder gestoppt. Keine VPS-Aktion.

## Lokale Vorschau

Synthetischer GP auf `http://127.0.0.1:52660/?view=articleCatalog`, eigener temporärer Datenbankbestand. Vorschaukonto: Personalnummer `99001`, Passwort `Vorschau-2026!`. Artikel `005479`, Suche `Hama`, zusätzliche EAN `4006381333931`, Bestellnummer `L-98765`.

Startskript: `tmp/article-workspace-preview-20260917.cjs`. Automatischer Stopp nach acht Stunden; aktuelle Prozess-/Verbindungsinformationen in `tmp/article-workspace-preview-ready.json`. Das ist eine zeitlich begrenzte lokale Vorschau mit Beispieldaten.

Screenshots: `output/artikelstamm-2026-09-17/uebersicht.png`, `stammdaten.png` und `preise.png`.
