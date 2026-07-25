# Personal-Regelwerk – Regelbaukasten v0.1

| Merkmal | Stand |
|---|---|
| Roadmap | Block 5 von 7 |
| Datum | 26. Juli 2026 |
| Status | lokale Arbeitsfassung, noch keine fachliche oder rechtliche Freigabe |
| Produktwirkung | ausschließlich nicht wirksame Entwurfsfassungen |
| VPS | bis zum Abschluss aller sieben Blöcke unverändert |

## Zweck

Der Regelbaukasten unter `Personalverwaltung > Regelwerk` ermöglicht der Personalleitung, eigene fachliche Personalregeln strukturiert vorzubereiten. Er verwendet fest definierte Bausteine und führt keinen frei eingegebenen Programmcode aus.

Unterstützte fachliche Arten:

- Betriebsvereinbarung,
- Unternehmensregel,
- Standort- oder Abteilungsregel.

Jeder Entwurf dokumentiert mindestens:

- stabiles Regelkürzel und Bezeichnung,
- Themenbereich,
- fachliche Beschreibung,
- organisatorischen Geltungsbereich,
- Gültigkeitszeitraum,
- fest definierten Regelbaustein und Grenzwert,
- Schweregrad und vorgesehene Reaktion,
- verständlichen Hinweistext,
- verantwortliche Stelle,
- Quelle und genaue Fundstelle,
- positiven, negativen und unklaren Testfall.

## Geführte Regelbausteine

Block 5 unterstützt zunächst:

- maximale geplante Arbeitszeit pro Tag,
- maximale geplante Arbeitszeit pro Woche,
- Mindestruhezeit zwischen zwei Diensten,
- maximale aufeinanderfolgende Arbeitstage,
- maximale Samstagsdienste pro Kalendermonat,
- frühesten geplanten Dienstbeginn,
- spätestes geplantes Dienstende,
- Mindestvorlauf für Urlaubsanträge,
- Mindestvorlauf für Zeitausgleichsanträge,
- maximale Urlaubstage je Antrag.

Weitere Regelbausteine benötigen eine eigene fachliche Definition und technische Implementierung. Freitext wird nicht als ausführbare Bedingung interpretiert.

## Versionierung und Testfälle

Jede Speicherung erzeugt eine neue unveränderliche Entwurfsfassung:

`draft-1 → draft-2 → draft-3`

Frühere Fassungen werden weder überschrieben noch gelöscht. Inhalt und Quellenstand erhalten eine SHA-256-Prüfsumme.

Vor dem Speichern prüft der Server drei Fälle gegen denselben Grenzwert:

1. ein eingehaltenes Beispiel muss `pass` ergeben,
2. ein verletztes Beispiel muss `fail` ergeben,
3. ein fehlender Prüfwert muss `unknown` ergeben.

Ein widersprüchlicher Testsatz wird abgelehnt.

## Rechte

Block 5 ergänzt das getrennte Recht `work_rules:draft`.

- Personalleitung und fachlich berechtigte Administration dürfen Entwürfe anlegen und fortschreiben.
- Filial- und Abteilungsleitungen behalten ihre bereichsbezogene Lesesicht im Dashboard, erhalten aber kein Entwurfsrecht.
- Ein reines IT-Administrationsrecht oder das bisherige technische Profilverwaltungsrecht genügt nicht zum Erstellen eigener fachlicher Regeln.

## Verbindliche Grenze zu Block 6

Der Regelbaukasten bietet in Block 5 ausdrücklich keine:

- Einreichung zur Prüfung,
- fachliche Freigabe,
- Vier-Augen-Bestätigung,
- Veröffentlichung,
- Geltungszuordnung,
- Aktivierung oder Deaktivierung,
- Übernahme in die Dienstplanprüfung.

Auch eine im Entwurf vorgesehene Reaktion „Speichern blockieren“ bleibt technisch wirkungslos. Die Server-API erzwingt den Status `draft`, `assignable = false` und Monitorbetrieb. Eine Zuordnung über den bestehenden Profilweg wird abgelehnt.

Diese Funktionen sowie Konfliktprüfung, Rücknahme und kontrollierte Wiederherstellung folgen in Block 6. Grabenplaner unterstützt die organisatorische und technische Prüfung; die Anwendung ersetzt keine rechtliche oder kollektivvertragliche Einzelfallbeurteilung.
