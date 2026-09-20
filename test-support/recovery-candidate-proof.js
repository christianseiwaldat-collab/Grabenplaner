'use strict';

// A candidate rehearsal is deliberately not a signed nightly assurance proof.
function candidateRecoveryReceipt(proof, {runId, commit, manifestSha256, sourceFilesSha256}) {
 const hash=/^[a-f0-9]{64}$/;
 if(!/^[a-f0-9-]{36}$/.test(runId||'')||!/^[a-f0-9]{40}$/.test(commit||'')
   ||!hash.test(manifestSha256||'')||!hash.test(sourceFilesSha256||''))throw new Error('CANDIDATE_RECOVERY_BINDING');
 if(proof?.providerId!=='postgresql-pair'||proof.verified!==true
   ||proof.manifestSha256!==manifestSha256||proof.recoveryAccounts!==8
   ||proof.managedImportKey!==true||!proof.databases?.core||!proof.databases?.sales)
  throw new Error('CANDIDATE_RECOVERY_DATABASE_PROOF');
 const app=proof.application;
 if(!app||['passed','compatibility','fullApplicationSmoke','http','authenticatedLogin',
   'historicalArticleSearch','importConfirmed','importConflictRejected','importUndo',
   'revokedSessionRejected'].some(key=>app[key]!==true)
   ||!['schedulePdfBytes','salesPdfBytes','salesPositions'].every(key=>Number.isFinite(app[key])&&app[key]>0))
  throw new Error('CANDIDATE_RECOVERY_APPLICATION_PROOF');
 return {format:'grabenplaner-candidate-recovery-v1',scope:'isolated-candidate-only',
  qualifiesInstalledApplication:false,renewsNightlyAssurance:false,runId,commit,
  manifestSha256,sourceFilesSha256,result:proof};
}
module.exports={candidateRecoveryReceipt};
