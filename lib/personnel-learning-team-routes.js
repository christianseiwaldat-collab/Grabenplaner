"use strict";
const crypto = require("node:crypto");
const T = require("./personnel-learning-team");
const fail = (message, status = 400) => { throw Object.assign(new Error(message), {status, code:"PERSONNEL_LEARNING_TEAM_INVALID"}); };
function contains(parent, child) {
  return parent.type === "organization" || parent.locationId === child.locationId
    && (parent.type === "location" || child.type === "department" && Number(parent.departmentId) === Number(child.departmentId));
}
function group(rows, key) {
  const map = new Map();
  for (const row of rows) { const values = map.get(row[key]) || []; values.push(row); map.set(row[key], values); }
  return map;
}
function register(app, deps) {
  const base = "/api/portal/v1/personnel-learning";
  async function actorFor(request, organization, write = false) {
    const actor = await deps.actor(deps.session(request, write), organization);
    if (!actor.actorId || actor.access.canWriteAssignments !== true) fail("Die Teamübersicht benötigt die Berechtigung zur Schulungszuweisung.", 403);
    return actor;
  }
  function allLocations(actor) { return actor.access.localSystem || actor.access.plPlus || actor.access.canAssignCrossLocation; }
  function canManage(actor, rule) {
    return actor.access.canManageCatalog && actor.access.canPublishCatalog && deps.scopeAccess(actor.access, rule.payload.scope, {manage:true});
  }
  function visible(actor, rule) {
    return allLocations(actor) || rule.payload.scope.type === "organization"
      || rule.payload.scope.locationId === actor.access.organizationScope?.locationId
      && (rule.payload.scope.type !== "department" || actor.access.role === "manager"
        || Number(rule.payload.scope.departmentId) === Number(actor.access.organizationScope?.departmentId));
  }
  const publicRule = (actor, rule) => ({...rule, canManage:!!canManage(actor, rule)});
  app.get(base + "/team/options", async (request, response) => {
    const actor = await actorFor(request);
    const [positions, roles, bundles, revisions] = await Promise.all([
      deps.organization.listPositions(), deps.organization.listPortalRoles(), deps.bundles(), deps.repository.listRequirements(),
    ]);
    const modules = bundles.filter(b => ["skill", "process"].includes(b.catalogEntity) && !b.state.archived && b.state.publishedVersion
      && deps.scopeAccess(actor.access, deps.scope(b.state.publishedVersion))).map(b => ({
        id:b.module.id, type:b.catalogEntity === "skill" ? "skill" : "training", title:b.state.publishedVersion.title,
        version:b.state.publishedVersionNumber, scope:deps.scope(b.state.publishedVersion),
      }));
    response.set("Cache-Control", "no-store").json({modules,
      positions:positions.filter(p => p.active).map(p => ({id:p.id, name:p.name})), roles:roles.map(r => ({id:r.id, name:r.name})),
      locations:actor.locations.filter(l => l.active && (allLocations(actor) || String(l.id) === actor.access.organizationScope?.locationId)).map(l => ({id:String(l.id), name:l.name})),
      scopes:deps.scopes(actor), canManage:!!(actor.access.canManageCatalog && actor.access.canPublishCatalog),
      rules:T.rules(revisions).filter(r => visible(actor, r)).map(r => publicRule(actor, r)),
    });
  });
  async function save(request, response) {
    const saved = await deps.transaction(async repositories => {
      const actor = await actorFor(request, repositories.organizationPersonnel, true);
      const repository = repositories.personnelLearning;
      const latest = T.rules(await repository.listRequirements());
      const previous = request.params.requirementId ? latest.find(r => r.id === request.params.requirementId) : null;
      if (request.params.requirementId && !previous) fail("Anforderung nicht gefunden.", 404);
      if (previous && !canManage(actor, previous)) fail("Diese Anforderung liegt außerhalb des Verantwortungsbereichs.", 403);
      if (String(request.body?.expectedReceipt || "") !== (previous?.receiptSha256 || "")) fail("Die Anforderung wurde inzwischen geändert. Bitte neu laden.", 409);
      const payload = T.normalize(request.body);
      if (!canManage(actor, {payload})) fail("Für diesen Geltungsbereich fehlt die Berechtigung zur Veröffentlichung.", 403);
      payload.scope = {...payload.scope, ...deps.scopeSnapshot(payload.scope, actor)};
      const [positions, roles, bundles] = await Promise.all([repositories.organizationPersonnel.listPositions(), repositories.organizationPersonnel.listPortalRoles(), deps.bundles(repository)]);
      if (payload.positionId && !positions.some(p => p.id === payload.positionId && p.active)
        || payload.roleId && !roles.some(r => r.id === payload.roleId)) fail("Position oder Rolle ist nicht mehr verfügbar.");
      const bundle = bundles.find(b => b.module.id === payload.moduleId);
      if (!payload.active && previous) {
        // Archiving preserves the original binding, even if the module was archived meanwhile.
        Object.assign(payload, previous.payload, {active:false});
      } else {
        if (!bundle || bundle.catalogEntity !== (payload.type === "skill" ? "skill" : "process") || bundle.state.archived || !bundle.state.publishedVersion) fail("Bitte eine veröffentlichte Fähigkeit oder Schulung wählen.", 409);
        if (!contains(deps.scope(bundle.state.publishedVersion), payload.scope)) fail("Die Anforderung darf nur innerhalb des Geltungsbereichs der gewählten Fassung gelten.");
        payload.moduleVersionNumber = bundle.state.publishedVersionNumber;
        if (latest.filter(r => r.payload.active && r.id !== previous?.id).length >= 50) fail("Höchstens 50 aktive Anforderungen. Bitte nicht mehr benötigte Anforderungen archivieren.", 409);
      }
      const row = {id:previous?.id || crypto.randomUUID(), revision:(previous?.revision || 0) + 1, payload,
        previousReceipt:previous?.receiptSha256 || "", changedBy:actor.actorId, changedAt:new Date().toISOString()};
      row.receiptSha256 = T.receipt(row);
      await repository.insertRequirement(row);
      await repositories.organizationPersonnel.insertAudit(actor.actorId, "personnel.learning.requirement.saved", "personnel_learning_requirement", row.id, JSON.stringify({revision:row.revision, receipt:row.receiptSha256}));
      return publicRule(actor, row);
    });
    response.status(request.params.requirementId ? 200 : 201).json({requirement:saved});
  }
  app.post(base + "/requirements", save);
  app.put(base + "/requirements/:requirementId", save);
  async function projection(request) {
    const actor = await actorFor(request);
    const bounded = (key, max = 100) => { const value = String(request.query[key] || "").trim(); if (value.length > max || value.includes("\0")) fail("Ungültiger Filter."); return value; };
    const pageSize = Number(request.query.pageSize || 25), offset = Number(request.query.offset || 0), kind = bounded("kind");
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000 || !["", "skill", "training"].includes(kind)) fail("Ungültige Seitenauswahl.");
    const filters = {allLocations:!!allLocations(actor), scopeLocation:actor.access.organizationScope?.locationId || "",
      scopeDepartment:actor.access.role === "department_manager" ? Number(actor.access.organizationScope?.departmentId || -1) : 0,
      locationId:bounded("locationId"), positionId:bounded("positionId"), roleId:bounded("roleId"), search:bounded("search", 150)};
    const [people, total, revisions, moduleBundles] = await Promise.all([
      deps.repository.listTeamPeople({...filters, pageSize, offset}), deps.repository.countTeamPeople(filters),
      deps.repository.listRequirements(), deps.bundles(),
    ]);
    const rules = T.rules(revisions).filter(r => r.payload.active && visible(actor, r) && (!kind || r.payload.type === kind));
    const bundles = new Map(moduleBundles.map(b => [b.module.id, b]));
    const data = await deps.repository.teamData(people.map(p => p.employeeNumber));
    const competencyRevisions = group(data.teamCompetencyRevisions, "competencyId"), assignmentRevisions = group(data.teamAssignmentRevisions, "assignmentId"), progressRevisions = group(data.teamProgressRevisions, "assignmentId");
    const competencies = data.teamCompetencies.map(c => {
      const state = deps.competencyState(c, competencyRevisions.get(c.id) || []);
      return {employeeNumber:c.employeeNumber, moduleId:c.skillModuleId, active:state.active, level:state.current.competencyLevel, version:state.current.skillVersionNumber, changedAt:state.current.changedAt};
    });
    const trainings = data.teamAssignments.map(a => {
      const state = deps.assignmentState(a, assignmentRevisions.get(a.id) || []);
      const version = bundles.get(a.processModuleId)?.versions.find(v => v.versionNumber === state.current.processVersionNumber);
      if (!version) fail("Die gebundene Schulungsfassung ist nicht vollständig verfügbar.", 503);
      const progress = deps.progressState(progressRevisions.get(a.id) || [], version.content.steps);
      return {employeeNumber:a.learnerEmployeeNumber, moduleId:a.processModuleId, active:state.active, version:version.versionNumber,
        result:progress.finalized ? progress.result : "pending", changedAt:progress.current?.changedAt || state.current.changedAt};
    });
    const rows = people.map(person => ({...person, cells:rules.map(rule => T.cell(rule, person, {competencies, trainings}))}));
    return {generatedAt:new Date().toISOString(), total:total.count, pageSize, offset, people:rows, rules:rules.map(r => publicRule(actor, r)), summary:T.summarize(rows), summaryScope:"page"};
  }
  app.get(base + "/team", async (request, response) => response.set("Cache-Control", "no-store").json(await projection(request)));
  app.get(base + "/team.csv", async (request, response) => {
    const value = await projection(request);
    response.set({"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff", "Content-Type":"text/csv; charset=utf-8", "Content-Disposition":'attachment; filename="Schulung-Team-Seite.csv"'}).send(T.csv(value));
  });
}
module.exports = {register, contains};
