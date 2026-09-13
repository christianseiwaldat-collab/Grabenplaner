# Geprüfte Teilwerte in Verkaufsberichten

Stand: 11.09.2026. In v0.92.36-beta veröffentlicht; die Berichterstellung ist
wieder freigegeben. Die folgenden Abschnitte dokumentieren die schrittweisen
fachlichen Klärungen mit ihrem jeweiligen damaligen Prüfstand. Der aktuelle
Bereitstellungsnachweis steht im [Releasebericht](VERKAUFSBERICHTE-RELEASE-v09236.md).

## Ursache und Darstellung

Bisher konnte eine einzige offene Belegprüfung sämtliche Kennzahlen einer
Herstellergruppe auf „Nicht verfügbar“ setzen. Das Diagramm ließ solche Gruppen
weg, obwohl geprüfte Verkäufe derselben Marke vorhanden waren. Die Zuordnung
aus dem historischen Kassenfeld `UMarke` war dabei korrekt.

Eine Belegprüfung umfasst alle Positionen des Belegs. Ein offener Verkaufsstatus,
eine ungeklärte Mehrwertsteuerzuordnung oder eine abweichende Belegsumme kann
deshalb auch eine für sich unauffällige Kamera-Position betreffen. Diese
Prüfregeln werden durch die Darstellungskorrektur nicht erweitert. Die inzwischen
fachlich bestätigten Kassenfälle sind im folgenden Abschnitt gesondert beschrieben.

Das Berichtsmodell erhält zusätzlich zu den vollständigen Werten ausdrücklich
getrennte geprüfte Teilwerte. Beispiel mit synthetischen Zahlen: Sind 100 Euro
Nettoumsatz geprüft und eine weitere passende Position offen, zeigt die PDF
`100,00 € *`. Der vollständige Umsatz bleibt unbekannt. Ohne geprüfte passende
Positionen wird kein Teilwert und kein künstlicher Nullumsatz ausgegeben.

Die Kennzeichnung gilt je Zeitraum und Kennzahl. Fehlender Rohertrag oder eine
fehlende Menge werden nicht durch Null ersetzt. Retouren behalten ihr Vorzeichen;
bekannte Kundenkonten, Belege und Werte je Kunde verwenden weiterhin die
bestehenden Regeln für eindeutige Zählung und den zugehörigen geprüften Umfang.
Absolute und prozentuelle Veränderungen erfordern vollständige Werte in beiden
Zeiträumen. Aus unterschiedlich unvollständigen Teilwerten wird kein Vergleich
berechnet.

## PDF

- Übersicht, Detailtabellen und Gesamtzeilen kennzeichnen geprüfte Teilwerte
  mit einem Stern und erklären die Kennzeichnung.
- Balkendiagramme enthalten auch geprüfte Teilwerte; die Beschriftung nennt den
  jeweils unvollständigen Zeitraum. Gruppen ohne auswertbaren aktuellen Wert
  bleiben vollständig in den Tabellen und werden im Diagrammhinweis gezählt.
- Ringdiagramme erfordern vollständige aktuelle Gruppenwerte. Bei offenen
  Werten erscheinen erklärte Vergleichsbalken, damit unvollständige Summen nicht
  als verlässliche Umsatzanteile erscheinen.
- „Offene Belegprüfungen“ nennt am Berichtsende für jede betroffene Gruppe die
  geprüften und offenen Positionen beider Zeiträume sowie verständliche
  Prüfgründe. Gründe beziehen sich auf die Belegprüfung und können von einer
  anderen Position desselben Belegs stammen.
- Schriftgrößen, Seitenränder und die bestehende Grenze von 250 Seiten bleiben
  erhalten. Kompaktere Absatzabstände im Querformat vermeiden eine einzelne
  verbleibende Umfangszeile auf einer zusätzlichen Seite.

## Prüfung

Die ursprüngliche Herstellerabfrage wurde mit unveränderter Quelle und
identischer Filial-/MA-Auswahl in einem separaten Prozess ausschließlich lesend
nachgerechnet. Auch das gespeicherte PDF wurde gelesen: Es enthielt die
ausgeblendeten Herstellerwerte. Die neue Fassung entstand ausschließlich im
Arbeitsspeicher; ihre extrahierten PDF-Werte entsprechen den geprüften Teilen
der ursprünglichen Abfrage. Ursprünglicher Auftrag, Datenquelle und aktive
Berichtspause blieben unverändert; sämtliche Bereitschaftsproben waren HTTP 200.
Die konkreten Betriebswerte stehen nur im lokalen Diagnoseprotokoll.

Automatische Prüfungen umfassen:

- eine offene Begleitposition mit ungeklärter Mehrwertsteuer im vollständigen
  Import-/Berichts-/PDF-Ablauf bei gleichzeitiger Hersteller- und MA-Filterung;
- getrennte aktuelle und frühere Teilwerte, Retouren, fehlenden Rohertrag,
  vollständig offene Gruppen sowie ausbleibende irreführende Veränderungen;
- reale Hintergrundprozesse, Zeitüberschreitung und Ersetzung eines Workers,
  begrenzte Checkpoints, Rechteänderung, Abbruch und geschützte Downloads;
