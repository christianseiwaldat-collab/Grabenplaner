# Optionale Passkeys für den GP

## Umfang und Bedienung

Passkeys ergänzen die Anmeldung der Weboberflächen für persönliche Mitarbeiter-,
Filial- und Terminalkonten. Beide Loginseiten bieten bei verfügbarer Funktion
„Mit Passkey anmelden“ an. Der Geräteanbieter bestätigt die Anmeldung etwa mit
PIN, Fingerabdruck oder Gesicht; der GP erhält keine biometrischen Daten.
Passwortanmeldung und die vorhandene Kennwortwiederherstellung bleiben verfügbar.
Die native App verwendet weiterhin ihren eigenen Anmeldevertrag.

Unter „Passkeys verwalten“ lassen sich bis zu zehn aktive Passkeys mit einem
Gerätenamen einrichten, ansehen und widerrufen. Die Einrichtung und
der Widerruf verlangen das aktuelle persönliche Passwort. Die Anzeige enthält
Name, Anlagezeitpunkt und letzte erfolgreiche Nutzung. Sie enthält keine
öffentlichen Schlüssel, Credential-IDs oder internen Sicherheitsbindungen.

Der Widerruf eines einzelnen Passkeys verhindert dessen künftige Verwendung.
Bereits angemeldete Sitzungen dieses Kontos bleiben bestehen. Bei einem verlorenen
oder gestohlenen Gerät ist deshalb zusätzlich die Administration zu verständigen:
Ein administrativer Kennwortreset oder eine Kontodeaktivierung beendet die
bestehenden Zielsitzungen und widerruft die Schlüssel des betroffenen Kontos.

Filial- und Terminalkonten richten keine dauerhaften Schlüssel aus einer
geteilten Sitzung heraus ein. Berechtigte Personen verwalten sie mit ihrem
persönlichen Zugang. Filialleitungen benötigen die bestehende Berechtigung zur
Filialkontoverwaltung und Zuständigkeit für sämtliche zugeordneten Standorte.
Terminalkonten verwaltet die zentrale Administration. Für geteilte Konten sind
verwaltete Firmengeräte oder betriebliche Sicherheitsschlüssel zweckmäßig.
Attestation wird nicht angefordert; die Anwendung erzwingt damit keine bestimmte
Hardware oder Synchronisierungsart.

Sicherungsdownload, Offsite-Ordneranlage, Offsite-Aktivierung, VPS-Neustart und
persönlicher Passwortwechsel bieten zusätzlich eine explizite Passkey-Bestätigung.
Der Beleg wird am ursprünglichen geschützten Request geprüft und ist an genau
diese Aktion gebunden. Ein abgebrochener Gerätedialog startet keinen Ersatzversuch.

## Sicherheitsvertrag

- WebAuthn-Prüfung mit exakt gepinntem `@simplewebauthn/server@14.0.3` und lokal
  ausgeliefertem `@simplewebauthn/browser@14.0.0`. Kein CDN und keine CSP-Aufweitung.
- RP und erwarteter Origin stammen ausschließlich aus der konfigurierten
  öffentlichen HTTPS-Adresse. IP-Adressen, HTTP, fremde Origins und eine
  stillschweigende Erweiterung auf eine übergeordnete Domain sind ausgeschlossen.
  Ein Wechsel des Anmeldehosts benötigt eine ausdrückliche Migrationsentscheidung.
- Ausschließlich ES256/RS256, erforderlicher auffindbarer Schlüssel und
  erforderliche Benutzerverifikation. Fremde Einbettung (`crossOrigin`/`topOrigin`)
  wird ausdrücklich abgewiesen.
- Eine zusätzliche Schlüsselrichtlinie gilt bei Registrierung und Anmeldung:
  ES256 benötigt einen gültigen EC2/P-256-Punkt; RS256 benötigt einen RSA-Modulus
  mit 2.048 bis 8.192 Bit und einen kanonischen ungeraden Exponenten zwischen 3
  und dem 32-Bit-Maximalwert. Widersprüchliche COSE-Angaben, private
  Schlüsselkomponenten und schwächere Schlüssel werden abgewiesen. Die
  kryptografische WebAuthn-Signaturprüfung verbleibt in der Bibliothek.
