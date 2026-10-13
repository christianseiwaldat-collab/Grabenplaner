'use strict';

// The server supplies an already authorized planning snapshot. A print choice
// can only narrow it; it never loads an employee or changes planning state.
function selectSchedulePrintEmployees(schedule, value) {
  if(value===undefined)return schedule;
  const invalid=()=>{const error=Error('Bitte mindestens eine Person aus dem gewählten Planungsbereich für den Druck wählen.');error.status=400;error.code='SCHEDULE_PRINT_EMPLOYEES_INVALID';return error;};
  if(typeof value!=='string'||!value.trim()||value.length>16000)throw invalid();
  const numbers=value.split(',').map(number=>number.trim());
  if(numbers.length>1000||numbers.some(number=>!number||number.length>32))throw invalid();
  const requested=new Set(numbers),employees=schedule.employees.filter(employee=>requested.has(String(employee.personnel_number)));
  if(!employees.length)throw invalid();
  const selected=new Set(employees.map(employee=>String(employee.personnel_number)));
  const result={...schedule,employees};
  for(const key of ['shifts','weekOptions','staffAssignments','pdfStaffAssignmentShifts','sicknessCredits']){
    if(Array.isArray(schedule[key]))result[key]=schedule[key].filter(row=>selected.has(String(row.employee_number??row.employeeNumber)));
  }
  for(const key of ['totals','plannedTotals','inStoreTotals','bonusTotals','optionCreditTotals','sicknessCreditTotals','saturdayStats']){
    if(schedule[key]&&typeof schedule[key]==='object'&&!Array.isArray(schedule[key]))result[key]=Object.fromEntries(Object.entries(schedule[key]).filter(([number])=>selected.has(number)));
  }
  return result;
}

module.exports={selectSchedulePrintEmployees};
