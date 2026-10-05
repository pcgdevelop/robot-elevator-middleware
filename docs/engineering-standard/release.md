# Release und Betrieb

Vor Release: Ticket, Commit/Version, Kriterien, unabhängiges Review, Testabnahme, kompatible Migration, Sicherung und Rücknahme. Danach Smoke-Test und Beobachtung von Fehlern, Latenz und Ressourcen anhand gemessener Grenzen. Secrets und private Daten bleiben außerhalb der Dokumentation.

Gefundene Workflows: keine bei der Prüfung. Vorhandene Deploymentabläufe werden durch diesen Standard nicht verändert. Eine reine Dokumentationseinrichtung darf keinen ungewollten Produktiv-Deploy auslösen; betroffene PRs bleiben zur konkreten Releaseentscheidung offen. Keine realen Aktuator-, Kommunikations- oder Zahlungsaktionen aus Tests.
