# Entwicklung in Codespaces

Das Repository ist öffentlich. Verwende in Codespaces synthetische Daten und
separate Zugangsdaten für die Entwicklung.

Der Devcontainer installiert die Abhängigkeiten mit `pnpm install --frozen-lockfile`.
Der private Port 3000 dient der lokalen Entwicklung über den authentifizierten
Codespaces-Proxy. Die vollständige Anwendungsprüfung läuft im synthetischen
PostgreSQL-Dienst der Linux-CI.