- Hoch-/Querformat, Textvollständigkeit, Seitenränder und Diagrammwahl;
- 939 MA-/Sortiment-Kombinationen mit sechs Kennzahlen: 195 Seiten bei
  vollständigen Daten und 227 Seiten mit zusätzlicher offener Position in
  jeder Gruppe und beiden Zeiträumen, jeweils mit unveränderter Schriftgröße.

57 Modell-, Import- und PDF-Prüfungen sowie anschließend 14 PDF-/Worker-/Route-/
Checkpoint-Prüfungen erfolgreich; darin sind acht PDF-Prüfungen wiederholt.
Nach der letzten Abstandskorrektur alle neun PDF-Prüfungen erneut erfolgreich.
Das entspricht 63 unterschiedlichen Prüfungen. Synthetische Beispiele in
beiden Formaten und die Fortsetzung der umfangreichen Prüftabelle wurden
gerendert und visuell kontrolliert.

Lokale Protokolle: `tmp/sales-brand-regression-tests.log`,
`tmp/sales-brand-final-worker-pdf-tests.log`,
`tmp/sales-brand-final-layout-tests.log` und `tmp/sales-brand-fixed-probe.log`.
Die synthetischen PDFs liegen unter `tmp/pdfs/sales-brand-review-20260910/`.

## Ergänzung: bestätigte Kassenfälle vom 10.09.2026

Nach der Darstellungskorrektur wurden konkrete Belege mit dem Benutzer geklärt.
Die Auswertung verwendete dafür zunächst die effektive Regelversion
`cash-confirmed-20260910`, Version 2:

- Steuerkennzeichen `10` bedeutet laut bestätigter Kassenkonvention 10 % MwSt.
  Es gilt für kostenlose und kostenpflichtige Positionen. Eine kostenlose
  Beigabe ergibt null Umsatz und Steuer und blockiert die übrigen Artikel nicht.
- Separate Hersteller-Sofortrabatte im Sortiment `170201` mit der bestätigten
  Sonderartikel-Kennzeichnung mindern den Umsatz; die positive Gegenbuchung
  nimmt den Rabatt zurück. Die Position bleibt bei ihrer historischen WGR und
  Marke. Ihr Vorzeichen ändert nicht den Kassen-Rohertrag der Warenposition.
  Eigene vorhandene Rohertragswerte der Rabattposition werden weiterhin aus der
  Kassa übernommen. Rabattmengen zählen nicht als verkaufte Warenstücke.
- Bestätigte negative Gutscheineinlösungen im Sortiment `170101` sind
  Zahlungsmittel. Sie verändern weder Warenumsatz noch Kassen-Rohertrag und
  erhöhen weder Warenmenge noch Kunden- oder Beleganzahl. Quelle, Menge und
  Quellpreis bleiben in den Belegdetails erhalten; der Status lautet
  „Zahlungsmittel“.
- Ein ausdrücklich bestätigter Nettobelegkopf wird mit der Nettosumme verglichen.
  Die Ausnahme ist an den vollständigen Fingerabdruck dieses einen Belegs
  gebunden. Andere oder veränderte Belege erhalten keine automatische
  Nettobetragsannahme, nur weil eine Rechnung zufällig passt.

Der historische Rohertrag bleibt `RohertragDM × VKMenge`, mit Rundung erst nach
der Multiplikation. Aktuelle EK-Preise werden nicht benötigt. `KalkRohertrag`
wird nicht als Ersatz verwendet: In der untersuchten Quelle sind die Felder
nicht generell rechnerisch austauschbar.

Die versiegelte ursprüngliche Quellfreigabe bleibt einschließlich Fingerabdruck
unverändert. Erst nach deren Integritätsprüfung wird die exakt bekannte alte
Regeldefinition zur effektiven Version 2 aufgelöst. Andere Regeldefinitionen
werden nicht überschrieben. Neue Quell-/Cache-/Auftragsbindungen enthalten den
effektiven Fingerabdruck. Ein noch wartender Auftrag mit der früheren Bindung
wird nicht stillschweigend mit neuen Regeln fortgesetzt; er muss neu erstellt
werden. Dafür ist kein erneuter Kassenimport erforderlich.

Die erneute Prüfung verwendete den tatsächlichen Berichts-Workspace mit seiner
begrenzten Checkpoint-Verarbeitung in einem separaten, schreibgeschützten
Prozess. Alle 16 gezielt untersuchten Belege bestehen jetzt die vollständige
Belegprüfung. Die ausgewählten Sony-, Canon-, Nikon-, Fujifilm-, Panasonic- und
Sigma-Werte sind in beiden Zeiträumen vollständig, einschließlich Kassen-Rohertrag.
Andere offene Belege bleiben ausdrücklich offen; die gesamte Abfrage ist daher
nicht pauschal als vollständig freigegeben zu behandeln.

