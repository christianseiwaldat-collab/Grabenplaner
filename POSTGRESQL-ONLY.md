# PostgreSQL als einzige Betriebsdatenbank

Der zentrale Linux-Server verwendet ausschließlich das gebundene PostgreSQL-Paar `grabenplaner_core` und `grabenplaner_sales`. SQLite ist kein auswählbarer Anwendungsprovider, kein Standard und kein Ausweichbetrieb. Fehlende oder widersprüchliche PostgreSQL-Konfiguration darf weder neue Datenbanken anlegen noch bestehende Dateien verändern.

## Installation und Übergang

Die Installation setzt ein zuvor bereitgestelltes und verifiziertes PostgreSQL-Paar mit den bestehenden Rollen-, Schema-, Pfad- und Schutzverträgen voraus. Die Einrichtung einer beliebigen fremden Datenbank durch ein bloßes `DATABASE_URL` ist nicht vorgesehen. Der Installer prüft seine Voraussetzungen vor den Installationsänderungen. Ein unvorbereiteter Host erfordert zunächst eine eigene geprüfte PostgreSQL-Provisionierung.

Ein noch mit SQLite betriebener Bestand wird mit dem erhaltenen früheren Migrationswerkzeug und seiner passenden Softwareversion übertragen. Vorher sind vollständige Sicherung einschließlich Dateien und Schlüssel, Wartungssperre und geprüfter Rückkehrpunkt erforderlich. Nach Veröffentlichung der PostgreSQL-Autorität erfolgt keine automatische Rückkehr nach SQLite. Ein Code-Rollback auf einen früheren PostgreSQL-fähigen Stand ist davon getrennt zu prüfen; ein Schema-Rollback benötigt ein konsistentes gemeinsam gesichertes Datenbankpaar.

## Alte Sicherungen

Benötigte alte Sicherungen und ihre Schlüssel bleiben erhalten. Ein SQLite-Backup darf nicht als einzelne Datenbankdatei in den aktuellen PostgreSQL-Betrieb eingespielt werden. Das aktuelle Wiederherstellungswerkzeug verweigert diesen Weg.

`scripts/legacy-recovery-capsule.js` konserviert den unveränderten früheren Quellstand `b2ba03cdc0b738d44766857de052e090db557807` mit Paket-Lockdatei und exakt gebundenem Node-Laufzeitstand. Die Kapsel dient der Offline-Verifikation und Wiederherstellung in einen neuen, leeren und privaten Arbeitsbereich. Sie startet keine Produktivdienste. Ihre Grenzen und die nativen Laufzeitvoraussetzungen sind im erzeugten Manifest enthalten. Der Manifest-Hash muss außerhalb der Kapsel verwahrt werden; Kapsel und Sicherungen sollen zusätzlich auf dem vorhandenen unabhängigen Sicherungsziel aufbewahrt werden.

Eine erfolgreiche Formatprüfung ersetzt keine Prüfung der fachlichen Vollständigkeit. Für einen tatsächlichen Altbestand sind Datenbank, geschützte Datensätze, referenzierte Dateien und verfügbare Entschlüsselungsschlüssel gemeinsam zu prüfen. Anschließend erfolgt eine kontrollierte Migration in ein neues PostgreSQL-Paar. Altsicherungen werden durch diese Umstellung nicht gelöscht und nicht in-place umgeschrieben.

Die Kapsel ist kein sofort startbares vollständiges Alt-Anwendungspaket. Für eine spätere historische Anwendungsausführung sind zusätzlich passende, verifizierte Abhängigkeiten und eine kompatible isolierte Betriebssystemumgebung erforderlich. Eine native Bibliotheksabweichung muss die Offline-Wiederherstellung vor der Zielerstellung stoppen.

## Laufzeit und Tests

Gemeinsame SQL-Kataloge liegen unter `lib/persistence/catalogs`. Historische SQL-Fingerprints bleiben erhalten. SQLite-Kompatibilitätsmodule gehören zu Altformatwerkzeugen und historischen Vergleichstests; ihre Existenz bedeutet keine Unterstützung als laufende GP-Datenbank. Der in Node enthaltene SQLite-Code wird durch diese Produktentscheidung nicht aus dem Node-Binary entfernt.

Die Instanzsperre verwendet Linux-Kernelsperren und einen kleinen Python-3-Helfer. Sie muss zugleich die von alten GP-Versionen verwendeten SQLite-Dateisperren respektieren, damit Update und Code-Rollback keinen zweiten Prozess zulassen. Sperrdateien dürfen nicht zur vermeintlichen Bereinigung gelöscht werden.

Die aktuelle Anwendung wird mit echten PostgreSQL-Fixtures geprüft. Historische SQLite- und Migrationsvergleiche bleiben getrennt erkennbar. Vollständige Linux-Anwendungsprüfung, negative Konfigurationstests, Parallelität, Sicherung/Wiederherstellung, native Inventar-CLI und SAST sind vor der Freigabe erforderlich. Ein lokaler oder CI-Nachweis ist keine Aussage über einen bereits erfolgten Produktivwechsel.
