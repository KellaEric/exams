# User guides

## Administrator / Super administrator
* **Accounts:** Users & roles → *Invite a user* (a one-time setup link is shown and emailed if mail is configured). Self-registered students appear as *pending*; *Approve* them. Suspending revokes sessions immediately. Only a super administrator can create admins or edit role permissions.
* **Courses:** Catalogue & courses → *Catalogue import* (dry run first; see COURSE-IMPORT.md) or add a course manually. The *Readiness* badge tells you what is missing: no offering → no instructor → no approved questions → ready.
* **Offerings:** Terms, offerings & enrolments → create a term, optional cohort, then an offering (course × term × cohort); assign an instructor (and optional teaching assistants); enrol students by email or approve their enrolment requests.
* **Approvals:** Restricted assessment types (mid-sem, final, practical lab, oral) appear on the dashboard under *Awaiting approval*. Open → *Approve* (cannot be the author, unless super admin).
* **During exams:** Assessment → *Submissions* shows live attempts. *+ time* grants extra minutes to one in-progress attempt; *Reopen* returns a submitted attempt to the student (both need a written reason and are audited). *Accommodations* grant extra time/attempts/late windows in advance.
* **Results:** when every submission is graded the assessment becomes *graded*. Check the gradebook, then *Release results*. Results are invisible to students until then.
* **Incidents:** students report problems/disputes; resolve them with a recorded outcome. The *Audit log* records logins, approvals, publications, grade changes, releases and exceptional actions (CSV export available).

## Instructor
1. **Question bank** (course → Question bank → New question). 12 types: multiple choice, multiple select, true/false, short answer, fill-in-the-blank (`___` markers), numerical (tolerance), matching, ordering, essay, code, file upload, practical (rubric required). Submit for review → Approve. Editing an approved question returns it to draft and creates a new version; assessments already approved keep the old version. Bulk import (CSV/JSON) validates first and skips duplicates.
2. **Create an assessment** (New assessment wizard): basics → schedule (Africa/Accra) → pick approved questions and marks → rules → review. Total marks are calculated from the questions. Save, then open *Manage*.
3. **Publish:** *Preview paper* shows exactly what students see (no keys). Quizzes/tests: *Publish*. Restricted types: *Submit for approval*. Future opening time ⇒ *scheduled* (opens automatically).
4. **Grade:** Grading queue lists essays, practicals, uploads and flagged answers. Use rubric boxes or direct marks, add feedback. Changing an existing mark needs a reason and is kept in the grade history. Pattern-checked code shows which checks passed.
5. **Reports:** Gradebook & reports tab (CSV/print); per-assessment analytics (distribution, pass rate, hardest questions, missing submissions).
Instructors only see courses they are assigned to. Teaching assistants can read the bank and grade, not edit.

## Student
* **Before:** open the assessment page and read the instructions, time allowed and attempts. The paper is hidden until you press *Start*.
* **During:** the timer is set by the server — refreshing, a second tab or changing your device clock changes nothing. "All answers saved" confirms the server has your answers; offline answers are kept and sent when you reconnect. Use the question panel to jump around and ⚑ to flag questions. *Review & submit* shows unanswered/flagged counts. At zero, saved answers are submitted automatically.
* **If something breaks:** reopen the assessment page and press *Resume*, then use *Report an issue* (technical, accessibility, dispute). Only an administrator can grant extra time or reopen an attempt.
* **After:** you get a receipt code on submission. Marks and feedback appear only after release, at the level the instructor chose (none / score / marks+feedback / full).
* **Integrity:** window-focus changes are recorded as signals only and are reviewed by a person; there is no webcam or biometric monitoring.
