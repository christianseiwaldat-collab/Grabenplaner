'use strict';
const { SALES_REPORT_JOB_STATEMENTS: S, SALES_REPORT_JOB_COLUMNS: columns } = require('../statements/sales-report-jobs');
const fields = Object.keys(columns), entry = (statement, sql) => Object.freeze({ statement, sql, returning: false });
const SQLITE_SALES_REPORT_JOBS_CATALOG = Object.freeze([
  entry(S.list, `SELECT ${fields} FROM sales_report_jobs WHERE scope=$scope AND owner=$owner ORDER BY created DESC,id DESC LIMIT 51`),
  entry(S.get, `SELECT ${fields} FROM sales_report_jobs WHERE scope=$scope AND id=$id`),
  entry(S.next, `SELECT ${fields} FROM sales_report_jobs WHERE scope=$scope AND (status='queued' OR (status='running' AND (lease<=$now OR worker=$worker))) ORDER BY CASE WHEN status='running' AND worker=$worker THEN 0 ELSE 1 END,updated,id LIMIT 1`),
  entry(S.insert, `INSERT INTO sales_report_jobs (${fields}) VALUES (${fields.map(f => '$' + f)})`),
  entry(S.update, `UPDATE sales_report_jobs SET status=$status,revision=revision+1,updated=$updated,lease=$lease,worker=$worker,payload=$payload WHERE id=$id AND scope=$scope AND owner=$owner AND revision=$revision AND created=$created`),
  entry(S.remove, `DELETE FROM sales_report_jobs WHERE id=$id AND scope=$scope AND owner=$owner AND revision=$revision AND status IN ('completed','failed','cancelled')`),
]);
module.exports = { SQLITE_SALES_REPORT_JOBS_CATALOG };
