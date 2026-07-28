# Kostenstellen-Typmodell v0.1

Status: lokale Implementierung für Block 1/8, noch nicht veröffentlicht

## Ziel

Kostenstellen sind nicht mehr auf die vier fest im Programm hinterlegten Kategorien
`branch`, `administration`, `production` und `other` beschränkt. Berechtigte Personen
ab Personalleitung können Typen wie beispielsweise Lager, Logistik, IT oder weitere
betriebliche Bereiche anlegen und pflegen.

Das Modell trennt dabei drei Begriffe:

1. Ein **Kostenstellentyp** beschreibt die organisatorische Art und das zulässige
   Positionsset.
2. Eine **Kostenstelle** ist eine konkrete organisatorische Einheit dieses Typs.
3. Ein **Standort** ist eine Filiale und darf deshalb nur genau einer freien,
   aktiven Kostenstelle mit Filialkennzeichen zugeordnet sein.

## Datenmodell

### `cost_center_types`

- stabile technische ID und unveränderlicher Code
- bearbeitbare Bezeichnung und Beschreibung
- `is_branch` als ausdrückliche Filialeigenschaft
- Aktivstatus mit weicher Archivierung
- Kennzeichnung der mitgelieferten Standardtypen
- Sortierung und Audit-Metadaten

### `cost_center_type_positions`

- n:m-Zuordnung zwischen Kostenstellentypen und Positionen
- eigene Sortierung je Typ
- referenzielle Integrität zu Typen und Positionen

### `cost_centers`

- zusätzliche Referenz `cost_center_type_id`
- die bisherige Spalte `type` bleibt vorerst als Kompatibilitätsprojektion erhalten
- eigene Typen werden in der alten Spalte als `other` dargestellt; die fachlich
  maßgebliche Information ist ausschließlich `cost_center_type_id`

## Standardtypen und Migration

Bestehende Daten werden deterministisch zugeordnet:

| Bisheriger Wert | Neuer Typ | Filialtyp |
| --- | --- | --- |
| `branch` | Filiale | ja |
| `administration` | Verwaltung | nein |
| `production` | Produktion | nein |
| `other` oder unbekannt | Sonstiges | nein |

Alle vorhandenen Positionen werden bei der erstmaligen Migration den vier
Standardtypen zugeordnet. Damit ändert diese Basismigration allein noch keine
bestehende Mitarbeiteranlage. Die inzwischen lokal umgesetzte, positionsabhängige
Mitarbeiterzuordnung ist separat in
`MITARBEITER-KOSTENSTELLENZUORDNUNG-v0.1.md` beschrieben.

## Verbindliche Regeln

- Jede Kostenstelle besitzt genau einen vorhandenen Typ.
- Eine aktive Kostenstelle kann nur einen aktiven Typ verwenden.
- Ein Standort kann nur einer aktiven Kostenstelle mit aktivem Filialtyp zugeordnet
  werden.
- Eine Filialkostenstelle kann höchstens einem Standort zugeordnet sein.
- Der Filialstatus eines verwendeten Typs kann nicht entfernt werden.
- Verwendete Typen und Kostenstellen können nicht archiviert werden.
- Typen und Kostenstellen werden archiviert, nicht physisch gelöscht.
- Eine Position kann nicht gelöscht werden, solange sie einem Typ zugeordnet ist.
- Technische Typ- und Kostenstellencodes bleiben nach der Anlage unveränderlich.

Diese Regeln werden sowohl in der API als auch durch SQLite-Trigger abgesichert.

## Berechtigungen und Audit

- Lesen: `cost_centers:read`
- Anlegen, Bearbeiten und Archivieren: `cost_centers:write`
- Die globale Verwaltung bleibt auf Developer, IT-Admin, Admin und
  Personalleitung begrenzt.
- Filial- und Abteilungsleitungen erhalten dadurch keinen globalen Zugriff.
- Anlage, Änderung und Archivierung eines Typs werden im Audit-Log protokolliert.

## Oberfläche

Die Personalverwaltung zeigt vor den konkreten Kostenstellen eine eigene Übersicht
der Typen. Je Typ sind sichtbar:

- Typname und technischer Code
- Filialkennzeichen
- Aktiv- und Standardstatus
- Zahl der Kostenstellen und gegebenenfalls Standorte
- hinterlegte Positionen

Beim Bearbeiten eines Standorts werden nur aktive, noch nicht anderweitig
zugeordnete Filialkostenstellen angeboten. Beim Bearbeiten einer Kostenstelle wird
der Typ aus dem dynamischen Katalog gewählt; es gibt keine fest verdrahtete
Typauswahl mehr.

## Abgrenzung zu den nächsten Blöcken

Block 1/8 liefert Typmodell, Migration, Verwaltung, Positionssets und
Standortinvarianten.

Nicht Bestandteil von Block 1/8:

- die typabhängige Positionseinschränkung bei der Mitarbeiteranlage
  (lokal umgesetzt in Block 2/8),
- das Entfernen der separaten Standortauswahl zugunsten der Kostenstellenlogik
  (lokal umgesetzt in Block 2/8),
- besondere Positionen und Formulare je Verwaltung, Produktion oder weiteren Typen,
- eigenständige Nicht-Mitarbeiter-Zugänge wie ein Filialaccount.
