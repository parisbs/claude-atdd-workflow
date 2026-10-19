---
name: adr-draft
description: Scaffold the next architecture decision record in the repository's own ADR directory, format and numbering, and add it to the index. Use when a decision closes an alternative.
argument-hint: <decision title>
---

Create an architecture decision record for: $ARGUMENTS

Repositories differ in where they keep ADRs and how they write them. Follow the
repository, never a default, when it has a convention.

1. Find the ADR directory: `docs/adr/`, `docs/adrs/`, `docs/decisions/` or
   whatever the repository's `CLAUDE.md` names. If none exists, propose
   `docs/adr/` with a `template.md` and a `README.md` index, and ask first.
2. Learn the local format from the template (`template.md`,
   `0000-template.md`) or, without one, from the two most recent records:
   numbering width, file name pattern, title line, section names. The
   metadata is not local: it is always MADR 4 YAML front matter (step 5).
3. The new number is the highest existing one plus one. Numbers are never
   reused, including those of rejected records. The slug is a short kebab-case
   form of the title.
4. Fill every section with concrete content from the conversation. The
   alternatives section is mandatory whatever the template calls it: name each
   rejected option and the concrete reason it was rejected. Only the human
   accepts or rejects a record.
5. The record starts with YAML front matter (MADR 4): line 1 is `---`, then
   `status: proposed`, `date:` with today's date as `YYYY-MM-DD`, and a closing
   `---`, then the title line. The status is that front matter field, never a
   `- Status:` or `Status:` line in the body: the ADR check counts a record
   without it as missing a status.
6. Records are immutable from the commit on `main` where their status becomes
   accepted or rejected. A proposed record on `main`, and any record in an
   open pull request, is still an editable draft. A changed decision or
   reconsidered rejection needs a new record; superseded records change only
   in their front matter status (`superseded by NNNN`, or a note naming the
   part superseded). Never edit a frozen record's body, even to fix a stale
   reference: note it in the new record's consequences. The status is its
   leading word, and an annotation such as `amended by NNNN` may follow it. A
   missing status or a leading word other than proposed, accepted, rejected,
   deprecated or superseded means immutability from the merge; ask to
   normalise it. Only an accepted record becomes `deprecated`, and a
   deprecated record only becomes superseded. The `date` of a decided record
   changes only together with its status.
7. Records in a legacy format, with a `- Status:` or `Status:` line instead of
   front matter, count as missing a status. Their one-time migration is
   mechanical: it adds front matter and removes the legacy status and date
   lines, every other line identical, and the ADR check verifies it. Where the
   repository has `scripts/migrate-adrs.mjs` it writes that change; otherwise
   `repo-bootstrap` brings the script and the check. Propose the migration in
   its own pull request; never mix it with edits.
8. Add the record to the index in numeric order when the repository keeps one.
9. Diagrams use Mermaid and carry a short prose description.

Report the path and stop. Do not commit: the human reviews the record first.
