"use strict";

// Defaults are Developer decisions. Other roles retain their existing delegation
// boundaries, even if they have roles:write or rights:write.
function registerPortalPermissionDefaultsRoutes(app, {
  requireActor, repository, transaction, catalog, builtinRoles, knownPermissions,
  validateDependencies, effectiveState, error,
}) {
  function actor(request) {
    const value = requireActor(request);
    if (value?.role !== "developer") throw error(403, "Nur der Developer kann Rollen- und Positionsstandards ändern.", "PORTAL_DEFAULTS_DEVELOPER_REQUIRED");
    return value;
  }
  async function payload() {
    const defaults = await repository.listPermissionDefaults();
    return {
      catalog,
      entries: defaults.map(row => ({ ...row,
        permissions: row.kind === "role" && row.id === "developer" ? [...knownPermissions] : row.permissions === null ? null : JSON.parse(row.permissions),
        protected: row.kind === "role" && row.id === "developer",
        builtinPermissions: row.kind === "role" ? builtinRoles.find(role => role.id === row.id)?.permissions || null : null,
      })),
    };
  }
  app.get("/api/portal/v1/rights/defaults", async (request, response) => {
    actor(request);
    response.set("Cache-Control", "private, no-store");
    response.json(await payload());
  });
  app.put("/api/portal/v1/rights/defaults/:kind/:id", async (request, response) => {
    const editor = actor(request), { kind, id } = request.params, body = request.body || {};
    if (!["role", "position"].includes(kind) || Object.keys(body).some(key => !["permissions", "revision", "reset"].includes(key))
      || !Number.isSafeInteger(body.revision) || body.revision < 0 || (body.reset !== undefined && typeof body.reset !== "boolean")) {
      throw error(400, "Bitte einen gültigen Standard mit Versionsstand übermitteln.", "PORTAL_DEFAULTS_INVALID");
    }
    if (kind === "role" && id === "developer") throw error(403, "Der Developer behält garantierten Vollzugriff.", "PORTAL_DEVELOPER_PROTECTED");
    const reset = body.reset === true;
    if (!reset && (!Array.isArray(body.permissions) || body.permissions.some(p => !knownPermissions.has(p))
      || new Set(body.permissions).size !== body.permissions.length)) {
      throw error(400, "Die Auswahl enthält unbekannte oder doppelte Rechte.", "PORTAL_DEFAULTS_INVALID");
    }
    let affected = 0;
    await transaction(async organization => {
      const live = await organization.getPortalAccessProjection(editor.employeeNumber);
      const employee = await organization.getEmployeeForUpdate(editor.employeeNumber);
      if (!live?.active || !employee?.active || live.role !== "developer") throw error(403, "Der Developer-Zugang ist nicht mehr aktiv.", "PORTAL_DEFAULTS_DEVELOPER_REQUIRED");
      const entry = (await organization.listPermissionDefaults()).find(row => row.kind === kind && row.id === id);
      if (!entry) throw error(404, "Diese Rolle oder Position ist nicht mehr vorhanden.", "PORTAL_DEFAULTS_NOT_FOUND");
      if (entry.revision !== body.revision) throw error(409, "Der Standard wurde inzwischen geändert. Bitte neu laden.", "PORTAL_DEFAULTS_CONFLICT");
      const builtin = builtinRoles.find(role => role.id === id);
      if (reset && kind === "role" && !builtin) throw error(400, "Für diese Rolle gibt es keinen eingebauten Standard.", "PORTAL_DEFAULTS_INVALID");
      const permissions = reset ? kind === "role" ? [...builtin.permissions].sort() : null : [...body.permissions].sort();
      if (permissions) validateDependencies(permissions);
      const beforeUsers = await organization.listPortalUsersForAdmin();
      const beforePermissions = new Map(beforeUsers.map(user => [user.personnel_number, user.role_permissions]));
      const write = kind === "role"
        ? await organization.updateRolePermissionDefaults({ id, permissions: JSON.stringify(permissions), revision: body.revision, customized: !reset })
        : await organization.updatePositionPermissionDefaults({ id, permissions: permissions === null ? null : JSON.stringify(permissions), revision: body.revision, actor: editor.employeeNumber });
      if (write.rowsAffected !== 1) throw error(409, "Der Standard wurde inzwischen geändert. Bitte neu laden.", "PORTAL_DEFAULTS_CONFLICT");
      for (const user of await organization.listPortalUsersForAdmin()) {
        if (user.role === "developer" || !user.active || !user.employee_active
          || user.role_permissions === beforePermissions.get(user.personnel_number)) continue;
        const [grants, denials] = await Promise.all([
          organization.listPortalPermissionGrants(user.personnel_number), organization.listPortalPermissionDenials(user.personnel_number),
        ]);
        try {
          validateDependencies(effectiveState(user.personnel_number, user.role, user.role_permissions, grants, denials, user.amu_local_access_mode).effectivePermissions);
        } catch (cause) {
          throw error(400, `Bei ${user.personnel_number} passen persönliche Rechte und neuer Standard nicht zusammen. ${cause.message}`, "PORTAL_DEFAULTS_PERSONAL_DEPENDENCY");
        }
        await organization.revokePortalSessions(user.personnel_number);
        await organization.revokeMobileSessions(user.personnel_number, "permission_defaults_changed");
        affected++;
      }
      const previous = new Set(entry.permissions === null ? [] : JSON.parse(entry.permissions)), next = new Set(permissions || []);
      for (const permission of new Set([...previous, ...next])) {
        if (previous.has(permission) === next.has(permission)) continue;
        await organization.insertAudit(editor.employeeNumber, "portal.permission-defaults.permission", kind, id,
          JSON.stringify({ revision: entry.revision + 1, permission, before: previous.has(permission), after: next.has(permission) }));
      }
      await organization.insertAudit(editor.employeeNumber, "portal.permission-defaults.update", kind, id,
        JSON.stringify({ revision: entry.revision + 1, reset, affected, inheritedBefore: entry.permissions === null, inheritedAfter: permissions === null }));
    });
    response.set("Cache-Control", "private, no-store");
    response.json({ ...await payload(), affected });
  });
}

module.exports = { registerPortalPermissionDefaultsRoutes };
