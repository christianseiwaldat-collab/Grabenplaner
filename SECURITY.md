# Sicherheitsrichtlinie

Die aktuelle Server-Beta erhält geprüfte Sicherheitskorrekturen.
Legacy v0.87.0-beta.legacy.1 ist eingefroren; ältere Versionen werden nicht unterstützt.

Sicherheitsprobleme vertraulich an `christian.seiwald.at@gmail.com` melden.
Bitte betroffene Version, Auswirkung und ein minimiertes synthetisches Beispiel nennen.
Keine realen Personal-, Gesundheits-, Zugangs- oder Produktivdaten in Meldungen verwenden.
Repository-Administratoren können private Security Advisories für die Bearbeitung nutzen.

Öffentlicher Betrieb benötigt HTTPS, einen geprüften Reverse Proxy und einen an Loopback gebundenen App-Prozess.
Datenbanken, verschlüsselte Dokumente, Schlüssel und Sicherungen müssen gemeinsam geschützt und wiederherstellbar sein.
Betrieb, Updates und Wiederherstellungen verantwortet die zuständige Systemadministration.
Reale Daten, Branding-Kits, Schlüssel und unbereinigte Protokolle gehören nicht in dieses Repository.
Die technische Umsetzung ersetzt keine Prüfung der konkreten Berechtigungs-, Datenschutz- und Betriebskonfiguration.

[Betriebs- und Recovery-Vertrag](SERVERBETRIEB.md). Kein Bug-Bounty-Programm.