Der Nachweis umfasst 18.954 Quellpositionen, 96 Batches, unveränderten Originalauftrag,
unveränderte Quellfreigabe und Inventarzähler sowie 22 erfolgreiche
Bereitschaftsprüfungen. Die Finanzwerte der im Arbeitsspeicher erzeugten PDF
wurden mit PDF.js geprüft. Anschließend wurde ausschließlich der zusätzliche
Erklärungstext zur ersten Detailtabelle verschoben, damit die Übersicht im
Querformat beide Zeitraumhinweise zusammenhält.

129 unterschiedliche automatische Prüfungen sind nach den gezielten Korrekturen
erfolgreich abgedeckt; davon wurden abschließend 63 Import-/Beleg-/Modell-/PDF-
Prüfungen erneut bestanden. Enthalten sind auch bezahlte 10-%-Positionen,
Gutscheinzahlungen, Rabattgegenbuchungen, unveränderte Quellfreigabe und die
Ablehnung eines an frühere Regeln gebundenen Auftrags. Der Persistenzaudit
meldet keine unklassifizierten Dateien oder Grenzverletzungen. Die abschließende
PDF-Fassung und die breitere Statusspalte der Beleginformation wurden gerendert
und auf vollständige, lesbare Texte kontrolliert.

Protokolle: `tmp/cash-confirmed-probe.log`, `tmp/cash-review-regression-tests.log`,
`tmp/cash-review-final-tests.log`, `tmp/cash-review-persistence-audit.log`.
Der erste Regressionslauf enthielt zwei inzwischen behobene Prüfprobleme:
Ein neuer Test griff auf eine Suchzusammenfassung statt die Belegdetails zu;
zusätzlicher Hinweistext verdrängte eine Umfangszeile von der Querformatübersicht.
Die abschließenden 63 Prüfungen decken beide Korrekturen ab.

## Beleganordnung und weitere Klärungsbelege

Die Belegansicht und der PDF-Auszug verwenden jetzt dieselben fünf Spalten:
Menge, Artikelnr., Bezeichnung, Einzelpreis und Gesamtpreis. Die Personalnummer
steht fett in einer eigenen Zeile über den zugehörigen Positionen. Gruppen
folgen dem ersten Auftreten der Personalnummer; innerhalb der Gruppe bleibt
die Quellreihenfolge erhalten. Fehlende Positionspersonalnummern werden nicht
durch den Verkäufer des Belegkopfs ersetzt. Ohne das entsprechende Leserecht
erscheinen weder Personalgruppen noch Personalnummern.

Bei einem PDF-Seitenumbruch werden die Spaltenüberschriften und die laufende
Personalgruppe wiederholt. Artikelnummern bleiben vollständig; Beschreibungen
und Statushinweise dürfen umbrechen. Auf kleinen Bildschirmen kann ausschließlich
die Positionstabelle horizontal gescrollt werden.

Der angezeigte Gesamtpreis ist Menge mal Quell-Einzelpreis, exakt dezimal
berechnet und danach auf Cent gerundet. Er bleibt vom geprüften Warenumsatz
getrennt: Eine Gutscheinzahlung zeigt beispielsweise ihren negativen
Positionsbetrag, ohne den Warenumsatz zu mindern. Auch bei offenen Belegen
sind Quellpreise sichtbar, aber keine ungeprüfte Umsatzsumme freigegeben.

Der erneute lesende Abgleich der ursprünglichen Auswahl enthält 71 offene
Belege mit 109 Positionen. Die Auswahl betrifft eine Filiale und einen MA,
keine Unternehmensgesamtwerte. Acht Klärungsgruppen und elf Beispielbelege
decken die wiederkehrenden Sachverhalte ab; alle 71 vollständigen Belege
wurden in einem privaten PDF-Bündel mit Übersicht und Lesezeichen ausgegeben.
Die dazugehörige Frageliste liegt ausschließlich unter dem lokalen `output/`.
Diese Darstellung ändert keine fachliche Auswertungsregel und bestätigt keine
weitere Status- oder Steuerkombination.

54 passende Layout-, Beleg-, Rechte-, Import- und Berichtsprüfungen bestanden.
Nach der abschließenden Anpassung der Artikelnummernspalte wurden die drei
gezielten Layouttests nochmals erfolgreich ausgeführt. Alle 72 Seiten des
Klärungsbündels wurden auf vollständige Beleg- und Artikelnummern sowie
Textgrenzen geprüft; repräsentative echte Belege und mehrseitige synthetische
Belege zusätzlich visuell. Browserprüfungen bei 1100 und 390 Pixeln bestätigen
die Spaltenfolge, fett gesetzte Gruppen und den begrenzten Tabellenüberlauf.

Protokolle: `tmp/receipt-layout-tests.log`, `tmp/receipt-layout-final-tests.log`,
`tmp/receipt-layout-pdf-qa.log`, `tmp/receipt-layout-browser-qa.log` und
`tmp/receipt-layout-audit.log`. Der lesende Produktionsnachweis liegt in
`tmp/cash-open-receipts-probe.log`; alle 23 Bereitschaftsprüfungen waren
erfolgreich, Originalauftrag und Quellfreigabe unverändert.

## Ergänzung: Sofortdrucke und KVA-Pauschale vom 11.09.2026

