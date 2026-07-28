# Windows Portable / LAN-Host – Legacy-Endstand

**Version:** v0.87 Legacy

**Paketversion:** `0.87.0-beta.legacy.1`

**Status:** eingefrorener Legacy-Endstand

**Plattform:** Windows 10/11 x64

## Zweck

Diese Ausgabe bildet den letzten Stand der früheren Windows-Portable-
Produktlinie. Sie dient bestehenden lokalen Installationen und einem einzelnen
Windows-Host in einem vertrauenswürdigen internen LAN. Aus dieser
Legacy-Veröffentlichung entsteht keine Verpflichtung für weitere
Funktions-, Sicherheits- oder Kompatibilitätsupdates.

## Installation und Start

1. Das veröffentlichte ZIP vollständig in einen normalen, beschreibbaren
   Ordner auf dem Windows-PC entpacken.
2. `Grabenplaner v0.87 Legacy starten.cmd` ausführen.
3. Die lokale Oberfläche unter `http://localhost:3000` verwenden.

Die Runtime wird als `runtime\node.exe` mitgeliefert. Programmdateien und
Arbeitsdaten müssen gemeinsam verschoben werden; ein Start direkt aus dem
ZIP-Archiv ist nicht unterstützt.

## Datenhaltung

Die Standarddatenbank liegt unter:

```text
data\dienstplan.db
```

SQLite bleibt für diesen Legacy-Endstand unverändert. Eine automatische
Umstellung auf einen anderen Datenbankprovider findet nicht statt. Bestehende
Daten dürfen nur über einen bewusst geprüften Sicherungs-, Wiederherstellungs-
oder späteren Migrationsweg übernommen werden.

## LAN-Vertrauensgrenze

Der LAN-Host ist genau eine aktive Grabenplaner-App-Instanz auf einem
Windows-PC. Andere Geräte greifen nur per Browser innerhalb eines kontrollierten
internen Firmen-LAN/WLAN zu.

Nicht freigegeben sind:

- öffentliche Router-Portfreigaben;
- direkte Erreichbarkeit aus dem Internet;
- ein öffentlicher Reverse-Proxy oder öffentlicher HTTPS-Produktivbetrieb;
- mehrere gleichzeitig schreibende App-Instanzen auf derselben Datenbank;
- die Erstellung oder Weitergabe vorkonfigurierter USB-Stick-Installationen.

Windows-Firewall, Benutzerkonten, Rollen, Netzwerkzugang und physischer Zugriff
bleiben durch die verantwortliche IT zu prüfen.

## Sicherung und Wiederherstellung

- Vor Änderungen und regelmäßig im Betrieb eine vollständige Sicherung
  erstellen.
- Mindestens eine Sicherung getrennt vom Host-PC aufbewahren.
- Wiederherstellungen ausschließlich auf einer Kopie und mit
  Integritätsprüfung erproben.
- Datenbank und zugehörige verschlüsselte Dokumentablage gemeinsam behandeln.
- Vor einer Migration den letzten konsistenten Stand unverändert sichern.

Eine vorhandene Sicherungsdatei ist noch kein Nachweis einer erfolgreichen
Wiederherstellung.

## Updates und Supportgrenze

Die Anwendung meldet `v0.87 Legacy` als finalen Stand. Update-Suche,
automatischer Download und automatische Installation sind fail-closed
deaktiviert. Das Release-ZIP wird mit einer separaten SHA-256-Datei
veröffentlicht.

Für neue zentrale Installationen, externen HTTPS-Zugriff, weiterentwickelte
Funktionen oder künftig andere Datenbankprovider ist die verwaltete
Server-Produktlinie vorgesehen. Die Migration ist ein eigener, zu planender
Vorgang mit Sicherung, Datenprüfung und Rückkehrmöglichkeit.

## Qualifizierter Hinweis

Dieser Legacy-Endstand enthält technische Schutzmaßnahmen, ersetzt aber weder
die konkrete Datenschutz- und Rechtsprüfung noch die Absicherung von Windows,
Netzwerk, Konten, Zugriffsrechten und Sicherungsmedien durch die verantwortliche
Stelle.
