# Monatsübergabe und externer ELDA-Nachweis in v0.83

Stand der fachlichen Quellenprüfung: 24. Juli 2026

## Zweck und klare Systemgrenze

Grabenplaner v0.83 erstellt aus finalisierten persönlichen Monats-Ist-Nachweisen eine minimierte, unveränderliche Übergaberevision für die externe Lohnverrechnung. Die Funktion unterstützt die nachvollziehbare Datenübergabe; sie ist weder Entgeltabrechnung noch Sozialversicherungsberechnung und keine direkte ELDA-Schnittstelle.

Die Monatsübergabe enthält ausschließlich:

- Personalnummer
- ID, Revision und SHA-256-Beleg des finalisierten Monatsnachweises
- tatsächliche Arbeitsminuten
- tatsächliche Pausenminuten

Planzeiten, Namen, Entgelt- und Beitragsgrundlagen, Bankdaten, Sozialversicherungsnummern, Adressen, Telefonnummern, AUM- und Personalakt-Inhalte sind nicht Bestandteil des Schemas `grabenplaner.payroll-period.v2`.

## Voraussetzungen

Eine Übergaberevision kann nur erzeugt werden, wenn für jedes betroffene aktive Teammitglied ein finalisierter Monats-Ist-Nachweis vorhanden ist. Diese Nachweise entstehen ausschließlich aus tatsächlichen Zeiterfassungsereignissen und nachvollziehbaren Korrekturen. Dienstpläne bleiben Planzeit.

Eine Abteilungsauswahl grenzt nur die betroffenen Teammitglieder ein. Der Monatswert eines Teammitglieds bleibt ein persönlicher Monats-Ist-Nachweis und wird nicht rechnerisch auf Abteilungen zerlegt.

## Nachweisfolge

1. **Vorprüfung:** Vollständigkeit und Finalisierung aller betroffenen Monatsnachweise werden geprüft.
2. **Übergaberevision:** Grabenplaner erstellt einen verschlüsselten, unveränderlichen Datensatz samt SHA-256-Beleg.
3. **Datei-Export:** Die versionierte JSON-Datei wird ausgegeben. Der Status lautet weiterhin „extern zu übermitteln“.
4. **Externe Weitergabe:** Eine berechtigte Person dokumentiert, dass die Datei an die zuständige externe Stelle übergeben wurde. Der Status lautet „Protokoll ausständig“.
5. **Externes Protokoll:** Protokollnummer und Ergebnis werden einer konkreten Revision zugeordnet.

Ohne zugeordnetes externes Protokoll gilt die Übergabe im Grabenplaner nicht als abgeschlossen. Ein nachträglich geänderter Monatsnachweis erzeugt eine neue Übergaberevision; ältere Revisionen und ihre Ereignisse bleiben nachvollziehbar erhalten.

## Protokollergebnisse

- **Übernommen:** Das externe Protokoll enthält keinen Status W oder N.
- **Mit Warnung weitergeleitet:** Status W wird als weitergeleitet, aber weiterhin prüfbedürftig dokumentiert.
- **Korrektur erforderlich:** Status N wird als nicht weitergeleitet dokumentiert. Nach fachlicher Korrektur ist eine neue Übermittlung erforderlich.

Grabenplaner speichert den angegebenen externen Status. Die Anwendung interpretiert keine fachlichen ELDA-Fehlertexte und bestätigt nicht selbst, dass eine mBGM rechtlich ordnungsgemäß erstattet wurde.

## Sicherheit und Wiederherstellbarkeit

Übergaben und Ereignisse werden kontextgebunden mit AES-256-GCM verschlüsselt. Die Datenbank verhindert Änderungen und Löschungen dieser Datensätze über Immutable-Trigger. Beim Linux-Recovery-Test werden die verschlüsselten Inhalte im wiederhergestellten Sicherungsstand mit dem jeweiligen Anwendungskontext entschlüsselt und geprüft. Der isolierte App-Smoke entfernt die geschützten Übergabedaten vor dem Teststart.

Die Rechte bleiben getrennt:

- `Lohnverrechnungsdaten exportieren`: Vorprüfung, Revision und Datei-Export
- `Lohnverrechnungsdaten sicher übertragen`: externe Weitergabe und Protokoll dokumentieren
- `Direkte Verbindungen lesen`: öffentlichen Vertrags- und Übergabestatus lesen

## Amtliche Quellen und Gültigkeitsstatus

Die nachstehenden Quellen wurden am 24. Juli 2026 geprüft. Änderungen der Meldeverfahren oder kundenspezifische Besonderheiten müssen vor einem produktiven Einsatz durch Personalverrechnung, Sozialversicherungsexpertise oder die zuständige IT erneut geprüft werden.

- [Unternehmensserviceportal: Monatliche Beitragsgrundlagenmeldung](https://www.usp.gv.at/themen/mitarbeiter-und-gesundheit/entgelt/monatliche-beitragsgrundlagenmeldung.html) – beschreibt die monatliche mBGM und die elektronische Übermittlung über ELDA.
- [ELDA FAQ](https://www.elda.at/cdscontent/?contentid=10007.838884) – erläutert Übermittlungsprotokoll, Status W und Status N sowie die Prüfung über das Übermittlungsjournal.
- [ELDA Online-Handbuch](https://www.elda.at/cdscontent/load?contentid=10008.788939&version=1719395644) – beschreibt Protokollnummer und Protokoll nach einer Übermittlung.
- [Österreichische Gesundheitskasse: Clearingfälle](https://www.oegk.at/cdscontent/?contentid=10007.905524&portal=oegkdgportal) – beschreibt formale Prüfungen, Rückmeldungen und erforderliche Korrekturen.

Diese technische Dokumentation ist keine Rechtsberatung und keine pauschale Zusage vollständiger Rechtskonformität.