Der Benutzer hat Sofortdrucke als normale Verkäufe einschließlich möglicher
Staffelpreise bestätigt. Die KVA-Pauschale ist eine berechnete
Kostenvoranschlagsleistung für Reparaturen. Bei der Reparaturabrechnung wird
sie über eine negative Position angerechnet; ohne durchgeführte Reparatur
bleibt die Pauschale berechnet.

Die effektive Regel wurde damit `cash-confirmed-20260911`, Version 3. Sie übernimmt
alle bestätigten Regeln der Version 2 und ergänzt die positiven Sonderartikel-
Verkäufe in der Sofortdruck-WGR `60401` sowie beide Vorzeichen der KVA-Pauschale
in WGR `110201`. Die KVA-Ergänzung gilt zusätzlich nur für die bestätigte
Quell-Artikelnummer `0000000049742`. Für beide Ergänzungen müssen die bestätigte
Statuskombination und Steuerkennzeichen `20` passen. Andere Sonderartikel,
Statuskombinationen, Steuerfälle und unbestätigte Nettobelegköpfe bleiben offen.

Der gebuchte Einzelpreis wird unverändert mit der Menge verrechnet; es gibt
keine zweite Staffel- oder Rabattberechnung und keinen Rückgriff auf aktuelle
Artikelpreise. Die negative KVA-Position ist eine Gutschrift auf die vorher
berechnete Leistung und verwendet intern den bestehenden Retourenstatus.
Nur tatsächlich vorhandene Gegenbuchungen werden berücksichtigt, ohne erfundene
Verknüpfung zwischen Belegen oder eine automatische Anrechnung nach Zeitablauf.
Der Kassen-Rohertrag bleibt `RohertragDM × VKMenge` mit Rundung nach Multiplikation.

Die ursprüngliche versiegelte Freigabe bleibt Version 1 und unverändert.
Die neue effektive Regel enthält einen neuen Evidenz- und Regelfingerabdruck;
damit ändern sich auch die Berichts- und Cache-Bindungen. An ältere Regeln
gebundene Aufträge dürfen ihre Berechnung nicht mit diesen Regeln fortsetzen.
Bereits gespeicherte PDFs bleiben unverändert.

Die erneute lesende Prüfung aller 71 zuvor offenen Belege löst 52 vollständige
Belege mit 83 ausgewählten Positionen einschließlich ihrer Begleitpositionen.
19 Belege mit 26 Positionen bleiben offen, davon sechs aktuelle und 20 im
Vergleichszeitraum. Die Auswahl bleibt auf eine Filiale und einen MA begrenzt.
Diese Zahlen sind keine Unternehmensgesamtwerte. Alle drei besprochenen
Beispielbelege stimmen einschließlich Kassen-Rohertrag. Die originale
Quellfreigabe, der gespeicherte Auftrag und das Quelleninventar sind unverändert;
alle zehn Bereitschaftsprüfungen waren erfolgreich.

Neue Prüfungen decken Staffelpreise ohne doppelten Rabatt, erhaltene KVA ohne
Reparatur, die gebuchte Anrechnung mit negativem Rohertrag sowie die unveränderten
Grenzen für unbekannte Fälle ab. Ein Integrationstest führt vier synthetische
Belege vom versiegelten Import über Belegsuche und Berichtskennzahlen bis zum
verschlüsselten PDF. Protokolle: `tmp/cash-print-kva-tests.log`,
`tmp/cash-print-kva-final-tests.log`, `tmp/cash-print-kva-audit.log` und
`tmp/cash-print-kva-probe.log`. Der erste Testlauf enthielt einen inzwischen
behobenen Gleitkommafehler allein in einer neuen Testbehauptung; der Vergleich
erfolgt nun wie die Berechnung mit exakten Centbeträgen.

## Ergänzung: Ausarbeitung HD vom 11.09.2026

Der Benutzer hat „Ausarbeitung HD“ ebenfalls als normale Verkäufe bestätigt.
Die effektive Regel `cash-confirmed-20260911`, Version 4, ergänzt deshalb die
positiven Positionen des Artikels `0000000000011` in WGR `60203`, mit der
bestätigten Sonderartikel-Kombination und Steuerkennzeichen `20`. Preise und
Rohertrag werden unverändert aus den Kassenpositionen berechnet. Andere Artikel,
unbestätigte negative Sonderpositionen und abweichende Status-/Steuercodes
werden nicht durch diese Bestätigung freigegeben.

Ein neuer Evidenz- und Regelfingerabdruck hält die Berichts-/Cache-Bindung
eindeutig; die versiegelte Originalfreigabe bleibt unverändert. Die Bestätigung
der Positionsbedeutung ändert ausdrücklich keine Belegkopfregel.

Der lesende Abgleich bestätigt alle sechs HD-Positionen des besprochenen
Belegs als Verkäufe, einschließlich vorhandener Kassen-Roherträge. Zusammen
mit seiner Warenposition sind alle sieben Positionen fachlich eingeordnet.
Der vollständige Beleg bleibt aber wegen des noch unbestätigten Kopf-Betrags
offen. Seine Positionssumme und der gespeicherte Kopf passen rechnerisch zu
Brutto und Netto bei 20 Prozent; eine neue Ausnahme wurde daraus noch nicht
automatisch abgeleitet. Es werden deshalb weiterhin keine vollständigen
Umsatz-/Rohertragssummen dieses Belegs zur Aggregation freigegeben.

