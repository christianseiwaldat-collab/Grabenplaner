# Anmeldung und konkurrierende Importe

Am 14.09.2026 zusätzlich zu den sechs Integrationsblöcken beauftragt. Die
Handyfotos zeigen `fromResponse` auf einem undefinierten Fehlerhelfer und eine
allgemeine Fehlermeldung. Die produktive Installation wurde zunächst nur gelesen.

## Befund und Korrektur

- Das VPS-Journal bestätigt fehlgeschlagene Anmeldungen und Sitzungszugriffe
  zwischen 20:37 und 20:43 CEST, darunter PostgreSQL-Sperrzeitüberschreitungen.
  Auch `/api-errors.js` gelangte wegen eines zu breiten Präfixvergleichs in die
  API-Sitzungsprüfung. Nun gelten nur `/api` und `/api/…` als API-Pfade. Beide
  Anmeldeseiten zeigen außerdem eine verständliche Ersatzmeldung, wenn der
  Fehlerhelfer nicht geladen werden konnte.
- Ein altes Sitzungscookie darf die frische Passwortanmeldung nicht als deren
  Berechtigungsgrundlage behandeln: Das Ersetzen der alten Sitzung konnte sonst
  die eigene Abschlussprüfung verwerfen. Der Login prüft die angegebenen
  Zugangsdaten eigenständig; nachfolgende Anfragen prüfen die neue Sitzung.
- Gleichzeitige Ressourcenabrufe benötigen keine identischen Ablaufzeit-Updates.
  Die optionale Verlängerung wird höchstens einmal pro Minute beziehungsweise
  Viertel der eingestellten Sitzungsdauer geschrieben und pro Sitzung gebündelt.
  Rechte, Sperren, Widerruf und Ablauf werden weiterhin frisch gelesen. Bei
  vorübergehender Datenbanksperre gilt nur die gespeicherte Ablaufzeit.
- Native Importoperationen verwenden bis zu 25 Zeilen und rund eine Sekunde
  Arbeitsbudget je fortsetzbarem Schritt. Ein vollständig begonnener Einzelschritt
  wird abgeschlossen; deshalb ist das keine harte Ein-Sekunden-Laufzeitgarantie.
  Quelldatei, Prüffortschritt, Revisionskontrolle und Wiederaufnahme bleiben erhalten.
- Historienreferenzen liegen gemeinsam mit den Quellstammdaten in Sales und
  dienen dort als atomare Löschsperre. Die Core-Abhängigkeitsprüfung berücksichtigt
  diese Referenzen. Damit ist beim Historienimport kein verbotener zweiter
  Datenbank-Schreiber für eine redundante Sperrzeile mehr nötig. Vorbestehende
  alte Core-Sperren werden bei einer Rücknahme weiterhin ausdrücklich geprüft.

## Nachweis

147 gezielte lokale Tests bestanden, keine Fehler und keine übersprungenen Fälle.
Darunter tatsächliche HTTP-Anmeldungen mit vorhandenem Cookie, parallele
Sitzungsabrufe, sofortiger Rechteentzug, statische Dateien ohne Datenbankzugriff,
Import-Fortsetzung und die sechs integrierten Fachbereiche.

Native PostgreSQL-Qualifikation in einer eigenen synthetischen Instanz auf
Loopback-Port 55487, getrennt von der produktiven Instanz auf 55486: dreimalige
Anmeldung mit vorhandenem Cookie, erzwungene Verlängerung unveränderlicher
Ergebniszeilen, zwölf parallele Sitzungs-/Planungsaufrufe bei gleichzeitigem
Import, anschließender Rechteentzug. Bestanden; maximal 4068 ms im Test.
Eine erste Testanordnung startete zusätzlich zum tatsächlichen Server eine
zweite Gruppe von Lesern und konnte nicht vollständig initialisiert werden.
Der erfolgreiche HTTP-Test verwendet nur die Leser des tatsächlich gestarteten
Servers; die produktiven Verbindungsgrenzen blieben gleich.

Die erste Browserprüfung fand zusätzlich einen Schreibversuch auf eine
unveränderliche Sitzungszeile. Die Verlängerung liefert nun einen eigenen
Rückgabewert; der gezielte Test verwendet eingefrorene Zeilen.

Protokolle: `tmp/integration-release-tests.log`, `tmp/integration-final-audit.log`,
`tmp/v09246-evidence/native-login-final.log` und
`tmp/v09246-evidence/native-dependency-qualified.log`. Produktive
Ladezeitmessungen und der tatsächliche Releaseabschluss werden getrennt im
Release-Nachweis ergänzt.
