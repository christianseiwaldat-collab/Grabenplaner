# Mitarbeiter-Kostenstellenzuordnung v0.1

Status: lokale Implementierung für Block 2/8, noch nicht veröffentlicht

## Ziel

Die Kostenstelle ist die führende organisatorische Zuordnung eines
Mitarbeitenden. Standort, mögliche Positionen und eine gegebenenfalls verfügbare
Abteilung werden daraus abgeleitet und können nicht mehr unabhängig voneinander
gesetzt werden.

## Verbindliches Zuordnungsmodell

1. Zuerst wird eine aktive Kostenstelle gewählt.
2. Der Kostenstellentyp bestimmt die zulässigen Positionen.
3. Nur bei einem Filialtyp wird der genau zugeordnete Standort automatisch
   übernommen.
4. Nur für diesen abgeleiteten Standort kann eine bevorzugte Abteilung gewählt
   werden.
5. Nicht-Filialkostenstellen, beispielsweise Verwaltung oder Produktion, besitzen
   keinen solchen Standort und keine bevorzugte Filialabteilung.

Zusätzliche Einsatzorte in der Dienstplanung bleiben davon unabhängig. Ein
Mitarbeitender kann weiterhin an einem anderen Standort geplant werden, ohne dass
dadurch seine organisatorische Kostenstelle geändert wird.

## Oberfläche

Die Mitarbeiteranlage und -bearbeitung enthält kein separates Feld für eine
Stammfiliale mehr. Im Abschnitt „Person & Organisation“ wird zuerst die
Kostenstelle gewählt. Daraufhin:

- zeigt die Position nur das Positionsset des Kostenstellentyps,
- erläutert ein Hinweis den automatisch übernommenen Standort,
- zeigt die Abteilung ausschließlich Werte dieses Standorts,
- bleibt die Abteilung bei Verwaltung, Produktion und anderen
  Nicht-Filialtypen deaktiviert.

Mitarbeiteranlage, Planungsangaben, geschützter Personalakt und App-Rechte sind als
eingeklappte Bereiche aufgebaut. Beim Öffnen des Dialogs bleiben sie geschlossen.
Enthält ein geschlossener Bereich ein ungültiges Pflichtfeld, wird genau dieser
Bereich für die Korrektur automatisch geöffnet.

## Interne Kompatibilität

Die Datenbankspalte `employees.home_location_id` bleibt vorerst als abgeleitete
Kompatibilitätsprojektion erhalten, weil bestehende Dienstplan-, Rechte- und
Auswertungsfunktionen darauf lesen. Sie ist keine eigenständige fachliche Eingabe:

- Filialkostenstelle: ID des mit der Kostenstelle verknüpften Standorts,
- alle anderen Kostenstellentypen: `NULL`.

Die Migration `v0.87-employee-cost-center-assignment` gleicht bestehende Datensätze
verlustarm ab. Bereits tatsächlich verwendete Positionen werden vor Aktivierung
der strengen Regeln in das Positionsset des jeweiligen Typs aufgenommen.
Unpassende bevorzugte Abteilungen werden entfernt; die Kostenstelle und die
Person selbst bleiben erhalten.

## Absicherung

Die Regeln gelten in drei Schichten:

- Die Oberfläche filtert Positionen und Abteilungen sofort.
- Die API leitet den Standort erneut aus der Kostenstelle ab und lehnt
  widersprüchliche Eingaben ab.
- SQLite-Trigger verhindern auch direkte inkonsistente Schreibzugriffe.

Zusätzlich können:

- verwendete Positionen nicht aus einem Kostenstellentyp entfernt werden,
- belegte Kostenstellen nicht auf einen anderen Typ umgestellt werden,
- Filialkostenstellen ohne verknüpften Standort keinem Mitarbeitenden neu
  zugeordnet werden.

## Personalimport

Neue Importprofile verwenden eine Standardkostenstelle. Zulässige Positionen und
der Standort werden auch dort automatisch abgeleitet. Standort-ID und
Standortname werden nicht mehr als neue Zuordnungsfelder angeboten.

Bestehende Profile mit einer früheren Standortvorgabe bleiben lesbar. Beim
Einlesen wird die frühere Standortangabe einmalig auf deren Kostenstelle
abgebildet. Ein Widerspruch zwischen alter Standortangabe und Kostenstelle wird
nicht stillschweigend übernommen, sondern als Fehler ausgewiesen.

## Abgrenzung

Block 2/8 verändert weder die Rechtearchitektur noch die Logik späterer
Nicht-Mitarbeiter-Zugänge. Ein Filialaccount ohne Personalstamm, Zeiterfassung und
arbeitsrechtliche Mitarbeiterlogik bleibt einem späteren Block vorbehalten.