Die Zahl offener Belege bleibt somit bei 19 mit 26 Positionen der bisherigen
Filial-/MA-Auswahl. Der Prüfgrund zur Bedeutung der HD-Positionen ist gelöst;
am betroffenen Beleg bleibt ausschließlich die Betragsabweichung. Alle anderen
zuvor geklärten und offenen Fälle behalten ihren Zustand. Originalauftrag,
Quellfreigabe und Inventar blieben unverändert; zehn Bereitschaftsprüfungen
waren erfolgreich.

52 gezielte Kassenregel- und Integrationstests bestanden. Darunter sind die
sechs HD-Positionen mit korrekter Bruttosumme, positionsweise gerundetem Netto
und Kassen-Rohertrag, die weiter wirksame Belegkopfprüfung sowie ein erweiterter
Import-/Beleg-/Berichts-/PDF-Test mit einer korrekt abgeglichenen HD-Position.
Protokolle: `tmp/cash-hd-tests.log`, `tmp/cash-hd-probe.log`. Keine PDF-Layout-
oder Persistenzstrukturänderung; keine erneute breite Prüfung unveränderter
History- oder Persistenzschichten notwendig.

## Ergänzung: bestätigter UID-Belegkopf vom 11.09.2026

Der Benutzer hat den Kopf des zuvor besprochenen HD-Belegs ausdrücklich als
Nettobetrag bestätigt. Es handelt sich um einen UID-Kauf, den die Buchhaltung
nachträglich der Filiale zugeordnet hat; die Positionen sind brutto gespeichert.
Diese Erklärung ergänzt die bereits bestätigte Bedeutung der HD-Verkäufe.

Die effektive Regel `cash-confirmed-20260911`, Version 5, vergleicht deshalb
auch bei diesem exakt bekannten Quellbeleg den Kopf mit der Nettosumme. Die
Zuordnung ist an den vollständigen Quellenfingerabdruck von Kopf und allen
Positionen gebunden. Andere oder geänderte Belege erben sie nicht. Preise,
Mengen, Quell-Steuerkennzeichen, Roherträge und historische Filialzuordnung
werden nicht umgeschrieben. Die UID-Erklärung führt zu keiner allgemeinen
Steuerregel oder automatischen Einstufung weiterer Verkäufe.

Alle sieben Positionen und der Kopf bestehen nun den vollständigen Abgleich.
Die offene Beleganzahl sinkt in der ursprünglichen Filial-/MA-Auswahl von 19
auf 18; die offenen Positionen von 26 auf 19. 53 der ursprünglich 71 Belege
sind damit geklärt. Alle übrigen Fallzustände bleiben unverändert, ebenso die
versiegelte Quellfreigabe, der gespeicherte Auftrag und das Quelleninventar.

Die 52 gezielten Regel-/Integrationsprüfungen bestehen einschließlich expliziter
Netto-Kopfbestätigung, vollständiger Quellbindung, unveränderter Brutto-
Positionen und Kassen-Roherträge sowie Ablehnung einer geänderten oder
unvollständigen Quelle. Der tatsächliche Beleg wurde vor der Regelergänzung
mit vollständigem Fingerabdruck und danach nochmals mit der neuen Regel
lesend geprüft; alle begleitenden Bereitschaftsprüfungen waren erfolgreich.
Protokolle: `tmp/cash-uid-head-source-probe.log`, `tmp/cash-uid-head-tests.log`,
`tmp/cash-uid-head-verify-probe.log`. Der aktuelle private Klärungsstand steht
unter `output/Kassenklaerung-aktueller-Stand.md`.

## Ergänzung: bestätigte Gutscheinausgabe vom 11.09.2026

Der Benutzer bestätigt: Bei der Gutscheinausgabe entstehen kein Umsatz,
Warenumsatz oder Rohertrag. Diese Werte entstehen beim späteren Warenkauf;
die bereits bestätigte Gutscheineinlösung dient als Zahlungsmittel.

Die effektive Regel `cash-confirmed-20260911`, Version 6, kennzeichnet die
bestätigten positiven Positionen der Warengruppe 170101 mit Steuerkennzeichen 0
und der geprüften Statuskombination als `voucher_issue`. Ihre Umsatz-, Steuer-
und Rohertragswerte für die Verkaufsanalyse sind null Euro. Sie erhöhen keine
Warenmenge, Warenbeleg- oder Kundenzahl und machen einen fehlenden Quell-Rohertrag
nicht zu einem fehlenden Waren-Rohertrag. Die Belegansicht behält den tatsächlichen
Gutscheinwert aus Menge mal Einzelpreis und erklärt „Gutscheinausgabe · kein
Warenumsatz“. Die PDF-Auswertung erläutert Ausgabe, Einlösung und Warenkauf.

