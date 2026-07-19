# Linux-Runtime-Migrationen

`runtime-schema.json` versioniert den ausserhalb des App-Ordners installierten
Serververtrag. Dazu gehoeren die Vorlagen fuer systemd, Caddy, den einmaligen
Admin-Bootstrap und die geschuetzte Env-Datei.

Das normale Update vergleicht vor jeder Aenderung die SHA-256-Fingerprints
dieser Artefakte. Es aktualisiert ausschliesslich den App-Baum. Dabei gelten
zwei harte Regeln:

- Geaenderte Artefakte bei unveraenderter `deploymentSchemaVersion` werden als
  fehlerhaftes Paket abgelehnt.
- Eine neue `deploymentSchemaVersion` stoppt das Update mit
  `migration-required`. Eine dafuer freigegebene Servermigration muss zuerst
  systemd/Caddy sichern, die bestehende Konfiguration und Secrets erhalten,
  die neuen Dateien validieren und bei einem Fehler zurueckrollen.

Neue Deployment-Haertungen duerfen deshalb nicht nur in den Vorlagen geaendert
werden. Die Schemaversion, eine gepruefte Migrationsroutine und ihre Tests
gehoeren immer zu derselben Aenderung. Env-Secrets, produktive Caddy-Regeln und
systemd-Units werden niemals blind aus einem App-Paket ueberschrieben.

## Deployment-Schema 2

Schema 2 ergaenzt `grabenplaner-monitor.service` und
`grabenplaner-monitor.timer` als root-verwaltete Runtime-Artefakte. Der Wechsel
von Schema 1 erfordert deshalb eine ausdrueckliche Wartungsmigration mit
Sicherung, Installation und Pruefung der neuen Units; das normale App-Update
bricht vorher mit `migration-required:1->2` ab.

### Offizieller Weg von Schema 1 auf Schema 2

Die Migration wird direkt aus dem separat heruntergeladenen und per SHA-256
freigegebenen v0.74-Linux-Serverpaket gestartet:

```bash
unzip Grabenplaner-Server-v0.74.0-beta-linux-x64.zip -d /root/grabenplaner-v074
sudo bash /root/grabenplaner-v074/server-tools/linux/migrate-grabenplaner-runtime-v2.sh \
  --package /root/Grabenplaner-Server-v0.74.0-beta-linux-x64.zip \
  --sha256-file /root/Grabenplaner-Server-v0.74.0-beta-linux-x64.zip.sha256
```

Das Werkzeug ist absichtlich kein Erstinstaller und akzeptiert nur eine aktive,
bereits fertig eingerichtete Produktionsinstallation mit Deployment-Schema 1,
mindestens einem aktiven Admin und bereits verbrauchtem Bootstrap-Schluessel.
Es fuehrt insbesondere folgende Schritte aus:

1. Paket-SHA, ZIP-Struktur, Einzeldatei-Manifest, Runtimevertrag und ClamAV
   pruefen; zugelassen ist ausschliesslich Schema 1 -> 2.
2. Eine gemeinsame root-only Wartungssperre halten und die neuen
   Monitor-Units samt Statusgruppe vorbereiten. Der Bootstrap wird dabei weder
   gestartet noch mit einem neuen Token versehen.
3. Bei aktivem Offsite-Modul dessen bisherige Installation gegen den
   Installationsbeleg pruefen, Timer pausieren und den unveraenderten
   Modulvertrag atomar an die v0.74-Werkzeuge binden. Repository, restic/rclone,
   Passwoerter und verschluesselte rclone-Konfiguration bleiben bestehen.
4. Den bewaehrten Server-Updater unter derselben Wartungssperre ausfuehren.
   Dieser erstellt einen verifizierten lokalen DB-/Dokumentsicherungspunkt,
   uebertraegt ihn bei aktivem Offsite vor dem App-Tausch, installiert die
   eingefrorenen Produktionsabhaengigkeiten und prueft internes sowie
   oeffentliches Live/Ready. Fehler vor dem erfolgreichen App-Commit rollen
   App, Daten, Runtime und Offsite-Bindung auf Schema 1 zurueck.
5. Env- und Offsite-Geheimdateien per Vorher-/Nachher-Pruefsumme bestaetigen,
   Runtime-Fingerprint, Bootstrap-Zustand und Live/Ready erneut pruefen und
   einen root-geschuetzten Migrationsbeleg unter
   `/var/lib/grabenplaner/maintenance/history` schreiben. Dieser enthaelt auch
   die SHA-256 des verifizierten Vorabbackups, aber keine Geheimwerte.

Tritt erst nach dem bereits erfolgreichen, von Live/Ready bestaetigten
App-Commit ein Fehler bei dieser abschliessenden Belegpruefung auf, wird kein
gefaehrlicher Teilrollback auf Schema 1 versucht. Die konsistente Runtime-v2-
Installation bleibt aktiv und das root-only Diagnoseverzeichnis wird mit
`POST-UPDATE-ACTION-REQUIRED` erhalten. Dieser Sonderfall verlangt eine
kontrollierte IT-Pruefung; er oeffnet ebenfalls niemals den Admin-Bootstrap.
