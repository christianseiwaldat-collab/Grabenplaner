'use strict';
// Existing category identities and retention defaults from the qualified
// personnel/document schema. Startup only fills missing IDs, never rewrites
// an administrator's existing label, visibility, status or retention policy.
const freeze = rows => Object.freeze(rows.map(row => Object.freeze(row)));
const PERSONNEL_DOCUMENT_CATEGORIES = freeze([
 ['contract','contract','Dienstvertrag',10],
 ['amendment','amendment','Vertragsänderung',20],
 ['certificate','certificate','Nachweis',30],
 ['training','training','Schulung',40],
 ['identity','identity','Identitätsnachweis',50],
 ['payroll','payroll','Lohnverrechnung',60],
 ['other','other','Dokument',70],
]);
const CANDIDATE_DOCUMENT_CATEGORIES = freeze([
 ['resume','resume','Lebenslauf','recruiting',1,10],
 ['cover-letter','cover_letter','Bewerbungsschreiben','recruiting',1,20],
 ['certificate','certificate','Zeugnis','hr_confidential',1,30],
 ['reference','reference','Referenz','hr_confidential',1,40],
 ['work-sample','work_sample','Arbeitsprobe','recruiting',0,50],
 ['other','other','Sonstiges','hr_confidential',0,60],
 ['profile-photo','profile_photo','Bewerberfoto','scoped_leadership',0,70],
]);
module.exports={PERSONNEL_DOCUMENT_CATEGORIES,CANDIDATE_DOCUMENT_CATEGORIES};