Nur die Kombination aus dieser Warengruppe und diesem Steuerkennzeichen wird
aus der bisherigen allgemeinen Verkaufsregel ausgenommen. Alle Merkmale der
Ausnahme müssen gemeinsam passen. Regeln werden weiterhin auf Eindeutigkeit
geprüft; eine überlappende Regel führt zu einem Prüfgrund. Ungültige oder
unbegrenzte Ausnahmelisten werden abgewiesen. Andere Steuerkennzeichen,
Anzahlungen, ungeklärte Statuskombinationen, negative Gutschein-Ausgabemengen
und negative Einzelpreise werden damit nicht pauschal bestätigt. Vollständige
Quellabdeckung und Belegkopfabgleich bleiben erforderlich. Die versiegelte
ursprüngliche Regeldefinition bleibt unverändert.

Alle fünf bisher offenen Gutscheinausgabebelege bestehen die erneute lesende
Prüfung. In der bisherigen Filial-/MA-Auswahl sind damit 58 von 71 Belegen
mit 95 Positionen geklärt. Offen bleiben 13 Belege mit 14 Positionen: vier im
aktuellen Zeitraum, zehn im Vorjahr. Alle anderen bisher bestätigten und offenen
Fälle behalten ihren Zustand. Originalauftrag, Quellfreigabe und Inventar sind
unverändert; die produktive Berichtspause bleibt aktiv.

82 unterschiedliche gezielte Tests bestehen einschließlich Ausgabe ohne Umsatz,
fehlendem oder abweichendem Quell-Rohertrag, späterem Warenkauf mit Einlösung,
gemischtem Beleg, Regelgrenzen, unveränderter Quellbindung, verschlüsselten
Berichts-PDFs, Worker und Rechtegrenzen. PDF-Textgrenzen und die betroffenen
Beleg-/Berichtsseiten wurden geprüft. Persistenzaudit: keine unklassifizierten
Dateien oder Phasengrenzverletzungen. Protokolle:
`tmp/cash-voucher-issuance-tests.log`, `tmp/cash-voucher-issuance-final-tests.log`,
`tmp/cash-voucher-issuance-history-tests.log`, `tmp/cash-voucher-issuance-audit.log`
und `tmp/cash-voucher-issuance-probe.log`.

## Ergänzung: UID-Zwischenbuchungen, Rücknahmen und weiterer Nettokopf

Der Benutzer hat am 11.09.2026 die Fälle F, G und H erklärt und die Gebrauchtware
(E) ausdrücklich auf eine spätere Prüfung verschoben.

„HANDELSWARE 0% MWST“ wird bei Kartenzahlungen für UID-Käufe zunächst erfasst.
Bei ausreichendem Bargeldbestand folgt die Gegenbuchung und die Weitergabe
des Geldes an die Buchhaltung, die den UID-Verkauf abschließt. Die Auswertung
führt beide Richtungen als Zahlungszwischenbuchung ohne Warenumsatz, Rohertrag,
Warenmenge oder zusätzlichen Warenbeleg/Kunden. Betrag und Vorzeichen bleiben
im Quellbeleg sichtbar, mit „UID-Zwischenbuchung · kein Warenumsatz“. Eine
spätere Warenbuchung erzeugt die eigentlichen Verkaufskennzahlen.

Die effektive Regel `cash-confirmed-20260911`, Version 7, begrenzt diese Bedeutung
auf den bestätigten Artikel 58204 in WGR 170102, Steuerkennzeichen 0 und die
geprüfte Statuskombination. Die betroffenen positiven und negativen Positionen
werden ausdrücklich aus den bisherigen allgemeinen Verkaufs-/Rücknahmeregeln
ausgenommen. Andere Artikel oder Steuercodes übernehmen diese Bedeutung nicht.

Negative Mengen der bestätigten Warenpositionen sind Rücknahmen; Umsatz und
historischer Kassen-Rohertrag folgen dem Vorzeichen der Menge. Die ergänzte
Regel für die bestätigte AStorno-Kombination überschneidet sich nicht mit
Gutscheineinlösungen. Diese sowie UID-Zwischenbuchungen behalten ihre gesonderte
Bedeutung. Andere ungeklärte Statuskombinationen und Steuercodes bleiben offen.

Der weitere Belegkopf ist ausdrücklich netto, bei unverändert brutto
gespeicherten Positionen. Die neue dritte Kopf-Ausnahme ist an den Fingerabdruck
der vollständigen Quelle gebunden. Ein möglicher UID-Hintergrund wird nicht als
bestätigte steuerliche Einstufung verwendet. Ursprüngliche versiegelte Regeln,
Quellpreise, Quell-Steuerkennzeichen und historische Filialzuordnung bleiben
unverändert. Belegkopfprüfung und vollständige Quellabdeckung bleiben Pflicht.

Die lesende Nachprüfung aller 71 ursprünglich offenen Belege bestätigt zehn
weitere geklärte Belege: sechs UID-Zwischenbuchungen, drei Rücknahmen und den
Nettokopf mit zwei Warenpositionen. Damit sind 68 Belege mit 106 Positionen
geklärt. Nur die drei zurückgestellten Gebrauchtwarenbelege bleiben offen.
Diese Zahlen betreffen weiterhin dieselbe Filial-/MA-Auswahl. Originalauftrag,
Quellfreigabe und Inventar blieben unverändert; alle zehn Bereitschaftsprüfungen
waren erfolgreich und die produktive Berichtspause blieb erhalten.