- Zufällige, stabile 32-Byte-User-Handles. Persönliche und organisatorische
  Identitäten bleiben auch bei identischer fachlicher Kennung getrennt.
- Challenges laufen nach zwei Minuten ab. Zweck, Browser, RP und Origin sowie
  bei angemeldeten Vorgängen Sitzung und aktuelle Berechtigung werden gebunden.
  Die Challenge wird vor der Kryptoprüfung atomar verbraucht; eine fehlgeschlagene
  Prüfung macht sie nicht erneut verwendbar. Abgelaufene Challenges werden bei
  der Ausgabe neuer Anfragen in begrenzten Batches entfernt.
- Anonyme Anmeldung verwendet auffindbare Schlüssel ohne vorherige Kontosuche
  und ein kurzlebiges `Secure`/`HttpOnly`/`SameSite=Strict`-Browsercookie.
  Bestehende Login-Drosselung und eine zusätzliche begrenzte Passkey-Drosselung
  gelten auch dort. Fehlerprotokolle enthalten keine Assertions oder User-Handles.
- Jede erfolgreiche Nutzung prüft Kontostatus, Sperre und Kennwortrichtlinie
  erneut. Startkennwortwechsel und noch nicht qualifizierte Bestandskennwörter
  können nicht durch einen Passkey übersprungen werden.
- Schlüsselverwendung, Credential-Revision, Zähler, Sitzung und Erfolgsnachweis
  werden in derselben serialisierbaren Anwendungsgrenze abgeschlossen. Auch
  synchronisierte Schlüssel mit Zähler null haben einen Revisions-CAS. Widerruf,
  Reset und parallele Bestätigung können keinen veralteten Erfolg übernehmen.
- Neue Anmeldung erstellt neue Sitzungs- und CSRF-Werte. Bestätigung innerhalb
  einer Sitzung rotiert beide Werte und erhält `authenticatedAt` sowie die
  ursprüngliche absolute Ablaufzeit. Cookies werden erst nach Commit gesetzt.
  Die bestehende Mehrtab-Koordination umfasst die neuen Übergänge.
- Administrative Kennwort-Resets und Kennwortwiederherstellung widerrufen
  Schlüssel und offene gebundene Challenges durch einen Epochwechsel. Ein
  regulärer eigener Kennwortwechsel erhält die hinterlegten Passkeys. Aktuelle
  Passwort- und Berechtigungsbindungen verhindern die Übernahme alter
  angemeldeter Einrichtungsvorgänge.

## Datenbank, Auslieferung und Wiederherstellung

Die additive PostgreSQL-Erweiterung besitzt einen eigenen DDL-/Katalogvertrag
und `passkeys_migration_history`. Die historischen 1.125 Core-Statements und
Boundary-Pins werden nicht ersetzt. Der Anwendungsstart führt kein DDL aus.

Eine Datenbank ohne Erweiterung bleibt startfähig; die Passwortanmeldung bleibt
verfügbar und Passkeys werden als nicht eingerichtet angezeigt. Unbekannte oder
beschädigte vorhandene Ledger werden als Schemaabweichung abgewiesen.

Die spätere Auslieferung benötigt den regulären geschützten Migrationsschritt
unter Betriebssperre, Paket-/Quellprüfung und geprüftem Sicherungspunkt. Die
Erweiterung wird vor dem Start der neuen Anwendung ausdrücklich migriert.
Der neue Schemafingerprint ist keine Zusage, ältere Binärstände unmittelbar mit
der erweiterten Datenbank betreiben zu können. Rückkehr erfolgt über den dafür
qualifizierten Wiederherstellungspfad oder einen kompatiblen Folgestand.

