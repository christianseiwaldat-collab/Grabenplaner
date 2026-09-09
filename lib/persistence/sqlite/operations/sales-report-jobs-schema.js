'use strict';
function ensureSqliteSalesReportJobsSchema(database) {
  database.exec(`CREATE TABLE IF NOT EXISTS sales_report_jobs (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, owner TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled')),
    revision INTEGER NOT NULL CHECK(revision>0), created TEXT NOT NULL, updated TEXT NOT NULL,
    lease INTEGER NOT NULL, worker TEXT NOT NULL, payload TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sales_report_jobs_owner ON sales_report_jobs(scope,owner,created,id);
  CREATE INDEX IF NOT EXISTS sales_report_jobs_queue ON sales_report_jobs(scope,status,updated,id);`);
}
module.exports = { ensureSqliteSalesReportJobsSchema };