86 gezielte Tests bestehen: 80 Kassenregel-, Import-/Job-/PDF-, Modell- und
Layouttests sowie sechs generische Regel-/Abdeckungsprüfungen. Getestet sind
insbesondere getrennte Zwischenbuchung, Gegenbuchung, späterer Warenverkauf
und Rücknahme über mehrere Belegtage, korrekte Vorzeichen, keine doppelte
Umsatz-/Rohertragszählung, unbekannte Gebrauchtwarensteuer und eindeutige Regeln.
Die UID-Belegseiten und die ergänzten PDF-Hinweise sind visuell geprüft;
Textgrenzen und der Persistenzaudit bestehen. Protokolle:
`tmp/cash-uid-clearing-tests.log`, `tmp/cash-uid-clearing-history-tests.log`,
`tmp/cash-uid-clearing-probe.log`, `tmp/cash-uid-clearing-audit.log`.

## Ergänzung: Gebrauchtware mit gespeichertem Steuerkennzeichen 0

Die spätere Bestätigung des Benutzers vom 11.09.2026 ersetzt die vorherige
Zurückstellung von Fall E: Für die betreffende Gebrauchtware werden die
gespeicherten 0 % MwSt. übernommen. Der unveränderte Verkaufspreis ist damit
zugleich der Nettobetrag. Es wird keine zusätzliche Steuer oder eine neue
steuerliche Behandlung aus aktuellen Artikelpreisen abgeleitet.

Die effektive Regel `cash-confirmed-20260911`, Version 8, erlaubt einen
Verkaufspreis ungleich null bei Steuerkennzeichen 0 für den bestätigten
Gebrauchtwarenartikel 69877 in WGR 130101. Alle drei Merkmale müssen gemeinsam
zutreffen. Die übrigen Status-, Vorzeichen-, Belegkopf- und Abdeckungsprüfungen
gelten weiterhin. Andere Artikel mit ungeklärtem Steuerkennzeichen 0 werden
dadurch nicht pauschal bestätigt. Die eng gefilterte Ausnahme ist Bestandteil
der geprüften Regeldefinition; leere oder unbeschränkte Ausnahmen werden
abgewiesen. Die ursprüngliche versiegelte Quellregel bleibt unverändert.

Der Rohertrag kommt weiterhin ausschließlich aus dem historischen Kassenfeld
`RohertragDM`: ungerundeter Wert je Stück mal signierter Menge, anschließend
Rundung jeder Position auf Cent. Beispielsweise ergeben zwei Stück mit je
39,485 EUR genau 78,97 EUR; bei minus zwei Stück sind es minus 78,97 EUR.
Der Bericht summiert die gerundeten Positionswerte. Fehlender Rohertrag bleibt
nicht verfügbar, auch wenn ein aktueller EK oder `KalkRohertrag` vorhanden ist.

Die erneute lesende Prüfung bestätigt alle 71 ursprünglich offenen Belege
mit 109 ausgewählten Positionen, einschließlich der letzten drei
Gebrauchtwarenbelege. In dieser konkreten Filial-/MA-Auswahl bleiben keine
offenen Positionen zurück. Daraus folgt keine Freigabe sämtlicher übrigen
Datenbankbelege. Originalauftrag, versiegelte Quellfreigabe und Inventar blieben
unverändert. Alle zehn Bereitschaftsprüfungen waren erfolgreich; die produktive
Berichtspause blieb aktiv.

89 unterschiedliche gezielte Tests bestehen: 83 Kassenregel-, Import-/Job-/PDF-,
Modell- und Layouttests sowie sechs generische Regel-/Abdeckungsprüfungen.
Der neue Integrationstest prüft die drei Gebrauchtwarenbeispiele vom
Quellimport über Belegsuche und Bericht bis zur verschlüsselt gespeicherten
PDF, einschließlich Rohertragsrundung und unveränderter Quellfreigabe.
Zusätzliche Regeltests decken Mehrfachmengen, Rücknahmen, Nullwerte, fehlenden
Rohertrag und die Grenzen der Steuerausnahme ab. Protokolle:
`tmp/cash-used-goods-tests.log`, `tmp/cash-used-goods-final-rules-tests.log`,
`tmp/cash-used-goods-final-integration-tests.log`,
`tmp/cash-used-goods-history-tests.log`, `tmp/cash-used-goods-probe.log`.

## Ergänzung: bestätigte Anzahlungen, Artikel 98 (13.09.2026)

Stand: lokal umgesetzt und geprüft, noch nicht veröffentlicht.

Der Benutzer bestätigt für Artikel 98: Eine positive Menge erfasst eine bereits
bezahlte Anzahlung als Umsatz. Eine negative Menge verrechnet die Anzahlung und
vermindert den Umsatz dieses späteren Belegs. Beide Richtungen erzeugen keinen
Rohertrag. Die historischen Kassen-Roherträge der Warenpositionen bleiben
unverändert. Gutscheine behalten ihre gesonderte Behandlung als Zahlungsmittel.

