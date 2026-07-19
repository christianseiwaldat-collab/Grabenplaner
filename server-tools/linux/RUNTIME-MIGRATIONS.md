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