Alte PostgreSQL- und historische SQLite-Sicherungen bleiben im bestehenden
Wiederherstellungsweg erhalten. Kopierte Authentifizierungszustände benötigen
im ausdrücklich gebundenen Restore-Schritt eine Invalidierung vor Aktivierung:
Browser-, Organisations-, Mobile- und Reset-Tokens, Passkeys und offene
Challenges. Dadurch werden später widerrufene Schlüssel aus einem älteren
Snapshot nicht wieder nutzbar. Das Originalbackup und Passwort-/Fachdaten werden
erhalten. Diese Invalidierung gehört zum Restore; ein normal wiederholter
Migrationslauf widerruft keine gültigen Schlüssel.

## Prüfungen und Nachweisgrenze

Die Tests umfassen echte WebAuthn-Registrierung und signierte Assertions über
virtuelle Browser-Authenticators, einschließlich falschem Origin/RP/Challenge,
fehlender Benutzerverifikation, fremder Einbettung, Handle-Verwechslung und Replay.
Management-, Login-, Reauthentifizierungs- und Mehrtab-Tests prüfen beide
Oberflächen einschließlich des vollständigen Produkt-CSS.

Native PostgreSQL-Prüfungen umfassen DDL-Rollback, Typtrennung, Rechte am
Datenbankzugang, Quoten, Challenge-Parallelität, Counter-/Revisions-CAS,
Widerruf sowie den tatsächlichen HTTP-Anwendungsweg. Betriebliche Wirkungen wie
Neustart oder Offsite-Aufträge werden ausschließlich durch synthetische
Testadapter ersetzt. Diese Prüfungen behaupten keine reale VPS-Aktion.

Vollsuite, Mindest-Node, Legacy-Wiederherstellung, Linux-SAST und Paketverträge
werden am eingefrorenen gemeinsamen Quellstand geprüft. Die Abschlussbelege
benennen Quelle, Umgebung, Ergebnis und Ausnahmen ausdrücklich. Lokale
Linux-Läufe sind eigenständige Nachweise; ein GitHub-Lauf entsteht erst nach
einer später gesondert autorisierten Veröffentlichung. Quellcommit und Deployment
sind getrennte Schritte.

## Einordnung im ASVS-Audit

Die Anforderungen stammen aus dem im Repository versionierten ASVS-5.0.0-Katalog.
Die Nachprüfung bewertet den neuen Pfad, ohne den Gesamtstatus früherer
Anforderungen pauschal zu überschreiben.

| Anforderung | Nachweisbereich dieser Änderung |
| --- | --- |
| V6.3.1 | Gemeinsame Login-Drosselung, begrenzte Passkey-Anfragen und atomare Fehlpasswortzählung bei Einrichtung/Widerruf. |
| V6.3.4 | Dokumentierte parallele Passwort-/Passkey-Wege und gleiche Konto-, Rechte- und Übergangskontrollen. |
| V6.3.8 | Auffindbare Anmeldung ohne öffentliche Kontosuche; Enrollment-Auskunft nur im berechtigten Kontext. |
| V6.5.6 | Eigener Widerruf, administrativer Reset und Invalidierung kopierter Schlüssel beim Restore. |
| V7.2.4 | Neue Sitzung bei Anmeldung und Bestätigung, ungültiger Vorgängertoken, Cookies erst nach Commit. |
| V7.3.1–V7.3.2 | Bestehende Leerlaufgrenzen und unveränderte absolute Deadline bei Reauthentifizierung. |

V6.3.3 ist durch eine freiwillige Passkey-Option nicht insgesamt erfüllt:
Verpflichtende Mehrfaktor- oder Hardwarevorgaben für sämtliche Anmeldewege bleiben
eine gesonderte Entscheidung. Auch Benachrichtigungen nach V6.3.5/V6.3.7 werden
durch ein reines Auditereignis nicht ersetzt. Diese Änderung führt keine neuen
externen Benachrichtigungen ein.

## Primärquellen

- [WebAuthn-Spezifikation](https://www.w3.org/TR/webauthn-3/)
- [SimpleWebAuthn Server](https://simplewebauthn.dev/docs/packages/server)
- [SimpleWebAuthn Browser](https://simplewebauthn.dev/docs/packages/browser)
- [OWASP Passkey Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html)
