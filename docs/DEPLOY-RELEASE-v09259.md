# Release v0.92.59 Beta

## Anlass und Änderung

Der vollständige Wiederherstellungstest von v0.92.58 erreichte auf dem VPS
die äußere 30-Minuten-Grenze. PostgreSQL prüfte nach dem Indexaufbau noch
Fremdschlüssel; der Prozess wurde durch systemd beendet. Die produktive App
blieb verfügbar, die Wiederherstellung lief ausschließlich in einer Testkopie.

`pg_restore` erhält maximal 45 Minuten. Der übergeordnete Worker leitet sein
Gesamtlimit aus derselben Konstante ab und reserviert zusätzlich 15 Minuten
für die andere Datenbank und den vollständigen Anwendungsfunktionstest.
Damit bleibt der gesamte Worker auf eine Stunde begrenzt. Andere native
Werkzeuge behalten ihre 15-Minuten-Grenze. CPU-Quote, Speichergrenze,
Prozessgruppenbeendigung, private Netzwerkumgebung und Pfadsperren bleiben
unverändert. Keine Integritäts- oder Anwendungsprüfung wird ausgelassen.

Uhr-gesteuerte Tests prüfen erfolgreichen Abschluss nach 44 Minuten, Abbruch
bei 45 Minuten, das Verwerfen verspäteter Erfolgsmeldungen und Timerbereinigung.
Der Worker-Vertrag prüft ausdrücklich die zusätzliche Reserve gegenüber dem
inneren Werkzeug sowie die unveränderte Abschottung.

## Status

Die lokale Recovery-Prüfung umfasst 22 Tests: 21 bestanden, kein Fehler,
eine unveränderte Live-Umgebungsauslassung. Alle zehn gezielten Versions-
und Budgetprüfungen bestehen. Der erste CI-Kandidat `5f45382` wird wegen
eines zusätzlich aufgedeckten zeitabhängigen Scheduler-Tests nicht
veröffentlicht. Die Testuhr ist korrigiert; alle 16 Tests dieser Datei bestehen.
Die vollständige CI und VPS-Abschlussnachweise werden erst nach tatsächlichem
Erfolg ergänzt. Die ursprünglichen
[26 CI-Fehler](CI-FEHLERKORREKTUR-2026-09-18.md) sind bereits korrigiert.
