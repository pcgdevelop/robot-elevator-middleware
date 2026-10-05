# Ticketbasierte Entwicklung

Ziel -> Epic -> kleine Story/Aufgabe -> Handbuch und prüfbare Kriterien vor Code -> Umsetzung -> tatsächliche Tests -> unabhängiges fachliches Review -> Testabnahme -> kontrollierter Release.

Ready: Rolle und Nutzen, klarer Umfang, konkrete Eingabe/Ausgabe, Fehler-/Berechtigungsfälle, synthetische Daten, Abhängigkeiten, Testplan, Handbuch, Risiko und Rücknahme. Gefundene Quellgruppen bleiben Backlog, bis diese Angaben belegt sind. Status: Backlog, Ready, In Progress, Review, Blocked, Done. WIP 1 pro Agent. P0 Zugriff/Betrieb, P1 notwendige Basis, P2 Verbesserung.

Branch hermes/<issue>-<kurzname>. Commit <typ>: Ergebnis (pcgdevelop/robot-elevator-middleware#<issue>). PR [#<issue>] Ergebnis mit Refs/Closes pcgdevelop/robot-elevator-middleware#<issue>. Nachweis docs/engineering-standard/acceptance/issue-<issue>.md. Relevante neue Fach-/Sicherheitsregeln erhalten eine knappe Ticketreferenz im Code; übrige Zeilen sind über Git/PR verfolgbar. Bestehende Ticketkonventionen werden im Inventar zugeordnet, nicht ohne Plan umbenannt.

Done setzt Kriterien, Tests, unabhängiges fachliches Review, aktualisierte Dokumentation und Abnahme voraus. Derselbe Implementierungslauf nimmt seine eigene Anwendung nicht ab. Nur der initiale Dokumentations-/CI-Bootstrap darf nach Scope-/Diff-Prüfung und bestandenen Checks vom Operator installiert werden. Kein App-Code oder produktiver Release fällt unter diese Ausnahme.

Bestehende Test-/Deploymentworkflows bleiben erhalten. Die ergänzte Foundation prüft Ticket und Dokumentationsregister, nicht die gesamte Anwendung. Ein separater GitHub-Wiki-/Branchschutz kann vom Tarif abhängen. Es werden keine bezahlten Pläne und keine neuen Agentenzugänge automatisch eingerichtet. Technische Schreibgrenzen und eigener Agentenzugang bleiben eigene Aufgaben.
