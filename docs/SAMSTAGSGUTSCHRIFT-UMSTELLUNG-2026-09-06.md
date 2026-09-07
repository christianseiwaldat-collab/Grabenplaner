# Samstagsgutschrift: vorbereitete Umstellung

Stand: 06.09.2026. Lokal integriert und gezielt geprüft, noch nicht veröffentlicht oder produktiv aktiviert.

## Bestätigte Vorgabe

Samstags erhalten Mitarbeitende im Verkauf ab 13:00 Uhr zusätzlich **50 Prozent der tatsächlich gearbeiteten Zeit** als Zeitgutschrift. Pausen sind ausgeschlossen. Die Firmenregel gilt auch nach 18 Uhr bis zum Ende des Samstags. Eine Stunde Arbeit ab 13 Uhr ergibt 90 bewertete Minuten. Das ist die bestätigte betriebliche Vorgabe.

Der Nutzer hat den nächsten Deploy als nahtlosen Übergang bestätigt. Alle dann bereits angelegten Mitarbeitenden sind ausdrücklich dem Verkauf zuzuordnen, einschließlich der Lehrlinge im Foto- und Multimediafachverkauf. Diese Initialzuordnung leitet sich aus der ausdrücklichen Freigabe ab, nicht aus einem Dienstbadge oder einer Positionsbezeichnung. Später neu angelegte Personen erhalten eine eigene bestätigte Zuordnung.

## Umsetzung

- Plan- und Ist-Bewertung, Tagesprüfung, daraus abgeleitete Zeitkonten und Lohnexport verwenden dieselbe Regel. Importierte Xoffi-Intervalle werden ab dem Stichtag ebenfalls danach bewertet; die Originalwerte des Imports bleiben unverändert gespeichert.
- Ein einmaliger Umstellungsbeleg hält den Wiener Kalendertag, den bisherigen Samstagsregelstand und die Zahl der initialen Zuordnungen fest. Initialzuordnung und Stichtag werden in einer Transaktion geschrieben. Ein Fehler nimmt beides zurück. Wiederholte Starts verändern den Stichtag nicht und ordnen neue Personen nicht automatisch zu.
- Vor dem Stichtag bleibt die bisherige Bewertung erhalten. Bestehende Monatsbelege, Rohimporte und Salden werden nicht rückwirkend überschrieben.
- Zuordnungen sind mit Gültigkeitsdatum, Begründung, Bearbeiter und Prüfsumme historisiert. Änderung und Löschung vorhandener Belege sind gesperrt; eine Tätigkeitsänderung erzeugt einen neuen Beleg.
- Die Mitarbeiteransicht bietet Verkauf/andere Tätigkeit, Datum und Begründung sowie die Zuordnungshistorie. Änderungen verlangen die geschützte Personal-/Regelberechtigung und werden einschließlich Bereichsprüfung innerhalb der Transaktion erneut autorisiert. Reine Darstellungsrechte und normale Mitarbeiterzugänge können keine Zuordnung ändern.
- Geteilte Dienste und verschiedene Dienstorte runden den Zuschlag einmal über den gesamten Personentag. Die einzelnen Bereichsansichten erhalten nur ihren Anteil. Unvollständige Buchungen, ungeklärte Pausenlage, widersprüchliche Intervalle oder ungeklärte Feiertagskonkurrenz erzeugen einen Prüfhinweis und verhindern eine fertige Abrechnung.
- Eine nachträgliche Zuordnungsänderung macht eine betroffene Tagesprüfung veraltet. Der Lohnexport verlangt eine neue Prüfung. Eine Prüfsumme ist ein Integritätsbeleg, keine digitale Signatur.

## Nachweis

Der Fall 10–17 Uhr mit Pause 12:30–13:00 ergibt 390 Arbeitsminuten, 240 zuschlagsfähige Minuten, 120 Minuten Gutschrift und 510 bewertete Minuten. API-, Xoffi-, Tagesprüfungs- und CSV-Exporttests prüfen diese Zahlen. Zwei einzelne zuschlagsfähige Minuten in zwei Filialen ergeben zusammen eine Gutschrift von einer Minute.

Weitere Tests betreffen Rückdatierung vor den Stichtag, atomaren Rollback, Wiederholung, konkurrierende Zuordnung, Berechtigungen, CSRF, Bereichsgrenzen, Feiertage, mehrere Pausen sowie überholte Antworten im Mitarbeiterdialog. Berichte: `tmp/saturday-final-20260906.tap` (31/31) und `tmp/saturday-export-audit-verified-20260906.tap` (16/16 einschließlich CSV-Export und aktualisierter Katalog-/Architekturprüfung). Die 74-Tests-Regression mit Zeitbewertung, Xoffi und Lohnexport steht in `tmp/saturday-legacy-inventory-20260906.tap`.

## Beim nächsten ausdrücklich freigegebenen Deploy

1. Reguläre Releaseprüfungen und gekoppelte Sicherung abschließen. Es ist kein Deploy Bestandteil dieses Arbeitsschritts.
2. In der bestehenden Anwendungsumgebung dieses Betriebs `GRABENPLANER_SATURDAY_CREDIT_ROLLOUT=existing-sales` setzen. Das ist eine gezielte betriebliche Rolloutoption; andere Installationen werden dadurch nicht automatisch vollständig dem Verkauf zugeordnet.
3. Der normale Start führt nach Datenbankmigration und Initialisierung, vor Öffnung des HTTP-Listeners, den einmaligen Rollout aus. Der Stichtag wird aus dem tatsächlichen Wiener Startdatum ermittelt; ein heutiges Datum wird nicht vorweggenommen.
4. Anzahl der initialen Verkaufszuordnungen gegen den vorhandenen Personalbestand prüfen und die 50-Prozent-Bewertung in Tagesprüfung und Lohnexport bestätigen. Die Option darf anschließend bestehen bleiben, weil der Vorgang idempotent ist.

Es ist keine weitere fachliche Rückfrage offen. Produktive Zuordnungen entstehen erst mit dem freigegebenen Deploy.
