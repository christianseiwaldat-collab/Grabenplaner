# Block 3: Core-Schema und Migrationsschutz

Stand 12.09.2026. Ausführbarer Entwicklungsstand für die zwei Datenbanken; die Produktivanwendung verwendet weiterhin SQLite.

## Umsetzung

Die am 12.09.2026 inventarisierte v0.92.37-Struktur ist als Schemafixture ohne Geschäftszeilen eingefroren. Der PostgreSQL-Plan übernimmt alle 191 Core-Tabellen, 213 expliziten Quellindizes, die Sicht `portal_user_roles` und 299 Schutztrigger. Fremdschlüssel werden nach Tabellen und Schlüsseln angelegt. Längere Objektnamen erhalten einen eindeutigen Hashsuffix statt einer kollidierenden PostgreSQL-Kürzung.

Historische IDs und Feldverträge bleiben erhalten: Personal-/Kundennummern als Text, Textzeitstempel unverändert, Flags als geprüfte 0/1-Werte, BLOBs als bytea und exakte JSON-Quelltexte als Text. Automatische Ganzzahl-IDs verwenden eine überschreibbare Identity. Bereits gespeicherte JSON-Payloads werden nicht nach jsonb umgeschrieben; die vorhandenen Audit-/Revisionsschutzauslöser bleiben aktiv.

Der Artikelrevisionsbezug der Leihen wird nicht als Fremdschlüssel in eine andere Datenbank ausgegeben oder einfach entfernt: `gp.article_reference_snapshots` ist die vorbereitete lokale Referenztabelle mit zusammengesetztem Schlüssel und Herkunftsdigest. Die App darf sie nur lesen. Die revisionsgebundene Befüllung und der Ausfallvertrag folgen in Block 7.

Eine private Kompatibilitätsschicht bildet die tatsächlich benötigten SQLite-Ausdrücke ab, darunter ASCII-NOCASE, NULL-sichere Vergleiche, JSON-Typen, Datumsrechnung und einfache GLOB-Muster. Monats-/Jahresüberläufe werden ausdrücklich wie SQLite behandelt; Zeitangaben mit Offset werden nach UTC umgerechnet. Sie ist kein universeller SQLite-Interpreter. Abweichende/neue Quellschemata oder zusätzliche Ausdrucksformen benötigen eine neue geprüfte Migration.

## Sicherer Ablauf

`migrateCoreDevelopment` prüft zuerst Datenbank, Rolle und privaten Entwicklungsmarker. Ein Advisory-Lock serialisiert den gesamten Lauf. Schema und Ledger entstehen in einer Transaktion; Fehler rollen die DDL zurück. Der Ledger bindet Quellschema und Plan per SHA-256. Zusätzlich werden reale Tabellen, Spalten, Constraints, Indizes, Trigger, Funktionen, Eigentümer und Grants fingerprinted. Ein Ledger allein genügt nicht für einen erfolgreichen Wiederholungslauf.

Ein Entwicklungsneuaufbau ist ausschließlich mit ausdrücklicher Option und vollständig leeren Anwendungstabellen zulässig. Auch eine einzige belegte Tabelle verhindert ihn. Dieser Weg ist kein Werkzeug für produktive Rücknahmen oder Datenbereinigung.

## Nachweise

- Vollständiger Plan und Anlage auf der getrennten PostgreSQL-18.6-Testinstanz.
- Alle 299 Triggerfunktionen zusätzlich mit typisierten NEW/OLD-Records auf SQL-Auflösung geprüft; das reine Anlegen einer PL/pgSQL-Funktion wäre dafür nicht ausreichend. Diese Prüfung belegt Typ-/Referenzauflösung, nicht jeden möglichen fachlichen Triggerzweig.
- Sechs automatisierte Tests: Objektabdeckung, Organisations-/FK-/NOCASE-Regeln gegenüber SQLite, unveränderliche historische Ereignisse mit exaktem Payload, wiederholter Migrationslauf, Datum/JSON/Text-Grenzfälle und Ablehnung von Schemadrift bzw. belegtem Neuaufbau.
- Ein fehlgeschlagener Fingerprint-Lauf während der Entwicklung rollte den gesamten Neuaufbau zurück; nach Korrektur ließ sich das zuvor vorhandene leere Schema erfolgreich neu anlegen.

Die Fachpfadvergleiche folgen in Block 4. Der massenhafte Transfer realer historischer Zeilen einschließlich Identity-Fortsetzung, Dateien und Schlüssel ist Block 9. Ältere SQLite-Stände müssen zunächst isoliert auf das nachgewiesene Quellschema normalisiert werden; es gibt keine Zusage für beliebige historische Schemafassungen. Die bestehenden produktiven PostgreSQL-Gates bleiben geschlossen.

Quellen für die geprüften Dialektunterschiede: [SQLite-Datumsfunktionen](https://www.sqlite.org/lang_datefunc.html), [SQLite-Textfunktionen](https://www.sqlite.org/lang_corefunc.html), [PostgreSQL-Trigger](https://www.postgresql.org/docs/18/sql-createtrigger.html).
