# Urlaub, Arbeitszeit und Datenschutz in v0.82

Stand der fachlichen Quellenprüfung: 23. Juli 2026

## Zweck und Grenze

Grabenplaner v0.82 stellt technische Governance-Bausteine für Urlaub, tatsächliche Arbeitszeit, Aufbewahrung und Betroffenenrechte bereit. Die Bausteine speichern versionierte Quellenstände, Eingaben, Bewertungen und SHA-256-Belege nachvollziehbar.

Sie sind keine Rechtsberatung und keine pauschale Zusage vollständiger Rechtskonformität. Anwendbarer Kollektivvertrag, Betriebsvereinbarungen, Sondergesetze, konkrete Arbeitsverhältnisse sowie die Rollen von Verantwortlichem und Auftragsverarbeiter müssen durch die zuständige Organisation geprüft werden.

## Urlaub

- Ansprüche werden je Urlaubsjahr als getrennte Komponenten für den unionsrechtlichen Mindesturlaub und den nationalen Mehrurlaub geführt.
- Eine Verbrauchsvorschau verwendet die älteste noch valide Tranche zuerst, verändert den gespeicherten Anspruch aber nicht selbst.
- Die Vorschau des ersten Beschäftigungsjahres rechnet bis zum Ablauf der ersten sechs Monate konservativ aliquot und bleibt ausdrücklich manuell zu bestätigen.
- Karenzzeiten können als Verlängerung eines möglichen Verjährungszeitpunkts dokumentiert werden.
- Ein Zeitablauf erzeugt nur einen **Verjährungskandidaten**. Ohne dokumentierte tatsächliche Ermöglichung, erforderliche Aufforderung und klare rechtzeitige Warnung bleibt der Fall `manual_review`.
- Auch bei vollständiger Evidenz erfolgt keine automatische Reduktion oder Löschung. Die abschließende Entscheidung bleibt einer berechtigten, fachlich verantwortlichen Stelle vorbehalten.
- Urlaubsantrag, Vereinbarung, Verbrauch, Korrektur und Nachweis werden append-only und revisionsfähig abgebildet.

Maßgebliche offizielle Quellen:

- [Urlaubsgesetz § 2 – Urlaubsausmaß und Urlaubsjahr](https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008376&Paragraf=2)
- [Urlaubsgesetz § 4 – Vereinbarung und Verjährung](https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008376&Paragraf=4)
- [Urlaubsgesetz § 8 – Urlaubsaufzeichnungen](https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008376&Paragraf=8)
- [OGH 8 ObA 23/23z – Ermöglichung, Aufforderung und Warnung](https://ris.bka.gv.at/Dokumente/Justiz/JJT_20230627_OGH0002_008OBA00023_23Z0000_000/JJT_20230627_OGH0002_008OBA00023_23Z0000_000.html)
- [OGH 8 ObS 1/25t – Trennung von unionsrechtlichem Mindesturlaub und nationalem Mehrurlaub](https://www.ris.bka.gv.at/Dokumente/Justiz/JJT_20250930_OGH0002_008OBS00001_25T0000_000/JJT_20250930_OGH0002_008OBS00001_25T0000_000.html)

## Tatsächliche Arbeitszeit und Monatsnachweis

Dienstplanung und Arbeitszeitaufzeichnung sind getrennte Datenbereiche:

| Planzeit | Ist-Zeit |
|---|---|
| Vorgesehener Dienst | Tatsächliche Buchung |
| Planungshilfe und Besetzungsgrundlage | Arbeitszeitnachweis |
| Kann vor Dienstbeginn geändert werden | Bleibt mit Korrekturhistorie nachvollziehbar |
| Wird nicht als geleistete Zeit ausgegeben | Grundlage des Monatsnachweises |

Der Monatsnachweis wird ausschließlich aus wirksamen Ist-Ereignissen gebildet:

- Kommen und Gehen,
- Beginn und Ende jeder Pause,
- tatsächliche Dauer,
- revisionsfähige, begründete Korrekturen,
- Prüf- und Unvollständigkeitsstatus.

Eine Korrektur überschreibt das ursprüngliche Ereignis nicht, sondern supersediert es in einer Hashkette. Ein Nachweis kann nur finalisiert werden, wenn die Ereignisfolge vollständig und die Prüfung freigegeben ist. Ein Dienstplan wird niemals stillschweigend in Ist-Zeit umgewandelt.

Maßgebliche offizielle Quellen:

- [Arbeitszeitgesetz § 26 – Aufzeichnungen und monatliche Kopie](https://ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10008238&Paragraf=26)
- [Arbeitsinspektion – Aushang und Aufzeichnung der Arbeitszeit](https://www.arbeitsinspektion.gv.at/Arbeitszeit-_Arbeitsruhe/Arbeitszeit_/Aushang_und_Aufzeichnung_der_Arbeitszeit.html)
- [Unternehmensserviceportal – Arbeitszeitaufzeichnungen und Mindestaufbewahrung](https://www.usp.gv.at/themen/mitarbeiter-und-gesundheit/urlaub-und-arbeitszeit/weitere-informationen-zu-urlaub-und-arbeitszeit/arbeitszeitaufzeichnungen.html)

Der kostenlose Monatsnachweis ist nach § 26 AZG bei nachweislichem Verlangen zu übermitteln. Grabenplaner kann zusätzlich einen freiwilligen, proaktiven Abruf anbieten. Anfrage, Zeitraum, Fassung und Bereitstellung sollten nachvollziehbar bleiben.

## Aufbewahrung und Löschung

Es gibt keine einheitliche Frist für sämtliche Personal-, Urlaubs-, Arbeitszeit-, Lohn- und Gesundheitsdaten. Regeln müssen mindestens nach Datenkategorie, Zweck, Rechtsgrundlage, Fristbeginn und möglichem Legal Hold unterschieden werden.

Grabenplaner:

- berechnet ausschließlich prüfbare Aufbewahrungskandidaten,
- führt keine Löschung, Anonymisierung oder Archivierung automatisch aus,
- sperrt Kandidaten bei aktivem Legal Hold,
- verlangt eine dokumentierte Freigabe,
- hält Ergebnis und Entscheidungsgrundlage nachvollziehbar fest.

Die arbeitszeitrechtliche Mindestaufbewahrung, längere steuer- oder unternehmensrechtliche Nachweise und offene Verfahren sind getrennt zu beurteilen. „Alles sieben Jahre“ und „alles unbegrenzt“ sind keine zulässigen pauschalen Produktregeln.

## Datenschutz und Betroffenenrechte

Das Fallmodell unterstützt:

- Auskunft und Datenkopie,
- Berichtigung und Vervollständigung,
- fallbezogene Löschprüfung,
- Einschränkung der Verarbeitung,
- Fristen und begründete Verlängerungen,
- angemessene Identitätsprüfung,
- dokumentierten Abschluss.

Eine Berichtigung kann bei revisionspflichtigen Nachweisen durch ein korrigierendes Ereignis erfolgen. Alte Werte dürfen nur mit tragfähigem Zweck und Rechtsgrund weiter gespeichert und müssen gegebenenfalls eingeschränkt werden. Eine Löschanfrage löst deshalb eine kategorienbezogene Prüfung aus und keinen globalen Löschbefehl.

Maßgebliche offizielle Quellen:

- [Datenschutz-Grundverordnung – konsolidierter Text](https://eur-lex.europa.eu/legal-content/DE/TXT/?uri=CELEX%3A32016R0679), insbesondere Art. 5, 12, 15 bis 19, 30 und 32
- [Österreichische Datenschutzbehörde – Rechte betroffener Personen](https://dsb.gv.at/rechte-pflichten/ihre-rechte-als-betroffene-person)

Gesundheitsdaten, AUM-Dokumente, Bank- und Sozialversicherungsdaten benötigen weiterhin besonders enge Rechte, Verschlüsselung, Datenminimierung und protokollierte Zugriffe. Die konkrete Zulässigkeit der Verarbeitung ist von der verantwortlichen Organisation festzulegen.

## Technische Nachweise

Die v0.82-Module sind reine CommonJS-Fachmodule ohne Datenbank- oder Netzwerkzugriff. Sie liefern deterministische SHA-256-Belege und unveränderliche Revisionen. Bei der Integration gilt:

1. Snapshots und Hashketten unverändert persistieren.
2. Vor jeder Mutation den vorhandenen Beleg prüfen.
3. Planzeit niemals als Ist-Zeit importieren.
4. Verjährung und Löschung niemals automatisch vollziehen.
5. Manuelle Entscheidungen mit Rolle, Zeitpunkt, Begründung und wirksamer Quellenfassung speichern.