Die effektive Kassenregel `cash-confirmed-20260911`, Version 9, verwendet dafür
den eigenen Status `deposit`. Sie gilt für die bestätigte Artikelnummer
`0000000000098`, WGR 170102, Steuerkennzeichen 20 und die bestätigten
Statuskombinationen. Andere Verrechnungsartikel und unbekannte Merkmale werden
nicht durch diese Regel freigegeben. Die UID-Zwischenbuchung in derselben
Warengruppe bleibt eigenständig. Der gespeicherte Steuerwert und alle
Quellbeträge werden unverändert verwendet.

Anzahlungen bleiben bei ihrer eigenen Warengruppe und Marke. Ihre signierten
Umsätze und betroffenen Belege zählen zur jeweiligen Auswahl; sie zählen nicht
als verkaufte Warenstücke. Ihr Rohertrag ist auch bei fehlenden oder abweichenden
Quell-Rohertragswerten null. Die Belegansicht und Beleg-PDF kennzeichnen sie mit
„Anzahlung / Verrechnung · ohne Rohertrag“. Berichts-PDFs erklären die Behandlung.

Synthetisches Beispiel über zwei Buchungstage: Eine Anzahlung von 300 EUR bringt
zunächst 300 EUR Bruttoumsatz und keinen Rohertrag. Bei einem späteren Warenkauf
über 600 EUR mit 100 EUR Kassen-Rohertrag führt die Verrechnung von 300 EUR zu
300 EUR Bruttoumsatz und weiterhin 100 EUR Rohertrag. Über beide Tage ergeben
sich 600 EUR Umsatz, 100 EUR Rohertrag und ein verkauftes Warenstück. Eine reine
Herstellerauswahl enthält die jeweils zugeordneten Warenpositionen; die
Anzahlung wird nicht zusätzlich auf deren Hersteller verteilt.

Die begrenzte lesende PostgreSQL-Prüfung vom 13.09.2026, 16:57:51 UTC, hat die
lokalen Kandidatenmodule ausschließlich im Speicher eines eigenen Leseprozesses
verwendet. Ergebnis: alle 40 passenden Positionen der zuvor geprüften
Sony-Januarabfrage sind mit dieser Regel geklärt. Der bisher betroffene Beleg
stimmt vollständig mit dem gespeicherten Kopf überein; seine Waren-Roherträge
bleiben erhalten. Der versiegelte Quellstand und der vorhandene Berichtsauftrag
wurden anschließend auf Unverändertheit geprüft. Keine Produktivdatei,
Datenbankzeile oder gespeicherte PDF wurde geändert.

Prüfung: 28 Regel-/Modelltests bestanden. Von 59 Integrations-, Beleglayout- und
Berichts-PDF-Tests bestanden zunächst 58; der neue Test verwendete zunächst
einen falschen Testaufruf für Belegdokumente. Nach Korrektur auf die bestehende
Beleg-API bestand dieser gezielte Test einschließlich verschlüsselter PDF und
beider Buchungstage. Damit sind alle 87 unterschiedlichen Tests erfolgreich
abgedeckt; es gab keinen zusätzlichen vollständigen Wiederholungslauf.
Beide synthetischen Belegseiten und alle sieben Berichtsseiten wurden gerendert
und visuell geprüft. Der Persistenzaudit meldet keine Phasengrenzverletzungen.
Die Kandidatenprüfung ist unter `tmp/build-cash-deposit-proof.py` nachvollziehbar;
die PDF-Prüfmuster liegen in `tmp/pdfs/cash-deposit-20260913/`.

## Weiterer Stand

Nicht bestätigte weitere Statuskombinationen, Steuercodes und Belegabweichungen
werden weiterhin als Prüfgründe ausgewiesen. Die Regeln für Hersteller-Sofortrabatt
und Gutscheineinlösung, die bestätigte Anzahlung für Artikel 98 sowie die
gesonderte UID-Zwischenbuchung werden nicht pauschal auf weitere
Verrechnungsartikel übertragen.

Eine Benutzerfunktion zum fachlichen Klären oder Freigeben einzelner Belege
gibt es derzeit nicht. „Kassenberichte & Belegsuche“ zeigt über „Öffnen“ die
Belegpositionen und ihren Prüfstatus. Die Klärung erfordert den Abgleich der
auffälligen Quellpositionen mit ihrer Bedeutung in TradeFoto und anschließend
eine belegte Ergänzung der Auswertungsregeln. „Prüfung offen“ bedeutet für sich
noch nicht, dass der Originalbeleg falsch gebucht wurde.

Gespeicherte PDFs bleiben unveränderte Ergebnisse ihres Erstellungszeitpunkts.
Für die veröffentlichten Regeln muss eine entsprechende neue Abfrage gestartet
werden. Die gemeinsame Bereitstellung mit dem Hotfix, den
[Berichtsfiltern und der Browsernavigation](VERKAUFSANALYSEN-AUSWAHL-UND-NAVIGATION-2026-09-10.md)
erfolgte am 11.09.2026 mit v0.92.36-beta. Nach den erfolgreichen installierten
Worker-/PDF-Prüfungen wurde die produktive Berichtspause aufgehoben.
